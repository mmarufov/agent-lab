import { describe, expect, it } from "vitest";
import type { DailyHttpObservation } from "@agent-lab/contracts/daily-capture";
import { evaluateCoverage, unassessedCoverage, type CoverageFact } from "../src/coverage";
import { dailyFeedAvailabilityFacts } from "../src/daily-coverage";
import { feedAvailabilityEvidence, observation } from "./daily-capture-fixture";

// The coverage evaluator and the daily-feed-availability-v1 facts, as pure
// functions: no files, database, or answer.

const fact = (id: string, requirements: string[][]): CoverageFact => ({
  id, label: `${id} evidence`, statement: `${id} happened`, applicable: true,
  requirements: requirements.map((anyOf, index) => ({ id: `${id}-${index}`, description: `requirement ${index}`, anyOf })),
});
const absent: CoverageFact = { id: "absent", label: "Absent evidence", statement: "Absent happened", applicable: false, reason: "Not in the recording." };

describe("the coverage evaluator", () => {
  it("covers a fact when each required combination has one of its alternatives", () => {
    const coverage = evaluateCoverage([fact("recovery", [["fail-1", "fail-2"], ["ok-1", "ok-2"]])], ["fail-2", "ok-1", "unrelated"]);
    expect(coverage).toMatchObject({ evaluatorVersion: "coverage-v1", result: "covered" });
    expect(coverage.facts[0]).toMatchObject({ status: "covered", requirements: [{ matchedIds: ["fail-2"] }, { matchedIds: ["ok-1"] }] });
  });

  it("misses a fact when one requirement has no retrieved alternative, and names it", () => {
    const coverage = evaluateCoverage([fact("recovery", [["fail-1"], ["ok-1", "ok-2"]]), fact("errors", [["fail-1"]])], ["fail-1"]);
    expect(coverage.result).toBe("missed");
    expect(coverage.facts.map((value) => value.status)).toEqual(["missed", "covered"]);
    expect(coverage.facts[0].reason).toBe("No retrieved record meets: requirement 1.");
    expect(coverage.reason).toContain("recovery evidence");
  });

  it("marks facts the recording lacks not assessed, and gives no pass when none applies", () => {
    expect(evaluateCoverage([absent, fact("errors", [["e"]])], ["e"])).toMatchObject({ result: "covered", facts: [{ status: "not_assessed", reason: "Not in the recording." }, { status: "covered" }] });
    expect(evaluateCoverage([absent], ["anything"])).toMatchObject({ result: "not_assessed", facts: [{ status: "not_assessed", requirements: [] }] });
    expect(evaluateCoverage([], [])).toMatchObject({ result: "not_assessed" });
  });

  it("keeps the requirements but assesses nothing when the retrieved records cannot be counted", () => {
    const coverage = unassessedCoverage([fact("errors", [["e"]]), absent], "The investigation failed.");
    expect(coverage).toMatchObject({ result: "not_assessed", reason: "The investigation failed." });
    expect(coverage.facts).toMatchObject([
      { status: "not_assessed", reason: "The investigation failed.", requirements: [{ anyOf: ["e"], matchedIds: [] }] },
      { status: "not_assessed", reason: "Not in the recording.", requirements: [] },
    ]);
  });

  it("refuses a fact that could never be met or is defined twice", () => {
    expect(() => evaluateCoverage([fact("empty", [])], [])).toThrow(/at least one requirement/);
    expect(() => evaluateCoverage([fact("empty", [[]])], [])).toThrow(/at least one acceptable record/);
    expect(() => evaluateCoverage([fact("twice", [["a"]]), fact("twice", [["b"]])], [])).toThrow(/defined twice/);
  });
});

describe("daily-feed-availability-v1 facts", () => {
  const http = (records: ReturnType<typeof feedAvailabilityEvidence>) => records.filter((record): record is DailyHttpObservation => record.kind === "http");
  const requirements = (facts: CoverageFact[]) =>
    Object.fromEntries(facts.map((value) => [value.id, value.applicable ? value.requirements.map((requirement) => requirement.anyOf) : value.reason]));

  it("finds each fact in the recording's own records and times", () => {
    const profile = dailyFeedAvailabilityFacts(http(feedAvailabilityEvidence()));
    expect(requirements(profile.facts)).toEqual({
      // 500 and 503; another path's 503 does not count.
      server_errors: [["http-0002", "http-0006"]],
      // A timeout and a network error.
      no_response: [["http-0003", "http-0004"]],
      // After the last failure (http-0006): not the apparent recovery (http-0005), the truncated 200 (http-0008), or either 401.
      recovery: [["http-0002", "http-0003", "http-0004", "http-0006"], ["http-0009", "http-0011"]],
    });
    expect(profile.acceptableEvidence.map((value) => value.id)).toEqual(["http-0002", "http-0003", "http-0004", "http-0006", "http-0009", "http-0011"]);
    expect(profile.acceptableEvidence[4]).toEqual(feedAvailabilityEvidence().find((value) => value.id === "http-0009"));
    // The unauthenticated 401 is outside the profile; the truncated 200 and the authenticated 401 are other responses.
    expect(profile.scope).toEqual({ feedObservations: 10, serverErrors: 2, noResponses: 2, readyResponses: 4, otherResponses: 2, lastFailureEndedAt: observation(6, 503).endedAt });
  });

  it("measures recovery from when the last failure ended, not when it started", () => {
    // A five-second timeout from 30 s to 35 s; a success that started at 32 s overlaps it.
    const overlapping = { ...observation(4, 200), startedAt: observation(3, 200).startedAt.replace(":30.000Z", ":32.000Z") };
    const profile = dailyFeedAvailabilityFacts([observation(3, "timeout", { durationMs: 5_000 }), overlapping]);
    expect(profile.facts.find((value) => value.id === "recovery")).toMatchObject({
      applicable: false, reason: expect.stringContaining(`last failed request ended at ${observation(3, "timeout", { durationMs: 5_000 }).endedAt}`),
    });
    const later = dailyFeedAvailabilityFacts([observation(3, "timeout", { durationMs: 5_000 }), observation(4, 200)]);
    expect(requirements(later.facts).recovery).toEqual([["http-0003"], ["http-0004"]]);
  });

  it.each([
    ["status is not ready", { body: { status: "degraded", articles: [] } }],
    ["no articles array", { body: { status: "ready" } }],
    ["the body is truncated", { truncated: true }],
  ])("does not count a 200 as recovery when its %s", (_name, options) => {
    const profile = dailyFeedAvailabilityFacts([observation(1, 500), observation(2, 200, options)]);
    expect(profile.facts.find((value) => value.id === "recovery")).toMatchObject({ applicable: false });
    expect(profile.scope).toMatchObject({ readyResponses: 0, otherResponses: 1 });
  });

  it("does not treat authentication failures or other paths as server errors or as the last failure", () => {
    const profile = dailyFeedAvailabilityFacts([
      observation(1, 500), observation(2, 200), observation(3, 401), observation(4, 401, { authenticated: false }), observation(5, 503, { path: "/readyz" }),
    ]);
    expect(requirements(profile.facts)).toEqual({
      server_errors: [["http-0001"]],
      no_response: "The recording has no authenticated GET /feed request that timed out or failed with a network error.",
      recovery: [["http-0001"], ["http-0002"]],
    });
  });

  it("finds no recovery while failures persist to the end, and no facts in a healthy recording", () => {
    const persistent = dailyFeedAvailabilityFacts([observation(1, 200), observation(2, 500), observation(3, "timeout")]);
    expect(requirements(persistent.facts).recovery).toMatch(/does not show recovery/);
    expect(evaluateCoverage(persistent.facts, ["http-0002", "http-0003"]).result).toBe("covered");

    const healthy = dailyFeedAvailabilityFacts([observation(1, 200), observation(2, 200)]);
    expect(healthy.facts.every((value) => !value.applicable)).toBe(true);
    expect(requirements(healthy.facts).recovery).toBe("The recording has no failed authenticated GET /feed request to recover from.");
    expect(evaluateCoverage(healthy.facts, ["http-0001", "http-0002"])).toMatchObject({ result: "not_assessed" });
    expect(healthy.acceptableEvidence).toEqual([]);
  });
});
