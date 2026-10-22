import type { Pool } from "pg";
import { investigationAnswerSchema } from "@agent-lab/contracts";
import { createRunStore } from "./runs";
import { createReviewStore } from "./reviews";
import { evaluateRun } from "./evaluate";
import { unassessedOutcome, type OutcomeReport } from "./outcome";
import { createJobStore } from "./jobs";
import { projectActivity, elapsed, type ActivityItem } from "./activity";
export type { ActivityItem } from "./activity";

type Status = "running" | "completed" | "failed" | "cancelled";
export interface RunSummary {
  id: string;
  deploymentId: string;
  caseName: string | null;
  outcomeStatus: OutcomeReport["status"];
  status: Status;
  modelId: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  costUsd: number | null;
  reviewStatus: Status | null;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

// Display projections allowlist browser data; raw records stay in the run store.
export function createWebStore(pool: Pool) {
  return {
    async list(
      input: {
        deploymentId?: string;
        status?: string;
        cursor?: string;
        limit?: number;
      } = {},
    ) {
      const limit = Math.min(50, Math.max(1, input.limit ?? 50));
      const result = await pool.query<{
        id: string;
        deploymentId: string;
        caseName: string | null;
        outcomeStatus: OutcomeReport["status"];
        status: Status;
        modelId: string | null;
        startedAt: Date;
        finishedAt: Date | null;
        durationMs: number | null;
        usage: unknown;
        reviewStatus: Status | null;
      }>(
        `SELECT r.id, r.deployment_id AS "deploymentId", r.case_snapshot ->> 'name' AS "caseName",
        COALESCE(r.outcome_report ->> 'status', 'not_evaluated') AS "outcomeStatus", r.status, r.model_id AS "modelId",
        r.started_at AS "startedAt", r.finished_at AS "finishedAt",
        (EXTRACT(EPOCH FROM (r.finished_at - r.started_at)) * 1000)::float8 AS "durationMs", r.usage,
        (SELECT status FROM lab_investigation_reviews WHERE run_id = r.id ORDER BY started_at DESC, id DESC LIMIT 1) AS "reviewStatus"
        FROM lab_investigation_runs r
        WHERE ($1::text IS NULL OR r.deployment_id = $1) AND ($2::text IS NULL OR r.status = $2)
          AND ($3::uuid IS NULL OR (r.started_at, r.id) < (SELECT started_at, id FROM lab_investigation_runs WHERE id = $3))
        ORDER BY r.started_at DESC, r.id DESC LIMIT $4`,
        [
          input.deploymentId ?? null,
          input.status ?? null,
          input.cursor ?? null,
          limit + 1,
        ],
      );
      const items: RunSummary[] = result.rows
        .slice(0, limit)
        .map(({ usage, ...row }) => ({
          ...row,
          startedAt: row.startedAt.toISOString(),
          finishedAt: row.finishedAt?.toISOString() ?? null,
          costUsd: number(object(usage).costUsd),
        }));
      return {
        items,
        nextCursor: result.rows.length > limit ? items.at(-1)!.id : null,
      };
    },
    async get(id: string) {
      const run = await createRunStore(pool).get(id);
      const evaluation = evaluateRun(run);
      const answer = investigationAnswerSchema.safeParse(run.answer);
      const ids = await pool.query<{ id: string }>(
        "SELECT id FROM lab_investigation_reviews WHERE run_id = $1 ORDER BY started_at DESC, id DESC",
        [id],
      );
      const reviewStore = createReviewStore(pool);
      const reviews = await Promise.all(
        ids.rows.map(async ({ id }) => {
          const review = await reviewStore.get(id);
          return {
            id: review.id,
            status: review.status,
            startedAt: review.startedAt,
            finishedAt: review.finishedAt,
            durationMs: review.durationMs,
            modelId:
              review.observation?.resolvedModelId ??
              review.configuration.modelId,
            promptVersion: review.configuration.promptVersion,
            review: review.review,
            usage: review.observation?.usage ?? {
              inputTokens: null,
              outputTokens: null,
              totalTokens: null,
              costUsd: null,
            },
            error: review.error
              ? "Review did not complete. Check the local worker and Gateway configuration before retrying."
              : null,
            checks: review.evidenceCheck.checks,
          };
        }),
      );
      const operations = (
        await pool.query<{
          id: string;
          kind: "investigate" | "review";
          status: "queued" | Status;
          reviewId: string | null;
          cancelRequested: boolean;
          startedAt: Date;
          finishedAt: Date | null;
        }>(
          `SELECT id, kind, status, review_id AS "reviewId", cancel_requested AS "cancelRequested",
          created_at AS "startedAt", finished_at AS "finishedAt"
          FROM lab_execution_jobs WHERE run_id = $1 ORDER BY created_at, id`,
          [id],
        )
      ).rows.map((row) => ({
        ...row,
        startedAt: row.startedAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
      }));
      const activity = projectActivity({
        ...run,
        answer: answer.success ? answer.data : null,
      });
      if (run.status !== "running") {
        const checks = Object.values(evaluation.checks);
        activity.push({
          id: `${id}:checks`,
          operationId: id,
          actor: "checks",
          kind: "checks",
          title: "Evidence checks completed",
          detail: `${checks.filter((c) => c.status === "pass").length} passed · ${checks.filter((c) => c.status === "fail").length} failed · ${checks.filter((c) => c.status === "not_evaluated").length} not assessed`,
          status: checks.some((c) => c.status === "fail")
            ? "failed"
            : "completed",
          // These checks are calculated from saved data, not timed agent work.
          at: null,
          finishedAt: null,
          durationMs: null,
          eventIds: [],
        });
      }
      const reviewActivity: ActivityItem[] = [];
      for (const review of [...reviews].reverse()) {
        const job = operations.find(
          (operation) => operation.reviewId === review.id,
        );
        const operationId = job?.id ?? review.id;
        reviewActivity.push(
          {
            id: `${operationId}:requested`,
            operationId,
            actor: "reviewer",
            kind: "review",
            reviewId: review.id,
            title: "Review requested",
            detail:
              "Saved answer and received evidence · separate model context",
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
          },
        );
      }
      for (const job of operations.filter(
        (operation) => operation.kind === "review" && !operation.reviewId,
      )) {
        reviewActivity.push({
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
        });
      }
      activity.push(
        ...reviewActivity.sort((a, b) =>
          (a.at ?? "").localeCompare(b.at ?? ""),
        ),
      );
      const runner = await createJobStore(pool).availability();
      return {
        id: run.id,
        deploymentId: run.deploymentId,
        caseName: run.caseSnapshot?.name ?? null,
        caseVersion: run.caseVersion,
        outcome: run.outcomeReport ?? unassessedOutcome(),
        task: run.task,
        status: run.status,
        modelId: run.modelId,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        durationMs: run.durationMs,
        instructionsHash: run.instructionsHash,
        answer: answer.success ? answer.data : null,
        error: run.error
          ? "Investigation did not complete. Its recorded evidence is preserved. Check the local worker for details."
          : null,
        usage: {
          inputTokens: number(run.usage?.inputTokens),
          outputTokens: number(run.usage?.outputTokens),
          costUsd: number(run.usage?.costUsd),
        },
        activity,
        evidence: evaluation.retrievedEvidence,
        checks: evaluation.checks,
        evaluatorVersion: evaluation.evaluatorVersion,
        missingEvidenceIds: evaluation.missingEvidenceIds,
        ambiguousEvidenceIds: evaluation.ambiguousEvidenceIds,
        reviewEligible: [
          evaluation.checks.execution,
          evaluation.checks.answer,
          evaluation.checks.toolTrace,
        ].every((check) => check.status === "pass"),
        reviews,
        operations,
        runner: { online: runner.online, busy: runner.busy },
        activeJobId:
          operations.find((job) => ["queued", "running"].includes(job.status))
            ?.id ?? null,
      };
    },
  };
}
export type RunView = Awaited<
  ReturnType<ReturnType<typeof createWebStore>["get"]>
>;
export type RunsPage = Awaited<
  ReturnType<ReturnType<typeof createWebStore>["list"]>
>;
