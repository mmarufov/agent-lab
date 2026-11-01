import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewConfig } from "@agent-lab/contracts";
import type { DailyCaptureEvidence, DailyHttpObservation } from "@agent-lab/contracts/daily-capture";
import type { DailyInvestigationAnswer } from "@agent-lab/contracts/daily-investigation";
import { createCaptureAccess } from "../src/capture-access";
import { describeCoverage } from "../src/coverage-report";
import { createPool } from "../src/database";
import { createCoverageStore, type SavedCoverageAssessment } from "../src/daily-coverage";
import { createTrial } from "../src/fixtures";
import { migrate } from "../src/migrate";
import { reviewSavedRun } from "../src/reviews";
import { createRunStore } from "../src/runs";
import { bypassingTriggers } from "./administrator";
import { capturesDir, feedAvailabilityEvidence, removeCaptureDirs, writeCapture } from "./daily-capture-fixture";

// pnpm lab:coverage and pnpm lab coverage against synthetic recordings and real
// PostgreSQL. No model, Docker, Eve, or Next.js is involved. The capture IDs
// here exist only in temporary directories, never in the real captures folder.

const CAPTURE_ID = "20261031T120000Z-c0ffee";
const CHANGED_ID = "20261031T120500Z-c0ffe2";
const admin = createPool();
const schema = `daily_coverage_${randomUUID().replaceAll("-", "")}`;
const url = new URL(process.env.DATABASE_URL!);
url.searchParams.set("options", `-c search_path=${schema}`);
const pool = createPool(url.toString());
const runs = createRunStore(pool);
const coverage = createCoverageStore(pool);
let dir = "";
type Grant = Awaited<ReturnType<ReturnType<typeof createCaptureAccess>["grant"]>>["grant"];
let grant: Grant;

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  dir = await capturesDir();
  await writeCapture(dir, { captureId: CAPTURE_ID, evidence: feedAvailabilityEvidence() });
  ({ grant } = await createCaptureAccess(pool, dir).grant(CAPTURE_ID));
});
afterAll(async () => {
  await removeCaptureDirs();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

const recorded = Object.fromEntries(feedAvailabilityEvidence().map((value) => [value.id, value])) as Record<string, DailyCaptureEvidence>;
const pick = (...ids: string[]) => ids.map((id) => recorded[id]);
const feed = feedAvailabilityEvidence().filter((value): value is DailyHttpObservation => value.kind === "http" && value.path === "/feed");
const logs = feedAvailabilityEvidence().filter((value) => value.kind === "log");

let eventIds = 0;
const turn = { turnId: "turn_0", sequence: 0 };
const event = (type: string, data: object) => ({ type, meta: { id: `event-${++eventIds}`, at: "2026-10-31T12:10:00.000Z" }, data: { ...turn, ...data } });
const call = (callId: string, toolName: string, input: object, records: DailyCaptureEvidence[], source: Grant = grant, output: object = {}) => [
  event("actions.requested", { stepIndex: 0, actions: [{ kind: "tool-call", toolName, callId, input }] }),
  event("action.result", {
    status: "completed",
    result: {
      kind: "tool-result", toolName, callId,
      output: {
        captureId: source.captureId, evidenceSha256: source.sha256["evidence.jsonl"],
        [toolName === "get_daily_logs" ? "logs" : "observations"]: records, oversized: [], nextCursor: null, ...output,
      },
    },
  }),
];
const observations = (callId: string, records: DailyCaptureEvidence[], output: object = {}) =>
  call(callId, "get_daily_http_observations", { path: "/feed" }, records, grant, output);
const failedCall = (callId: string) => [
  event("actions.requested", { stepIndex: 0, actions: [{ kind: "tool-call", toolName: "get_daily_logs", callId, input: {} }] }),
  event("action.result", { status: "failed", error: { code: "TOOL_ERROR", message: "Unavailable." },
    result: { kind: "tool-result", toolName: "get_daily_logs", callId, isError: true, output: "Unavailable." } }),
];

const answer: DailyInvestigationAnswer = {
  diagnosis: "/feed returned server errors and timeouts, then served the feed again.",
  evidenceIds: ["http-0002"],
  uncertainty: "Why the failures happened is not recorded.",
};

async function dailyRun(steps: object[], options: { answer?: DailyInvestigationAnswer; finish?: "completed" | "failed" | null; source?: Grant } = {}) {
  const source = options.source ?? grant;
  const final = options.answer ?? answer;
  const finish = options.finish === undefined ? "completed" : options.finish;
  const id = await runs.createDaily({
    captureId: source.captureId, grantId: source.id, sha256: source.sha256,
    task: "Investigate Daily's feed API during the recorded period.", instructions: "Investigate.", agentConfigSource: "{}",
    configuration: { toolMode: "daily_capture" },
  });
  for (const step of [...steps, ...(finish === "completed" ? [event("result.completed", { result: final })] : [])]) await runs.appendEvent(id, step);
  if (finish === "completed") await runs.finish(id, { status: "completed", answer: final, message: "Done." });
  if (finish === "failed") await runs.finish(id, { status: "failed", error: "Eve stopped." });
  return id;
}

const assess = (runId: string) => coverage.assess(runId, { capturesDir: dir });
const assessments = async (runId: string) =>
  (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM lab_coverage_assessments WHERE run_id = $1", [runId])).rows[0].n;
const statuses = (saved: SavedCoverageAssessment) => Object.fromEntries(saved.facts.map((fact) => [fact.id, fact.status]));
const matched = (saved: SavedCoverageAssessment) =>
  Object.fromEntries(saved.facts.map((fact) => [fact.id, fact.requirements.map((requirement) => requirement.matchedIds)]));

function cli(script: string, args: string[]) {
  return new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, ["--import", "tsx", script, ...args], { env: { ...process.env, DATABASE_URL: url.toString() }, timeout: 20_000 },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

describe("coverage of a completed Daily investigation", () => {
  it("covers every fact when the retrieved records include failures and the later recovery, cited or not", async () => {
    const id = await dailyRun([...observations("call-1", feed), ...call("call-2", "get_daily_logs", {}, logs)]);
    const { created, assessment } = await assess(id);
    expect(created).toBe(true);
    expect(assessment).toMatchObject({
      runId: id, profileVersion: "daily-feed-availability-v1", evaluatorVersion: "coverage-v1", result: "covered",
      captureId: CAPTURE_ID, captureSha256: grant.sha256,
      integrity: { version: 1, origin: "finalization", sha256: (await runs.getDaily(id)).integrity.fingerprint!.sha256 },
      retrieved: { counted: true, records: 14, httpObservations: 11 },
      answerInterpretation: { status: "not_assessed" },
    });
    expect(statuses(assessment)).toEqual({ server_errors: "covered", no_response: "covered", recovery: "covered" });
    // The answer cites only http-0002; retrieval alone counts.
    expect(matched(assessment)).toEqual({
      server_errors: [["http-0002", "http-0006"]],
      no_response: [["http-0003", "http-0004"]],
      recovery: [["http-0002", "http-0003", "http-0004", "http-0006"], ["http-0009", "http-0011"]],
    });
    expect(assessment.acceptableEvidence).toEqual(pick("http-0002", "http-0003", "http-0004", "http-0006", "http-0009", "http-0011"));
    expect(assessment.retrieved.matches.map((value) => [value.id, value.callId])).toEqual(
      ["http-0002", "http-0003", "http-0004", "http-0006", "http-0009", "http-0011"].map((value) => [value, "call-1"]));

    const lines = describeCoverage(assessment);
    for (const line of [
      "Integrity: verified (fingerprint v1 of",
      "Recording: 10 authenticated GET /feed observation(s): 2 server error(s), 2 without a response, 4 ready response(s), 2 other.",
      "Retrieved before the answer: 14 distinct record(s), 11 of them HTTP observations, each identical to the recorded record.",
      "Server-error evidence: covered",
      "No-response evidence: covered",
      "Recovery evidence: covered",
      "    Retrieved: http-0009, http-0011",
      "Answer interpretation: not assessed by this coverage check",
      "Result: covered.",
    ]) expect(lines.some((value) => value.startsWith(line))).toBe(true);
  });

  it("misses recovery without a success after the last failure, even with earlier successes retrieved", async () => {
    // Stops after the first page: http-0001 and the apparent recovery http-0005 succeeded, but before the last failure.
    const id = await dailyRun(observations("call-1", pick("http-0001", "http-0002", "http-0003", "http-0004", "http-0005", "http-0006"), { nextCursor: "page-2" }));
    const { assessment } = await assess(id);
    expect(assessment.result).toBe("missed");
    expect(statuses(assessment)).toEqual({ server_errors: "covered", no_response: "covered", recovery: "missed" });
    expect(matched(assessment).recovery).toEqual([["http-0002", "http-0003", "http-0004", "http-0006"], []]);
    const lines = describeCoverage(assessment);
    expect(lines).toContain("Recovery evidence: missed");
    expect(lines).toContain("    Missing: none of these acceptable records was retrieved: http-0009, http-0011");
    expect(lines.join("\n")).toContain("Result: missed. Retrieved records do not meet the evidence requirements of: Recovery evidence.");
  });

  it("accepts different valid observations for the same fact", async () => {
    const first = await assess(await dailyRun(observations("call-1", pick("http-0002", "http-0003", "http-0009"))));
    const second = await assess(await dailyRun(observations("call-1", pick("http-0006", "http-0004", "http-0011"))));
    expect([first.assessment.result, second.assessment.result]).toEqual(["covered", "covered"]);
    expect(matched(first.assessment)).toEqual({ server_errors: [["http-0002"]], no_response: [["http-0003"]], recovery: [["http-0002", "http-0003"], ["http-0009"]] });
    expect(matched(second.assessment)).toEqual({ server_errors: [["http-0006"]], no_response: [["http-0004"]], recovery: [["http-0004", "http-0006"], ["http-0011"]] });
  });

  it("does not count a cited record that was never retrieved", async () => {
    const id = await dailyRun(observations("call-1", pick("http-0002", "http-0003")), {
      answer: { ...answer, evidenceIds: ["http-0002", "http-0009", "http-0011"] },
    });
    expect((await runs.getDaily(id)).evidenceReport!.checks.citations.status).toBe("fail");
    const { assessment } = await assess(id);
    expect(statuses(assessment)).toEqual({ server_errors: "covered", no_response: "covered", recovery: "missed" });
  });

  it("misses every fact when a valid trace retrieved nothing", async () => {
    const id = await dailyRun(failedCall("call-1"), { answer: { ...answer, evidenceIds: [] } });
    const { assessment } = await assess(id);
    expect(assessment).toMatchObject({ result: "missed", retrieved: { counted: true, records: 0, matches: [] } });
    expect(statuses(assessment)).toEqual({ server_errors: "missed", no_response: "missed", recovery: "missed" });
  });

  it("can pass with a false conclusion, and says it did not assess the answer", async () => {
    const id = await dailyRun(observations("call-1", feed), {
      answer: { diagnosis: "Every recorded /feed request succeeded; there was no outage.", evidenceIds: ["http-0001"], uncertainty: "None." },
    });
    const { assessment } = await assess(id);
    expect(assessment.result).toBe("covered");
    const text = describeCoverage(assessment).join("\n");
    expect(text).toContain("Answer interpretation: not assessed by this coverage check");
    expect(text).toContain("It does not assess the diagnosis, whether the answer states these facts");
    expect(text).not.toMatch(/correct|accura|%/i);
    expect(JSON.stringify(assessment)).not.toContain("Every recorded /feed request succeeded");
  });
});

describe("investigations that are not assessed", () => {
  it("refuses an unfinished investigation without saving anything", async () => {
    const id = await dailyRun(observations("call-1", feed), { finish: null });
    await expect(assess(id)).rejects.toThrow(`Investigation ${id} has not finished, so it has no integrity fingerprint yet. No coverage assessment was saved`);
    expect(await assessments(id)).toBe(0);
  });

  it("saves a failed investigation as not assessed, with the facts the recording held", async () => {
    const id = await dailyRun(observations("call-1", feed), { finish: "failed" });
    const { assessment } = await assess(id);
    expect(assessment).toMatchObject({ result: "not_assessed", retrieved: { counted: false, records: 0, matches: [] }, investigation: { status: "failed" } });
    expect(assessment.facts.every((fact) => fact.status === "not_assessed" && fact.reason.startsWith("The investigation failed"))).toBe(true);
    const lines = describeCoverage(assessment);
    expect(lines).toContain("Recovery evidence: not assessed");
    expect(lines).toContain("    Acceptable: http-0009, http-0011");
    expect(lines).toContain("Retrieved before the answer: not counted; this investigation cannot be assessed.");
  });

  it("saves an invalid trace as not assessed", async () => {
    const conflicting = { ...recorded["http-0006"], response: { ...(recorded["http-0006"] as Extract<DailyHttpObservation, { outcome: "response" }>).response, status: 200 } };
    const id = await dailyRun([...observations("call-1", pick("http-0006")), ...observations("call-2", [conflicting as DailyCaptureEvidence])], { answer: { ...answer, evidenceIds: [] } });
    const { assessment } = await assess(id);
    expect(assessment.result).toBe("not_assessed");
    expect(assessment.reason).toMatch(/^The evidence trace is invalid: .*Conflicting contents for record ID\(s\): http-0006/);
  });
});

describe("source evidence that cannot produce an assessment", () => {
  it("a simulated run", async () => {
    const { trialId } = await createTrial(pool);
    const id = await runs.create({ trialId, deploymentId: "B", task: "Investigate B.", instructions: "Investigate.", agentConfigSource: "{}" });
    await runs.finish(id, { status: "failed", error: "Stopped." });
    await expect(assess(id)).rejects.toThrow(`Investigation ${id} is a simulated deployment run. Coverage profile daily-feed-availability-v1 assesses recorded Daily capture runs only`);
    const result = await cli("scripts/lab-coverage.ts", [id]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is a simulated deployment run");
    expect(await assessments(id)).toBe(0);
  }, 30_000);

  it("a missing recording, from the CLI too", async () => {
    const id = await dailyRun(observations("call-1", feed));
    await expect(coverage.assess(id, { capturesDir: await capturesDir() })).rejects.toThrow(
      `Coverage needs the recording run ${id} read. Capture ${CAPTURE_ID} is not in the captures directory. No coverage assessment was saved.`);
    // The CLI reads the repository's captures folder, where this fixture's capture never exists.
    const result = await cli("scripts/lab-coverage.ts", [id]);
    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toContain(`Capture ${CAPTURE_ID} is not in the captures directory. No coverage assessment was saved.`);
    expect(await assessments(id)).toBe(0);
  }, 30_000);

  it("a recording changed after the run's access was granted", async () => {
    const changedDir = await capturesDir();
    await writeCapture(changedDir, { captureId: CHANGED_ID, evidence: feedAvailabilityEvidence() });
    const { grant: pinned } = await createCaptureAccess(pool, changedDir).grant(CHANGED_ID);
    const id = await dailyRun(call("call-1", "get_daily_http_observations", { path: "/feed" }, feed, pinned), { source: pinned });
    await appendFile(join(changedDir, CHANGED_ID, "evidence.jsonl"), "\n");
    await expect(coverage.assess(id, { capturesDir: changedDir })).rejects.toThrow(/evidence\.jsonl changed after access was granted\. No coverage assessment was saved/);
    expect(await assessments(id)).toBe(0);
  });

  it.each([
    ["contents that differ from the recorded record", () => [{ ...recorded["http-0009"], elapsedMs: 1 }], /http-0009 differs from the recorded observation/],
    ["an ID the recording does not have", () => [{ ...recorded["http-0009"], id: "http-0099" }], /http-0099 is not in the recording/],
  ])("retrieved %s", async (_name, records, message) => {
    const id = await dailyRun(observations("call-1", [...pick("http-0002"), ...(records() as DailyCaptureEvidence[])]), { answer: { ...answer, evidenceIds: [] } });
    expect((await runs.getDaily(id)).evidenceReport!.checks.toolTrace.status).toBe("pass");
    await expect(assess(id)).rejects.toThrow(message);
    await expect(assess(id)).rejects.toThrow(/No coverage assessment was saved/);
    expect(await assessments(id)).toBe(0);
  });

  it("a run whose saved record no longer matches its fingerprint", async () => {
    const id = await dailyRun(observations("call-1", feed));
    await bypassingTriggers(pool, "lab_investigation_events", () => pool.query(
      `UPDATE lab_investigation_events SET payload = jsonb_set(payload, '{data,result,output,observations,0,elapsedMs}', '1') WHERE run_id = $1 AND payload ->> 'type' = 'action.result'`, [id]));
    await expect(assess(id)).rejects.toThrow(`Investigation ${id} no longer matches its integrity fingerprint`);
    expect(await assessments(id)).toBe(0);
  });
});

describe("saved assessments", () => {
  it("are created once per run and version, including by concurrent commands", async () => {
    const id = await dailyRun(observations("call-1", feed));
    const [a, b] = await Promise.all([assess(id), assess(id)]);
    expect(a.assessment.id).toBe(b.assessment.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    const again = await assess(id);
    expect(again).toEqual({ created: false, assessment: a.assessment });
    expect(await assessments(id)).toBe(1);
  });

  it("reopen unchanged from PostgreSQL alone after the recording disappears", async () => {
    const ownDir = await capturesDir();
    const ownId = "20261031T121000Z-c0ffe3";
    await writeCapture(ownDir, { captureId: ownId, evidence: feedAvailabilityEvidence() });
    const { grant: own } = await createCaptureAccess(pool, ownDir).grant(ownId);
    const id = await dailyRun(call("call-1", "get_daily_http_observations", { path: "/feed" }, pick("http-0002", "http-0003"), own), { source: own });
    const { assessment } = await coverage.assess(id, { capturesDir: ownDir });
    await rm(join(ownDir, ownId), { recursive: true });

    expect(await coverage.get(assessment.id)).toEqual(assessment);
    const json = await cli("packages/lab/src/cli.ts", ["coverage", assessment.id, "--json"]);
    expect(json.code).toBe(1); // missed
    expect(JSON.parse(json.stdout)).toEqual(assessment);
    const text = await cli("packages/lab/src/cli.ts", ["coverage", "latest"]);
    expect(text.stdout.trim()).toBe(describeCoverage(assessment).join("\n"));
    // Repeating the assessment itself now needs the recording, and saves nothing new.
    await expect(coverage.assess(id, { capturesDir: ownDir })).rejects.toThrow(/is not in the captures directory/);
    expect(await assessments(id)).toBe(1);
  }, 30_000);

  it("refuse to return a saved assessment the current rules no longer reproduce", async () => {
    const id = await dailyRun(observations("call-1", feed));
    const { assessment } = await assess(id);
    // As if the rules had changed without a new version: the saved document now differs from a fresh computation.
    await bypassingTriggers(pool, "lab_coverage_assessments", () => pool.query(
      `UPDATE lab_coverage_assessments SET assessment = jsonb_set(assessment, '{reason}', '"Older wording."') WHERE id = $1`, [assessment.id]));
    await expect(assess(id)).rejects.toThrow(`Coverage assessment ${assessment.id} of run ${id} under daily-feed-availability-v1 and coverage-v1 differs from what these rules compute now`);
    expect((await coverage.get(assessment.id)).reason).toBe("Older wording.");
  });

  it("never change, and are removed only with their whole run", async () => {
    const id = await dailyRun(observations("call-1", feed));
    const { assessment } = await assess(id);
    for (const change of ["result = 'missed'", "assessment = assessment", "assessed_at = now()"])
      await expect(pool.query(`UPDATE lab_coverage_assessments SET ${change} WHERE id = $1`, [assessment.id])).rejects.toThrow(/Saved coverage assessments are immutable/);
    await expect(pool.query("DELETE FROM lab_coverage_assessments WHERE id = $1", [assessment.id])).rejects.toThrow(/deleted only with their whole run/);
    await expect(pool.query("TRUNCATE lab_coverage_assessments")).rejects.toThrow(/deleted only with their whole run/);
    await pool.query("DELETE FROM lab_investigation_runs WHERE id = $1", [id]);
    expect(await assessments(id)).toBe(0);
  });

  it("must name the run's verified fingerprint and pinned files, and match their own columns", async () => {
    const id = await dailyRun(observations("call-1", feed));
    const run = await runs.getDaily(id);
    const insert = (columns: { sha?: string; evidence?: string; result?: string }) => pool.query(
      `INSERT INTO lab_coverage_assessments (id, run_id, profile_version, evaluator_version, integrity_version, integrity_sha256, capture_id,
         capture_manifest_sha256, capture_evidence_sha256, capture_controller_sha256, result, assessment)
       VALUES ($1, $2, 'test-profile-v1', 'test-evaluator-v1', 1, $3, $4, $5, $6, $7, $8, $9)`,
      [randomUUID(), id, columns.sha ?? run.integrity.fingerprint!.sha256, CAPTURE_ID, grant.sha256["manifest.json"], columns.evidence ?? grant.sha256["evidence.jsonl"],
        grant.sha256["controller.jsonl"], columns.result ?? "covered", JSON.stringify({
          runId: id, profileVersion: "test-profile-v1", evaluatorVersion: "test-evaluator-v1", result: "covered", captureId: CAPTURE_ID, captureSha256: grant.sha256,
          integrity: { version: 1, sha256: columns.sha ?? run.integrity.fingerprint!.sha256 },
        })]);
    await expect(insert({ sha: "0".repeat(64) })).rejects.toThrow(/verified integrity fingerprint|matches its integrity fingerprint/);
    await expect(insert({ evidence: "0".repeat(64) })).rejects.toThrow(/pinned capture files/);
    await expect(insert({ result: "missed" })).rejects.toThrow(/assessment_matches_columns/);
    await expect(insert({})).resolves.toBeTruthy();
  });
});

it("resolves latest to one run, and is never given to the investigation's reviewer", async () => {
  const id = await dailyRun(observations("call-1", pick("http-0002", "http-0003")));
  const { assessment } = await coverage.assess("latest", { capturesDir: dir });
  expect(assessment.runId).toBe(id);
  let supplied = "";
  const reviewer: ReviewConfig = {
    source: "daily_capture", modelId: "test/reviewer", promptVersion: "test-daily-v1", schemaVersion: 1, system: "Review.",
    settings: { maxOutputTokens: 100, maxRetries: 0, timeoutMs: 1_000, maxInputBytes: 65_536 },
  };
  await reviewSavedRun(pool, id, () => reviewer, async (input) => {
    supplied = JSON.stringify(input);
    throw new Error("No model in this test.");
  });
  expect(supplied).toContain("http-0002");
  for (const hidden of ["http-0009", "http-0011", "daily-feed-availability", "acceptable", "Recovery evidence"]) expect(supplied).not.toContain(hidden);
});
