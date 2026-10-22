import { expect, it } from "vitest";
import { investigationAnswerSchema } from "@agent-lab/contracts";

it("accepts structured outcome claims without weakening legacy answer validation", () => {
  const legacy = { diagnosis: "Startup failed.", evidenceIds: ["log-17"], uncertainty: "No later evidence." };
  expect(investigationAnswerSchema.safeParse(legacy).success).toBe(true);
  expect(investigationAnswerSchema.safeParse({ ...legacy, outcome: {
    state: "failed", cause: "missing_configuration", configurationKey: "DATABASE_URL",
  } }).success).toBe(true);
  expect(investigationAnswerSchema.safeParse({ ...legacy, outcome: { state: "healthy" } }).success).toBe(false);
});

import { bindCase, getCase } from "../src/cases";
import { evaluateOutcome } from "../src/outcome";
import { evaluateRun } from "../src/evaluate";
import type { CaseId, InvestigationOutcome } from "@agent-lab/contracts";

function fixture(id: CaseId = "missing-config", outcome: InvestigationOutcome = { state: "failed", cause: "missing_configuration", configurationKey: "DATABASE_URL" }) {
  const snapshot = bindCase(getCase(id), "trial-one");
  const answer = { diagnosis: "Evidence-based conclusion.", uncertainty: "Only these logs are available.", evidenceIds: snapshot.decisiveEvidenceIds, outcome };
  const event = (id: string, type: string, data: object) => ({ type, meta: { id, at: "2026-10-21T00:00:00Z" }, data: { turnId: "turn", ...data } as Record<string, unknown> });
  return { id: "run", trialId: "trial-one", deploymentId: "B", status: "completed", answer, caseSnapshot: snapshot, events: [
    event("request", "actions.requested", { actions: [{ kind: "tool-call", toolName: "get_logs", callId: "call", input: { deploymentId: "B" } }] }),
    event("result", "action.result", { status: "completed", result: { kind: "tool-result", toolName: "get_logs", callId: "call", output: { logs: snapshot.logs } } }),
    event("answer", "result.completed", { result: answer }),
  ] };
}

it.each([
  ["missing-config", "failed", "missing_configuration", "DATABASE_URL"],
  ["healthy-startup", "healthy", "none", null],
  ["recovered-startup", "recovered", "missing_configuration", "DATABASE_URL"],
  ["no-logs", "unknown", "unknown", null],
] as const)("passes %s only from retrieved case evidence", (id, state, cause, configurationKey) => {
  const run = fixture(id, { state, cause, configurationKey });
  const before = structuredClone(run);
  expect(evaluateOutcome(run).status).toBe("pass");
  expect(run).toEqual(before);
});

it.each([
  ["missing-config", "failed", "other", null],
  ["missing-config", "unknown", "unknown", null],
  ["missing-config", "failed", "missing_configuration", "API_KEY"],
  ["recovered-startup", "failed", "missing_configuration", "DATABASE_URL"],
  ["no-logs", "healthy", "none", null],
] as const)("fails the wrong conclusion on %s: %s / %s / %s", (id, state, cause, configurationKey) => {
  const run = fixture(id, { state, cause, configurationKey });
  expect(evaluateRun(run).checks.answer.status).toBe("pass");
  if (id !== "no-logs") expect(evaluateRun(run).checks.citations.status).toBe("pass");
  expect(evaluateOutcome(run).status).toBe("fail");
});

it("requires both earlier failure and later success citations for recovery", () => {
  const run = fixture("recovered-startup", { state: "recovered", cause: "missing_configuration", configurationKey: "DATABASE_URL" });
  run.answer.evidenceIds = [run.caseSnapshot.decisiveEvidenceIds[0]];
  expect(evaluateOutcome(run).status).toBe("fail");
});
it("rejects citations belonging to another trial even when their log text matches", () => {
  const run = fixture();
  const other = bindCase(getCase("missing-config"), "trial-two");
  run.answer.evidenceIds = other.decisiveEvidenceIds;
  run.events[1].data = { turnId: "turn", status: "completed", result: { kind: "tool-result", toolName: "get_logs", callId: "call", output: { logs: other.logs } } };
  expect(evaluateRun(run).checks.citations.status).toBe("pass");
  expect(evaluateOutcome(run).status).toBe("not_evaluated");
});
it("does not credit an empty log answer without a successful retrieval", () => {
  const run = fixture("no-logs", { state: "unknown", cause: "unknown", configurationKey: null });
  run.events[1].data = { ...run.events[1].data, status: "failed" };
  expect(evaluateOutcome(run).status).toBe("fail");
});
it("requires evidence before the answer", () => {
  const run = fixture();
  run.events.push(run.events.splice(1, 1)[0]);
  expect(evaluateOutcome(run).status).toBe("fail");
});
it.each(["running", "cancelled", "failed"])("leaves %s outcomes unassessed", (status) => {
  expect(evaluateOutcome({ ...fixture(), status }).status).toBe("not_evaluated");
});
it("leaves legacy runs and unreliable traces unassessed, but fails malformed completed answers", () => {
  const run = fixture();
  expect(evaluateOutcome({ ...run, caseSnapshot: null }).status).toBe("not_evaluated");
  expect(evaluateOutcome({ ...run, answer: { diagnosis: "Invalid" } }).status).toBe("fail");
  expect(evaluateOutcome({ ...run, events: [...run.events, {}] }).status).toBe("not_evaluated");
  expect(evaluateOutcome({ ...run, trialId: "another-trial" }).status).toBe("not_evaluated");
});
