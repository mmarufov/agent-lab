import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPool } from "../src/database";
import { createTrial, deleteTrials } from "../src/fixtures";
import { migrate } from "../src/migrate";
import { createRunStore } from "../src/runs";

const pool = createPool();
const runs = createRunStore(pool);
const trialIds: string[] = [];
const answer = { diagnosis: "Startup configuration was missing.", evidenceIds: ["log-17"], uncertainty: "No later evidence." };
const toolEvent = {
  type: "action.result",
  meta: { id: "event-tool", at: "2026-10-20T12:00:00.000Z" },
  data: { status: "completed", result: { kind: "tool-result", toolName: "get_logs", callId: "call-1", output: { logs: [
    { id: "log-17", deploymentId: "B", level: "error", message: "Startup failed: DATABASE_URL is missing." },
  ] } } },
};
async function fixture() {
  const trial = await createTrial(pool);
  trialIds.push(trial.trialId);
  const runId = await runs.create({
    trialId: trial.trialId, deploymentId: "B", task: "Investigate B.",
    instructions: "abc", agentConfigSource: 'model: "example/model", reasoning: "high"',
  });
  return { runId, trial };
}

beforeAll(() => migrate(pool));
afterAll(async () => {
  try { await deleteTrials(pool, trialIds); } finally { await pool.end(); }
});

it("persists the source snapshot and tool evidence before the run has finished", async () => {
  const { runId, trial } = await fixture();
  await runs.setSession(runId, "session-example");
  await runs.appendEvent(runId, toolEvent);
  const readerPool = createPool();
  try {
    const saved = await createRunStore(readerPool).get(runId);
    expect(saved).toMatchObject({
      id: runId, trialId: trial.trialId, deploymentId: "B", task: "Investigate B.",
      instructions: "abc", instructionsHash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      agentConfigSource: 'model: "example/model", reasoning: "high"', resultSchemaVersion: 1,
      sessionId: "session-example", status: "running", answer: null, usage: null, finishedAt: null,
      events: [toolEvent],
    });
    expect(JSON.stringify(saved)).not.toContain(trial.token);
  } finally { await readerPool.end(); }
});

it("deduplicates replayed event IDs but rejects a different payload under the same ID", async () => {
  const { runId } = await fixture();
  await Promise.all([runs.appendEvent(runId, toolEvent), runs.appendEvent(runId, toolEvent)]);
  const second = { ...toolEvent, meta: { ...toolEvent.meta, id: "event-second" } };
  await runs.appendEvent(runId, second);
  await expect(runs.appendEvent(runId, { ...toolEvent, data: { changed: true } })).rejects.toThrow(/different payload/);
  expect((await runs.get(runId)).events).toEqual([toolEvent, second]);
});

it("keeps events with identical IDs separate for different runs", async () => {
  const first = await fixture();
  const second = await fixture();
  const different = { ...toolEvent, data: { status: "failed", error: "Other trial only." } };
  await runs.appendEvent(first.runId, toolEvent);
  await runs.appendEvent(second.runId, different);
  expect((await runs.get(first.runId)).events).toEqual([toolEvent]);
  expect((await runs.get(second.runId)).events).toEqual([different]);
});

it("reopens the completed answer, model, reported usage, and evidence from a fresh CLI process", async () => {
  const { runId } = await fixture();
  await runs.setSession(runId, "session-example");
  await runs.appendEvent(runId, { type: "step.started", meta: { id: "model", at: toolEvent.meta.at }, data: { modelId: "example/model" } });
  await runs.appendEvent(runId, toolEvent);
  await runs.appendEvent(runId, { type: "session.waiting", meta: { id: "usage", at: toolEvent.meta.at }, data: {
    usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 },
  } });
  await runs.finish(runId, { status: "completed", answer, message: "The original model response." });
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "packages/lab/src/cli.ts", "run", runId, "--json"], { timeout: 10_000 });
  const saved = JSON.parse(stdout);
  expect(saved).toMatchObject({
    id: runId, status: "completed", answer, message: "The original model response.", modelId: "example/model",
    usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 },
  });
  expect(saved.events[1]).toEqual(toolEvent);
  expect(saved.finishedAt).toBeTruthy();
  expect(saved.durationMs).toBeGreaterThanOrEqual(0);
  await expect(runs.finish(runId, { status: "failed", error: "Overwrite history" })).rejects.toThrow(/already finished/);
  await expect(runs.appendEvent(runId, { ...toolEvent, meta: { ...toolEvent.meta, id: "too-late" } })).rejects.toThrow(/already finished/);
  expect((await runs.get(runId)).answer).toEqual(answer);
});

it.each(["failed", "cancelled"] as const)("retains partial evidence on a %s run without inventing an answer or cost", async (status) => {
  const { runId } = await fixture();
  await runs.appendEvent(runId, toolEvent);
  await runs.finish(runId, { status, error: "Stopped before an answer." });
  expect(await runs.get(runId)).toMatchObject({ status, error: "Stopped before an answer.", answer: null, usage: null, events: [toolEvent] });
});

it("does not mark a malformed answer as completed", async () => {
  const { runId } = await fixture();
  await expect(runs.finish(runId, { status: "completed", answer: { ...answer, evidenceIds: 17 as unknown as string[] }, message: "" })).rejects.toThrow();
  expect(await runs.get(runId)).toMatchObject({ status: "running", answer: null, finishedAt: null });
});

it("reports a missing run rather than exposing another run's data", async () => {
  await expect(runs.get(randomUUID())).rejects.toThrow("Investigation run not found.");
});

async function evaluateCli(runId: string) {
  return new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, ["--import", "tsx", "packages/lab/src/cli.ts", "evaluate", runId, "--json"],
      { timeout: 10_000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

it.each([
  ["received", ["log-17"], 0],
  ["invented", ["log-999"], 1],
  ["present in the fixture but never retrieved", ["log-15"], 1],
] as const)("evaluates %s citations from the stored trace in a fresh CLI without changing the run", async (_name, evidenceIds, exitCode) => {
  const { runId } = await fixture();
  const finalAnswer = { ...answer, evidenceIds: [...evidenceIds] };
  const coordinates = { turnId: "turn-1", sequence: 0, stepIndex: 0 };
  await runs.appendEvent(runId, { type: "actions.requested", meta: { ...toolEvent.meta, id: "request" }, data: {
    ...coordinates, actions: [{ kind: "tool-call", toolName: "get_logs", callId: "call-1", input: { deploymentId: "B" } }],
  } });
  await runs.appendEvent(runId, { ...toolEvent, data: { ...toolEvent.data, ...coordinates } });
  await runs.appendEvent(runId, { type: "result.completed", meta: { ...toolEvent.meta, id: "answer" }, data: {
    ...coordinates, result: finalAnswer,
  } });
  await runs.finish(runId, { status: "completed", answer: finalAnswer, message: "Example answer." });
  const before = await runs.get(runId);
  const result = await evaluateCli(runId);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(exitCode);
  const report = JSON.parse(result.stdout);
  expect(report).toMatchObject({
    runId, checks: { citations: { status: exitCode ? "fail" : "pass" } },
    missingEvidenceIds: exitCode ? [...evidenceIds] : [], diagnosisAssessment: { status: "not_evaluated" },
  });
  // Fixture logs also contain log-15 and log-16. Only the actual result counts.
  expect(report.retrievedEvidence.map(({ log }: { log: { id: string } }) => log.id)).toEqual(["log-17"]);
  expect(await runs.get(runId)).toEqual(before);
});

it("reports an unfinished investigation separately from a passing evaluation", async () => {
  const { runId } = await fixture();
  const result = await evaluateCli(runId);
  expect(result.code).toBe(2);
  expect(JSON.parse(result.stdout).checks.execution.status).toBe("not_evaluated");
});

it("saves a failed CLI run when the log service is unavailable, before starting a model", async () => {
  const service = createServer((_request, response) => { response.writeHead(503).end(); });
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  try {
    const address = service.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address.");
    const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, ["--import", "tsx", "scripts/lab-investigate.ts", "B"], {
        env: { ...process.env, LAB_BASE_URL: `http://127.0.0.1:${address.port}` }, timeout: 10_000,
      }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    });
    const trialId = result.stdout.match(/^Trial: (.+)$/m)?.[1];
    if (trialId) trialIds.push(trialId);
    expect(result.error).not.toBeNull();
    expect(result.stderr).toContain("503");
    const runId = result.stdout.match(/^Run: (.+)$/m)?.[1];
    expect(runId).toBeTruthy();
    expect(await runs.get(runId!)).toMatchObject({
      trialId, deploymentId: "B", status: "failed", sessionId: null,
      answer: null, usage: null, events: [], error: expect.stringContaining("503"),
    });
    expect(result.stdout).not.toContain("Starting Eve");
  } finally {
    await new Promise<void>((resolve, reject) => service.close((error) => error ? reject(error) : resolve()));
  }
});
