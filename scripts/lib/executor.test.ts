import { randomUUID } from "node:crypto";
import { appendFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@agent-lab/lab/database";
import { createCaptureAccess } from "@agent-lab/lab/capture-access";
import { createCoverageStore } from "@agent-lab/lab/daily-coverage";
import { createJobStore } from "@agent-lab/lab/jobs";
import { migrate } from "@agent-lab/lab/migrate";
import { createRunStore } from "@agent-lab/lab/runs";
import { createWebStore } from "@agent-lab/lab/web";
import { bypassingTriggers } from "../../packages/lab/test/administrator";
import { CLEAN_CAPTURE_ID, capturesDir, incidentEvidence, removeCaptureDirs, writeCapture } from "../../packages/lab/test/daily-capture-fixture";
import { createExecutor } from "./executor";
import { createInvestigatorFixture, startEvidenceService } from "./investigator-fixture";
import { serveWorker } from "./worker";

// The local worker running browser operations for Daily recordings: the real
// job queue, serveWorker, and createExecutor over real PostgreSQL, the real
// evidence handler over synthetic captures, and a real `eve dev` of the
// investigator whose model this test scripts. No model provider is called.

const admin = createPool();
const schema = `executor_${randomUUID().replaceAll("-", "")}`;
const url = new URL(process.env.DATABASE_URL!);
url.searchParams.set("options", `-c search_path=${schema}`);
const pool = createPool(url.toString());
const runs = createRunStore(pool);
const SPOILED = "20261031T140000Z-5b0115";
const MOVING = "20261031T140500Z-30e1e0";
let dir = "";
let fixture: Awaited<ReturnType<typeof createInvestigatorFixture>>;
let service: Awaited<ReturnType<typeof startEvidenceService>>;
const options = () => ({ capturesDir: dir, baseUrl: service.baseUrl, startEve: fixture.start });

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  dir = await capturesDir();
  await writeCapture(dir);
  await writeCapture(dir, { captureId: SPOILED });
  await writeCapture(dir, { captureId: MOVING });
  service = await startEvidenceService({ pool, capturesDir: dir });
  fixture = await createInvestigatorFixture();
}, 30_000);
afterAll(async () => {
  await fixture?.close();
  await service?.close();
  await removeCaptureDirs();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

const final = (input: unknown) => ({ toolCalls: [{ name: "final_output", input }] });
const answer = {
  diagnosis: "Scripted fixture: /feed returned HTTP 500 and the logs show AdminShutdown.",
  evidenceIds: ["http-0005"],
  uncertainty: "Scripted fixture uncertainty.",
};

/** A registered worker that never claims anything, so a test drives the executor itself. */
async function idleWorker() {
  const jobs = createJobStore(pool, { capturesDir: dir });
  const owner = randomUUID();
  await jobs.register(owner);
  return { jobs, owner, stop: () => jobs.unregister(owner) };
}

/** A completed Daily run of `captureId`, written directly: one page of /feed observations and a matching answer. */
async function completedRun(captureId: string) {
  const { grant } = await createCaptureAccess(pool, dir).grant(captureId);
  const id = await runs.createDaily({
    captureId, grantId: grant.id, sha256: grant.sha256, task: "Fixture task.", instructions: "Fixture.",
    agentConfigSource: "{}", configuration: { toolMode: "daily_capture" },
  });
  const turn = { turnId: "turn_0", sequence: 0 };
  const records = incidentEvidence().filter((record) => record.kind === "http" && record.path === "/feed");
  const steps = [
    { type: "actions.requested", data: { ...turn, actions: [{ kind: "tool-call", toolName: "get_daily_http_observations", callId: "call-1", input: { path: "/feed" } }] } },
    { type: "action.result", data: { ...turn, status: "completed", result: { kind: "tool-result", toolName: "get_daily_http_observations", callId: "call-1",
      output: { captureId, evidenceSha256: grant.sha256["evidence.jsonl"], observations: records, oversized: [], nextCursor: null } } } },
    { type: "result.completed", data: { ...turn, result: answer } },
  ];
  for (const [index, step] of steps.entries()) await runs.appendEvent(id, { ...step, meta: { id: `${id}-${index}`, at: "2026-10-31T14:10:00.000Z" } });
  await runs.finish(id, { status: "completed", answer, message: "" });
  return id;
}

describe("the local worker", () => {
  it("runs a browser-started Daily investigation, then queues and saves its coverage without a model", async () => {
    fixture.reply((_call, index) =>
      index === 0 ? { toolCalls: [{ name: "get_daily_http_observations", input: { path: "/feed" } }] } : final(answer),
    );
    const shutdown = new AbortController();
    const jobs = createJobStore(pool, { capturesDir: dir });
    const running = serveWorker(pool, { signal: shutdown.signal, execute: createExecutor(pool, options()) });
    try {
      await expect.poll(async () => (await jobs.availability()).online).toBe(true);
      const job = await jobs.submit({ requestId: randomUUID(), kind: "investigate", source: "daily_capture", captureId: CLEAN_CAPTURE_ID });
      await expect.poll(async () => (await jobs.get(job.id)).status, { timeout: 60_000, interval: 250 }).toBe("completed");
      const { runId } = await jobs.get(job.id);
      expect(runId).toBeTruthy();
      await expect.poll(async () => (await createWebStore(pool).get(runId!)).activeJobId, { timeout: 20_000 }).toBeNull();
      const calls = fixture.calls.length;
      expect(calls).toBe(2);

      const view = await createWebStore(pool).get(runId!);
      if (view.source !== "daily_capture") throw new Error("Expected a Daily run view.");
      expect(view).toMatchObject({ status: "completed", answer, checks: { citations: { status: "pass" } }, integrity: { status: "verified" } });
      expect(view.accessRevokedAt).not.toBeNull();
      expect(view.operations.map((operation) => [operation.kind, operation.status, operation.automatic])).toEqual([
        ["investigate", "completed", false],
        ["coverage", "completed", true],
      ]);
      // Every /feed observation came back on one page: the 500 and the later ready response.
      expect(view.coverage).toMatchObject({ state: "covered", action: null, assessment: { result: "covered" } });
      expect(view.coverage.assessment?.facts.map((fact) => [fact.id, fact.status])).toEqual([
        ["server_errors", "covered"], ["no_response", "not_assessed"], ["recovery", "covered"],
      ]);
      expect(view.activity.find((item) => item.kind === "coverage")).toMatchObject({ title: "Coverage saved: covered", status: "completed" });
      expect(view.reviewEligible).toBe(true);
      // Coverage made no model request.
      expect(fixture.calls).toHaveLength(calls);
    } finally {
      shutdown.abort();
      await running;
    }
  }, 120_000);

  it("refuses a recording that no longer verifies when the job starts, before any run, grant, or model call", async () => {
    fixture.reply(() => final(answer));
    const worker = await idleWorker();
    try {
      const job = await worker.jobs.submit({ requestId: randomUUID(), kind: "investigate", source: "daily_capture", captureId: SPOILED });
      // The file changes after admission checked it.
      await appendFile(join(dir, SPOILED, "evidence.jsonl"), "\n");
      const claimed = await worker.jobs.claim(worker.owner);
      const before = {
        runs: (await pool.query("SELECT count(*)::int AS n FROM lab_investigation_runs")).rows[0].n,
        grants: (await pool.query("SELECT count(*)::int AS n FROM lab_capture_access_grants")).rows[0].n,
      };
      const result = await createExecutor(pool, options())(claimed!, new AbortController().signal);
      expect(result).toEqual({
        status: "failed",
        error: `The recording could not be verified when the investigation started. evidence.jsonl in ${SPOILED} does not match the SHA-256 recorded in its manifest. No investigation was saved and no model request was made.`,
      });
      await worker.jobs.finish(job.id, result.status as "failed", result.error);
      expect(await worker.jobs.get(job.id)).toMatchObject({ status: "failed", runId: null, error: result.error });
      expect({
        runs: (await pool.query("SELECT count(*)::int AS n FROM lab_investigation_runs")).rows[0].n,
        grants: (await pool.query("SELECT count(*)::int AS n FROM lab_capture_access_grants")).rows[0].n,
      }).toEqual(before);
      expect(fixture.calls).toHaveLength(0);
    } finally {
      await worker.stop();
    }
  }, 30_000);

  it("keeps the answer when coverage cannot read the recording, explains why, and saves it when retried", async () => {
    const id = await completedRun(MOVING);
    const worker = await idleWorker();
    const execute = createExecutor(pool, options());
    try {
      await rename(join(dir, MOVING), join(dir, `${MOVING}-moved`));
      const job = await worker.jobs.submit({ requestId: randomUUID(), kind: "coverage", runId: id });
      const failed = await execute((await worker.jobs.claim(worker.owner))!, new AbortController().signal);
      expect(failed).toEqual({
        status: "failed",
        error: `Coverage could not be checked. Coverage needs the recording run ${id} read. Capture ${MOVING} is not in the captures directory. No coverage assessment was saved.`,
      });
      await worker.jobs.finish(job.id, "failed", failed.error);
      const view = await createWebStore(pool).get(id);
      if (view.source !== "daily_capture") throw new Error("Expected a Daily run view.");
      expect(view).toMatchObject({ status: "completed", answer, coverage: { state: "check_failed", action: "retry", error: failed.error } });

      await rename(join(dir, `${MOVING}-moved`), join(dir, MOVING));
      const retry = await worker.jobs.submit({ requestId: randomUUID(), kind: "coverage", runId: id });
      expect(await execute((await worker.jobs.claim(worker.owner))!, new AbortController().signal)).toEqual({ status: "completed" });
      await worker.jobs.finish(retry.id, "completed");
      expect((await createCoverageStore(pool).latestForRun(id))?.result).toBe("covered");
      const after = await createWebStore(pool).get(id);
      expect(after.source === "daily_capture" && after.coverage.state).toBe("covered");
    } finally {
      await worker.stop();
    }
  }, 30_000);

  it("explains a review refused after admission, without a model request", async () => {
    const id = await completedRun(CLEAN_CAPTURE_ID);
    const worker = await idleWorker();
    try {
      const job = await worker.jobs.submit({ requestId: randomUUID(), kind: "review", runId: id });
      await bypassingTriggers(pool, "lab_investigation_runs", () =>
        pool.query("UPDATE lab_investigation_runs SET answer = jsonb_set(answer, '{diagnosis}', '\"Edited after admission.\"') WHERE id = $1", [id]));
      const result = await createExecutor(pool, options())((await worker.jobs.claim(worker.owner))!, new AbortController().signal);
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/^Review could not start\. Investigation .* no longer matches its integrity fingerprint/);
      await worker.jobs.finish(job.id, "failed", result.error);
      expect((await pool.query("SELECT count(*)::int AS n FROM lab_investigation_reviews WHERE run_id = $1", [id])).rows[0].n).toBe(0);
      const view = await createWebStore(pool).get(id);
      expect(view.activity.find((item) => item.kind === "review")).toMatchObject({ title: "Review could not start", error: result.error });
    } finally {
      await worker.stop();
    }
  }, 30_000);
});
