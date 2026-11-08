import { isDeepStrictEqual } from "node:util";
import { DAILY_AVAILABILITY_ANSWER_VERSION, type DailyAvailabilityState } from "@agent-lab/contracts/daily-availability";
import type { DailyHttpObservation } from "@agent-lab/contracts/daily-capture";
import { evaluateCoverage, unassessedCoverage, type CoverageResult } from "./coverage";
import {
  DAILY_FEED_AVAILABILITY_PROFILE,
  dailyFeedAvailabilityFacts,
  isFeedRequest,
  isReadyFeed,
  recordsDifferingFromRecording,
} from "./daily-coverage";
import { readDailyAvailabilityEvidence, type CitationCheck, type DailyEvidenceReport } from "./daily-evaluate";
import { DailyCaptureError, EVIDENCE, readDailyCapture, type CaptureFileHashes, type DailyCaptureRecords } from "./daily-evidence";

// The deterministic checks of the Daily recovery evaluation
// (my-agent/evals/daily/recovery.eval.ts). Input: one evaluation turn's
// original events and structured answer, and the full recording, verified
// against the case's pinned hashes. Output: three separate results. Evidence
// checks: the citations came from valid records received before the answer.
// Availability outcome: the structured failure/recovery conclusion matches
// the recording. Coverage: which availability facts the received records
// establish. It reads no files, database, or model, and nothing here is sent
// to the investigator. Root cause and the free-text explanation are not graded.
// readCaseRecording is the one function here that reads files: the recording.

export const DAILY_RECOVERY_EVALUATOR_VERSION = "daily-recovery-v1";

/** One evaluation case. Evaluator-only: none of it is sent to the model. */
export interface DailyRecoveryCase {
  id: string;
  /** What the recording is, such as a real Daily capture or a labeled synthetic test recording. */
  recording: string;
  captureId: string;
  /** SHA-256 of each capture file, verified before any model work. */
  captureSha256: CaptureFileHashes;
  expected: { availability: DailyAvailabilityState };
}

/**
 * The case's recording, read and verified like any capture served as
 * evidence, and refused unless all three files match the case's pinned
 * SHA-256. A missing, incomplete, or changed recording throws a
 * DailyCaptureError; no other recording is ever substituted.
 */
export async function readCaseRecording(capturesDir: string, evalCase: DailyRecoveryCase) {
  const recording = await readDailyCapture(capturesDir, evalCase.captureId);
  const changed = (Object.keys(evalCase.captureSha256) as (keyof CaptureFileHashes)[]).filter(
    (name) => recording.sha256[name] !== evalCase.captureSha256[name],
  );
  if (changed.length)
    throw new DailyCaptureError("changed", `Capture ${evalCase.captureId}: ${changed.join(", ")} differ from the SHA-256 that case ${evalCase.id} pins.`);
  return recording;
}

type Status = "pass" | "fail" | "not_evaluated";
const result = (status: Status, reason: string) => ({ status, reason });

export type TurnStatus = "completed" | "failed" | "cancelled" | "waiting_for_input" | "incomplete";

const eventType = (event: unknown) =>
  event !== null && typeof event === "object" && typeof (event as { type?: unknown }).type === "string" ? (event as { type: string }).type : "";
const eventData = (event: unknown) => {
  const data = event !== null && typeof event === "object" ? (event as { data?: unknown }).data : undefined;
  return data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
};

/**
 * How one evaluation turn ended, read from its original events. Only
 * "completed" has an answer to grade: a cancelled or failed turn, one parked
 * on an input request such as a usage-limit extension (never approved), or
 * one that ended without turn.completed and a structured result is not. A
 * session left waiting for the next user message is the normal end of a
 * completed turn.
 */
export function dailyTurnStatus(events: readonly unknown[]): { status: TurnStatus; reason: string } {
  const types = events.map(eventType);
  if (types.includes("turn.cancelled")) return { status: "cancelled", reason: "The turn was cancelled before it completed." };
  const failure = events.find((event) => ["turn.failed", "session.failed", "step.failed"].includes(eventType(event)));
  if (failure) {
    const { code, message } = eventData(failure);
    const detail = [code, message].filter((part) => typeof part === "string" && part).join(": ");
    return { status: "failed", reason: `The turn failed${detail ? ` (${detail})` : ""}.` };
  }
  const requests = events.filter((event) => eventType(event) === "input.requested");
  if (requests.length) {
    const kinds = requests.flatMap((event) => {
      const list = eventData(event).requests;
      return Array.isArray(list) ? list.map((request) => String((request as { kind?: unknown })?.kind ?? "input")) : ["input"];
    });
    return { status: "waiting_for_input", reason: `The turn stopped at ${kinds.length} unanswered input request(s) (${[...new Set(kinds)].join(", ")}); none is ever approved.` };
  }
  if (!types.includes("turn.completed")) return { status: "incomplete", reason: "The turn ended without turn.completed." };
  if (!types.includes("result.completed")) return { status: "incomplete", reason: "The turn completed without a structured result." };
  return { status: "completed", reason: "The turn completed with a structured result." };
}

/**
 * The availability the full recording establishes under
 * daily-feed-availability-v1: its authenticated GET /feed observations only.
 * Recovery needs a ready response to a request started after the last
 * failure ended; an earlier success, or one overlapping a failure, is not.
 */
export function recordedAvailability(observations: readonly DailyHttpObservation[]) {
  const profile = dailyFeedAvailabilityFacts(observations);
  const recovery = profile.facts.find((fact) => fact.id === "recovery");
  const requirement = (id: string) =>
    recovery?.applicable ? (recovery.requirements.find((entry) => entry.id === id)?.anyOf ?? []) : [];
  const { feedObservations, serverErrors, noResponses, lastFailureEndedAt } = profile.scope;
  const failures = serverErrors + noResponses;
  const state: DailyAvailabilityState =
    feedObservations === 0 ? "unknown" : failures === 0 ? "healthy" : recovery?.applicable ? "recovered" : "failing";
  return { state, profile, failureIds: requirement("failure"), laterSuccessIds: requirement("later_success"), lastFailureEndedAt };
}

export interface DailyRecoveryInput {
  /** Eve's session ID for the evaluation turn. */
  sessionId: string;
  case: DailyRecoveryCase;
  /** The full recording, read and verified against case.captureSha256. */
  recording: DailyCaptureRecords;
  /** The session's original events, unmodified. */
  events: readonly unknown[];
  /** The structured answer Eve's client returned for the turn, if any. */
  answer: unknown;
}

interface RoleCitations {
  /** Cited, received before the answer, and a record this role accepts. */
  counted: string[];
  notCounted: { id: string; reason: string }[];
}

/**
 * daily-recovery-v1. Passing needs all three of: a completed turn whose
 * answer and evidence trace are valid; availability.state "recovered"; and at
 * least one cited, received failure (a 500-599 response, timeout, or network
 * error) and one cited, received ready response to a request started after the
 * recording's last failure ended. Every role-specific citation must be valid
 * and also appear in evidenceIds. Any qualifying records count; tool order,
 * reading every page, and log retrieval are not required.
 */
export function evaluateDailyRecovery(input: DailyRecoveryInput) {
  const { case: evalCase, recording } = input;
  if (recording.captureId !== evalCase.captureId || !isDeepStrictEqual(recording.sha256, evalCase.captureSha256))
    throw new Error(`The recording supplied is not case ${evalCase.id}'s pinned capture ${evalCase.captureId}.`);
  const expected = recordedAvailability(recording.observations);
  if (expected.state !== evalCase.expected.availability)
    throw new Error(`Case ${evalCase.id} expects ${evalCase.expected.availability}, but its recording establishes ${expected.state}.`);
  if (expected.state !== "recovered")
    throw new Error(`${DAILY_RECOVERY_EVALUATOR_VERSION} defines passing rules for a recording that shows recovery, not ${expected.state}.`);

  const turn = dailyTurnStatus(input.events);
  const read = readDailyAvailabilityEvidence({
    id: input.sessionId,
    captureId: recording.captureId,
    evidenceSha256: recording.sha256[EVIDENCE],
    status: turn.status,
    answer: input.answer,
    events: input.events,
  });
  const { report, records, answer } = read;
  const recordProblems = recordsDifferingFromRecording(records, recording);

  // Evidence checks.
  const roles = answer && {
    failure: read.checkCitations(answer.availability.failureEvidenceIds),
    recovery: read.checkCitations(answer.availability.recoveryEvidenceIds),
  };
  const listed = new Set(answer?.evidenceIds ?? []);
  const unlisted = roles ? [...new Set([...roles.failure.citedIds, ...roles.recovery.citedIds])].filter((id) => !listed.has(id)) : [];
  const { execution, answer: answerCheck, toolTrace, citations } = report.checks;
  let evidence: { status: Status; reason: string };
  if (execution.status !== "pass") evidence = result("not_evaluated", `No completed answer to check. ${turn.reason}`);
  else if (answerCheck.status !== "pass") evidence = result("fail", answerCheck.reason);
  else {
    const problems: string[] = [];
    if (toolTrace.status === "fail") problems.push(`Invalid tool evidence: ${toolTrace.reason}`);
    if (recordProblems.length) problems.push(`Received records that are not the pinned recording's: ${recordProblems.join("; ")}.`);
    if (citations.status === "fail") problems.push(`evidenceIds: ${citations.reason}`);
    if (roles?.failure.problems.length) problems.push(`failureEvidenceIds: ${roles.failure.problems.join(" ")}`);
    if (roles?.recovery.problems.length) problems.push(`recoveryEvidenceIds: ${roles.recovery.problems.join(" ")}`);
    if (unlisted.length) problems.push(`Role-specific citations missing from evidenceIds: ${unlisted.join(", ")}.`);
    const cited = new Set([...listed, ...unlisted]).size;
    evidence = problems.length
      ? result("fail", problems.join(" "))
      : cited === 0
        ? result("not_evaluated", "No evidence IDs were cited, so no citation could be checked.")
        : result(
            "pass",
            `All ${cited} cited ID(s), including ${roles!.failure.citedIds.length} failure and ${roles!.recovery.citedIds.length} recovery citation(s), ` +
              "are records received in full from the pinned recording before the answer, and every role-specific citation is in evidenceIds.",
          );
  }

  // Availability outcome.
  const recorded = new Map(recording.observations.map((observation) => [observation.id, observation]));
  const failureIds = new Set(expected.failureIds);
  const laterSuccessIds = new Set(expected.laterSuccessIds);
  const lastFailure = expected.lastFailureEndedAt;
  const sortRole = (check: CitationCheck, accepts: Set<string>, explain: (id: string) => string): RoleCitations => {
    const unusable = new Set([...check.missingIds, ...check.ambiguousIds]);
    const counted = check.citedIds.filter((id) => !unusable.has(id) && accepts.has(id));
    const notCounted = check.citedIds
      .filter((id) => !counted.includes(id))
      .map((id) => ({
        id,
        reason: check.ambiguousIds.includes(id)
          ? "its returned contents conflict"
          : check.oversizedOnlyIds.includes(id)
            ? "it was listed only as oversized, so its contents were never returned"
            : check.missingIds.includes(id)
              ? "no successful tool result returned it before the answer"
              : explain(id),
      }));
    return { counted, notCounted };
  };
  const failureReason = (id: string) =>
    recorded.has(id) ? "it is not a failed authenticated GET /feed request" : "it is not an HTTP observation of the recording";
  const recoveryReason = (id: string) => {
    const observation = recorded.get(id);
    if (!observation) return "it is not an HTTP observation of the recording";
    if (failureIds.has(id)) return "it is a failed request";
    if (isFeedRequest(observation) && isReadyFeed(observation))
      return `it is a ready response to a request that started before the recording's last failure ended at ${lastFailure}`;
    return "it is not a ready authenticated GET /feed response";
  };
  const failureCitations = roles ? sortRole(roles.failure, failureIds, failureReason) : undefined;
  const recoveryCitations = roles ? sortRole(roles.recovery, laterSuccessIds, recoveryReason) : undefined;
  let outcome: { status: Status; reason: string };
  if (!answer) outcome = result("not_evaluated", execution.status !== "pass" ? `No completed answer to grade. ${turn.reason}` : answerCheck.reason);
  else {
    const problems: string[] = [];
    if (answer.availability.state !== expected.state)
      problems.push(`The answer's availability state is ${answer.availability.state}; the recording establishes ${expected.state}.`);
    if (!failureCitations!.counted.length)
      problems.push(
        "No cited failure qualifies: failureEvidenceIds needs a received authenticated GET /feed request that got a 500-599 response, timed out, or failed with a network error.",
      );
    if (!recoveryCitations!.counted.length)
      problems.push(
        `No cited recovery qualifies: recoveryEvidenceIds needs a received ready authenticated GET /feed response to a request started after the recording's last failure ended at ${lastFailure}.`,
      );
    outcome = problems.length
      ? result("fail", problems.join(" "))
      : result(
          "pass",
          `The answer says recovered, as the recording establishes. Qualifying failure citation(s): ${failureCitations!.counted.join(", ")}; ` +
            `qualifying recovery citation(s), started after the last failure ended at ${lastFailure}: ${recoveryCitations!.counted.join(", ")}.`,
        );
  }

  // Coverage: which availability facts the received records establish.
  const unassessable =
    execution.status !== "pass" ? `No completed answer. ${turn.reason}`
      : answerCheck.status !== "pass" ? `${answerCheck.reason} Which records came before the answer is therefore unknown.`
        : toolTrace.status !== "pass" ? `The evidence trace is invalid: ${toolTrace.reason}`
          : recordProblems.length ? "Received records differ from the pinned recording, so they cannot count as its evidence."
            : null;
  const coverage: CoverageResult = unassessable
    ? unassessedCoverage(expected.profile.facts, unassessable)
    : evaluateCoverage(expected.profile.facts, records.map((record) => record.id));

  return {
    evaluatorVersion: DAILY_RECOVERY_EVALUATOR_VERSION,
    answerVersion: DAILY_AVAILABILITY_ANSWER_VERSION,
    profileVersion: DAILY_FEED_AVAILABILITY_PROFILE,
    caseId: evalCase.id,
    captureId: recording.captureId,
    captureSha256: recording.sha256,
    sessionId: input.sessionId,
    turn,
    evidence: {
      ...evidence,
      /** The daily-evidence-v1 report of the same events, read with the availability answer schema. */
      report: report satisfies DailyEvidenceReport,
      recordProblems,
      roleCitations: roles ? { failure: roles.failure, recovery: roles.recovery, missingFromEvidenceIds: unlisted } : null,
    },
    outcome: {
      ...outcome,
      expected: expected.state,
      answered: answer?.availability.state ?? null,
      lastFailureEndedAt: lastFailure,
      failureCitations: failureCitations ?? null,
      recoveryCitations: recoveryCitations ?? null,
    },
    coverage: { ...coverage, retrievedRecords: unassessable ? 0 : records.length },
    notAssessed: [
      {
        id: "root_cause",
        label: "Root-cause correctness",
        reason: "Not assessed. No check compares a stated cause with what the capture controller did.",
      },
      {
        id: "explanation",
        label: "Free-text explanation correctness",
        reason: "Not assessed. The diagnosis and uncertainty text are saved but not graded.",
      },
    ],
  };
}

export type DailyRecoveryEvaluation = ReturnType<typeof evaluateDailyRecovery>;

/**
 * What one evaluation turn used, read from its events: model steps and the
 * model IDs they started with, Gateway generation IDs, tool calls, and the
 * session's latest reported tokens and cost. A value Eve did not report is
 * "unavailable", never zero.
 */
export function turnUsage(events: readonly unknown[]) {
  const models = new Set<string>();
  const generationIds: string[] = [];
  const toolCalls = new Map<string, string>();
  let modelSteps = 0;
  let usage: Record<string, unknown> | undefined;
  for (const event of events) {
    const type = eventType(event);
    const data = eventData(event);
    if (type === "step.started") {
      modelSteps += 1;
      if (typeof data.modelId === "string") models.add(data.modelId);
    } else if (type === "step.completed") {
      const gateway = (data.providerMetadata as { gateway?: { generationId?: unknown } } | undefined)?.gateway;
      if (typeof gateway?.generationId === "string") generationIds.push(gateway.generationId);
    } else if (type === "actions.requested" && Array.isArray(data.actions)) {
      for (const action of data.actions as { kind?: unknown; callId?: unknown; toolName?: unknown }[])
        if (action?.kind === "tool-call" && typeof action.callId === "string") toolCalls.set(action.callId, String(action.toolName));
    } else if (["session.waiting", "turn.waiting", "session.failed", "session.completed"].includes(type)) {
      if (data.usage !== null && typeof data.usage === "object") usage = data.usage as Record<string, unknown>;
    }
  }
  const value = (raw: unknown) => (typeof raw === "number" && Number.isFinite(raw) ? raw : ("unavailable" as const));
  const byTool: Record<string, number> = {};
  for (const name of toolCalls.values()) byTool[name] = (byTool[name] ?? 0) + 1;
  return {
    modelSteps,
    observedModels: [...models],
    gatewayGenerationIds: generationIds,
    toolCalls: { total: toolCalls.size, byTool },
    tokens: usage
      ? {
          input: value(usage.inputTokens),
          output: value(usage.outputTokens),
          cacheRead: value(usage.cacheReadTokens),
          cacheWrite: value(usage.cacheWriteTokens),
        }
      : ("unavailable" as const),
    costUsd: usage ? value(usage.costUsd) : ("unavailable" as const),
  };
}
