import { randomUUID } from "node:crypto";
import { get as httpGet } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPool } from "@agent-lab/lab/database";
import { createTrial, deleteTrials } from "@agent-lab/lab/fixtures";
import { createRunStore } from "@agent-lab/lab/runs";

const base = process.env.LAB_BASE_URL ?? "http://127.0.0.1:3000";
const pool = createPool();
let trialId: string, runId: string;
beforeAll(async () => {
  const trial = await createTrial(pool);
  trialId = trial.trialId;
  runId = await createRunStore(pool).create({
    trialId,
    deploymentId: "B",
    task: "Inspect B",
    instructions: "PRIVATE_INSTRUCTIONS",
    agentConfigSource: "PRIVATE_CONFIG",
  });
});
afterAll(async () => {
  if (trialId) await deleteTrials(pool, [trialId]);
  await pool.end();
});

it("serves saved display data without private configuration and without caching", async () => {
  const response = await fetch(`${base}/api/runs/${runId}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const data = await response.json();
  expect(data).toMatchObject({
    id: runId,
    status: "running",
    answer: null,
    reviewEligible: false,
    evidence: [],
  });
  expect(JSON.stringify(data)).not.toContain("PRIVATE_");
  expect((await fetch(`${base}/api/runs/${randomUUID()}`)).status).toBe(404);
  expect((await fetch(`${base}/api/runs?status=not-a-status`)).status).toBe(
    400,
  );
});

it("rejects cross-origin or malformed model operations before creating any work", async () => {
  const id = randomUUID();
  const command = JSON.stringify({
    requestId: id,
    kind: "investigate",
    deploymentId: "B",
  });
  for (const origin of [undefined, "https://unrelated.example"]) {
    const response = await fetch(`${base}/api/jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(origin ? { Origin: origin } : {}),
      },
      body: command,
    });
    expect(response.status).toBe(403);
  }
  const malformed = await fetch(`${base}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({
      requestId: id,
      kind: "investigate",
      deploymentId: "B",
      model: "arbitrary/model",
    }),
  });
  expect(malformed.status).toBe(400);
  expect(
    (await pool.query("SELECT id FROM lab_execution_jobs WHERE id = $1", [id]))
      .rows,
  ).toEqual([]);
  const cancel = await fetch(`${base}/api/jobs/${id}/cancel`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://unrelated.example",
    },
    body: "{}",
  });
  expect(cancel.status).toBe(403);
});

it("streams saved changes, resumes with the latest state, and closes after completion", async () => {
  const store = createRunStore(pool);
  const id = await store.create({
    trialId,
    deploymentId: "B",
    task: "Stream fixture",
    instructions: "PRIVATE_STREAM",
    agentConfigSource: "PRIVATE_CONFIG",
  });
  const abort = new AbortController();
  const response = await fetch(`${base}/api/runs/${id}/stream`, {
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("cache-control")).toContain("no-store");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  async function frame() {
    while (!buffer.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Stream closed before frame");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    const end = buffer.indexOf("\n\n");
    const result = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    return result;
  }
  const first = await frame();
  expect(first).toContain("event: snapshot");
  expect(first).toContain("Preparing investigation");
  expect(first).not.toContain("PRIVATE");
  await store.appendEvent(id, {
    type: "step.started",
    meta: { id: "stream-step", at: new Date().toISOString() },
    data: { modelId: "test/model", turnId: "turn" },
  });
  expect(await frame()).toContain("Requesting a model response");
  abort.abort();
  await store.finish(id, { status: "cancelled", error: "PRIVATE_CANCEL" });
  const reopened = await fetch(`${base}/api/runs/${id}/stream`, {
    headers: { "Last-Event-ID": "old-event" },
    signal: AbortSignal.timeout(5_000),
  });
  const body = await reopened.text();
  expect(body).toContain("Investigation cancelled");
  expect(body).toContain("event: settled");
  expect(body.match(/event: snapshot/g)).toHaveLength(1);
  expect(body).not.toContain("PRIVATE");
  expect(
    (
      await pool.query("SELECT id FROM lab_execution_jobs WHERE run_id = $1", [
        id,
      ])
    ).rows,
  ).toEqual([]);
});

it("applies the existing local access and record guards before opening a stream", async () => {
  // Node fetch normalizes Host; use the HTTP client to exercise an actual
  // untrusted Host header as a DNS-rebinding request would send it.
  const status = await new Promise<number | undefined>((resolve, reject) => {
    httpGet(
      `${base}/api/runs/${runId}/stream`,
      { headers: { Host: "untrusted.example" } },
      (response) => {
        resolve(response.statusCode);
        response.resume();
      },
    ).on("error", reject);
  });
  expect(status).toBe(403);
  expect((await fetch(`${base}/api/runs/invalid/stream`)).status).toBe(400);
  expect((await fetch(`${base}/api/runs/${randomUUID()}/stream`)).status).toBe(
    404,
  );
});

it("validates case selectors before admitting model work", async () => {
  const { acquireExecution } = await import("@agent-lab/lab/jobs");
  const lease = await acquireExecution(pool);
  try {
    for (const [selector, invalid] of [
      [{ caseId: "missing-config" }, false],
      [{ caseId: "healthy-startup" }, false],
      [{ caseId: "recovered-startup" }, false],
      [{ caseId: "no-logs" }, false],
      [{ caseId: "absent" }, true],
      [{ caseId: "missing-config", deploymentId: "B" }, true],
    ] as const) {
      const id = randomUUID();
      const response = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ requestId: id, kind: "investigate", ...selector }) });
      // A valid request reaches admission (busy/offline), never model execution.
      expect(invalid ? [400] : [409, 503]).toContain(response.status);
      expect((await pool.query("SELECT id FROM lab_execution_jobs WHERE id = $1", [id])).rows).toEqual([]);
    }
  } finally { await lease.release(); }
});
