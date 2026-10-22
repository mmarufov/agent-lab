import { isDeepStrictEqual } from "node:util";
import { investigationAnswerV2Schema, type InvestigationOutcome } from "@agent-lab/contracts";
import type { CaseSnapshot } from "./cases";
import { evaluateRun } from "./evaluate";
export interface OutcomeRun {
  id: string; trialId: string; deploymentId: string; status: string;
  answer: unknown; events: readonly unknown[]; caseSnapshot: CaseSnapshot | null;
}
export interface OutcomeReport {
  evaluatorVersion: "outcome-v1";
  status: "pass" | "fail" | "not_evaluated";
  reasons: string[];
  expected: InvestigationOutcome | null;
  observed: InvestigationOutcome | null;
  decisiveEvidenceIds: string[];
  supportingEvidence: { id: string; resultEventId: string }[];
}
export function unassessedOutcome(reason = "No saved case outcome assessment is available for this investigation."): OutcomeReport {
  return { evaluatorVersion: "outcome-v1", status: "not_evaluated", reasons: [reason], expected: null, observed: null, decisiveEvidenceIds: [], supportingEvidence: [] };
}

// Pure and case-version independent: evaluate the bound snapshot, never the registry.
export function evaluateOutcome(run: OutcomeRun): OutcomeReport {
  const snapshot = run.caseSnapshot;
  if (!snapshot) return unassessedOutcome("Legacy investigation: no case expectation was saved.");
  const parsed = investigationAnswerV2Schema.safeParse(run.answer);
  const report: OutcomeReport = { ...unassessedOutcome(), expected: snapshot.expected,
    observed: parsed.success ? parsed.data.outcome : null, decisiveEvidenceIds: snapshot.decisiveEvidenceIds };
  const finish = (status: OutcomeReport["status"], ...reasons: string[]) => ({ ...report, status, reasons });
  if (run.status !== "completed") return finish("not_evaluated", `Investigation is ${run.status}; a completed answer is required.`);
  if (snapshot.trialId !== run.trialId || snapshot.deploymentId !== run.deploymentId) return finish("not_evaluated", "Case snapshot does not belong to this trial and deployment.");
  if (!parsed.success) return finish("fail", "Case investigations require a valid version-two structured answer.");
  const evidence = evaluateRun(run);
  if (evidence.checks.toolTrace.status !== "pass" || evidence.checks.answer.status !== "pass") {
    return finish("not_evaluated", "The saved answer or tool trace is unreliable. Inspect the evidence checks.");
  }
  const fixtureLogs = new Map(snapshot.logs.map((log) => [log.id, log]));
  if (evidence.retrievedEvidence.some(({ log }) => !isDeepStrictEqual(log, fixtureLogs.get(log.id)))) {
    return finish("not_evaluated", "Retrieved logs do not match the saved trial fixture; evidence from other trials cannot count.");
  }
  report.supportingEvidence = snapshot.decisiveEvidenceIds.flatMap((id) => {
    const received = evidence.retrievedEvidence.find(({ log }) => log.id === id);
    return received ? [{ id, resultEventId: received.resultEventId }] : [];
  });
  const reasons: string[] = [];
  for (const field of ["state", "cause", "configurationKey"] as const) {
    if (parsed.data.outcome[field] !== snapshot.expected[field]) {
      reasons.push(`${field}: expected ${snapshot.expected[field] ?? "null"}; observed ${parsed.data.outcome[field] ?? "null"}.`);
    }
  }
  if (evidence.checks.retrieval.status !== "pass") reasons.push("No successful retrieval for this deployment was recorded before the answer.");
  if (evidence.checks.citations.status === "fail") reasons.push(evidence.checks.citations.reason);
  const receivedIds = new Set(evidence.retrievedEvidence.map(({ log }) => log.id));
  const missing = snapshot.decisiveEvidenceIds.filter((id) => !receivedIds.has(id) || !parsed.data.evidenceIds.includes(id));
  if (missing.length) reasons.push(`Decisive evidence must be retrieved and cited: ${missing.join(", ")}.`);
  if (snapshot.logs.length === 0 && parsed.data.evidenceIds.length) reasons.push("An empty-log case must not cite invented evidence.");
  return reasons.length ? finish("fail", ...reasons) : finish("pass", "Structured outcome matches the saved case expectation and the required evidence was retrieved before the answer.");
}
