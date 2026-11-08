import { randomUUID } from "node:crypto";
import { get as httpGet } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createCaptureAccess } from "@agent-lab/lab/capture-access";
import { createPool } from "@agent-lab/lab/database";
import { createTrial, deleteTrials } from "@agent-lab/lab/fixtures";
import { createRunStore } from "@agent-lab/lab/runs";
import { CLEAN_CAPTURE_ID, capturesDir, removeCaptureDirs, writeCapture } from "../packages/lab/test/daily-capture-fixture";

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

it("serves a Daily capture run in the workbench without private data, and filters runs by source", async () => {
  const dir = await capturesDir();
  await writeCapture(dir);
  const access = createCaptureAccess(pool, dir);
  const { grant, token } = await access.grant(CLEAN_CAPTURE_ID);
  const id = await createRunStore(pool).createDaily({
    captureId: grant.captureId, grantId: grant.id, sha256: grant.sha256, task: "Daily fixture",
    instructions: "PRIVATE_DAILY", agentConfigSource: "PRIVATE_CONFIG", configuration: { toolMode: "daily_capture", note: "PRIVATE_SETTINGS" },
  });
  try {
    const daily = await (await fetch(`${base}/api/runs?source=daily_capture`)).json();
    expect(daily.items.map((item: { id: string }) => item.id)).toContain(id);
    expect(daily.items.every((item: { source: string }) => item.source === "daily_capture")).toBe(true);
    const simulated = await (await fetch(`${base}/api/runs?source=simulated`)).json();
    expect(simulated.items.map((item: { id: string }) => item.id)).not.toContain(id);
    expect((await fetch(`${base}/api/runs?source=bogus`)).status).toBe(400);
    const response = await fetch(`${base}/api/runs/${id}`);
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view).toMatchObject({ id, source: "daily_capture", captureId: CLEAN_CAPTURE_ID, status: "running", coverage: { state: "waiting" } });
    const stream = await fetch(`${base}/api/runs/${id}/stream`, { signal: AbortSignal.timeout(3_000) });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(first).toContain("event: snapshot");
    for (const body of [JSON.stringify(view), first, JSON.stringify(daily)]) {
      expect(body).not.toContain("PRIVATE_");
      expect(body).not.toContain(token);
      expect(body).not.toContain(dir);
    }
    const page = await fetch(`${base}/runs/${id}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Daily recording");
    expect(html).not.toContain("PRIVATE_");
  } finally {
    await pool.query("DELETE FROM lab_investigation_runs WHERE id = $1", [id]);
    await access.revoke(grant.id);
    await pool.query("DELETE FROM lab_capture_access_grants WHERE id = $1", [grant.id]);
    await removeCaptureDirs();
  }
});

it("lists saved recordings as allowlisted metadata, behind the local-access guard", async () => {
  const response = await fetch(`${base}/api/captures`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const { captures } = await response.json();
  expect(Array.isArray(captures)).toBe(true);
  for (const capture of captures) {
    const keys = Object.keys(capture).sort();
    expect(keys).toEqual(capture.available
      ? ["available", "captureId", "finishedAt", "httpObservations", "logLines", "recordedAt"]
      : ["available", "captureId", "problem", "recordedAt"]);
    expect(capture.captureId).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{6}$/);
    if (!capture.available) expect(Object.keys(capture.problem).sort()).toEqual(["code", "message"]);
  }
  // Filesystem paths and file hashes never appear; a problem names files, not their contents.
  expect(JSON.stringify(captures)).not.toMatch(/\/Users\/|\.context|[0-9a-f]{64}/);
  const untrusted = await new Promise<number | undefined>((resolve, reject) => {
    httpGet(`${base}/api/captures`, { headers: { Host: "untrusted.example" } }, (answer) => {
      resolve(answer.statusCode);
      answer.resume();
    }).on("error", reject);
  });
  expect(untrusted).toBe(403);
});

it("validates Daily, coverage, and review requests before any job exists", async () => {
  const post = (body: unknown) =>
    fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify(body) });
  const jobsFor = async (id: string) => (await pool.query("SELECT id FROM lab_execution_jobs WHERE id = $1", [id])).rows;
  for (const body of [
    { kind: "investigate", source: "daily_capture", captureId: "../20261022T050138Z-39b307" },
    { kind: "investigate", source: "daily_capture", captureId: "latest" },
    { kind: "investigate", source: "daily_capture", captureId: "20261022T050138Z-39b307", caseId: "no-logs" },
    { kind: "investigate", source: "simulated", captureId: "20261022T050138Z-39b307" },
    { kind: "coverage", runId: "not-a-uuid" },
  ]) {
    const requestId = randomUUID();
    expect((await post({ requestId, ...body })).status).toBe(400);
    expect(await jobsFor(requestId)).toEqual([]);
  }
  // With a worker online, admission checks the recording or run, then refuses.
  const { createJobStore } = await import("@agent-lab/lab/jobs");
  const jobs = createJobStore(pool);
  const owner = randomUUID();
  await jobs.register(owner);
  try {
    const unknown = randomUUID();
    const response = await post({ requestId: unknown, kind: "investigate", source: "daily_capture", captureId: "20991231T000000Z-000000" });
    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe("Capture 20991231T000000Z-000000 is not in the captures directory. Choose another recording.");
    const coverageOfSimulated = randomUUID();
    const refused = await post({ requestId: coverageOfSimulated, kind: "coverage", runId });
    expect(refused.status).toBe(422);
    expect((await refused.json()).error.message).toContain("recorded Daily investigations only");
    const missingRun = randomUUID();
    expect((await post({ requestId: missingRun, kind: "coverage", runId: randomUUID() })).status).toBe(404);
    for (const id of [unknown, coverageOfSimulated, missingRun]) expect(await jobsFor(id)).toEqual([]);
  } finally {
    await jobs.unregister(owner);
  }
});
