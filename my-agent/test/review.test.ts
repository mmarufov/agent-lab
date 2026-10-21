import { expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { generateReview } from "../client/review";

const input = {
  task: "Investigate B.", deploymentId: "B",
  answer: { diagnosis: "DATABASE_URL is missing.", evidenceIds: ["log-17"], uncertainty: "Why it is missing is unknown." },
  evidence: [{ id: "log-17", deploymentId: "B", level: "error", message: "Startup failed: DATABASE_URL is missing." }],
};
const review = {
  claims: [
    { field: "diagnosis", quote: "DATABASE_URL is missing.", verdict: "supported", evidenceIds: ["log-17"], explanation: "The startup error explicitly names the missing variable." },
    { field: "uncertainty", quote: "Why it is missing is unknown.", verdict: "supported", evidenceIds: [], explanation: "The log does not establish why." },
  ],
  missingEvidence: ["Configuration history."], summary: "The stated cause is supported within the available logs.",
};
function response(output: unknown = review) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 40, text: 40, reasoning: undefined } },
    warnings: [], response: { id: "response-example", timestamp: new Date(), modelId: "test/reviewer" },
    providerMetadata: { gateway: { cost: "0.0012" } },
  };
}

it("sends a fresh system/user request with only the selected task, answer, and evidence, and records response usage", async () => {
  const observed: unknown[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async () => response() });
  const result = await generateReview(input, { model, onResponse: async (value: unknown) => { observed.push(value); } });
  expect(result).toEqual(review);
  const calls = model.doGenerateCalls;
  expect(calls).toHaveLength(1);
  expect(calls[0].prompt.map((message) => message.role)).toEqual(["system", "user"]);
  expect(calls[0].tools ?? []).toEqual([]);
  const user = calls[0].prompt[1];
  if (user.role !== "user" || user.content[0].type !== "text") throw new Error("Expected a text user message.");
  expect(JSON.parse(user.content[0].text)).toEqual(input);
  expect(observed).toEqual([{
    responseId: "response-example", resolvedModelId: "test/reviewer", finishReason: "stop",
    usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140, costUsd: 0.0012 },
  }]);
});

it.each([
  ["invented evidence", { ...review, claims: [{ ...review.claims[0], evidenceIds: ["log-999"] }, review.claims[1]] }],
  ["invented quotation", { ...review, claims: [{ ...review.claims[0], quote: "The disk is full." }, review.claims[1]] }],
  ["missing diagnosis assessment", { ...review, claims: [review.claims[1]] }],
  ["invalid response shape", { approved: true }],
])("rejects %s while retaining reported usage", async (_name, output) => {
  const observations: unknown[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async () => response(output) });
  await expect(generateReview(input, { model, onResponse: async (value: unknown) => { observations.push(value); } })).rejects.toThrow();
  expect(observations).toHaveLength(1);
  expect(model.doGenerateCalls).toHaveLength(1);
});

it("does not retry a failed model call or turn it into a review", async () => {
  const model = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("Service unavailable"); } });
  await expect(generateReview(input, { model })).rejects.toThrow();
  expect(model.doGenerateCalls).toHaveLength(1);
});

it("rejects oversized input before calling the model", async () => {
  const model = new MockLanguageModelV4({ doGenerate: async () => response() });
  await expect(generateReview({ ...input, task: "x".repeat(70_000) }, { model })).rejects.toThrow(/large|limit/i);
  expect(model.doGenerateCalls).toHaveLength(0);
});

it("passes cancellation to the model instead of starting a review after cancellation", async () => {
  const model = new MockLanguageModelV4({ doGenerate: async () => response() });
  await expect(generateReview(input, { model, signal: AbortSignal.abort() })).rejects.toThrow();
  expect(model.doGenerateCalls).toHaveLength(0);
});

it("keeps unknown cost unknown instead of reporting zero", async () => {
  const observations: unknown[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async () => ({ ...response(), providerMetadata: undefined }) });
  await generateReview(input, { model, onResponse: async (value: unknown) => { observations.push(value); } });
  expect(observations[0]).toMatchObject({ usage: { costUsd: null } });
});

it("does not publish a valid-looking JSON response when the model was cut off", async () => {
  const model = new MockLanguageModelV4({ doGenerate: async () => ({ ...response(), finishReason: { unified: "length", raw: "length" } }) });
  await expect(generateReview(input, { model })).rejects.toThrow(/complete/);
});

it("stops when the metadata sink fails instead of silently losing reported usage", async () => {
  const model = new MockLanguageModelV4({ doGenerate: async () => response() });
  await expect(generateReview(input, { model, onResponse: async () => { throw new Error("Database unavailable"); } })).rejects.toThrow(/Database unavailable/);
});

it("aborts a pending provider request when its signal times out", async () => {
  const model = new MockLanguageModelV4({ doGenerate: async ({ abortSignal }) => new Promise((_resolve, reject) => {
    abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
  }) });
  await expect(generateReview(input, { model, signal: AbortSignal.timeout(30) })).rejects.toThrow();
  expect(model.doGenerateCalls).toHaveLength(1);
});
