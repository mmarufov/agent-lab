import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPool } from "../src/database";
import { createTrial, deleteTrials } from "../src/fixtures";
import { migrate } from "../src/migrate";
import { createRunStore } from "../src/runs";
import { createReviewStore, reviewSavedRun } from "../src/reviews";
import type { ReviewConfig, ReviewInput, ReviewObservation } from "@agent-lab/contracts";

const pool = createPool();
const runs = createRunStore(pool);
const trialIds: string[] = [];
const config: ReviewConfig = { modelId: "test/reviewer", system: "Review only.", promptVersion: "test-v1", schemaVersion: 1,
  settings: { maxOutputTokens: 1000, maxRetries: 0, timeoutMs: 1000, maxInputBytes: 65_536 } };
const observation: ReviewObservation = { responseId: "response-1", resolvedModelId: "test/reviewer", finishReason: "stop",
  usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100, costUsd: 0.001 } };
const answer = { diagnosis: "DATABASE_URL is missing.", evidenceIds: ["log-17"], uncertainty: "The reason is unknown." };
const review = {
  claims: [
    { field: "diagnosis", quote: "DATABASE_URL is missing.", verdict: "supported", evidenceIds: ["log-17"], explanation: "Explicit startup error." },
    { field: "uncertainty", quote: "The reason is unknown.", verdict: "supported", evidenceIds: [], explanation: "The cause of the missing configuration is not recorded." },
  ], missingEvidence: ["Configuration history."], summary: "The cause is supported by the available evidence.",
};
async function fixture(evidenceIds = ["log-17"], completed = true) {
  const trial = await createTrial(pool);
  trialIds.push(trial.trialId);
  const id = await runs.create({ trialId: trial.trialId, deploymentId: "B", task: "Investigate B.",
    instructions: "PRIVATE INVESTIGATOR INSTRUCTIONS", agentConfigSource: "private config" });
  if (!completed) return id;
  const data = { turnId: "turn-1", stepIndex: 0, sequence: 0 };
  const events = [
    { type: "actions.requested", data: { ...data, actions: [{ kind: "tool-call", callId: "call-1", toolName: "get_logs", input: { deploymentId: "B" } }] } },
    { type: "action.result", data: { ...data, status: "completed", result: { kind: "tool-result", callId: "call-1", toolName: "get_logs", output: {
      logs: [{ id: "log-17", deploymentId: "B", level: "error", message: "Startup failed: DATABASE_URL is missing." }],
    } } } },
    { type: "result.completed", data: { ...data, result: { ...answer, evidenceIds } } },
  ];
  for (const [index, event] of events.entries()) await runs.appendEvent(id, { ...event, meta: { id: `event-${index}`, at: "2026-10-21T01:00:00Z" } });
  await runs.finish(id, { status: "completed", answer: { ...answer, evidenceIds }, message: "PRIVATE CHAT TEXT" });
  return id;
}
beforeAll(() => migrate(pool));
afterAll(async () => { try { await deleteTrials(pool, trialIds); } finally { await pool.end(); } });

it("saves the exact review input, config, observation, and assessment for a fresh CLI to reopen", async () => {
  const runId = await fixture();
  const original = await runs.get(runId);
  let supplied: ReviewInput | undefined;
  const result = await reviewSavedRun(pool, runId, config, async (input, { onResponse }) => {
    supplied = input;
    await onResponse(observation);
    return review;
  });
  expect(result.status).toBe("completed");
  expect(result.runId).toBe(runId);
  expect(result.configuration).toEqual(config);
  expect(result.observation).toEqual(observation);
  expect(result.review).toEqual(review);
  expect(result.input).toEqual(supplied);
  expect(Object.keys(result.input).sort()).toEqual(["answer", "deploymentId", "evidence", "task"]);
  expect(JSON.stringify(supplied)).not.toContain("PRIVATE");
  expect(result.input.evidence.map((log) => log.id)).toEqual(["log-17"]);
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "packages/lab/src/cli.ts", "review", result.id, "--json"]);
  expect(JSON.parse(stdout)).toEqual(result);
  expect(await runs.get(runId)).toEqual(original);
});

it("keeps failed objective checks even when the reviewer says the diagnosis is supported", async () => {
  const runId = await fixture(["log-999"]);
  const result = await reviewSavedRun(pool, runId, config, async (_input, { onResponse }) => {
    await onResponse(observation);
    return review;
  });
  expect(result.status).toBe("completed");
  expect(result.review?.claims[0].verdict).toBe("supported");
  expect(result.evidenceCheck.checks.citations.status).toBe("fail");
  expect(result.evidenceCheck.missingEvidenceIds).toEqual(["log-999"]);
});

it("records a model failure without publishing a review or leaking the raw error", async () => {
  const runId = await fixture();
  const result = await reviewSavedRun(pool, runId, config, async () => {
    throw Object.assign(new Error("SECRET provider error body"), { statusCode: 503 });
  });
  expect(result.status).toBe("failed");
  expect(result.error).toContain("503");
  expect(result.review).toBeNull();
  expect(result.observation).toBeNull();
  expect(JSON.stringify(result)).not.toContain("SECRET");
});

it("retains charged usage when a review has invalid evidence references", async () => {
  const runId = await fixture();
  const result = await reviewSavedRun(pool, runId, config, async (_input, { onResponse }) => {
    await onResponse(observation);
    return { ...review, claims: [{ ...review.claims[0], evidenceIds: ["invented"] }, review.claims[1]] };
  });
  expect(result.status).toBe("failed");
  expect(result.review).toBeNull();
  expect(result.observation?.usage.costUsd).toBe(0.001);
});

it("records cancellation without accepting a late response", async () => {
  const runId = await fixture();
  const controller = new AbortController();
  const result = await reviewSavedRun(pool, runId, config, async (_input, { onResponse }) => {
    await onResponse(observation);
    controller.abort();
    return review;
  }, { signal: controller.signal });
  expect(result.status).toBe("cancelled");
  expect(result.review).toBeNull();
  expect(result.observation).toEqual(observation);
});

it("does not call a reviewer for an unfinished investigation", async () => {
  const runId = await fixture([], false);
  let called = false;
  await expect(reviewSavedRun(pool, runId, config, async () => { called = true; return review; })).rejects.toThrow(/completed|answer/i);
  expect(called).toBe(false);
});

it("keeps repeated reviews as separate attempts and prevents overwriting a finished attempt", async () => {
  const runId = await fixture();
  const generate = async (_input: ReviewInput, { onResponse }: { onResponse: (value: ReviewObservation) => Promise<void> }) => {
    await onResponse(observation); return review;
  };
  const first = await reviewSavedRun(pool, runId, config, generate);
  const second = await reviewSavedRun(pool, runId, config, generate);
  expect(first.id).not.toBe(second.id);
  const store = createReviewStore(pool);
  await expect(store.finish(first.id, { status: "failed", error: "Overwrite" })).rejects.toThrow(/finished/);
  expect(await store.get(first.id)).toEqual(first);
});

it("saves a failed review attempt from the CLI when standalone Gateway credentials are missing", async () => {
  const runId = await fixture();
  const result = await new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, ["--import", "tsx", "scripts/lab-review.ts", runId], {
      env: { ...process.env, LAB_REVIEW_GATEWAY_API_KEY: "", AI_GATEWAY_API_KEY: "", VERCEL_OIDC_TOKEN: "" }, timeout: 10_000,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
  expect(result.code).toBe(1);
  const reviewId = result.stdout.match(/^Review: (.+)$/m)?.[1];
  expect(reviewId).toBeTruthy();
  expect(result.stderr).toContain("AI_GATEWAY_API_KEY");
  const saved = await createReviewStore(pool).get(reviewId!);
  expect(saved.status).toBe("failed");
  expect(saved.runId).toBe(runId);
  expect(saved.review).toBeNull();
  expect(saved.observation).toBeNull();
});
