import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  executionRequestSchema,
  REVIEW_MAX_INPUT_BYTES,
  type ExecutionRequest,
} from "@agent-lab/contracts";
import { COVERAGE_EVALUATOR_VERSION } from "./coverage";
import { transaction } from "./database";
import { DAILY_FEED_AVAILABILITY_PROFILE } from "./daily-coverage";
import { DailyCaptureError, dailyCapturesDir, readDailyCapture } from "./daily-evidence";
import { reviewBlocker, reviewInputProblem } from "./reviews";
import { createRunStore, settleRun } from "./runs";

const executionLock = 713906422;
const workerLock = 713906423;
const admissionLock = 713906424;
export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export interface ExecutionJob {
  id: string;
  command: ExecutionRequest;
  kind: "investigate" | "review" | "coverage";
  runId: string | null;
  reviewId: string | null;
  /** For an automatic coverage job: the investigation job whose completion queued it. */
  scheduledBy: string | null;
  status: JobStatus;
  cancelRequested: boolean;
  error: string | null;
}
const columns = `id, command, kind, run_id AS "runId", review_id AS "reviewId", scheduled_by AS "scheduledBy", status,
  cancel_requested AS "cancelRequested", error`;

/** What a finished operation queues next, in the same transaction: coverage of the Daily run it completed. */
export interface FollowUp {
  kind: "coverage";
  runId: string;
}

const stopped = "Local worker stopped before this operation settled. Inspect the saved evidence before starting a new operation.";

export class JobError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "busy"
      | "offline"
      | "conflict"
      | "invalid"
      | "missing",
  ) {
    super(message);
  }
}

// Held on a dedicated PostgreSQL connection, shared by the CLI and web worker.
// Scope locks to the current schema so isolated test databases remain independent.
// A lost connection aborts the caller; it must stop its model operation before retrying.
export async function acquireExecution(
  pool: Pool,
  role: "execution" | "worker" = "execution",
) {
  const client = await pool.connect();
  const controller = new AbortController();
  const onError = () =>
    controller.abort(new Error("The execution lock connection was lost."));
  client.on("error", onError);
  const key = role === "worker" ? workerLock : executionLock;
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext(current_schema()), $1::int) AS locked",
      [key],
    );
    if (!result.rows[0].locked)
      throw new JobError(
        role === "worker"
          ? "A local worker is already running."
          : "The runner is busy. Wait for the active operation.",
        "busy",
      );
  } catch (error) {
    client.removeListener("error", onError);
    client.release(true);
    throw error;
  }
  let released = false;
  return {
    signal: controller.signal,
    async release() {
      if (released) return;
      released = true;
      try {
        if (!controller.signal.aborted)
          await client.query("SELECT pg_advisory_unlock(hashtext(current_schema()), $1::int)", [key]);
      } finally {
        client.removeListener("error", onError);
        client.release(controller.signal.aborted);
      }
    },
  };
}

export function createJobStore(pool: Pool, options: { capturesDir?: string } = {}) {
  const capturesDir = options.capturesDir ?? dailyCapturesDir();
  const hasCoverage = async (runId: string) =>
    Boolean((await pool.query(
      "SELECT 1 FROM lab_coverage_assessments WHERE run_id = $1 AND profile_version = $2 AND evaluator_version = $3",
      [runId, DAILY_FEED_AVAILABILITY_PROFILE, COVERAGE_EVALUATOR_VERSION],
    )).rowCount);
  const store = {
    async register(owner: string) {
      await pool.query(
        `INSERT INTO lab_worker (singleton, owner) VALUES (true, $1)
        ON CONFLICT (singleton) DO UPDATE SET owner = $1, heartbeat_at = clock_timestamp()`,
        [owner],
      );
    },
    async heartbeat(owner: string) {
      const result = await pool.query(
        "UPDATE lab_worker SET heartbeat_at = clock_timestamp() WHERE owner = $1",
        [owner],
      );
      if (result.rowCount !== 1)
        throw new Error("Local worker ownership was lost.");
    },
    async unregister(owner: string) {
      await pool.query("DELETE FROM lab_worker WHERE owner = $1", [owner]);
    },
    async availability() {
      const result = await pool.query<{
        online: boolean;
        busy: boolean;
        activeJobId: string | null;
      }>(
        `SELECT EXISTS(SELECT 1 FROM lab_worker WHERE heartbeat_at > clock_timestamp() - interval '10 seconds') AS online,
          (EXISTS(SELECT 1 FROM lab_execution_jobs WHERE status IN ('queued', 'running')) OR
           EXISTS(SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = (hashtext(current_schema())::bigint & 4294967295)::oid AND objid = ${executionLock} AND objsubid = 2
             AND database = (SELECT oid FROM pg_database WHERE datname = current_database()))) AS busy,
          (SELECT id FROM lab_execution_jobs WHERE status IN ('queued', 'running')) AS "activeJobId"`,
      );
      return result.rows[0];
    },
    async submit(raw: ExecutionRequest) {
      const command = executionRequestSchema.parse(raw);
      return transaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()), $1::int)", [admissionLock]);
        const existing = await client.query<
          ExecutionJob & { matches: boolean }
        >(
          `SELECT ${columns}, command = $2::jsonb AS matches FROM lab_execution_jobs WHERE id = $1`,
          [command.requestId, JSON.stringify(command)],
        );
        if (existing.rows[0]) {
          if (!existing.rows[0].matches)
            throw new JobError(
              "This request ID was already used for a different operation.",
              "conflict",
            );
          return existing.rows[0];
        }
        const state = await store.availability();
        if (!state.online)
          throw new JobError(
            "The local runner is offline. Start pnpm dev:lab.",
            "offline",
          );
        if (state.busy)
          throw new JobError(
            "The runner is busy. Wait for the active operation.",
            "busy",
          );
        if (command.kind === "investigate" && "captureId" in command) {
          // Checked here so a bad choice is refused at once. The worker checks
          // the recording again before it grants Eve access to the files.
          try {
            await readDailyCapture(capturesDir, command.captureId);
          } catch (error) {
            if (error instanceof DailyCaptureError)
              throw new JobError(`${error.message} Choose another recording.`, error.code === "missing" ? "missing" : "invalid");
            throw error;
          }
        }
        if (command.kind === "review" || command.kind === "coverage") {
          const run = await createRunStore(pool).getAny(command.runId).catch((error: unknown) => {
            throw error instanceof Error && /not found/i.test(error.message)
              ? new JobError("This investigation was not found.", "missing")
              : error;
          });
          if (command.kind === "review") {
            const blocker = reviewBlocker(run) ?? reviewInputProblem(run, REVIEW_MAX_INPUT_BYTES);
            if (blocker) throw new JobError(blocker, "invalid");
          } else {
            if (run.source !== "daily_capture")
              throw new JobError("Evidence coverage is assessed for recorded Daily investigations only; simulated runs have outcome checks.", "invalid");
            if (run.status !== "completed")
              throw new JobError("Evidence coverage is checked for a completed investigation.", "invalid");
            if (run.integrity.status !== "verified")
              throw new JobError("This investigation's saved record does not match its integrity fingerprint, so its coverage cannot be checked.", "invalid");
            if (await hasCoverage(run.id))
              throw new JobError("This investigation already has a saved coverage assessment.", "invalid");
          }
        }
        const inserted = await client.query<ExecutionJob>(
          `INSERT INTO lab_execution_jobs (id, command, kind, run_id)
          VALUES ($1, $2::jsonb, $3, $4) RETURNING ${columns}`,
          [
            command.requestId,
            JSON.stringify(command),
            command.kind,
            command.kind === "review" || command.kind === "coverage" ? command.runId : null,
          ],
        );
        return inserted.rows[0];
      });
    },
    async get(id: string) {
      const result = await pool.query<ExecutionJob>(
        `SELECT ${columns} FROM lab_execution_jobs WHERE id = $1`,
        [id],
      );
      if (!result.rows[0])
        throw new JobError("Operation not found.", "missing");
      return result.rows[0];
    },
    async activeForRun(runId: string) {
      const result = await pool.query<ExecutionJob>(
        `SELECT ${columns} FROM lab_execution_jobs WHERE run_id = $1 AND status IN ('queued', 'running')`,
        [runId],
      );
      return result.rows[0] ?? null;
    },
    async claim(owner: string) {
      const result = await pool.query<ExecutionJob>(
        `UPDATE lab_execution_jobs SET status = 'running', owner = $1
        WHERE id = (SELECT id FROM lab_execution_jobs WHERE status = 'queued' FOR UPDATE SKIP LOCKED LIMIT 1)
          AND EXISTS (SELECT 1 FROM lab_worker WHERE owner = $1 AND heartbeat_at > clock_timestamp() - interval '10 seconds')
        RETURNING ${columns}`,
        [owner],
      );
      return result.rows[0] ?? null;
    },
    async cancel(id: string) {
      await pool.query(
        `UPDATE lab_execution_jobs SET cancel_requested = true,
        status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
        finished_at = CASE WHEN status = 'queued' THEN clock_timestamp() ELSE finished_at END
        WHERE id = $1 AND status IN ('queued', 'running')`,
        [id],
      );
      return store.get(id);
    },
    /**
     * Settles an operation once. A completed investigation of a Daily run
     * can queue its coverage check in the same transaction, unless someone
     * asked to cancel it: a reader then always sees an active operation for
     * the run, and a repeated finish queues nothing more.
     */
    async finish(
      id: string,
      status: "completed" | "failed" | "cancelled",
      error?: string,
      next?: FollowUp,
    ) {
      await transaction(pool, async (client) => {
        const finished = await client.query<{ kind: ExecutionJob["kind"]; runId: string | null; cancelRequested: boolean }>(
          `UPDATE lab_execution_jobs SET status = $2, error = $3, finished_at = clock_timestamp()
          WHERE id = $1 AND status IN ('queued', 'running')
          RETURNING kind, run_id AS "runId", cancel_requested AS "cancelRequested"`,
          [id, status, error ?? null],
        );
        const job = finished.rows[0];
        if (!next || !job || status !== "completed" || job.kind !== "investigate" || job.cancelRequested || job.runId !== next.runId) return;
        const coverageId = randomUUID();
        await client.query(
          `INSERT INTO lab_execution_jobs (id, command, kind, run_id, scheduled_by)
          VALUES ($1, $2::jsonb, 'coverage', $3, $4) ON CONFLICT DO NOTHING`,
          [coverageId, JSON.stringify({ requestId: coverageId, kind: "coverage", runId: next.runId }), next.runId, id],
        );
      });
    },
    // Called only after acquiring the worker leader lock. Interrupted paid work
    // is retained as failed, never silently resubmitted to a model.
    async recover() {
      await transaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()), $1::int)", [admissionLock]);
        const active = await client.query<ExecutionJob>(
          `SELECT ${columns} FROM lab_execution_jobs WHERE status IN ('queued', 'running') FOR UPDATE`,
        );
        for (const job of active.rows) {
          if (job.kind === "coverage") {
            // Coverage makes no model request. A queued check still runs when the
            // worker starts; an interrupted one counts if it saved its assessment.
            if (job.status === "queued") continue;
            const saved = Boolean(job.runId) && (await hasCoverage(job.runId!));
            await client.query(
              "UPDATE lab_execution_jobs SET status = $2, error = $3, finished_at = clock_timestamp() WHERE id = $1",
              [job.id, saved ? "completed" : "failed", saved ? null : "Local worker stopped before this coverage check finished. Retry coverage; it makes no model request."],
            );
            continue;
          }
          let status: JobStatus = "failed";
          if (job.kind === "review") {
            await client.query(
              "UPDATE lab_investigation_reviews SET status = 'failed', error = $2, finished_at = clock_timestamp() WHERE id = $1 AND status = 'running'",
              [job.reviewId, stopped],
            );
            const saved = await client.query<{ status: JobStatus }>("SELECT status FROM lab_investigation_reviews WHERE id = $1", [job.reviewId]);
            status = saved.rows[0]?.status ?? "failed";
          } else if (job.runId) {
            // Finishing here freezes a Daily run's evidence report and seals the
            // record like any other finish; an answer saved before is kept.
            await settleRun(client, job.runId, { status: "failed", error: stopped });
            // Eve can outlive the worker. Its capture token stops working now.
            await client.query(
              `UPDATE lab_capture_access_grants SET revoked_at = now()
              WHERE revoked_at IS NULL AND id = (SELECT capture_grant_id FROM lab_investigation_runs WHERE id = $1)`,
              [job.runId],
            );
            const saved = await client.query<{ status: JobStatus }>("SELECT status FROM lab_investigation_runs WHERE id = $1", [job.runId]);
            status = saved.rows[0]?.status ?? "failed";
          }
          await client.query(
            "UPDATE lab_execution_jobs SET status = $2, error = $3, finished_at = clock_timestamp() WHERE id = $1",
            [job.id, status, status === "completed" ? null : stopped],
          );
        }
      });
    },
  };
  return store;
}
