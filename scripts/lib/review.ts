import { createPool } from "@agent-lab/lab/database";
import { acquireExecution } from "@agent-lab/lab/jobs";
import { reviewSavedRun } from "@agent-lab/lab/reviews";
import { generateReview, reviewerConfig } from "../../my-agent/client/review";

export async function runReview(
  pool: ReturnType<typeof createPool>,
  runId: string,
  options: {
    signal?: AbortSignal;
    jobId?: string;
    onCreated?: (id: string) => void;
  } = {},
) {
  const lease = await acquireExecution(pool);
  const signal = AbortSignal.any([
    lease.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  const configuration = {
    ...reviewerConfig,
    modelId: process.env.LAB_REVIEW_MODEL || reviewerConfig.modelId,
  };
  try {
    return await reviewSavedRun(
      pool,
      runId,
      configuration,
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
        return generateReview(input, {
          ...request,
          modelId: configuration.modelId,
        });
      },
      { ...options, signal },
    );
  } finally {
    await lease.release();
  }
}
