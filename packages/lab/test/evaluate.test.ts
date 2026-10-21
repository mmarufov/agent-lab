import { expect, it } from "vitest";
import type { InvestigationEvent } from "@agent-lab/contracts";
import { evaluateRun } from "../src/evaluate";

const log = { id: "log-17", deploymentId: "B", level: "error", message: "Startup failed: DATABASE_URL is missing." };
const answer = { diagnosis: "DATABASE_URL is missing.", evidenceIds: ["log-17"], uncertainty: "The reason it is missing is unknown." };
const coordinates = { turnId: "turn-1", stepIndex: 0, sequence: 0 };
function event(id: string, type: string, data: unknown): InvestigationEvent {
  return { type, meta: { id, at: "2026-10-20T12:00:00.000Z" }, data };
}
function request(callId = "call-1", deploymentId = "B", toolName = "get_logs") {
  return event(`request-${callId}`, "actions.requested", { ...coordinates, actions: [
    { kind: "tool-call", toolName, callId, input: { deploymentId } },
  ] });
}
function result(callId = "call-1", output: unknown = { logs: [log] }, status = "completed", toolName = "get_logs", isError = false) {
  return event(`result-${callId}`, "action.result", { ...coordinates, status,
    result: { kind: "tool-result", callId, toolName, output, isError },
  });
}
function run(evidenceIds = ["log-17"], events = [request(), result()]) {
  const finalAnswer = { ...answer, evidenceIds };
  return { id: "run-example", deploymentId: "B", status: "completed", answer: finalAnswer,
    events: [...events, event("answer", "result.completed", { ...coordinates, result: finalAnswer })],
  };
}

it("links received evidence to its actual request and result without grading the diagnosis", () => {
  const saved = run();
  const original = structuredClone(saved);
  const report = evaluateRun(saved);
  expect(report.checks.citations.status).toBe("pass");
  expect(report.checks.retrieval.status).toBe("pass");
  expect(report.retrievedEvidence).toEqual([{ callId: "call-1", requestEventId: "request-call-1", resultEventId: "result-call-1", log }]);
  expect(report.diagnosisAssessment.status).toBe("not_evaluated");
  expect(saved).toEqual(original);
});

it("flags an invented citation even when other cited IDs were received", () => {
  const report = evaluateRun(run(["log-17", "log-999"]));
  expect(report.checks.citations.status).toBe("fail");
  expect(report.missingEvidenceIds).toEqual(["log-999"]);
});

it.each([
  ["unmatched call ID", [request(), result("unrelated")]],
  ["another tool", [request("call-1", "B", "other_tool"), result("call-1", { logs: [log] }, "completed", "other_tool")]],
  ["a result impersonating another tool", [request("call-1", "B", "other_tool"), result()]],
  ["another deployment", [request("call-1", "A"), result("call-1", { logs: [{ ...log, deploymentId: "A" }] })]],
  ["a response with the wrong deployment", [request(), result("call-1", { logs: [{ ...log, deploymentId: "A" }] })]],
  ["a failed call", [request(), result("call-1", { logs: [log] }, "failed")]],
  ["an error-marked result", [request(), result("call-1", { logs: [log] }, "completed", "get_logs", true)]],
  ["malformed returned logs", [request(), result("call-1", { logs: [{ id: "log-17" }] })]],
] as const)("does not credit evidence from %s", (_name, events) => {
  const report = evaluateRun(run(["log-17"], [...events]));
  expect(report.checks.citations.status).toBe("fail");
  expect(report.missingEvidenceIds).toEqual(["log-17"]);
  expect(report.retrievedEvidence).toEqual([]);
});

it("matches overlapping tool calls by ID, even when results arrive in reverse order", () => {
  const report = evaluateRun(run(["log-17"], [
    request("call-A", "A"), request("call-B", "B"), result("call-B"),
    result("call-A", { logs: [{ ...log, deploymentId: "A" }] }),
  ]));
  expect(report.checks.citations.status).toBe("pass");
  expect(report.retrievedEvidence[0].callId).toBe("call-B");
});

it("distinguishes an empty successful response from no successful retrieval", () => {
  const empty = evaluateRun(run([], [request(), result("call-1", { logs: [] })]));
  expect(empty.checks.retrieval.status).toBe("pass");
  expect(empty.checks.citations.status).toBe("not_evaluated");
  expect(empty.diagnosisAssessment.status).toBe("not_evaluated");
  const absent = evaluateRun(run([], []));
  expect(absent.checks.retrieval.status).toBe("fail");
  expect(absent.checks.citations.status).toBe("not_evaluated");
});

it.each(["running", "failed", "cancelled"])("does not grade a %s run as a completed answer", (status) => {
  const report = evaluateRun({ ...run(), status, answer: null });
  expect(report.checks.execution.status).toBe(status === "running" ? "not_evaluated" : "fail");
  expect(report.checks.citations.status).toBe("not_evaluated");
});

it("does not use logs received only after the final answer", () => {
  const saved = run(["log-17"], [request()]);
  saved.events.push(result());
  expect(evaluateRun(saved).missingEvidenceIds).toEqual(["log-17"]);
});

it("does not accept an answer that differs from the last recorded structured result", () => {
  const saved = run();
  saved.answer = { ...answer, evidenceIds: ["log-999"] };
  const report = evaluateRun(saved);
  expect(report.checks.answer.status).toBe("fail");
  expect(report.checks.citations.status).toBe("not_evaluated");
});

it("reports conflicting content under the same log ID instead of treating the citation as unambiguous", () => {
  const report = evaluateRun(run(["log-17"], [
    request("first"), result("first"), request("second"),
    result("second", { logs: [{ ...log, message: "Startup completed successfully." }] }),
  ]));
  expect(report.checks.toolTrace.status).toBe("fail");
  expect(report.checks.citations.status).toBe("fail");
  expect(report.ambiguousEvidenceIds).toEqual(["log-17"]);
});

it.each([
  ["requests", [request(), result(), request("call-1", "A")]],
  ["results", [request(), result(), result("call-1", { logs: [] })]],
] as const)("rejects conflicting %s for the same call ID", (_name, events) => {
  const report = evaluateRun(run(["log-17"], [...events]));
  expect(report.checks.toolTrace.status).toBe("fail");
  expect(report.retrievedEvidence).toEqual([]);
});

it("does not confuse a matching call ID in another turn with this turn's result", () => {
  const otherTurn = result();
  otherTurn.data = { ...otherTurn.data as object, turnId: "other-turn" };
  expect(evaluateRun(run(["log-17"], [request(), otherTurn])).missingEvidenceIds).toEqual(["log-17"]);
});

it("can pass citation membership without claiming that a false diagnosis is correct", () => {
  const saved = run();
  const incorrect = { ...answer, diagnosis: "The disk was full." };
  saved.answer = incorrect;
  saved.events[saved.events.length - 1] = event("answer", "result.completed", { ...coordinates, result: incorrect });
  const report = evaluateRun(saved);
  expect(report.checks.citations.status).toBe("pass");
  expect(report.diagnosisAssessment.status).toBe("not_evaluated");
});
