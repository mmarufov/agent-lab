import { describe, expect, it } from "vitest";
import { compareTimestamps, dailyReviewInputSchema, orderDailyRecords } from "@agent-lab/contracts/daily-review";
import { evaluateDailyRun, readDailyEvidence } from "../src/daily-evaluate";
import { http, log } from "./daily-capture-fixture";

// The records a Daily reviewer receives come from the same pass over the saved
// events as the evidence report. Hand-written events only: no files or database.

const source = { captureId: "20261022T050138Z-39b307", evidenceSha256: "e".repeat(64) };
const turn = { turnId: "turn_0", sequence: 0, stepIndex: 0 };
let ids = 0;
const event = (type: string, data: object) => ({ type, meta: { id: `event-${++ids}`, at: "2026-10-30T00:00:00.000Z" }, data: { ...turn, ...data } });
const request = (callId: string, toolName: string, input: object = {}) =>
  event("actions.requested", { actions: [{ kind: "tool-call", toolName, callId, input }] });
const page = (callId: string, toolName: string, records: object[], extra: object = {}) =>
  event("action.result", {
    status: "completed",
    result: {
      kind: "tool-result", toolName, callId,
      output: { ...source, [toolName === "get_daily_logs" ? "logs" : "observations"]: records, oversized: [], nextCursor: null, ...extra },
    },
  });
const answer = { diagnosis: "/feed failed, then recovered.", evidenceIds: ["http-0005"], uncertainty: "The cause is not established." };
const run = (events: object[], status = "completed") =>
  ({ id: "run", ...source, status, answer, events: [...events, event("result.completed", { result: answer })] });

const ok = http(2, "/feed", 200);
const failure = http(5, "/feed", 500, { detail: "Internal server error" });
const timeout = http(7, "/healthz", "timeout");
const shutdown = log(3, "psycopg.errors.AdminShutdown: terminating connection due to administrator command");
const untimed = { ...log(6, 'INFO:     172.21.0.4:2 - "GET /feed HTTP/1.1" 200 OK'), timestamp: null };

describe("records shared by the evidence report and the review", () => {
  it("keeps every distinct record received, cited or not, once, with its complete contents", () => {
    const events = [
      request("call-1", "get_daily_http_observations", { path: "/feed", limit: 2 }), page("call-1", "get_daily_http_observations", [ok, failure], { nextCursor: "next" }),
      // An overlapping page and a repeated call return the same records again.
      request("call-2", "get_daily_http_observations", { limit: 3 }), page("call-2", "get_daily_http_observations", [failure, timeout]),
      request("call-3", "get_daily_logs"), page("call-3", "get_daily_logs", [untimed, shutdown]),
      request("call-4", "get_daily_logs"), page("call-4", "get_daily_logs", [untimed, shutdown]),
    ];
    const { report, records } = readDailyEvidence(run(events));
    expect(report).toEqual(evaluateDailyRun(run(events)));
    expect(report.checks.toolTrace.status).toBe("pass");
    expect(report.retrievedEvidence.map((record) => record.id)).toEqual([
      "http-0002", "http-0005", "http-0005", "http-0007", "log-api-0006", "log-api-0003", "log-api-0006", "log-api-0003",
    ]);
    // First-received order; only http-0005 was cited.
    expect(records).toEqual([ok, failure, timeout, untimed, shutdown]);
  });

  it("orders timed records by time across both kinds and keeps untimed log lines apart", () => {
    const { records } = readDailyEvidence(run([
      request("call-1", "get_daily_logs"), page("call-1", "get_daily_logs", [untimed, shutdown]),
      request("call-2", "get_daily_http_observations"), page("call-2", "get_daily_http_observations", [timeout, failure, ok]),
    ]));
    const ordered = orderDailyRecords(records);
    // log-api-0003 was received at 05:01:03.000123456, after http-0002 (05:01:02.000) and before http-0005 (05:01:05.000).
    expect(ordered.evidence.map((record) => record.id)).toEqual(["http-0002", "log-api-0003", "http-0005", "http-0007"]);
    expect(ordered.untimedEvidence).toEqual([untimed]);
  });

  it("leaves out failed calls, records after the answer, and results from another recording", () => {
    const failed = event("action.result", {
      status: "failed",
      error: { code: "TOOL_ERROR", message: "FAILED CALL DETAIL" },
      result: { kind: "tool-result", toolName: "get_daily_logs", callId: "call-2", isError: true, output: "FAILED CALL DETAIL" },
    });
    const events = [
      request("call-1", "get_daily_http_observations"), page("call-1", "get_daily_http_observations", [failure]),
      request("call-2", "get_daily_logs"), failed,
    ];
    const late = [request("call-9", "get_daily_logs"), page("call-9", "get_daily_logs", [shutdown])];
    const answered = run(events);
    const { report, records } = readDailyEvidence({ ...answered, events: [...answered.events, ...late] });
    expect(records).toEqual([failure]);
    expect(JSON.stringify(records)).not.toContain("FAILED CALL DETAIL");
    expect(report.checks.toolTrace.status).toBe("pass");

    const other = readDailyEvidence(run([request("call-1", "get_daily_logs"), page("call-1", "get_daily_logs", [shutdown], { evidenceSha256: "f".repeat(64) })]));
    expect(other.records).toEqual([]);
    expect(other.report.checks.toolTrace.status).toBe("fail");
  });

  it("names a record returned with conflicting contents and fails the trace", () => {
    const { report } = readDailyEvidence(run([
      request("call-1", "get_daily_logs"), page("call-1", "get_daily_logs", [shutdown]),
      request("call-2", "get_daily_logs"), page("call-2", "get_daily_logs", [{ ...shutdown, message: "rewritten" }]),
    ]));
    expect(report.ambiguousEvidenceIds).toEqual(["log-api-0003"]);
    expect(report.checks.toolTrace.status).toBe("fail");
  });
});

describe("timestamps", () => {
  it.each([
    ["2026-10-22T05:01:39.086Z", "2026-10-22T05:01:39.092182508Z", -1],
    // Docker trims trailing zeros: .09 is earlier than .0921 although its text sorts later.
    ["2026-10-22T05:01:39.09Z", "2026-10-22T05:01:39.0921Z", -1],
    ["2026-10-22T05:01:39.1Z", "2026-10-22T05:01:39.100000000Z", 0],
    ["2026-10-22T05:01:39Z", "2026-10-22T05:01:39.000000001Z", -1],
    ["2026-10-22T07:01:39.5+02:00", "2026-10-22T05:01:39.4Z", 1],
  ])("compares %s with %s exactly", (a, b, sign) => {
    expect(Math.sign(compareTimestamps(a, b))).toBe(sign);
  });
});

describe("the Daily review input contract", () => {
  const base = { task: "Investigate.", ...source, answer, evidence: [ok, shutdown, failure], untimedEvidence: [untimed] };

  it("accepts complete records in time order with untimed lines apart, and empty evidence", () => {
    expect(dailyReviewInputSchema.parse(base)).toEqual(base);
    expect(dailyReviewInputSchema.safeParse({ ...base, evidence: [], untimedEvidence: [] }).success).toBe(true);
  });

  it.each([
    ["records out of time order", { evidence: [failure, ok] }],
    ["a record listed twice", { evidence: [ok, failure], untimedEvidence: [untimed, untimed] }],
    ["the same ID in both lists", { evidence: [shutdown], untimedEvidence: [{ ...untimed, id: shutdown.id }] }],
    ["an untimed line among timed records", { evidence: [ok, untimed] }],
    ["a timed line among untimed ones", { untimedEvidence: [shutdown] }],
    ["a controller-only database log", { evidence: [{ ...shutdown, id: "log-db-0001", service: "daily-db" }] }],
    ["an extra field on a record", { evidence: [{ ...ok, controller: "CONTROLLER_ONLY" }] }],
    ["investigator instructions", { instructions: "PRIVATE" }],
  ])("rejects %s", (_name, change) => {
    expect(dailyReviewInputSchema.safeParse({ ...base, ...change }).success).toBe(false);
  });
});
