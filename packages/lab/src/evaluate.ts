import { isDeepStrictEqual } from "node:util";
import {
  getLogsInputSchema, getLogsOutputSchema, investigationAnswerSchema, investigationEventSchema,
  type DeploymentLog, type InvestigationEvent,
} from "@agent-lab/contracts";

interface EvidenceRun {
  id: string;
  deploymentId: string;
  status: string;
  answer: unknown;
  events: readonly unknown[];
}
type CheckStatus = "pass" | "fail" | "not_evaluated";
function check(status: CheckStatus, reason: string) { return { status, reason }; }
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }

interface Call {
  action: Record<string, unknown>;
  requestEventId: string;
  invalid: boolean;
  response?: { data: Record<string, unknown>; resultEventId: string };
  logs?: DeploymentLog[];
}

// No database/model calls or mutations. Only recorded, successful get_logs
// evidence from before the final answer can support its structured citations.
export function evaluateRun(run: EvidenceRun) {
  const issues: string[] = [];
  const events: InvestigationEvent[] = [];
  for (const raw of run.events) {
    const parsed = investigationEventSchema.safeParse(raw);
    if (parsed.success) events.push(parsed.data);
    else issues.push("An event has an invalid envelope.");
  }
  let answerIndex = -1;
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].type === "result.completed") { answerIndex = index; break; }
  }
  const finalData = object(events[answerIndex]?.data);
  const storedAnswer = investigationAnswerSchema.safeParse(run.answer);
  const streamedAnswer = investigationAnswerSchema.safeParse(finalData?.result);
  const answerMatches = storedAnswer.success && streamedAnswer.success && nonempty(finalData?.turnId)
    && isDeepStrictEqual(storedAnswer.data, streamedAnswer.data);
  const completed = run.status === "completed";
  const answerCheck = !completed ? check("not_evaluated", "The run has no completed answer to evaluate.")
    : !storedAnswer.success ? check("fail", "The saved answer is missing or does not match the answer schema.")
      : !answerMatches ? check("fail", "The saved answer does not match the last recorded structured result in the trace.")
        : check("pass", "The saved answer matches the recorded structured result.");

  const calls = new Map<string, Call>();
  // Fresh investigations contain one turn. Scope IDs to that turn as well as
  // callId so another turn cannot supply an unrelated result with the same ID.
  const beforeAnswer = answerIndex < 0 ? events : events.slice(0, answerIndex);
  for (const event of beforeAnswer) {
    if (event.type !== "actions.requested" && event.type !== "action.result") continue;
    const data = object(event.data);
    if (!data || !nonempty(data.turnId)) {
      issues.push(`${event.meta.id}: missing action data or turn ID.`);
      continue;
    }
    if (finalData && data.turnId !== finalData.turnId) continue;
    if (event.type === "actions.requested") {
      if (!Array.isArray(data.actions)) {
        issues.push(`${event.meta.id}: invalid action list.`);
        continue;
      }
      for (const raw of data.actions) {
        const action = object(raw);
        if (action?.kind !== "tool-call") continue;
        if (!nonempty(action.callId) || !nonempty(action.toolName)) {
          issues.push(`${event.meta.id}: tool request has no valid call ID or name.`);
          continue;
        }
        const key = JSON.stringify([data.turnId, action.callId]);
        const previous = calls.get(key);
        if (previous) {
          if (!isDeepStrictEqual(previous.action, action)) {
            previous.invalid = true;
            issues.push(`${event.meta.id}: conflicting requests for call ${action.callId}.`);
          }
          continue;
        }
        calls.set(key, { action, requestEventId: event.meta.id, invalid: false });
      }
      continue;
    }

    const result = object(data.result);
    if (!result || !nonempty(result.callId) || !nonempty(result.toolName)) {
      // Other action kinds are outside this tool-evidence check.
      if (result && result.kind !== "tool-result") continue;
      issues.push(`${event.meta.id}: invalid tool result.`);
      continue;
    }
    const call = calls.get(JSON.stringify([data.turnId, result.callId]));
    if (result.toolName !== "get_logs" && call?.action.toolName !== "get_logs") continue;
    if (!call) {
      issues.push(`${event.meta.id}: no preceding request for call ${result.callId}.`);
      continue;
    }
    if (call.action.toolName !== result.toolName || result.kind !== "tool-result") {
      call.invalid = true;
      issues.push(`${event.meta.id}: result does not match the requested tool.`);
      continue;
    }
    if (call.response) {
      if (!isDeepStrictEqual(call.response.data, data)) {
        call.invalid = true;
        issues.push(`${event.meta.id}: conflicting results for call ${result.callId}.`);
      }
      continue;
    }
    call.response = { data, resultEventId: event.meta.id };
    if (data.status === "failed" || data.status === "rejected" || result.isError === true) continue;
    const input = getLogsInputSchema.safeParse(call.action.input);
    const output = getLogsOutputSchema.safeParse(result.output);
    if (data.status !== "completed" || (result.isError !== undefined && result.isError !== false)
      || !input.success || !output.success
      || output.data.logs.some((log) => log.deploymentId !== input.data.deploymentId)) {
      call.invalid = true;
      issues.push(`${event.meta.id}: invalid get_logs input, result, or deployment identity.`);
      continue;
    }
    if (input.data.deploymentId === run.deploymentId) call.logs = output.data.logs;
  }

  const successfulCalls = [...calls.values()].filter((call) => !call.invalid && call.logs !== undefined);
  const retrievedEvidence = successfulCalls.flatMap((call) => call.logs!.map((log) => ({
    callId: call.action.callId as string, requestEventId: call.requestEventId,
    resultEventId: call.response!.resultEventId, log,
  })));
  const logsById = new Map<string, DeploymentLog>();
  const ambiguousIds = new Set<string>();
  for (const { log } of retrievedEvidence) {
    const previous = logsById.get(log.id);
    if (previous && !isDeepStrictEqual(previous, log)) ambiguousIds.add(log.id);
    logsById.set(log.id, log);
  }
  if (ambiguousIds.size) issues.push(`Conflicting log content for ID(s): ${[...ambiguousIds].join(", ")}.`);
  const receivedIds = new Set(retrievedEvidence.map(({ log }) => log.id));
  const canCheckCitations = completed && answerMatches;
  const citedIds = canCheckCitations ? [...new Set(storedAnswer.data.evidenceIds)] : [];
  const missingEvidenceIds = citedIds.filter((id) => !receivedIds.has(id));
  const citationProblems: string[] = [];
  if (missingEvidenceIds.length) citationProblems.push(`Cited IDs not received from successful get_logs calls for ${run.deploymentId}: ${missingEvidenceIds.join(", ")}.`);
  const ambiguousCitations = citedIds.filter((id) => ambiguousIds.has(id));
  if (ambiguousCitations.length) citationProblems.push(`Cited IDs have conflicting log content: ${ambiguousCitations.join(", ")}.`);

  return {
    runId: run.id,
    deploymentId: run.deploymentId,
    evaluatorVersion: "evidence-v1",
    checks: {
      execution: completed ? check("pass", "The investigation is recorded as completed.")
        : check(run.status === "running" ? "not_evaluated" : "fail", `Investigation status: ${run.status}.`),
      answer: answerCheck,
      toolTrace: issues.length ? check("fail", issues.join(" ")) : check("pass", "No invalid tool evidence records were found."),
      retrieval: successfulCalls.length
        ? check("pass", `${successfulCalls.length} successful get_logs call(s) for ${run.deploymentId}; ${retrievedEvidence.length} returned log record(s).`)
        : check(completed ? "fail" : "not_evaluated", `No valid, successful get_logs result for ${run.deploymentId} was recorded before the answer.`),
      citations: !canCheckCitations ? check("not_evaluated", "A completed, matching structured answer is required.")
        : citedIds.length === 0 ? check("not_evaluated", "No evidence IDs were cited; this does not establish that the diagnosis is supported.")
          : citationProblems.length ? check("fail", citationProblems.join(" "))
            : check("pass", `All ${citedIds.length} cited ID(s) were received before the answer.`),
    },
    retrievedEvidence,
    citedEvidenceIds: citedIds,
    missingEvidenceIds,
    ambiguousEvidenceIds: [...ambiguousIds],
    diagnosisAssessment: check("not_evaluated", "Citation membership does not establish that the logs support the diagnosis. This deterministic checker does not assess semantic correctness."),
  };
}
