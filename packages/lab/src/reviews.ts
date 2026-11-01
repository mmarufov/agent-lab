import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import {
  reviewConfigSchema, reviewInputSchema, reviewObservationSchema, reviewSchemaFor,
  type InvestigationReview, type ReviewConfig, type ReviewInput, type ReviewObservation,
} from "@agent-lab/contracts";
import { dailyReviewInputSchema, orderDailyRecords, type DailyReviewInput } from "@agent-lab/contracts/daily-review";
import { evaluateRun } from "./evaluate";
import { readDailyEvidence, type DailyEvidenceReport } from "./daily-evaluate";
import { EVIDENCE } from "./daily-evidence";
import { createRunStore, requireVerifiedIntegrity, type DailyRun, type RunSource, type SimulatedRun } from "./runs";
import { transaction } from "./database";

type Status = "running" | "completed" | "failed" | "cancelled";
/** Reviews saved before migration 009 have no source in their configuration; all of them reviewed simulated runs. */
type SavedReviewConfig = Omit<ReviewConfig, "source"> & { source?: RunSource };

interface CommonReview {
  id: string;
  runId: string;
  configuration: SavedReviewConfig;
  promptHash: string;
  status: Status;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  observation: ReviewObservation | null;
  review: InvestigationReview | null;
  error: string | null;
}

/** One saved review attempt. Its source is the reviewed run's source. */
export type SavedReview =
  | (CommonReview & { source: "simulated"; input: ReviewInput; evidenceCheck: ReturnType<typeof evaluateRun> })
  | (CommonReview & { source: "daily_capture"; input: DailyReviewInput; evidenceCheck: DailyEvidenceReport });

const requiresAnswer = "Review requires a completed investigation with a matching saved answer.";
const requiresTrace = "Cannot review an invalid evidence trace; inspect the evidence checks first.";

function prepareSimulated(run: SimulatedRun) {
  const evidenceCheck = evaluateRun(run);
  if (evidenceCheck.checks.execution.status !== "pass" || evidenceCheck.checks.answer.status !== "pass") throw new Error(requiresAnswer);
  if (evidenceCheck.checks.toolTrace.status !== "pass") throw new Error(requiresTrace);
  const logs = new Map(evidenceCheck.retrievedEvidence.map(({ log }) => [log.id, log]));
  const input = reviewInputSchema.parse({
    task: run.task, deploymentId: run.deploymentId, answer: run.answer, evidence: [...logs.values()],
  });
  return { input, evidenceCheck };
}

// A Daily review's evidence check is the report frozen when the investigation
// finished. The saved events must still produce that report, and the reviewer
// receives exactly the records it counts. Capture files are never reopened.
function prepareDaily(run: DailyRun) {
  const frozen = run.evidenceReport;
  if (run.status !== "completed" || !frozen) throw new Error(requiresAnswer);
  const { report, records } = readDailyEvidence({ ...run, evidenceSha256: run.captureSha256[EVIDENCE] });
  if (!isDeepStrictEqual(report, frozen)) {
    throw new Error(`The saved events of run ${run.id} no longer produce the evidence report frozen when it finished. No review was created; inspect it with pnpm lab evaluate.`);
  }
  if (frozen.checks.execution.status !== "pass" || frozen.checks.answer.status !== "pass") throw new Error(requiresAnswer);
  if (frozen.checks.toolTrace.status !== "pass") throw new Error(requiresTrace);
  const input = dailyReviewInputSchema.parse({
    task: run.task, captureId: run.captureId, evidenceSha256: run.captureSha256[EVIDENCE], answer: run.answer,
    ...orderDailyRecords(records),
  });
  const supplied = [...input.evidence, ...input.untimedEvidence].map((record) => record.id).sort();
  if (!isDeepStrictEqual(supplied, [...new Set(frozen.retrievedEvidence.map((record) => record.id))].sort())) {
    throw new Error("The records prepared for review differ from those the frozen evidence report counts. No review was created.");
  }
  return { input, evidenceCheck: frozen };
}

// Trusted controller access. No reviewer write tool or public endpoint.
export function createReviewStore(pool: Pool) {
  const store = {
    /** Saves a running attempt with its exact input, configuration, and evidence check. No model is called. */
    async start(runId: string, rawConfiguration: ReviewConfig, jobId?: string) {
      const configuration = reviewConfigSchema.parse(rawConfiguration);
      const run = await createRunStore(pool).getAny(runId);
      if (configuration.source !== run.source) {
        throw new Error(`Reviewer configuration ${configuration.promptVersion} is for ${configuration.source} runs; run ${run.id} is a ${run.source} run.`);
      }
      // A running run is refused below as unfinished; a finished one must still match its fingerprint.
      if (run.status !== "running") requireVerifiedIntegrity(run, "No review was created");
      const { input, evidenceCheck } = run.source === "daily_capture" ? prepareDaily(run) : prepareSimulated(run);
      const bytes = Buffer.byteLength(JSON.stringify(input), "utf8");
      if (bytes > configuration.settings.maxInputBytes) {
        throw new Error(`Review input is ${bytes} bytes, over the ${configuration.settings.maxInputBytes}-byte limit. No review was created and no model request was made; evidence is never truncated, summarized, or split.`);
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
      return { id, runId: run.id, source: run.source, input, configuration };
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

    async get(id: string): Promise<SavedReview> {
      const result = await pool.query<Omit<CommonReview, "startedAt" | "finishedAt"> & {
        source: RunSource; input: unknown; evidenceCheck: unknown; startedAt: Date; finishedAt: Date | null;
      }>(
        `SELECT v.id, v.run_id AS "runId", r.source, v.configuration, v.prompt_sha256 AS "promptHash", v.input,
           v.evidence_check AS "evidenceCheck", v.status, v.started_at AS "startedAt", v.finished_at AS "finishedAt",
           (EXTRACT(EPOCH FROM (v.finished_at - v.started_at)) * 1000)::float8 AS "durationMs", v.observation, v.review, v.error
         FROM lab_investigation_reviews v JOIN lab_investigation_runs r ON r.id = v.run_id
         ${id === "latest" ? "ORDER BY v.started_at DESC, v.id DESC LIMIT 1" : "WHERE v.id = $1"}`,
        id === "latest" ? [] : [id],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Investigation review not found.");
      return { ...row, startedAt: row.startedAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null } as SavedReview;
    },
  };
  return store;
}

export type StartedReview = Awaited<ReturnType<ReturnType<typeof createReviewStore>["start"]>>;

export interface ReviewRequestOptions {
  /** The configuration saved with the attempt; the request must use exactly this. */
  configuration: ReviewConfig;
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
  /** The reviewer configuration for a run of this source. */
  configure: (source: RunSource) => ReviewConfig,
  generate: (input: ReviewInput | DailyReviewInput, request: ReviewRequestOptions) => Promise<unknown>,
  options: { signal?: AbortSignal; onCreated?: (attempt: StartedReview) => void; jobId?: string } = {},
) {
  options.signal?.throwIfAborted();
  const store = createReviewStore(pool);
  // Resolve 'latest' once. The configuration is chosen for this run's source,
  // and the attempt belongs to this run even if a newer run starts meanwhile.
  const run = await createRunStore(pool).getAny(runId);
  const attempt = await store.start(run.id, configure(run.source), options.jobId);
  const { id } = attempt;
  try {
    options.onCreated?.(attempt);
    options.signal?.throwIfAborted();
    const review = await generate(attempt.input, {
      configuration: attempt.configuration, signal: options.signal, onResponse: (value) => store.recordResponse(id, value),
    });
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
