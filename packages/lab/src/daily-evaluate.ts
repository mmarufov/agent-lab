import { isDeepStrictEqual } from "node:util";
import { investigationEventSchema, type InvestigationEvent } from "@agent-lab/contracts";
import type { DailyApplicationLog, DailyHttpObservation } from "@agent-lab/contracts/daily-capture";
import {
  getDailyHttpObservationsInputSchema,
  getDailyHttpObservationsOutputSchema,
  getDailyLogsInputSchema,
  getDailyLogsOutputSchema,
} from "@agent-lab/contracts/daily-evidence";
import { dailyAvailabilityAnswerSchema } from "@agent-lab/contracts/daily-availability";
import { dailyInvestigationAnswerSchema } from "@agent-lab/contracts/daily-investigation";

// Which recorded records a Daily investigation actually received, and whether
// its citations come from them. It reads saved events only: no files, database,
// or model. It says nothing about whether the diagnosis is right. The evidence
// checker and the review of a Daily run both read the events through
// readDailyEvidence, so a reviewer sees exactly the records the report counts.
// The Daily recovery evaluation reads the same events with the same rules
// through readDailyAvailabilityEvidence, which validates its extended answer.

export interface DailyEvidenceRun {
  id: string;
  captureId: string;
  /** SHA-256 of the evidence.jsonl the run's grant pinned. */
  evidenceSha256: string;
  status: string;
  answer: unknown;
  events: readonly unknown[];
}

type CheckStatus = "pass" | "fail" | "not_evaluated";
type DailyRecord = DailyApplicationLog | DailyHttpObservation;
export type DailyTool = "get_daily_logs" | "get_daily_http_observations";

/** Where one record came from: the tool call and the request/result events that carried it. */
export interface ReceivedRecord {
  id: string;
  kind: DailyRecord["kind"];
  toolName: DailyTool;
  callId: string;
  requestEventId: string;
  resultEventId: string;
}

export type DailyEvidenceReport = ReturnType<typeof readDailyEvidence>["report"];

const check = (status: CheckStatus, reason: string) => ({ status, reason });
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * One successful Daily tool result's page, or why it cannot count as evidence:
 * the input and output must match the tool's schemas, every record must match
 * the requested filters, and the page must come from this run's capture and
 * evidence file. The evidence checker and the workbench's activity view share it.
 */
export function readDailyToolPage(
  toolName: DailyTool,
  rawInput: unknown,
  rawOutput: unknown,
  run: { captureId: string; evidenceSha256: string },
): { problem: string } | { records: DailyRecord[]; oversized: { id: string; bytes: number }[]; nextCursor: string | null } {
  let records: DailyRecord[];
  let page: { captureId: string; evidenceSha256: string; oversized: { id: string; bytes: number }[]; nextCursor: string | null };
  if (toolName === "get_daily_logs") {
    const input = getDailyLogsInputSchema.safeParse(rawInput);
    const output = getDailyLogsOutputSchema.safeParse(rawOutput);
    if (!input.success || !output.success) return { problem: "invalid get_daily_logs input or result" };
    const needle = input.data.messageContains?.toLowerCase();
    const matches = (log: DailyApplicationLog) =>
      (!input.data.service || log.service === input.data.service) && (!needle || log.message.toLowerCase().includes(needle));
    if (!output.data.logs.every(matches)) return { problem: "get_daily_logs returned lines outside its filters" };
    records = output.data.logs;
    page = output.data;
  } else {
    const input = getDailyHttpObservationsInputSchema.safeParse(rawInput);
    const output = getDailyHttpObservationsOutputSchema.safeParse(rawOutput);
    if (!input.success || !output.success) return { problem: "invalid get_daily_http_observations input or result" };
    if (input.data.path && output.data.observations.some((observation) => observation.path !== input.data.path))
      return { problem: "get_daily_http_observations returned another path" };
    records = output.data.observations;
    page = output.data;
  }
  if (page.captureId !== run.captureId || page.evidenceSha256 !== run.evidenceSha256)
    return { problem: `records from capture ${page.captureId} (evidence ${page.evidenceSha256.slice(0, 12)}), not this run's` };
  return { records, oversized: page.oversized, nextCursor: page.nextCursor };
}

interface Call {
  action: Record<string, unknown>;
  toolName: DailyTool;
  requestEventId: string;
  invalid: boolean;
  resultEventId?: string;
  resultData?: Record<string, unknown>;
  failed?: boolean;
  records?: DailyRecord[];
  oversized?: string[];
}

export const DAILY_TOOLS: readonly string[] = ["get_daily_logs", "get_daily_http_observations"];

/** The daily-evidence-v1 report for a run. */
export function evaluateDailyRun(run: DailyEvidenceRun) {
  return readDailyEvidence(run).report;
}

/**
 * daily-evidence-v1. Requests and results are paired by turn and call ID.
 * Only successful, schema-valid results from this run's capture and evidence
 * file, recorded before the final answer, supply evidence. A citation must
 * name a record one of them returned: never an invented ID, a record whose
 * returned contents conflict, or an ID listed only as oversized.
 *
 * Returns the report and, from the same pass, every distinct record those
 * results returned, cited or not, complete and in the order first received.
 * A record returned twice with different contents is listed once here; the
 * report names it as ambiguous and fails the trace.
 */
export function readDailyEvidence(run: DailyEvidenceRun) {
  const { report, records } = readEvidence(run, dailyInvestigationAnswerSchema, "the Daily answer schema");
  return { report, records };
}

/**
 * The same daily-evidence-v1 checks for the evaluation-only availability
 * answer: the saved answer and the last recorded structured result must both
 * match dailyAvailabilityAnswerSchema and each other. Also returns that
 * answer, when its citations could be checked, and the citation check itself,
 * so role-specific citations are judged by exactly the same rules.
 */
export function readDailyAvailabilityEvidence(run: DailyEvidenceRun) {
  return readEvidence(run, dailyAvailabilityAnswerSchema, "the Daily availability answer schema");
}

interface AnswerSchema<Answer> {
  safeParse(value: unknown): { success: true; data: Answer } | { success: false };
}

/** Which of these cited IDs the run's successful results returned, and why each other one cannot count. */
export interface CitationCheck {
  /** Distinct cited IDs, in first-cited order. */
  citedIds: string[];
  missingIds: string[];
  oversizedOnlyIds: string[];
  inventedIds: string[];
  ambiguousIds: string[];
  problems: string[];
}

function readEvidence<Answer extends { evidenceIds: string[] }>(run: DailyEvidenceRun, answerSchema: AnswerSchema<Answer>, schemaName: string) {
  const issues: string[] = [];
  const events: InvestigationEvent[] = [];
  for (const raw of run.events) {
    const parsed = investigationEventSchema.safeParse(raw);
    if (parsed.success) events.push(parsed.data);
    else issues.push("An event has an invalid envelope.");
  }
  let answerIndex = -1;
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].type === "result.completed") {
      answerIndex = index;
      break;
    }
  }
  const finalData = object(events[answerIndex]?.data);
  const storedAnswer = answerSchema.safeParse(run.answer);
  const streamedAnswer = answerSchema.safeParse(finalData?.result);
  const answerMatches =
    storedAnswer.success && streamedAnswer.success && nonempty(finalData?.turnId) && isDeepStrictEqual(storedAnswer.data, streamedAnswer.data);
  const completed = run.status === "completed";
  const answer = !completed
    ? check("not_evaluated", "The run has no completed answer to evaluate.")
    : !storedAnswer.success
      ? check("fail", `The saved answer is missing or does not match ${schemaName}.`)
      : !answerMatches
        ? check("fail", "The saved answer does not match the last recorded structured result in the trace.")
        : check("pass", "The saved answer matches the recorded structured result.");

  const calls = new Map<string, Call>();
  // Records returned after the answer cannot have informed it.
  for (const event of answerIndex < 0 ? events : events.slice(0, answerIndex)) {
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
        if (!DAILY_TOOLS.includes(action.toolName)) {
          issues.push(`${event.meta.id}: ${action.toolName} is not a Daily evidence tool.`);
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
        calls.set(key, { action, toolName: action.toolName as DailyTool, requestEventId: event.meta.id, invalid: false });
      }
      continue;
    }

    const result = object(data.result);
    if (!result || result.kind !== "tool-result") continue; // Other action kinds carry no tool evidence.
    if (!nonempty(result.callId) || !nonempty(result.toolName)) {
      issues.push(`${event.meta.id}: invalid tool result.`);
      continue;
    }
    if (!DAILY_TOOLS.includes(result.toolName)) {
      issues.push(`${event.meta.id}: ${result.toolName} is not a Daily evidence tool.`);
      continue;
    }
    const call = calls.get(JSON.stringify([data.turnId, result.callId]));
    if (!call) {
      issues.push(`${event.meta.id}: no preceding request for call ${result.callId}.`);
      continue;
    }
    if (call.toolName !== result.toolName) {
      call.invalid = true;
      issues.push(`${event.meta.id}: result does not match the requested tool.`);
      continue;
    }
    if (call.resultData) {
      // A replayed result is the same result; a different one makes the call unreliable.
      if (!isDeepStrictEqual(call.resultData, data)) {
        call.invalid = true;
        issues.push(`${event.meta.id}: conflicting results for call ${result.callId}.`);
      }
      continue;
    }
    call.resultData = data;
    call.resultEventId = event.meta.id;
    // A failed tool call is an observation, not evidence and not a trace defect.
    if (data.status === "failed" || data.status === "rejected" || result.isError === true) {
      call.failed = true;
      continue;
    }
    const page = readDailyToolPage(call.toolName, call.action.input, result.output, run);
    if (data.status !== "completed" || (result.isError !== undefined && result.isError !== false) || "problem" in page) {
      call.invalid = true;
      issues.push(`${event.meta.id}: ${"problem" in page ? page.problem : "the result is not a completed tool result"}.`);
      continue;
    }
    call.records = page.records;
    call.oversized = page.oversized.map((entry) => entry.id);
  }

  const successful = [...calls.values()].filter((call) => !call.invalid && call.records);
  const failedCalls = [...calls.values()].filter((call) => call.failed).length;
  const retrievedEvidence: ReceivedRecord[] = [];
  const contents = new Map<string, DailyRecord>();
  const ambiguous = new Set<string>();
  const oversized = new Set<string>();
  for (const call of successful) {
    for (const record of call.records!) {
      retrievedEvidence.push({
        id: record.id,
        kind: record.kind,
        toolName: call.toolName,
        callId: call.action.callId as string,
        requestEventId: call.requestEventId,
        resultEventId: call.resultEventId!,
      });
      const previous = contents.get(record.id);
      if (previous && !isDeepStrictEqual(previous, record)) ambiguous.add(record.id);
      contents.set(record.id, record);
    }
    for (const id of call.oversized!) oversized.add(id);
  }
  if (ambiguous.size) issues.push(`Conflicting contents for record ID(s): ${[...ambiguous].join(", ")}.`);

  const checkCitations = (ids: readonly string[]): CitationCheck => {
    const citedIds = [...new Set(ids)];
    const missingIds = citedIds.filter((id) => !contents.has(id));
    const oversizedOnlyIds = missingIds.filter((id) => oversized.has(id));
    const inventedIds = missingIds.filter((id) => !oversized.has(id));
    const ambiguousIds = citedIds.filter((id) => ambiguous.has(id));
    const problems: string[] = [];
    if (inventedIds.length) problems.push(`Cited IDs that no successful Daily tool result returned: ${inventedIds.join(", ")}.`);
    if (oversizedOnlyIds.length)
      problems.push(`Cited IDs listed only as oversized, so their contents were never returned: ${oversizedOnlyIds.join(", ")}.`);
    if (ambiguousIds.length) problems.push(`Cited IDs with conflicting returned contents: ${ambiguousIds.join(", ")}.`);
    return { citedIds, missingIds, oversizedOnlyIds, inventedIds, ambiguousIds, problems };
  };
  const canCheckCitations = completed && answerMatches;
  const { citedIds, missingIds, oversizedOnlyIds, problems } = checkCitations(canCheckCitations ? storedAnswer.data.evidenceIds : []);

  const report = {
    runId: run.id,
    captureId: run.captureId,
    evidenceSha256: run.evidenceSha256,
    evaluatorVersion: "daily-evidence-v1" as const,
    checks: {
      execution: completed
        ? check("pass", "The investigation is recorded as completed.")
        : check(run.status === "running" ? "not_evaluated" : "fail", `Investigation status: ${run.status}.`),
      answer,
      toolTrace: issues.length ? check("fail", issues.join(" ")) : check("pass", "No invalid tool evidence records were found."),
      retrieval: successful.length
        ? check(
            "pass",
            `${successful.length} successful Daily tool call(s) returned ${contents.size} distinct record(s) from capture ${run.captureId}` +
              (failedCalls ? `; ${failedCalls} call(s) failed.` : "."),
          )
        : check(
            completed ? "fail" : "not_evaluated",
            `No valid, successful Daily tool result from capture ${run.captureId} was recorded before the answer` +
              (failedCalls ? `; ${failedCalls} call(s) failed.` : "."),
          ),
      citations: !canCheckCitations
        ? check("not_evaluated", "A completed, matching structured answer is required.")
        : citedIds.length === 0
          ? check("not_evaluated", "No evidence IDs were cited; this does not establish that the diagnosis is supported.")
          : problems.length
            ? check("fail", problems.join(" "))
            : check("pass", `All ${citedIds.length} cited ID(s) were returned by successful Daily tool calls before the answer.`),
    },
    retrievedEvidence,
    citedEvidenceIds: citedIds,
    missingEvidenceIds: missingIds,
    oversizedOnlyEvidenceIds: oversizedOnlyIds,
    ambiguousEvidenceIds: [...ambiguous],
    diagnosisAssessment: check(
      "not_evaluated",
      "Diagnosis correctness is not assessed. These checks establish only where cited records came from, not that they support the diagnosis.",
    ),
  };
  return {
    report,
    records: [...contents.values()],
    /** The saved answer, only when it matches the last recorded result of a completed run, so its citations could be checked. */
    answer: canCheckCitations ? storedAnswer.data : undefined,
    checkCitations,
  };
}
