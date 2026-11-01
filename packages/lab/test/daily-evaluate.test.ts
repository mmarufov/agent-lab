import { describe, expect, it } from "vitest";
import { evaluateDailyRun } from "../src/daily-evaluate";
import { http, log } from "./daily-capture-fixture";

// daily-evidence-v1 over hand-written event records. Only the saved events
// decide what counts as received; nothing is read from files or a database.

const source = { captureId: "20261022T050138Z-39b307", evidenceSha256: "e".repeat(64) };
const turn = { turnId: "turn_0", sequence: 0, stepIndex: 0 };
let ids = 0;
const event = (type: string, data: object, turnId = turn.turnId) => ({
  type,
  meta: { id: `event-${++ids}`, at: "2026-10-30T00:00:00.000Z" },
  data: { ...turn, turnId, ...data },
});
const request = (callId: string, toolName: string, input: object = {}, turnId?: string) =>
  event("actions.requested", { actions: [{ kind: "tool-call", toolName, callId, input }] }, turnId);
const logs = (callId: string, records: ReturnType<typeof log>[], extra: object = {}, turnId?: string) =>
  event("action.result", {
    status: "completed",
    result: { kind: "tool-result", toolName: "get_daily_logs", callId, output: { ...source, logs: records, oversized: [], nextCursor: null, ...extra } },
  }, turnId);
const observations = (callId: string, records: ReturnType<typeof http>[]) =>
  event("action.result", {
    status: "completed",
    result: { kind: "tool-result", toolName: "get_daily_http_observations", callId, output: { ...source, observations: records, oversized: [], nextCursor: null } },
  });
const answer = (evidenceIds: string[]) => ({ diagnosis: "Requests failed.", evidenceIds, uncertainty: "The cause is not established." });
const result = (value: object) => event("result.completed", { result: value });

const failure = http(5, "/feed", 500, { detail: "Internal server error" });
const shutdown = log(3, "psycopg.errors.AdminShutdown: terminating connection due to administrator command");
const evidence = () => [request("call-1", "get_daily_http_observations", { path: "/feed" }), observations("call-1", [failure]), request("call-2", "get_daily_logs"), logs("call-2", [shutdown])];

function evaluate(events: object[], cited: string[] | null, status = "completed") {
  const final = cited ? answer(cited) : null;
  return evaluateDailyRun({ id: "run", ...source, status, answer: final, events: final ? [...events, result(final)] : events });
}

describe("daily-evidence-v1", () => {
  it("passes citations of records successful calls returned before the answer, and never assesses the diagnosis", () => {
    const report = evaluate(evidence(), ["http-0005", "log-api-0003"]);
    expect(Object.fromEntries(Object.entries(report.checks).map(([name, check]) => [name, check.status]))).toEqual({
      execution: "pass", answer: "pass", toolTrace: "pass", retrieval: "pass", citations: "pass",
    });
    expect(report.retrievedEvidence).toEqual([
      { id: "http-0005", kind: "http", toolName: "get_daily_http_observations", callId: "call-1", requestEventId: expect.any(String), resultEventId: expect.any(String) },
      { id: "log-api-0003", kind: "log", toolName: "get_daily_logs", callId: "call-2", requestEventId: expect.any(String), resultEventId: expect.any(String) },
    ]);
    expect(report.diagnosisAssessment.status).toBe("not_evaluated");
  });

  it("rejects invented citations and IDs listed only as oversized", () => {
    const events = [...evidence(), request("call-3", "get_daily_logs", { messageContains: "error" }), logs("call-3", [], { oversized: [{ id: "log-api-0099", bytes: 70_000 }] })];
    const report = evaluate(events, ["log-api-0003", "log-api-0099", "http-0001"]);
    expect(report.checks.citations.status).toBe("fail");
    expect(report.checks.citations.reason).toContain("no successful Daily tool result returned: http-0001");
    expect(report.checks.citations.reason).toContain("listed only as oversized, so their contents were never returned: log-api-0099");
    expect(report).toMatchObject({ missingEvidenceIds: ["log-api-0099", "http-0001"], oversizedOnlyEvidenceIds: ["log-api-0099"] });
  });

  it("treats an empty citation list as unassessed, not evidence-backed", () => {
    const report = evaluate(evidence(), []);
    expect(report.checks.citations).toEqual({ status: "not_evaluated", reason: "No evidence IDs were cited; this does not establish that the diagnosis is supported." });
  });

  it("rejects a record whose returned contents conflict between calls", () => {
    const events = [...evidence(), request("call-3", "get_daily_logs", { messageContains: "admin" }), logs("call-3", [{ ...shutdown, message: "AdminShutdown, rewritten" }])];
    const report = evaluate(events, ["log-api-0003"]);
    expect(report.ambiguousEvidenceIds).toEqual(["log-api-0003"]);
    expect(report.checks.toolTrace.status).toBe("fail");
    expect(report.checks.citations.reason).toContain("conflicting returned contents: log-api-0003");
  });

  it.each([
    ["another capture", { captureId: "20261022T050320Z-ad558c" }],
    ["another evidence file", { evidenceSha256: "f".repeat(64) }],
  ])("refuses records from %s", (_name, other) => {
    const report = evaluate([request("call-1", "get_daily_logs"), logs("call-1", [shutdown], other)], ["log-api-0003"]);
    expect(report.checks.toolTrace.status).toBe("fail");
    expect(report.checks.toolTrace.reason).toContain("not this run's");
    expect(report.checks.retrieval.status).toBe("fail");
    expect(report.missingEvidenceIds).toEqual(["log-api-0003"]);
  });

  it("refuses schema-invalid results and records outside the requested filters", () => {
    const invalid = evaluate([request("call-1", "get_daily_logs"), logs("call-1", [{ ...shutdown, id: "not-a-log-id" }])], []);
    expect(invalid.checks.toolTrace.reason).toContain("invalid get_daily_logs input or result");
    const filtered = evaluate([request("call-1", "get_daily_logs", { service: "daily-gateway" }), logs("call-1", [shutdown])], ["log-api-0003"]);
    expect(filtered.checks.toolTrace.reason).toContain("returned lines outside its filters");
    expect(filtered.checks.citations.status).toBe("fail");
  });

  it("counts only records returned before the final answer, in the answer's turn", () => {
    const final = answer(["log-api-0003", "log-api-0004"]);
    const late = [request("call-9", "get_daily_logs"), logs("call-9", [log(4, "after the answer")])];
    const otherTurn = [request("call-1", "get_daily_logs", {}, "turn_1"), logs("call-1", [log(4, "another turn")], {}, "turn_1")];
    const report = evaluateDailyRun({ id: "run", ...source, status: "completed", answer: final, events: [...evidence(), ...otherTurn, result(final), ...late] });
    expect(report.retrievedEvidence.map((record) => record.id)).toEqual(["http-0005", "log-api-0003"]);
    expect(report.missingEvidenceIds).toEqual(["log-api-0004"]);
  });

  it("pairs results with requests by turn and call ID", () => {
    const report = evaluate([logs("call-1", [shutdown])], ["log-api-0003"]);
    expect(report.checks.toolTrace.reason).toContain("no preceding request for call call-1");
    expect(report.checks.retrieval.status).toBe("fail");
  });

  it("keeps a failed call out of the evidence without calling the trace invalid", () => {
    const failed = event("action.result", {
      status: "failed",
      error: { code: "TOOL_ERROR", message: "get_daily_logs received HTTP 500 from the lab service." },
      result: { kind: "tool-result", toolName: "get_daily_logs", callId: "call-3", isError: true, output: "HTTP 500" },
    });
    const report = evaluate([...evidence(), request("call-3", "get_daily_logs", { limit: 5 }), failed], ["log-api-0003"]);
    expect(report.checks.toolTrace.status).toBe("pass");
    expect(report.checks.retrieval.reason).toContain("1 call(s) failed");
  });

  it("flags any tool other than the two Daily evidence tools", () => {
    const report = evaluate([...evidence(), request("call-3", "bash", { command: "env" })], ["log-api-0003"]);
    expect(report.checks.toolTrace).toEqual({ status: "fail", reason: expect.stringContaining("bash is not a Daily evidence tool") });
  });

  it("does not assess citations of a mismatched or unfinished answer", () => {
    const mismatched = evaluateDailyRun({ id: "run", ...source, status: "completed", answer: answer(["log-api-0003"]), events: [...evidence(), result(answer(["http-0005"]))] });
    expect(mismatched.checks.answer.status).toBe("fail");
    expect(mismatched.checks.citations.status).toBe("not_evaluated");
    const running = evaluate(evidence(), null, "running");
    expect(running.checks).toMatchObject({ execution: { status: "not_evaluated" }, answer: { status: "not_evaluated" }, retrieval: { status: "pass" } });
  });
});
