import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  reviewConfigSchema, reviewInputSchema, reviewObservationSchema, reviewSchemaFor,
  type InvestigationReview, type ReviewConfig, type ReviewInput, type ReviewObservation,
} from "@agent-lab/contracts";
import { evaluateRun } from "./evaluate";
import { createRunStore } from "./runs";
import { transaction } from "./database";

interface ReviewRow {
  id: string;
  runId: string;
  configuration: ReviewConfig;
  promptHash: string;
  input: ReviewInput;
  evidenceCheck: ReturnType<typeof evaluateRun>;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  observation: ReviewObservation | null;
  review: InvestigationReview | null;
  error: string | null;
}

// Trusted controller access. No reviewer write tool or public endpoint.
export function createReviewStore(pool: Pool) {
  const store = {
    async start(runId: string, rawConfiguration: ReviewConfig, jobId?: string) {
      const configuration = reviewConfigSchema.parse(rawConfiguration);
      const run = await createRunStore(pool).get(runId);
      const evidenceCheck = evaluateRun(run);
      if (evidenceCheck.checks.execution.status !== "pass" || evidenceCheck.checks.answer.status !== "pass") {
        throw new Error("Review requires a completed investigation with a matching saved answer.");
      }
      if (evidenceCheck.checks.toolTrace.status !== "pass") throw new Error("Cannot review an invalid evidence trace; inspect the evidence checks first.");
      const logs = new Map(evidenceCheck.retrievedEvidence.map(({ log }) => [log.id, log]));
      const input = reviewInputSchema.parse({
        task: run.task, deploymentId: run.deploymentId, answer: run.answer, evidence: [...logs.values()],
      });
      if (Buffer.byteLength(JSON.stringify(input), "utf8") > configuration.settings.maxInputBytes) {
        throw new Error("Review input exceeds the configured size limit. No model request was made.");
      }
      const id = randomUUID();
      const hash = createHash("sha256").update(configuration.system).digest("hex");
      await transaction(pool, async (client) => {
        await client.query(
          `INSERT INTO lab_investigation_reviews (id, run_id, configuration, prompt_sha256, input, evidence_check)
           VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6::jsonb)`,
          [id, run.id, JSON.stringify(configuration), hash, JSON.stringify(input), JSON.stringify(evidenceCheck)],
        );
        if (jobId) {
          const linked = await client.query("UPDATE lab_execution_jobs SET review_id = $2 WHERE id = $1 AND kind = 'review' AND status = 'running' AND run_id = $3 AND review_id IS NULL", [jobId, id, run.id]);
          if (linked.rowCount !== 1) throw new Error("Cannot attach this review to its operation.");
        }
      });
      return { id, input };
    },

    async recordResponse(id: string, rawObservation: ReviewObservation) {
      const observation = reviewObservationSchema.parse(rawObservation);
      const result = await pool.query(
        `UPDATE lab_investigation_reviews SET observation = $2::jsonb
         WHERE id = $1 AND status = 'running' AND observation IS NULL`,
        [id, JSON.stringify(observation)],
      );
      if (result.rowCount !== 1) throw new Error("Review is missing, finished, or already has a model response.");
    },

    async finish(id: string, outcome:
      | { status: "completed"; review: unknown }
      | { status: "failed" | "cancelled"; error: string }
    ) {
      const saved = await store.get(id);
      if (saved.status !== "running") throw new Error("Review is already finished.");
      const review = outcome.status === "completed" ? reviewSchemaFor(saved.input).parse(outcome.review) : null;
      const result = await pool.query(
        `UPDATE lab_investigation_reviews SET status = $2, finished_at = clock_timestamp(), review = $3::jsonb, error = $4
         WHERE id = $1 AND status = 'running'`,
        [id, outcome.status, review === null ? null : JSON.stringify(review), outcome.status === "completed" ? null : outcome.error],
      );
      if (result.rowCount !== 1) throw new Error("Review is missing or already finished.");
    },

    async get(id: string) {
      const result = await pool.query<ReviewRow>(
        `SELECT id, run_id AS "runId", configuration, prompt_sha256 AS "promptHash", input,
           evidence_check AS "evidenceCheck", status, started_at AS "startedAt", finished_at AS "finishedAt",
           (EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)::float8 AS "durationMs", observation, review, error
         FROM lab_investigation_reviews
         ${id === "latest" ? "ORDER BY started_at DESC, id DESC LIMIT 1" : "WHERE id = $1"}`,
        id === "latest" ? [] : [id],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Investigation review not found.");
      return { ...row, startedAt: row.startedAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null };
    },
  };
  return store;
}

export interface ReviewRequestOptions {
  signal?: AbortSignal;
  onResponse: (observation: ReviewObservation) => Promise<void>;
}

function safeReviewError(error: unknown) {
  const value = error !== null && typeof error === "object" ? error as { name?: unknown; statusCode?: unknown } : undefined;
  if (typeof value?.statusCode === "number") return `Model request failed (HTTP ${value.statusCode}). Check Gateway access or availability before retrying.`;
  if (value?.name === "TimeoutError") return "Review exceeded its time limit.";
  if (value?.name === "GatewayAuthenticationError" || value?.name === "AI_LoadAPIKeyError") return "Gateway authentication failed. Configure LAB_REVIEW_GATEWAY_API_KEY, AI_GATEWAY_API_KEY, or VERCEL_OIDC_TOKEN.";
  if (value?.name === "ZodError" || value?.name === "AI_NoObjectGeneratedError" || value?.name === "AI_NoOutputGeneratedError") {
    return "Reviewer output failed schema or evidence-reference validation. No valid assessment was saved.";
  }
  return "Review failed before a valid assessment could be saved. Check the saved response metadata and Gateway configuration.";
}

export async function reviewSavedRun(
  pool: Pool,
  runId: string,
  configuration: ReviewConfig,
  generate: (input: ReviewInput, options: ReviewRequestOptions) => Promise<unknown>,
  options: { signal?: AbortSignal; onCreated?: (id: string) => void; jobId?: string } = {},
) {
  options.signal?.throwIfAborted();
  const store = createReviewStore(pool);
  const { id, input } = await store.start(runId, configuration, options.jobId);
  try {
    options.onCreated?.(id);
    options.signal?.throwIfAborted();
    const review = await generate(input, { signal: options.signal, onResponse: (value) => store.recordResponse(id, value) });
    options.signal?.throwIfAborted();
    await store.finish(id, { status: "completed", review });
  } catch (error) {
    try {
      await store.finish(id, {
        status: options.signal?.aborted ? "cancelled" : "failed",
        error: options.signal?.aborted ? "Review cancelled." : safeReviewError(error),
      });
    } catch {
      throw new Error(`Could not save the final status of review ${id}. Inspect it before retrying.`);
    }
  }
  return store.get(id);
}
