import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCaptureAccess } from "../src/capture-access";
import { createPool } from "../src/database";
import { createJobStore, JobError } from "../src/jobs";
import { migrate } from "../src/migrate";
import { createReviewStore } from "../src/reviews";
import { createRunStore, UnsupportedRunSourceError } from "../src/runs";
import { createTrial } from "../src/fixtures";
import { createWebStore } from "../src/web";
import { CLEAN_CAPTURE_ID, capturesDir, log, removeCaptureDirs, writeCapture } from "./daily-capture-fixture";

// Daily capture runs in the shared run and event tables: what the database
// enforces for each source, and how simulated-only readers refuse them.

const admin = createPool();
const schema = `daily_runs_${randomUUID().replaceAll("-", "")}`;
const url = new URL(process.env.DATABASE_URL!);
url.searchParams.set("options", `-c search_path=${schema}`);
const pool = createPool(url.toString());
const runs = createRunStore(pool);
let grant: Awaited<ReturnType<ReturnType<typeof createCaptureAccess>["grant"]>>["grant"];

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  const dir = await capturesDir();
  await writeCapture(dir);
  ({ grant } = await createCaptureAccess(pool, dir).grant(CLEAN_CAPTURE_ID));
});
afterAll(async () => {
  await removeCaptureDirs();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

const daily = () =>
  runs.createDaily({
    captureId: grant.captureId,
    grantId: grant.id,
    sha256: grant.sha256,
    task: "Investigate the recording.",
    instructions: "Daily instructions.",
    agentConfigSource: "export default {}",
    configuration: { toolMode: "daily_capture" },
  });

const turn = { turnId: "turn_0", sequence: 0, stepIndex: 0 };
const event = (type: string, id: string, data: object) => ({ type, meta: { id, at: "2026-10-30T00:00:00.000Z" }, data });
const page = () => ({
  captureId: grant.captureId,
  evidenceSha256: grant.sha256["evidence.jsonl"],
  logs: [log(2, "ERROR app.main: Unhandled error on GET /feed")],
  oversized: [],
  nextCursor: null,
});
const answer = { diagnosis: "Requests failed.", evidenceIds: ["log-api-0002"], uncertainty: "Cause not established." };

function cli(...args: string[]) {
  return new Promise<{ code: number | string; stdout: string }>((resolve) => {
    execFile(process.execPath, ["--import", "tsx", "packages/lab/src/cli.ts", ...args], { env: { ...process.env, DATABASE_URL: url.toString() }, timeout: 10_000 },
      (error, stdout) => resolve({ code: error?.code ?? 0, stdout }));
  });
}

describe("a Daily capture run", () => {
  it("has no trial or deployment, records the grant and its pinned hashes, and is refused by simulated-only readers", async () => {
    const id = await daily();
    expect(await runs.getDaily(id)).toMatchObject({
      id, source: "daily_capture", captureId: CLEAN_CAPTURE_ID, captureSha256: grant.sha256, grantId: grant.id,
      grantExpiresAt: grant.expiresAt, grantRevokedAt: null, resultSchemaVersion: 3, status: "running",
      configuration: { toolMode: "daily_capture" }, evidenceReport: null, events: [],
    });
    expect((await runs.getAny(id)).source).toBe("daily_capture");
    await expect(runs.get(id)).rejects.toThrow(UnsupportedRunSourceError);
    await expect(runs.get(id)).rejects.toThrow(`read it with pnpm lab run ${id}`);
    await expect(createWebStore(pool).get(id)).rejects.toThrow(UnsupportedRunSourceError);
    // The review store reads Daily runs, but only a finished one, with a Daily reviewer configuration.
    const reviewer = {
      modelId: "test/reviewer", promptVersion: "test", schemaVersion: 1 as const, system: "Review.",
      settings: { maxOutputTokens: 100, maxRetries: 0 as const, timeoutMs: 1_000, maxInputBytes: 65_536 },
    };
    await expect(createReviewStore(pool).start(id, { ...reviewer, source: "daily_capture" })).rejects.toThrow(/requires a completed investigation/);
    await expect(createReviewStore(pool).start(id, { ...reviewer, source: "simulated" })).rejects.toThrow(/is for simulated runs; run .* is a daily_capture run/);
    expect((await pool.query("SELECT count(*)::int AS n FROM lab_investigation_reviews WHERE run_id = $1", [id])).rows[0].n).toBe(0);
  });

  it("stays out of the workbench list, and a review request for it is invalid", async () => {
    const id = await daily();
    const { trialId } = await createTrial(pool);
    const simulated = await runs.create({ trialId, deploymentId: "B", task: "Investigate B.", instructions: "Simulated.", agentConfigSource: "{}" });
    const listed = (await createWebStore(pool).list()).items.map((item) => item.id);
    expect(listed).toContain(simulated);
    expect(listed).not.toContain(id);
    const jobs = createJobStore(pool);
    const owner = randomUUID();
    await jobs.register(owner);
    try {
      const submitted = jobs.submit({ requestId: randomUUID(), kind: "review", runId: id });
      await expect(submitted).rejects.toThrow(JobError);
      await expect(submitted).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("recorded Daily capture") });
    } finally {
      await jobs.unregister(owner);
    }
  });

  it("freezes its evidence report when it finishes, and keeps its source and report immutable", async () => {
    const id = await daily();
    await runs.appendEvent(id, event("actions.requested", "request", { ...turn, actions: [{ kind: "tool-call", toolName: "get_daily_logs", callId: "call-1", input: { messageContains: "error" } }] }));
    await runs.appendEvent(id, event("action.result", "result", { ...turn, status: "completed", result: { kind: "tool-result", toolName: "get_daily_logs", callId: "call-1", output: page() } }));
    await runs.appendEvent(id, event("result.completed", "answer", { ...turn, result: answer }));
    await expect(runs.finish(id, { status: "completed", answer: { ...answer, evidenceIds: "log-api-0002" } as never, message: "" })).rejects.toThrow();
    expect((await runs.getDaily(id)).status).toBe("running");

    await runs.finish(id, { status: "completed", answer, message: "Requests failed." });
    const saved = await runs.getDaily(id);
    expect(saved).toMatchObject({ status: "completed", answer, error: null });
    expect(saved.evidenceReport).toMatchObject({
      evaluatorVersion: "daily-evidence-v1",
      checks: { execution: { status: "pass" }, answer: { status: "pass" }, toolTrace: { status: "pass" }, retrieval: { status: "pass" }, citations: { status: "pass" } },
      retrievedEvidence: [{ id: "log-api-0002", kind: "log", toolName: "get_daily_logs", callId: "call-1", requestEventId: "request", resultEventId: "result" }],
      diagnosisAssessment: { status: "not_evaluated" },
    });
    await expect(runs.finish(id, { status: "failed", error: "Overwrite." })).rejects.toThrow(/already finished/);
    await expect(runs.appendEvent(id, event("action.result", "late", { ...turn }))).rejects.toThrow(/already finished/);
    for (const change of ["evidence_report = '{}'", "capture_id = '20261022T050320Z-ad558c'", "configuration = '{}'", "instructions = 'Changed.'", "source = 'simulated'"])
      await expect(pool.query(`UPDATE lab_investigation_runs SET ${change} WHERE id = $1`, [id])).rejects.toThrow(/immutable|violates/);
    expect(await runs.getDaily(id)).toEqual(saved);

    // lab run and lab evaluate read the saved record and report in a fresh process.
    const evaluation = await cli("evaluate", id, "--json");
    expect(evaluation.code).toBe(0);
    expect(JSON.parse(evaluation.stdout)).toEqual({ ...saved.evidenceReport, frozen: true, integrity: saved.integrity });
    expect(saved.integrity).toMatchObject({ status: "verified", fingerprint: { origin: "finalization", eventCount: 3 } });
    const text = await cli("run", id);
    expect(text.stdout).toContain(`Source: recorded Daily capture ${CLEAN_CAPTURE_ID}`);
    expect(text.stdout).toContain("Tool request get_daily_logs {\"messageContains\":\"error\"}");
    expect(text.stdout).toContain("  log-api-0002  ");
    expect(text.stdout).toContain("Integrity: verified (fingerprint v1 of 3 event(s), saved when the run finished");
  });

  it("checks an unfinished run on demand without claiming a frozen report", async () => {
    const id = await daily();
    const evaluation = await cli("evaluate", id);
    expect(evaluation.code).toBe(2);
    expect(evaluation.stdout).toContain("Computed now: the run has no saved report because it never finished.");
    expect(evaluation.stdout).toContain("NOT_EVALUATED execution");
    expect(evaluation.stdout).toContain("Integrity: not sealed yet; a fingerprint is saved when the run finishes.");
  });
});

describe("database constraints for each source", () => {
  const insert = (columns: Record<string, unknown>) => {
    const values = { id: randomUUID(), task: "t", instructions: "i", instructions_sha256: "a".repeat(64), agent_config_source: "{}", ...columns };
    const names = Object.keys(values);
    return pool.query(
      `INSERT INTO lab_investigation_runs (${names.join(", ")}) VALUES (${names.map((_, index) => `$${index + 1}`).join(", ")})`,
      Object.values(values),
    );
  };
  const dailyColumns = () => ({
    source: "daily_capture", capture_id: grant.captureId, capture_grant_id: grant.id, capture_manifest_sha256: grant.sha256["manifest.json"],
    capture_evidence_sha256: grant.sha256["evidence.jsonl"], capture_controller_sha256: grant.sha256["controller.jsonl"],
    configuration: "{}", result_schema_version: 3,
  });

  it("accepts each source with its own fields only", async () => {
    await expect(insert(dailyColumns())).resolves.toBeTruthy();
    const { trialId } = await createTrial(pool);
    await expect(insert({ trial_id: trialId, deployment_id: "B" })).resolves.toBeTruthy();
  });

  it.each([
    ["a trial", { trial_id: null as unknown }],
    ["a deployment", { deployment_id: "B" }],
    ["the simulated answer schema", { result_schema_version: 1 }],
    ["no configuration", { configuration: null }],
    ["no grant", { capture_grant_id: null }],
    ["hashes other than its grant pinned", { capture_evidence_sha256: "0".repeat(64) }],
    ["a capture other than its grant's", { capture_id: "20261022T050320Z-ad558c" }],
    ["a finished status without a frozen report", { status: "failed", finished_at: new Date(), error: "Failed." }],
  ])("refuses a Daily run with %s", async (_name, change) => {
    const columns: Record<string, unknown> = { ...dailyColumns(), ...change };
    if ("trial_id" in change) columns.trial_id = (await createTrial(pool)).trialId;
    await expect(insert(columns)).rejects.toThrow(/violates/);
  });

  it("refuses a simulated run without a trial or with Daily fields", async () => {
    const { trialId } = await createTrial(pool);
    await expect(insert({ deployment_id: "B" })).rejects.toThrow(/violates/);
    await expect(insert({ trial_id: trialId, deployment_id: "B", capture_id: grant.captureId })).rejects.toThrow(/violates/);
    await expect(insert({ trial_id: trialId, deployment_id: "B", configuration: "{}" })).rejects.toThrow(/violates/);
  });
});
