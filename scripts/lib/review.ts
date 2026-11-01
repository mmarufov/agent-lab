import type { ReviewSource } from "@agent-lab/contracts";
import { createPool } from "@agent-lab/lab/database";
import { acquireExecution } from "@agent-lab/lab/jobs";
import { reviewSavedRun, type StartedReview } from "@agent-lab/lab/reviews";
import { generateReview, reviewerConfigs } from "../../my-agent/client/review";

/** The reviewer configuration for a run's source, with the LAB_REVIEW_MODEL override applied. */
export function reviewerConfigFor(source: ReviewSource) {
  const configuration = reviewerConfigs[source];
  return { ...configuration, modelId: process.env.LAB_REVIEW_MODEL || configuration.modelId };
}

export async function runReview(
  pool: ReturnType<typeof createPool>,
  runId: string,
  options: {
    signal?: AbortSignal;
    jobId?: string;
    onCreated?: (attempt: StartedReview) => void;
  } = {},
) {
  const lease = await acquireExecution(pool);
  const signal = AbortSignal.any([
    lease.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  try {
    return await reviewSavedRun(
      pool,
      runId,
      reviewerConfigFor,
      async (input, request) => {
        if (
          !process.env.LAB_REVIEW_GATEWAY_API_KEY &&
          !process.env.AI_GATEWAY_API_KEY &&
          !process.env.VERCEL_OIDC_TOKEN
        ) {
          throw Object.assign(new Error("Missing Gateway credentials."), {
            name: "GatewayAuthenticationError",
          });
        }
        // request.configuration is the one saved with this attempt.
        return generateReview(input, request);
      },
      { ...options, signal },
    );
  } finally {
    await lease.release();
  }
}
