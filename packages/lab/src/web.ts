import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import { investigationAnswerSchema, REVIEW_MAX_INPUT_BYTES } from "@agent-lab/contracts";
import { dailyCaptureStartedAt, type DailyHttpObservation } from "@agent-lab/contracts/daily-capture";
import { dailyInvestigationAnswerSchema } from "@agent-lab/contracts/daily-investigation";
import type { CoverageStatus } from "./coverage";
import { createCoverageStore, type SavedCoverageAssessment } from "./daily-coverage";
import { readDailyEvidence } from "./daily-evaluate";
import { evaluateRun } from "./evaluate";
import { createJobStore } from "./jobs";
import { unassessedOutcome, type OutcomeReport } from "./outcome";
import { createReviewStore, reviewBlocker, reviewInputProblem, type SavedReview } from "./reviews";
import { createRunStore, type DailyRun, type RunIntegrity, type SimulatedRun } from "./runs";
import {
  createRecordStore,
  dailyRecordView,
  elapsed,
  projectActivity,
  type ActivityItem,
  type RecordStore,
  type RecordView,
} from "./activity";
export type { ActivityItem, RecordView, ToolResultView } from "./activity";

type Status = "running" | "completed" | "failed" | "cancelled";
type JobStatus = "queued" | Status;
type CheckResult = { status: "pass" | "fail" | "not_evaluated"; reason: string };

/**
 * Where a Daily run's coverage stands. covered, missed and not_assessed are a
 * saved assessment's result; the rest describe why there is none yet.
 */
export type CoverageState =
  | CoverageStatus
  | "waiting" // the investigation is still running
  | "checking" // a coverage job is queued or running
  | "check_failed" // the latest coverage job failed or was cancelled
  | "not_checked" // a finished run nobody has assessed, such as a CLI run
  | "not_applicable"; // the investigation did not complete

interface SummaryBase {
  id: string;
  status: Status;
  modelId: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  costUsd: number | null;
  reviewStatus: Status | null;
}
export type RunSummary =
  | (SummaryBase & {
      source: "simulated";
      deploymentId: string;
      caseName: string | null;
      outcomeStatus: OutcomeReport["status"];
    })
  | (SummaryBase & {
      source: "daily_capture";
      captureId: string;
      /** When the capture started, read from its ID. */
      recordedAt: string;
      coverage: { state: CoverageState; missedFacts: string[] };
    });

/** One received record and every tool call that returned it. */
export interface ReceivedEvidence {
  /** Key into RunView.records. */
  key: string;
  id: string;
  receipts: { toolName: string; callId: string; requestEventId: string; resultEventId: string }[];
}

export interface ReviewView {
  id: string;
  status: Status;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  modelId: string;
  promptVersion: string;
  review: SavedReview["review"];
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; costUsd: number | null };
  error: string | null;
  /** The evidence checks saved with this attempt. */
  checks: Record<string, CheckResult>;
  /** How many records the reviewer was given. */
  inputRecords: number;
}

export interface OperationView {
  id: string;
  kind: "investigate" | "review" | "coverage";
  status: JobStatus;
  reviewId: string | null;
  cancelRequested: boolean;
  /** Queued by the investigation's completion rather than by a person. */
  automatic: boolean;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface CoverageAssessmentView {
  id: string;
  assessedAt: string;
  profileVersion: string;
  evaluatorVersion: string;
  result: CoverageStatus;
  reason: string;
  /** The fingerprint the record had when this was saved, and whether the record still has it now. */
  integrity: { sha256: string; eventCount: number; matchesCurrentRecord: boolean };
  scope: SavedCoverageAssessment["scope"];
  retrieved: { counted: boolean; records: number; httpObservations: number };
  facts: {
    id: string;
    label: string;
    statement: string;
    status: CoverageStatus;
    reason: string;
    requirements: { id: string; description: string; anyOf: string[]; matchedIds: string[] }[];
  }[];
  /**
   * Recorded observations a missed requirement would have accepted. They are
   * in the recording, but the investigator never received them, so they are
   * never received evidence and never reached the reviewer.
   */
  notRetrieved: Record<string, DailyHttpObservation>;
  answerInterpretation: { status: "not_assessed"; reason: string };
}

export interface CoverageView {
  state: CoverageState;
  /** The explicit coverage job this run may start: check one never assessed, or retry a failed check. */
  action: "check" | "retry" | null;
  /** Why that action cannot start right now. */
  blocked: string | null;
  /** The latest failed coverage job's explanation. */
  error: string | null;
  assessment: CoverageAssessmentView | null;
}

interface ViewBase {
  id: string;
  task: string;
  status: Status;
  modelId: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  instructionsHash: string;
  answer: { diagnosis: string; evidenceIds: string[]; uncertainty: string } | null;
  error: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
  integrity: RunIntegrity;
  activity: ActivityItem[];
  /** Every distinct record any recorded tool result returned, by key. */
  records: Record<string, RecordView>;
  /** The received evidence the checks count, once per record, in the order first received. */
  evidence: ReceivedEvidence[];
  checks: Record<"execution" | "answer" | "toolTrace" | "retrieval" | "citations", CheckResult>;
  evaluatorVersion: string;
  citedEvidenceIds: string[];
  missingEvidenceIds: string[];
  ambiguousEvidenceIds: string[];
  reviewEligible: boolean;
  /** Why a new review cannot start, when it cannot. */
  reviewBlocked: string | null;
  reviews: ReviewView[];
  operations: OperationView[];
  runner: { online: boolean; busy: boolean };
  activeJobId: string | null;
}
export type SimulatedRunView = ViewBase & {
  source: "simulated";
  deploymentId: string;
  caseName: string | null;
  caseVersion: number | null;
  outcome: OutcomeReport;
};
export type DailyRunView = ViewBase & {
  source: "daily_capture";
  captureId: string;
  /** When the capture started, read from its ID. */
  recordedAt: string;
  /** When the run's read access to the recording was revoked; null while it may still read. */
  accessRevokedAt: string | null;
  answerSchemaVersion: number;
  /** Whether the frozen evidence report is the one the saved events produce today. */
  reportReproduced: boolean;
  oversizedOnlyEvidenceIds: string[];
  coverage: CoverageView;
};
export type RunView = SimulatedRunView | DailyRunView;
export type RunsPage = { items: RunSummary[]; nextCursor: string | null };

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

/** Where coverage stands, from the saved assessment and the latest coverage job. */
export function coverageState(runStatus: Status, result: CoverageStatus | null, latestJob: JobStatus | null): CoverageState {
  if (result) return result;
  if (latestJob === "queued" || latestJob === "running") return "checking";
  if (runStatus === "running") return "waiting";
  if (runStatus !== "completed") return "not_applicable";
  return latestJob === "failed" || latestJob === "cancelled" ? "check_failed" : "not_checked";
}

/** The live stream stops once nothing about the run can change without a new request. */
export function snapshotSettled(view: RunView) {
  return view.status !== "running" && !view.activeJobId && !view.reviews.some((review) => review.status === "running");
}

// Run and review errors can carry Eve output or provider details. The browser
// sees only messages written by this code.
function runError(error: string | null, status: Status) {
  if (!error) return null;
  if (status === "cancelled") return "Investigation cancelled. Its recorded evidence is preserved.";
  if (error.startsWith("Local worker stopped")) return error;
  if (/exceeded (its|the) .*limit/.test(error)) return "Investigation exceeded its time limit. Its recorded evidence is preserved.";
  if (/session usage limit/.test(error)) return "Eve stopped at its session usage limit, and more usage was not approved. Its recorded evidence is preserved.";
  return "Investigation did not complete. Its recorded evidence is preserved. Check the local worker for details.";
}
const SAFE_REVIEW_ERROR =
  /^(Model request failed \(HTTP \d+\)|Review exceeded its time limit|Gateway authentication failed|Reviewer output failed|Review failed before|Review cancelled|Local worker stopped)/;
const reviewError = (error: string | null) =>
  !error ? null : SAFE_REVIEW_ERROR.test(error) ? error : "Review did not complete. Check the local worker and Gateway configuration before retrying.";

function reviewView(review: SavedReview): ReviewView {
  return {
    id: review.id,
    status: review.status,
    startedAt: review.startedAt,
    finishedAt: review.finishedAt,
    durationMs: review.durationMs,
    modelId: review.observation?.resolvedModelId ?? review.configuration.modelId,
    promptVersion: review.configuration.promptVersion,
    review: review.review,
    usage: review.observation?.usage ?? { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null },
    error: reviewError(review.error),
    checks: review.evidenceCheck.checks,
    inputRecords: review.source === "daily_capture"
      ? review.input.evidence.length + review.input.untimedEvidence.length
      : review.input.evidence.length,
  };
}

function reviewActivity(reviews: ReviewView[], operations: OperationView[]) {
  const items: ActivityItem[] = [];
  for (const review of [...reviews].reverse()) {
    const job = operations.find((operation) => operation.reviewId === review.id);
    const operationId = job?.id ?? review.id;
    items.push(
      {
        id: `${operationId}:requested`,
        operationId,
        actor: "reviewer",
        kind: "review",
        reviewId: review.id,
        title: "Review requested",
        detail: `Saved answer and ${review.inputRecords} received record${review.inputRecords === 1 ? "" : "s"} · separate model context`,
        status: "completed",
        at: job?.startedAt ?? review.startedAt,
        finishedAt: null,
        durationMs: null,
        eventIds: [],
      },
      {
        id: `${review.id}:response`,
        operationId,
        actor: "reviewer",
        kind: "review",
        reviewId: review.id,
        title:
          review.status === "running"
            ? "Reviewing the answer"
            : review.status === "completed"
              ? "Review completed"
              : review.status === "cancelled"
                ? "Review cancelled"
                : "Review interrupted",
        detail: review.modelId,
        status: review.status,
        at: review.startedAt,
        finishedAt: review.finishedAt,
        durationMs: elapsed(review.startedAt, review.finishedAt),
        eventIds: [],
        ...(review.status === "failed" && review.error ? { error: review.error } : {}),
      },
    );
  }
  for (const job of operations.filter((operation) => operation.kind === "review" && !operation.reviewId)) {
    items.push({
      id: `${job.id}:requested`,
      operationId: job.id,
      actor: "reviewer",
      kind: "review",
      title:
        job.status === "failed"
          ? "Review could not start"
          : job.status === "cancelled"
            ? "Review cancelled"
            : "Review requested",
      detail:
        job.cancelRequested && ["running", "queued"].includes(job.status)
          ? "Cancellation requested"
          : "Separate model review of the saved investigation",
      status: job.status,
      at: job.startedAt,
      finishedAt: job.finishedAt,
      durationMs: null,
      eventIds: [],
      ...(job.status === "failed" && job.error ? { error: job.error } : {}),
    });
  }
  return items.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
}

function checksActivity(runId: string, status: Status, checks: ViewBase["checks"], evaluatorVersion: string): ActivityItem[] {
  if (status === "running") return [];
  const values = Object.values(checks);
  const count = (value: CheckResult["status"]) => values.filter((check) => check.status === value).length;
  return [{
    id: `${runId}:checks`,
    operationId: runId,
    actor: "checks",
    kind: "checks",
    title: "Evidence checks completed",
    detail: `${count("pass")} passed · ${count("fail")} failed · ${count("not_evaluated")} not assessed · ${evaluatorVersion}`,
    status: values.some((check) => check.status === "fail") ? "failed" : "completed",
    // These checks are calculated from saved data, not timed agent work.
    at: null,
    finishedAt: null,
    durationMs: null,
    eventIds: [],
  }];
}

const coverageWords: Record<CoverageStatus, string> = { covered: "covered", missed: "missed", not_assessed: "not assessed" };

function coverageActivity(operations: OperationView[], assessment: SavedCoverageAssessment | null): ActivityItem[] {
  const jobs = operations.filter((operation) => operation.kind === "coverage");
  const items = jobs.map((job): ActivityItem => {
    const saved = job.status === "completed" && assessment;
    return {
      id: `${job.id}:coverage`,
      operationId: job.id,
      actor: "checks",
      kind: "coverage",
      title:
        job.status === "queued"
          ? "Coverage check queued"
          : job.status === "running"
            ? "Checking evidence coverage"
            : job.status === "completed"
              ? saved ? `Coverage saved: ${coverageWords[assessment.result]}` : "Coverage check finished"
              : job.status === "cancelled"
                ? "Coverage check cancelled"
                : "Coverage check failed",
      detail: `${job.automatic ? "Automatic after the answer" : "Requested"} · reads the full recording · no model request`,
      status: job.status,
      at: job.startedAt,
      finishedAt: job.finishedAt,
      durationMs: elapsed(job.startedAt, job.finishedAt),
      eventIds: [],
      ...(job.status === "failed" && job.error ? { error: job.error } : {}),
    };
  });
  // Saved by pnpm lab:coverage, with no browser operation.
  if (assessment && !jobs.some((job) => job.status === "completed")) {
    items.push({
      id: `${assessment.id}:coverage`,
      operationId: assessment.id,
      actor: "checks",
      kind: "coverage",
      title: `Coverage saved: ${coverageWords[assessment.result]}`,
      detail: "Saved by pnpm lab:coverage · no model request",
      status: "completed",
      at: assessment.assessedAt,
      finishedAt: null,
      durationMs: null,
      eventIds: [],
    });
  }
  return items;
}

function assessmentView(run: DailyRun, saved: SavedCoverageAssessment): CoverageAssessmentView {
  const missing = new Set(
    saved.retrieved.counted
      ? saved.facts.flatMap((fact) => fact.requirements.filter((requirement) => !requirement.matchedIds.length).flatMap((requirement) => requirement.anyOf))
      : [],
  );
  return {
    id: saved.id,
    assessedAt: saved.assessedAt,
    profileVersion: saved.profileVersion,
    evaluatorVersion: saved.evaluatorVersion,
    result: saved.result,
    reason: saved.reason,
    integrity: {
      sha256: saved.integrity.sha256,
      eventCount: saved.integrity.eventCount,
      matchesCurrentRecord: run.integrity.status === "verified" && run.integrity.fingerprint?.sha256 === saved.integrity.sha256,
    },
    scope: saved.scope,
    retrieved: { counted: saved.retrieved.counted, records: saved.retrieved.records, httpObservations: saved.retrieved.httpObservations },
    facts: saved.facts.map(({ id, label, statement, status, reason, requirements }) => ({
      id, label, statement, status, reason,
      requirements: requirements.map(({ id, description, anyOf, matchedIds }) => ({ id, description, anyOf, matchedIds })),
    })),
    notRetrieved: Object.fromEntries(saved.acceptableEvidence.filter((record) => missing.has(record.id)).map((record) => [record.id, record])),
    answerInterpretation: saved.answerInterpretation,
  };
}

/** Group receipts by stored record, keeping the order records were first received. */
function received(entries: { key: string; id: string; receipt: ReceivedEvidence["receipts"][number] }[]) {
  const grouped = new Map<string, ReceivedEvidence>();
  for (const { key, id, receipt } of entries) {
    const entry = grouped.get(key) ?? { key, id, receipts: [] };
    if (!entry.receipts.some((known) => known.resultEventId === receipt.resultEventId && known.callId === receipt.callId)) entry.receipts.push(receipt);
    grouped.set(key, entry);
  }
  return [...grouped.values()];
}

// Display projections allowlist browser data; raw records stay in the run store.
export function createWebStore(pool: Pool) {
  async function context(runId: string) {
    const ids = await pool.query<{ id: string }>(
      "SELECT id FROM lab_investigation_reviews WHERE run_id = $1 ORDER BY started_at DESC, id DESC",
      [runId],
    );
    const reviewStore = createReviewStore(pool);
    const reviews = await Promise.all(ids.rows.map(async ({ id }) => reviewView(await reviewStore.get(id))));
    const operations = (
      await pool.query<Omit<OperationView, "startedAt" | "finishedAt"> & { startedAt: Date; finishedAt: Date | null }>(
        `SELECT id, kind, status, review_id AS "reviewId", cancel_requested AS "cancelRequested",
        scheduled_by IS NOT NULL AS automatic, error, created_at AS "startedAt", finished_at AS "finishedAt"
        FROM lab_execution_jobs WHERE run_id = $1 ORDER BY created_at, id`,
        [runId],
      )
    ).rows.map((row) => ({
      ...row,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    }));
    const runner = await createJobStore(pool).availability();
    return {
      reviews,
      operations,
      runner: { online: runner.online, busy: runner.busy },
      activeJobId: operations.find((job) => job.status === "queued" || job.status === "running")?.id ?? null,
    };
  }

  function common(
    run: SimulatedRun | DailyRun,
    saved: Awaited<ReturnType<typeof context>>,
    store: RecordStore,
    activity: ActivityItem[],
  ) {
    return {
      id: run.id,
      task: run.task,
      status: run.status,
      modelId: run.modelId,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      instructionsHash: run.instructionsHash,
      error: runError(run.error, run.status),
      usage: {
        inputTokens: number(run.usage?.inputTokens),
        outputTokens: number(run.usage?.outputTokens),
        costUsd: number(run.usage?.costUsd),
      },
      integrity: run.integrity,
      records: store.records,
      activity: [...activity, ...reviewActivity(saved.reviews, saved.operations)],
      ...saved,
    };
  }

  function simulated(run: SimulatedRun, saved: Awaited<ReturnType<typeof context>>): SimulatedRunView {
    const store = createRecordStore();
    const answer = investigationAnswerSchema.safeParse(run.answer);
    const investigation = projectActivity({ ...run, answer: answer.success ? answer.data : null }, store);
    const evaluation = evaluateRun(run);
    const blocked = reviewBlocker(run) ?? reviewInputProblem(run, REVIEW_MAX_INPUT_BYTES);
    return {
      ...common(run, saved, store, [...investigation, ...checksActivity(run.id, run.status, evaluation.checks, evaluation.evaluatorVersion)]),
      source: "simulated",
      deploymentId: run.deploymentId,
      caseName: run.caseSnapshot?.name ?? null,
      caseVersion: run.caseVersion,
      outcome: run.outcomeReport ?? unassessedOutcome(),
      answer: answer.success ? { diagnosis: answer.data.diagnosis, evidenceIds: answer.data.evidenceIds, uncertainty: answer.data.uncertainty } : null,
      evidence: received(evaluation.retrievedEvidence.map(({ log, callId, requestEventId, resultEventId }) => ({
        key: store.keyOf({ type: "deployment_log", ...log }),
        id: log.id,
        receipt: { toolName: "get_logs", callId, requestEventId, resultEventId },
      }))),
      checks: evaluation.checks,
      evaluatorVersion: evaluation.evaluatorVersion,
      citedEvidenceIds: evaluation.citedEvidenceIds,
      missingEvidenceIds: evaluation.missingEvidenceIds,
      ambiguousEvidenceIds: evaluation.ambiguousEvidenceIds,
      reviewEligible: blocked === null,
      reviewBlocked: blocked,
    };
  }

  async function daily(run: DailyRun, saved: Awaited<ReturnType<typeof context>>): Promise<DailyRunView> {
    const store = createRecordStore();
    const answer = dailyInvestigationAnswerSchema.safeParse(run.answer);
    const capture = { captureId: run.captureId, evidenceSha256: run.captureSha256["evidence.jsonl"] };
    const investigation = projectActivity({ ...run, answer: answer.success ? answer.data : null, capture }, store);
    const { report: current, records } = readDailyEvidence({ ...run, ...capture });
    // A finished run shows the report frozen with it; a running one, the report so far.
    const report = run.evidenceReport ?? current;
    const reportReproduced = run.evidenceReport === null || isDeepStrictEqual(current, run.evidenceReport);
    // Each receipt names the result event that carried the record, so even an
    // ID returned with conflicting contents maps to the version that call returned.
    const keysByResult = new Map(
      investigation.flatMap((item) => item.tool?.results.map((result) => [result.eventId, result.recordKeys ?? []] as const) ?? []),
    );
    const contents = new Map(records.map((record) => [record.id, record]));
    const evidence = received(report.retrievedEvidence.map((receipt) => {
      const key = keysByResult.get(receipt.resultEventId)?.find((candidate) => store.records[candidate].id === receipt.id)
        ?? store.keyOf(dailyRecordView(contents.get(receipt.id)!));
      const { toolName, callId, requestEventId, resultEventId } = receipt;
      return { key, id: receipt.id, receipt: { toolName, callId, requestEventId, resultEventId } };
    }));

    const latest = await createCoverageStore(pool).latestForRun(run.id);
    const coverageJobs = saved.operations.filter((operation) => operation.kind === "coverage");
    const lastJob = coverageJobs.at(-1) ?? null;
    const state = coverageState(run.status, latest?.result ?? null, lastJob?.status ?? null);
    const action = state === "not_checked" ? "check" : state === "check_failed" ? "retry" : null;
    const reviewProblem = reviewBlocker(run)
      ?? (reportReproduced ? null : "The saved events no longer produce the evidence report frozen when the investigation finished, so it cannot be reviewed.")
      ?? reviewInputProblem(run, REVIEW_MAX_INPUT_BYTES);
    return {
      ...common(run, saved, store, [
        ...investigation,
        ...checksActivity(run.id, run.status, report.checks, report.evaluatorVersion),
        ...coverageActivity(saved.operations, latest),
      ]),
      source: "daily_capture",
      captureId: run.captureId,
      recordedAt: dailyCaptureStartedAt(run.captureId),
      accessRevokedAt: run.grantRevokedAt,
      answerSchemaVersion: run.resultSchemaVersion,
      reportReproduced,
      answer: answer.success ? answer.data : null,
      evidence,
      checks: report.checks,
      evaluatorVersion: report.evaluatorVersion,
      citedEvidenceIds: report.citedEvidenceIds,
      missingEvidenceIds: report.missingEvidenceIds,
      oversizedOnlyEvidenceIds: report.oversizedOnlyEvidenceIds,
      ambiguousEvidenceIds: report.ambiguousEvidenceIds,
      reviewEligible: reviewProblem === null,
      reviewBlocked: reviewProblem,
      coverage: {
        state,
        action,
        // Whether the worker is free is shown with every action; this is about the record.
        blocked: action && run.integrity.status !== "verified"
          ? "The saved record does not match its integrity fingerprint, so its coverage cannot be checked."
          : null,
        error: state === "check_failed" ? (lastJob?.error ?? "The coverage check did not finish.") : null,
        assessment: latest ? assessmentView(run, latest) : null,
      },
    };
  }

  return {
    async list(
      input: {
        source?: "simulated" | "daily_capture";
        deploymentId?: string;
        status?: string;
        cursor?: string;
        limit?: number;
      } = {},
    ): Promise<RunsPage> {
      const limit = Math.min(50, Math.max(1, input.limit ?? 50));
      const result = await pool.query<{
        id: string;
        source: "simulated" | "daily_capture";
        deploymentId: string | null;
        caseName: string | null;
        outcomeStatus: OutcomeReport["status"];
        captureId: string | null;
        status: Status;
        modelId: string | null;
        startedAt: Date;
        finishedAt: Date | null;
        durationMs: number | null;
        usage: unknown;
        reviewStatus: Status | null;
        coverageResult: CoverageStatus | null;
        missedFacts: string[];
        coverageJob: JobStatus | null;
      }>(
        `SELECT r.id, r.source, r.deployment_id AS "deploymentId", r.case_snapshot ->> 'name' AS "caseName",
        COALESCE(r.outcome_report ->> 'status', 'not_evaluated') AS "outcomeStatus", r.capture_id AS "captureId",
        r.status, r.model_id AS "modelId", r.started_at AS "startedAt", r.finished_at AS "finishedAt",
        (EXTRACT(EPOCH FROM (r.finished_at - r.started_at)) * 1000)::float8 AS "durationMs", r.usage,
        (SELECT status FROM lab_investigation_reviews WHERE run_id = r.id ORDER BY started_at DESC, id DESC LIMIT 1) AS "reviewStatus",
        c.result AS "coverageResult",
        COALESCE((SELECT array_agg(f.fact ->> 'label' ORDER BY f.position) FROM jsonb_array_elements(c.assessment -> 'facts') WITH ORDINALITY AS f(fact, position)
          WHERE f.fact ->> 'status' = 'missed'), '{}') AS "missedFacts",
        (SELECT status FROM lab_execution_jobs WHERE run_id = r.id AND kind = 'coverage' ORDER BY created_at DESC, id DESC LIMIT 1) AS "coverageJob"
        FROM lab_investigation_runs r
        LEFT JOIN LATERAL (SELECT result, assessment FROM lab_coverage_assessments WHERE run_id = r.id ORDER BY assessed_at DESC, id DESC LIMIT 1) c ON true
        WHERE ($1::text IS NULL OR r.source = $1) AND ($2::text IS NULL OR r.deployment_id = $2) AND ($3::text IS NULL OR r.status = $3)
          AND ($4::uuid IS NULL OR (r.started_at, r.id) < (SELECT started_at, id FROM lab_investigation_runs WHERE id = $4))
        ORDER BY r.started_at DESC, r.id DESC LIMIT $5`,
        [
          input.source ?? null,
          input.deploymentId ?? null,
          input.status ?? null,
          input.cursor ?? null,
          limit + 1,
        ],
      );
      const items = result.rows.slice(0, limit).map((row): RunSummary => {
        const base: SummaryBase = {
          id: row.id,
          status: row.status,
          modelId: row.modelId,
          startedAt: row.startedAt.toISOString(),
          finishedAt: row.finishedAt?.toISOString() ?? null,
          durationMs: row.durationMs,
          costUsd: number(object(row.usage).costUsd),
          reviewStatus: row.reviewStatus,
        };
        return row.source === "daily_capture"
          ? {
              ...base,
              source: "daily_capture",
              captureId: row.captureId!,
              recordedAt: dailyCaptureStartedAt(row.captureId!),
              coverage: { state: coverageState(row.status, row.coverageResult, row.coverageJob), missedFacts: row.missedFacts },
            }
          : { ...base, source: "simulated", deploymentId: row.deploymentId!, caseName: row.caseName, outcomeStatus: row.outcomeStatus };
      });
      return {
        items,
        nextCursor: result.rows.length > limit ? items.at(-1)!.id : null,
      };
    },

    /** One run's saved state for the browser. Reading never starts work or saves an assessment. */
    async get(id: string): Promise<RunView> {
      const run = await createRunStore(pool).getAny(id);
      const saved = await context(run.id);
      return run.source === "daily_capture" ? daily(run, saved) : simulated(run, saved);
    },
  };
}
