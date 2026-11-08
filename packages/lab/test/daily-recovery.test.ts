import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dailyAvailabilityAnswerSchema } from "@agent-lab/contracts/daily-availability";
import { readDailyAvailabilityEvidence, readDailyEvidence } from "../src/daily-evaluate";
import type { DailyCaptureRecords } from "../src/daily-evidence";
import {
  dailyTurnStatus,
  evaluateDailyRecovery,
  readCaseRecording,
  recordedAvailability,
  turnUsage,
  type DailyRecoveryCase,
} from "../src/daily-recovery";
import { capturesDir, feedAvailabilityEvidence, observation, writeCapture } from "./daily-capture-fixture";

// daily-recovery-v1 over hand-written events and a labeled synthetic
// recording (daily-capture-fixture.ts). In feedAvailabilityEvidence's
// recording, the authenticated /feed failures are http-0002 (500), http-0003
// (timeout), http-0004 (network error), and http-0006 (503, the last, ending
// at 05:02:00.250Z); http-0001 and http-0005 are earlier successes; http-0008
// is truncated; http-0009 and http-0011 are the recovery.

const captureId = "20261107T090000Z-5e5e5e";
const sha256 = { "manifest.json": "a".repeat(64), "evidence.jsonl": "e".repeat(64), "controller.jsonl": "c".repeat(64) };
const evalCase: DailyRecoveryCase = {
  id: "daily/recovery",
  recording: "SYNTHETIC test recording",
  captureId,
  captureSha256: sha256,
  expected: { availability: "recovered" },
};

function recordingOf(evidence = feedAvailabilityEvidence()): DailyCaptureRecords {
  return {
    captureId,
    sha256,
    observations: evidence.filter((record) => record.kind === "http"),
    logs: evidence.filter((record) => record.kind === "log"),
  };
}
const recording = recordingOf();
const byId = (id: string) => [...recording.observations, ...recording.logs].find((record) => record.id === id)!;

const turn = { turnId: "turn_0", sequence: 0, stepIndex: 0 };
let ids = 0;
const event = (type: string, data: object = {}) => ({ type, meta: { id: `event-${++ids}`, at: "2026-11-07T00:00:00.000Z" }, data: { ...turn, ...data } });
const request = (callId: string, toolName: string, input: object = {}) =>
  event("actions.requested", { actions: [{ kind: "tool-call", toolName, callId, input }] });
const page = (callId: string, records: object[], extra: object = {}) =>
  event("action.result", {
    status: "completed",
    result: {
      kind: "tool-result",
      toolName: "get_daily_http_observations",
      callId,
      output: { captureId, evidenceSha256: sha256["evidence.jsonl"], observations: records, oversized: [], nextCursor: null, ...extra },
    },
  });
const logPage = (callId: string, records: object[]) =>
  event("action.result", {
    status: "completed",
    result: {
      kind: "tool-result",
      toolName: "get_daily_logs",
      callId,
      output: { captureId, evidenceSha256: sha256["evidence.jsonl"], logs: records, oversized: [], nextCursor: null },
    },
  });
const feed = () => recording.observations.filter((record) => record.path === "/feed");
/** One call that read every /feed observation. */
const retrieval = () => [request("call-1", "get_daily_http_observations", { path: "/feed" }), page("call-1", feed())];
const ending = (answer: object) => [
  event("result.completed", { result: answer }),
  event("turn.completed"),
  event("session.waiting", { usage: { inputTokens: 1_000, outputTokens: 50, costUsd: 0.0012 } }),
];

const answerOf = (state: string, failure: string[], recovery: string[], evidenceIds = [...new Set([...failure, ...recovery])]) => ({
  diagnosis: "Feed requests failed while the database was unavailable, then recovered.",
  evidenceIds,
  uncertainty: "The recording does not show why the database was unavailable.",
  availability: { state, failureEvidenceIds: failure, recoveryEvidenceIds: recovery },
});

const versionThreeOf = ({ diagnosis, evidenceIds, uncertainty }: ReturnType<typeof answerOf>) => ({ diagnosis, evidenceIds, uncertainty });

function evaluate(answer: object | undefined, events: object[] = retrieval(), recorded = recording) {
  return evaluateDailyRecovery({
    sessionId: "wrun_test",
    case: evalCase,
    recording: recorded,
    events: answer ? [event("session.started"), event("turn.started"), ...events, ...ending(answer)] : events,
    answer,
  });
}

const statuses = (evaluation: ReturnType<typeof evaluate>) => ({
  turn: evaluation.turn.status,
  evidence: evaluation.evidence.status,
  outcome: evaluation.outcome.status,
  coverage: evaluation.coverage.result,
});

describe("the recording's expected availability", () => {
  it("comes from authenticated /feed observations: failures, then a ready response to a request started after the last failure ended", () => {
    const expected = recordedAvailability(recording.observations);
    expect(expected).toMatchObject({
      state: "recovered",
      failureIds: ["http-0002", "http-0003", "http-0004", "http-0006"],
      laterSuccessIds: ["http-0009", "http-0011"],
      lastFailureEndedAt: "2026-10-22T05:02:00.250Z",
    });
    expect(recordedAvailability(recording.observations.filter((record) => record.id !== "http-0009" && record.id !== "http-0011")).state).toBe("failing");
    expect(recordedAvailability([observation(1, 200)]).state).toBe("healthy");
    expect(recordedAvailability([]).state).toBe("unknown");
  });

  it("refuses a case whose expectation or recording does not match", () => {
    expect(() => evaluateDailyRecovery({ sessionId: "s", case: { ...evalCase, expected: { availability: "failing" } }, recording, events: [], answer: undefined })).toThrow(
      /expects failing, but its recording establishes recovered/,
    );
    expect(() => evaluateDailyRecovery({ sessionId: "s", case: { ...evalCase, captureSha256: { ...sha256, "controller.jsonl": "d".repeat(64) } }, recording, events: [], answer: undefined })).toThrow(
      /not case daily\/recovery's pinned capture/,
    );
  });
});

describe("daily-recovery-v1", () => {
  it("passes a recovered answer citing a received failure and a later received ready response", () => {
    const evaluation = evaluate(answerOf("recovered", ["http-0002", "http-0003"], ["http-0009"]));
    expect(statuses(evaluation)).toEqual({ turn: "completed", evidence: "pass", outcome: "pass", coverage: "covered" });
    expect(evaluation.outcome).toMatchObject({ expected: "recovered", answered: "recovered", failureCitations: { counted: ["http-0002", "http-0003"], notCounted: [] } });
    expect(evaluation.notAssessed.map((item) => item.id)).toEqual(["root_cause", "explanation"]);
  });

  it.each([
    ["a timeout and the last recovery", ["http-0003"], ["http-0011"]],
    ["a network error and both recoveries", ["http-0004"], ["http-0009", "http-0011"]],
    ["the last failure", ["http-0006"], ["http-0009"]],
  ])("accepts any qualifying citations: %s", (_name, failure, recovery) => {
    expect(statuses(evaluate(answerOf("recovered", failure, recovery)))).toMatchObject({ evidence: "pass", outcome: "pass" });
  });

  it.each([
    ["still failing", answerOf("failing", ["http-0002"], []), /availability state is failing; the recording establishes recovered/],
    ["healthy throughout", answerOf("healthy", [], ["http-0011"]), /availability state is healthy[^]*No cited failure qualifies/],
    ["an unsupported abstention", answerOf("unknown", [], [], []), /availability state is unknown[^]*No cited failure qualifies[^]*No cited recovery qualifies/],
  ])("fails %s", (_name, answer, reason) => {
    const evaluation = evaluate(answer);
    expect(evaluation.outcome.status).toBe("fail");
    expect(evaluation.outcome.reason).toMatch(reason);
  });

  it("does not count an early success, a truncated response, a log line, or a failure as recovery", () => {
    const evaluation = evaluate(
      answerOf("recovered", ["http-0002", "log-api-0001"], ["http-0001", "http-0005", "http-0008", "http-0002", "log-api-0003"]),
      [...retrieval(), request("call-2", "get_daily_logs"), logPage("call-2", recording.logs)],
    );
    expect(evaluation.evidence.status).toBe("pass");
    expect(evaluation.outcome.status).toBe("fail");
    expect(evaluation.outcome.reason).toContain("No cited recovery qualifies");
    expect(evaluation.outcome.recoveryCitations?.notCounted).toEqual([
      { id: "http-0001", reason: "it is a ready response to a request that started before the recording's last failure ended at 2026-10-22T05:02:00.250Z" },
      { id: "http-0005", reason: "it is a ready response to a request that started before the recording's last failure ended at 2026-10-22T05:02:00.250Z" },
      { id: "http-0008", reason: "it is not a ready authenticated GET /feed response" },
      { id: "http-0002", reason: "it is a failed request" },
      { id: "log-api-0003", reason: "it is not an HTTP observation of the recording" },
    ]);
    expect(evaluation.outcome.failureCitations).toEqual({
      counted: ["http-0002"],
      notCounted: [{ id: "log-api-0001", reason: "it is not an HTTP observation of the recording" }],
    });
  });

  it("does not count a ready response to a request that overlapped the last failure", () => {
    // http-0005 starts at second 50 and takes 20 s, so it ends after
    // http-0006's timeout (seconds 60-65) ended; only http-0007 starts later.
    const overlapping = [
      observation(1, 500),
      observation(5, 200, { durationMs: 20_000 }),
      observation(6, "timeout", { durationMs: 5_000 }),
      observation(7, 200),
    ];
    const recorded = recordingOf(overlapping);
    const events = [request("call-1", "get_daily_http_observations"), page("call-1", overlapping)];
    const overlap = evaluate(answerOf("recovered", ["http-0006"], ["http-0005"]), events, recorded);
    expect(overlap.outcome.status).toBe("fail");
    expect(overlap.outcome.recoveryCitations?.notCounted[0].reason).toContain("started before the recording's last failure ended at 2026-10-22T05:02:05.000Z");
    expect(evaluate(answerOf("recovered", ["http-0006"], ["http-0007"]), events, recorded).outcome.status).toBe("pass");
  });

  it.each([
    ["an invented ID", answerOf("recovered", ["http-9999"], ["http-0009"]), /evidenceIds: Cited IDs that no successful Daily tool result returned: http-9999/],
    ["a recorded but unreceived ID", answerOf("recovered", ["http-0006"], ["http-0010"]), /no successful Daily tool result returned: http-0010/],
    ["a role citation missing from evidenceIds", answerOf("recovered", ["http-0002"], ["http-0009"], ["http-0002"]), /Role-specific citations missing from evidenceIds: http-0009/],
  ])("fails the evidence checks for %s", (_name, answer, reason) => {
    const evaluation = evaluate(answer);
    expect(evaluation.evidence.status).toBe("fail");
    expect(evaluation.evidence.reason).toMatch(reason);
  });

  it("fails an ID listed only as oversized; its contents were never received", () => {
    const events = [request("call-1", "get_daily_http_observations", { path: "/feed" }), page("call-1", feed().filter((record) => record.id !== "http-0009"), { oversized: [{ id: "http-0009", bytes: 70_000 }] })];
    const evaluation = evaluate(answerOf("recovered", ["http-0002"], ["http-0009"]), events);
    expect(evaluation.evidence.reason).toContain("listed only as oversized, so their contents were never returned: http-0009");
    expect(evaluation.outcome.status).toBe("fail");
    expect(evaluation.outcome.recoveryCitations?.notCounted).toEqual([{ id: "http-0009", reason: "it was listed only as oversized, so its contents were never returned" }]);
  });

  it("fails a received record whose contents differ from the pinned recording, and does not count it toward coverage", () => {
    const altered = feed().map((record) => (record.id === "http-0009" ? { ...record, elapsedMs: 1 } : record));
    const evaluation = evaluate(answerOf("recovered", ["http-0002"], ["http-0009"]), [request("call-1", "get_daily_http_observations", { path: "/feed" }), page("call-1", altered)]);
    expect(evaluation.evidence.status).toBe("fail");
    expect(evaluation.evidence.reason).toContain("http-0009 differs from the recorded observation");
    expect(evaluation.coverage.result).toBe("not_assessed");
    const unknown = evaluate(answerOf("recovered", ["http-0002"], ["http-0009"]), [...retrieval(), request("call-2", "get_daily_http_observations", { path: "/feed" }), page("call-2", [observation(99, 200)])]);
    expect(unknown.evidence.reason).toContain("http-0099 is not in the recording");
  });

  it.each([
    ["another capture", { captureId: "20261022T050320Z-ad558c" }],
    ["another evidence file", { evidenceSha256: "f".repeat(64) }],
  ])("fails evidence from %s", (_name, other) => {
    const evaluation = evaluate(answerOf("recovered", ["http-0002"], ["http-0009"]), [request("call-1", "get_daily_http_observations", { path: "/feed" }), page("call-1", feed(), other)]);
    expect(evaluation.evidence.status).toBe("fail");
    expect(evaluation.evidence.reason).toContain("not this run's");
    expect(evaluation.outcome.status).toBe("fail");
    expect(evaluation.coverage.result).toBe("not_assessed");
  });

  it("keeps identical overlapping pages valid and fails conflicting copies of a record", () => {
    const answer = answerOf("recovered", ["http-0002"], ["http-0009"]);
    const twice = [...retrieval(), request("call-2", "get_daily_http_observations"), page("call-2", recording.observations)];
    expect(statuses(evaluate(answer, twice))).toMatchObject({ evidence: "pass", outcome: "pass", coverage: "covered" });
    const conflicting = [...retrieval(), request("call-2", "get_daily_http_observations"), page("call-2", [{ ...byId("http-0002"), elapsedMs: 1 }])];
    const evaluation = evaluate(answer, conflicting);
    expect(evaluation.evidence.status).toBe("fail");
    expect(evaluation.evidence.reason).toContain("Conflicting contents for record ID(s): http-0002");
    expect(evaluation.outcome.failureCitations?.notCounted).toEqual([{ id: "http-0002", reason: "its returned contents conflict" }]);
  });

  it("does not count records returned after the answer", () => {
    const answer = answerOf("recovered", ["http-0002"], ["http-0009"]);
    const evaluation = evaluateDailyRecovery({
      sessionId: "wrun_test",
      case: evalCase,
      recording,
      events: [request("call-1", "get_daily_http_observations", { path: "/feed" }), page("call-1", feed().slice(0, 4)), ...ending(answer), request("call-2", "get_daily_http_observations", { path: "/feed" }), page("call-2", feed())],
      answer,
    });
    expect(evaluation.evidence.reason).toContain("no successful Daily tool result returned: http-0009");
    expect(evaluation.outcome.status).toBe("fail");
  });

  it("fails an answer that differs from the last recorded structured result", () => {
    const recorded = answerOf("failing", ["http-0002"], []);
    const evaluation = evaluateDailyRecovery({
      sessionId: "wrun_test",
      case: evalCase,
      recording,
      events: [...retrieval(), ...ending(recorded)],
      answer: answerOf("recovered", ["http-0002"], ["http-0009"]),
    });
    expect(evaluation.evidence).toMatchObject({ status: "fail", reason: "The saved answer does not match the last recorded structured result in the trace." });
    expect(evaluation.outcome.status).toBe("not_evaluated");
  });

  it.each([
    ["missing output", [event("turn.started"), ...retrieval(), event("turn.completed"), event("session.waiting")], "incomplete", "The turn completed without a structured result."],
    ["a failed execution", [event("turn.started"), ...retrieval(), event("step.failed", { code: "OUTPUT_SCHEMA_NOT_FULFILLED", message: "No result." }), event("turn.failed", { code: "OUTPUT_SCHEMA_NOT_FULFILLED", message: "No result." }), event("session.waiting")], "failed", "OUTPUT_SCHEMA_NOT_FULFILLED"],
    ["a usage limit", [event("turn.started"), ...retrieval(), event("input.requested", { requests: [{ kind: "session-limit" }] }), event("turn.completed"), event("session.waiting")], "waiting_for_input", "session-limit"],
    ["a timeout's cancellation", [event("turn.started"), ...retrieval(), event("turn.cancelled"), event("session.waiting")], "cancelled", "cancelled"],
    ["a stream that ended early", [event("turn.started"), ...retrieval()], "incomplete", "without turn.completed"],
  ])("cannot pass %s, even with a correct answer to hand", (_name, events, status, reason) => {
    const evaluation = evaluateDailyRecovery({ sessionId: "s", case: evalCase, recording, events, answer: answerOf("recovered", ["http-0002"], ["http-0009"]) });
    expect(evaluation.turn.status).toBe(status);
    expect(evaluation.turn.reason).toContain(reason);
    expect(statuses(evaluation)).toMatchObject({ evidence: "not_evaluated", outcome: "not_evaluated", coverage: "not_assessed" });
  });

  it("reports coverage separately: a correct answer can pass while missing a fact's evidence", () => {
    const events = [request("call-1", "get_daily_http_observations", { path: "/feed" }), page("call-1", [byId("http-0002"), byId("http-0009")])];
    const evaluation = evaluate(answerOf("recovered", ["http-0002"], ["http-0009"]), events);
    expect(statuses(evaluation)).toMatchObject({ evidence: "pass", outcome: "pass", coverage: "missed" });
    expect(evaluation.coverage.facts.map((fact) => [fact.id, fact.status])).toEqual([
      ["server_errors", "covered"],
      ["no_response", "missed"],
      ["recovery", "covered"],
    ]);
  });
});

describe("answer schemas", () => {
  it("adds the availability answer to the three version-three fields, strictly", () => {
    const answer = answerOf("recovered", ["http-0002"], ["http-0009"]);
    expect(dailyAvailabilityAnswerSchema.parse(answer)).toEqual(answer);
    expect(dailyAvailabilityAnswerSchema.safeParse({ ...answer, extra: true }).success).toBe(false);
    expect(dailyAvailabilityAnswerSchema.safeParse({ ...answer, availability: { ...answer.availability, state: "degraded" } }).success).toBe(false);
    expect(dailyAvailabilityAnswerSchema.safeParse(versionThreeOf(answer)).success).toBe(false);
  });

  it("keeps saved runs on strict version three: the extended answer is not a version-three answer", () => {
    const answer = answerOf("recovered", ["http-0002"], ["http-0009"]);
    const run = { id: "r", captureId, evidenceSha256: sha256["evidence.jsonl"], status: "completed", answer, events: [...retrieval(), ...ending(answer)] };
    expect(readDailyEvidence(run).report.checks.answer).toEqual({ status: "fail", reason: "The saved answer is missing or does not match the Daily answer schema." });
    expect(readDailyAvailabilityEvidence(run).report.checks.answer.status).toBe("pass");
    const versionThree = versionThreeOf(answer);
    const v3 = { ...run, answer: versionThree, events: [...retrieval(), ...ending(versionThree)] };
    expect(readDailyEvidence(v3).report.checks.citations.status).toBe("pass");
    expect(readDailyAvailabilityEvidence(v3).report.checks.answer.reason).toBe("The saved answer is missing or does not match the Daily availability answer schema.");
    // The same events yield the same received records and trace checks under either schema.
    const [v3Read, availabilityRead] = [readDailyEvidence(run), readDailyAvailabilityEvidence(run)];
    expect(availabilityRead.records).toEqual(v3Read.records);
    expect(availabilityRead.report.retrievedEvidence).toEqual(v3Read.report.retrievedEvidence);
    expect(availabilityRead.report.checks.toolTrace).toEqual(v3Read.report.checks.toolTrace);
    expect(availabilityRead.report.checks.retrieval).toEqual(v3Read.report.checks.retrieval);
  });
});

describe("turn status and usage", () => {
  it("treats a session waiting for the next message as the normal end of a completed turn", () => {
    expect(dailyTurnStatus([event("turn.started"), event("result.completed", { result: {} }), event("turn.completed"), event("session.waiting")])).toEqual({
      status: "completed",
      reason: "The turn completed with a structured result.",
    });
  });

  it("reports tokens, cost, models, and tool calls from the events, and unavailable cost as unavailable", () => {
    const events = [
      event("step.started", { modelId: "openai/gpt-6-luna-fast" }),
      request("call-1", "get_daily_http_observations"),
      request("call-2", "get_daily_logs"),
      event("step.completed", { providerMetadata: { gateway: { generationId: "gen_1" } } }),
      event("step.started", { modelId: "openai/gpt-6-luna-fast" }),
      event("session.waiting", { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0001 } }),
    ];
    expect(turnUsage(events)).toEqual({
      modelSteps: 2,
      observedModels: ["openai/gpt-6-luna-fast"],
      gatewayGenerationIds: ["gen_1"],
      toolCalls: { total: 2, byTool: { get_daily_http_observations: 1, get_daily_logs: 1 } },
      tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.0001,
    });
    expect(turnUsage([event("session.waiting", { usage: { inputTokens: 10, outputTokens: 2 } })])).toMatchObject({ costUsd: "unavailable", tokens: { cacheRead: "unavailable" } });
    expect(turnUsage([])).toMatchObject({ tokens: "unavailable", costUsd: "unavailable" });
  });
});

describe("the case's recording", () => {
  it("is read only when every file matches the case's pinned SHA-256", async () => {
    const dir = await capturesDir();
    await writeCapture(dir, { captureId, evidence: feedAvailabilityEvidence() });
    const read = await readDailyCaptureHashes(dir);
    await expect(readCaseRecording(dir, { ...evalCase, captureSha256: read })).resolves.toMatchObject({ captureId, sha256: read });
    await expect(readCaseRecording(dir, { ...evalCase, captureSha256: { ...read, "controller.jsonl": "0".repeat(64) } })).rejects.toThrow(
      "Capture 20261107T090000Z-5e5e5e: controller.jsonl differ from the SHA-256 that case daily/recovery pins.",
    );
    await expect(readCaseRecording(await capturesDir(), evalCase)).rejects.toThrow("is not in the captures directory");
  });
});

async function readDailyCaptureHashes(dir: string) {
  const file = async (name: string) => createHash("sha256").update(await readFile(join(dir, captureId, name))).digest("hex");
  return { "manifest.json": await file("manifest.json"), "evidence.jsonl": await file("evidence.jsonl"), "controller.jsonl": await file("controller.jsonl") };
}
