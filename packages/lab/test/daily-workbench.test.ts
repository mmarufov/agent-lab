import { randomUUID } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DailyCaptureEvidence, DailyHttpObservation } from "@agent-lab/contracts/daily-capture";
import type { DailyInvestigationAnswer } from "@agent-lab/contracts/daily-investigation";
import { createCaptureAccess } from "../src/capture-access";
import { createPool } from "../src/database";
import { createCoverageStore } from "../src/daily-coverage";
import { listDailyCaptures } from "../src/daily-evidence";
import { createJobStore, JobError } from "../src/jobs";
import { migrate } from "../src/migrate";
import { createRunStore } from "../src/runs";
import { createWebStore, snapshotSettled, type DailyRunView } from "../src/web";
import { bypassingTriggers } from "./administrator";
import { CONTROLLER_ONLY, capturesDir, feedAvailabilityEvidence, log, removeCaptureDirs, writeCapture } from "./daily-capture-fixture";

// The workbench's view of Daily investigations, the jobs the browser can start
// for them, and worker recovery, against synthetic recordings and real
// PostgreSQL. No model, Eve, Docker, or Next.js. Every capture here exists only
// in a temporary directory, and every answer is a labeled fixture.

const CAPTURE_ID = "20261031T130000Z-fade01";
const INVALID_ID = "20261031T130500Z-fade02";
const admin = createPool();
const schema = `daily_workbench_${randomUUID().replaceAll("-", "")}`;
const url = new URL(process.env.DATABASE_URL!);
url.searchParams.set("options", `-c search_path=${schema}`);
const pool = createPool(url.toString());
const runs = createRunStore(pool);
const web = createWebStore(pool);
let dir = "";
let token = "";
type Grant = Awaited<ReturnType<ReturnType<typeof createCaptureAccess>["grant"]>>["grant"];
let grant: Grant;

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  dir = await capturesDir();
  await writeCapture(dir, { captureId: CAPTURE_ID, evidence: feedAvailabilityEvidence() });
  await writeCapture(dir, { captureId: INVALID_ID, manifest: (manifest) => ({ ...manifest, status: "cancelled" }) });
  ({ grant, token } = await createCaptureAccess(pool, dir).grant(CAPTURE_ID));
});
afterAll(async () => {
  await removeCaptureDirs();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

const recorded = Object.fromEntries(feedAvailabilityEvidence().map((value) => [value.id, value])) as Record<string, DailyCaptureEvidence>;
const pick = (...ids: string[]) => ids.map((id) => recorded[id]);
let eventIds = 0;
const turn = { turnId: "turn_0", sequence: 0 };
const event = (type: string, data: object) => ({ type, meta: { id: `wb-event-${++eventIds}`, at: "2026-10-31T13:10:00.000Z" }, data: { ...turn, ...data } });
function call(callId: string, toolName: string, input: object, records: DailyCaptureEvidence[], output: object = {}) {
  return [
    event("actions.requested", { stepIndex: 0, actions: [{ kind: "tool-call", toolName, callId, input }] }),
    event("action.result", {
      status: "completed",
      result: {
        kind: "tool-result", toolName, callId,
        output: {
          captureId: grant.captureId, evidenceSha256: grant.sha256["evidence.jsonl"],
          [toolName === "get_daily_logs" ? "logs" : "observations"]: records, oversized: [], nextCursor: null, ...output,
        },
      },
    }),
  ];
}
const answer: DailyInvestigationAnswer = {
  diagnosis: "Fixture: /feed returned server errors and timeouts, then served the feed again.",
  evidenceIds: ["http-0002", "http-0009"],
  uncertainty: "Fixture: why the failures happened is not recorded.",
};

async function dailyRun(steps: object[], options: { finish?: "completed" | "failed" | null; final?: DailyInvestigationAnswer; jobId?: string } = {}) {
  const final = options.final ?? answer;
  const finish = options.finish === undefined ? "completed" : options.finish;
  const id = await runs.createDaily({
    captureId: grant.captureId, grantId: grant.id, sha256: grant.sha256,
    task: "Fixture task: investigate Daily's feed API during the recorded period.", instructions: "PRIVATE_INSTRUCTIONS",
    agentConfigSource: "PRIVATE_AGENT_CONFIG", configuration: { toolMode: "daily_capture", note: "PRIVATE_CONFIGURATION" },
  }, options.jobId);
  for (const step of [...steps, ...(finish === "completed" ? [event("result.completed", { result: final })] : [])]) await runs.appendEvent(id, step);
  if (finish === "completed") await runs.finish(id, { status: "completed", answer: final, message: "PRIVATE_ASSISTANT_MESSAGE" });
  if (finish === "failed") await runs.finish(id, { status: "failed", error: "PRIVATE_EVE_OUTPUT" });
  return id;
}
async function daily(id: string) {
  const view = await web.get(id);
  if (view.source !== "daily_capture") throw new Error("Expected a Daily run view.");
  return view;
}
const count = async (table: string, runId: string) =>
  (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE run_id = $1`, [runId])).rows[0].n;
async function withWorker<T>(run: (jobs: ReturnType<typeof createJobStore>) => Promise<T>) {
  const jobs = createJobStore(pool, { capturesDir: dir });
  const owner = randomUUID();
  await jobs.register(owner);
  try {
    return await run(jobs);
  } finally {
    await pool.query("UPDATE lab_execution_jobs SET status = 'cancelled', finished_at = clock_timestamp() WHERE status IN ('queued', 'running')");
    await jobs.unregister(owner);
  }
}

describe("the workbench view of a Daily investigation", () => {
  it("stores each received record once, keeps every tool call that returned it, and describes each page", async () => {
    const firstPage = pick("http-0001", "http-0002", "http-0003");
    const secondPage = pick("http-0003", "http-0005", "http-0009");
    const logs = feedAvailabilityEvidence().filter((value) => value.kind === "log");
    const id = await dailyRun([
      ...call("call-1", "get_daily_http_observations", { path: "/feed", limit: 3 }, firstPage, { nextCursor: "next-page" }),
      ...call("call-2", "get_daily_http_observations", { path: "/feed", limit: 3, cursor: "next-page" }, secondPage),
      ...call("call-3", "get_daily_logs", { service: "daily-api", messageContains: "error" }, logs.slice(0, 1), { oversized: [{ id: "log-api-0009", bytes: 70_000 }] }),
    ]);
    const view = await daily(id);
    expect(view).toMatchObject({
      source: "daily_capture", captureId: CAPTURE_ID, recordedAt: "2026-10-31T13:00:00.000Z", status: "completed",
      answer, checks: { toolTrace: { status: "pass" }, citations: { status: "pass" } }, evaluatorVersion: "daily-evidence-v1",
      reportReproduced: true, integrity: { status: "verified" },
    });
    // http-0003 came back on both overlapping pages: one record, two receipts.
    expect(view.evidence.map((entry) => entry.id)).toEqual(["http-0001", "http-0002", "http-0003", "http-0005", "http-0009", "log-api-0001"]);
    const overlap = view.evidence.find((entry) => entry.id === "http-0003")!;
    expect(overlap.receipts.map((receipt) => receipt.callId)).toEqual(["call-1", "call-2"]);
    expect(Object.keys(view.records).sort()).toEqual(["http-0001", "http-0002", "http-0003", "http-0005", "http-0009", "log-api-0001"]);
    expect(view.records["http-0003"]).toEqual({ type: "http", ...recorded["http-0003"] });
    expect(view.records["log-api-0001"]).toMatchObject({ type: "daily_log", service: "daily-api", message: "ERROR app.main: Unhandled error on GET /feed" });

    const tools = view.activity.filter((item) => item.kind === "tool");
    expect(tools.map((item) => `${item.title}: ${item.detail}`)).toEqual([
      "get_daily_http_observations: 3 HTTP observations · more pages available",
      "get_daily_http_observations: 3 HTTP observations · last page",
      "get_daily_logs: 1 log line · 1 too large to return · last page",
    ]);
    expect(tools[0].tool?.results[0]).toMatchObject({ recordKeys: ["http-0001", "http-0002", "http-0003"], morePages: true, status: "completed" });
    expect(tools[1].tool?.results[0].recordKeys).toEqual(["http-0003", "http-0005", "http-0009"]);
    expect(tools[2].tool?.results[0].oversized).toEqual([{ id: "log-api-0009", bytes: 70_000 }]);
    expect(tools[1].tool?.input).toEqual({ path: "/feed", limit: 3, cursor: "next-page" });
    expect(tools.map((item) => item.tool?.request)).toEqual([
      "path /feed · first page · up to 3",
      "path /feed · next page · up to 3",
      'daily-api only · containing "error" · first page',
    ]);
    expect(view.activity.find((item) => item.kind === "checks")).toMatchObject({ actor: "checks", status: "completed" });

    // Private configuration, instructions, Eve output, and controller records never reach the browser.
    const json = JSON.stringify(view);
    for (const secret of ["PRIVATE_", CONTROLLER_ONLY, token, "token_hash", dir])
      expect(json).not.toContain(secret);
  });

  it("describes filters in words and keeps conflicting versions of a record apart", async () => {
    const conflicting = { ...recorded["http-0006"], elapsedMs: 1 } as DailyCaptureEvidence;
    const id = await dailyRun([
      ...call("call-1", "get_daily_http_observations", {}, pick("http-0006")),
      ...call("call-2", "get_daily_http_observations", { path: "/feed" }, [conflicting]),
    ], { final: { ...answer, evidenceIds: [] } });
    const view = await daily(id);
    expect(view.checks.toolTrace.status).toBe("fail");
    expect(view.ambiguousEvidenceIds).toEqual(["http-0006"]);
    expect(Object.keys(view.records).sort()).toEqual(["http-0006", "http-0006#2"]);
    expect((view.records["http-0006#2"] as DailyHttpObservation).elapsedMs).toBe(1);
    expect(view.activity.filter((item) => item.kind === "tool").map((item) => item.tool?.results[0].recordKeys)).toEqual([["http-0006"], ["http-0006#2"]]);
    expect(describeOf(view, "call-1")).toBe("all paths · first page");
    expect(describeOf(view, "call-2")).toBe("path /feed · first page");
    expect(view.reviewEligible).toBe(false);
    expect(view.reviewBlocked).toMatch(/invalid evidence trace/);
  });

  it("shows a failed tool call with its own message and accepts no records from it", async () => {
    const id = await dailyRun([
      event("actions.requested", { stepIndex: 0, actions: [{ kind: "tool-call", toolName: "get_daily_logs", callId: "call-1", input: { limit: 5 } }] }),
      event("action.result", { status: "failed", error: { code: "TOOL_ERROR", message: "get_daily_logs timed out after 5 seconds." },
        result: { kind: "tool-result", toolName: "get_daily_logs", callId: "call-1", isError: true, output: "get_daily_logs timed out after 5 seconds." } }),
      event("actions.requested", { stepIndex: 1, actions: [{ kind: "tool-call", toolName: "get_daily_logs", callId: "call-2", input: {} }] }),
      event("action.result", { status: "failed", error: { code: "TOOL_ERROR", message: "Stack trace at /Users/someone/private/path" },
        result: { kind: "tool-result", toolName: "get_daily_logs", callId: "call-2", isError: true, output: "Stack trace" } }),
    ], { final: { ...answer, evidenceIds: [] } });
    const view = await daily(id);
    const [ownMessage, other] = view.activity.filter((item) => item.kind === "tool");
    expect(ownMessage).toMatchObject({ status: "failed", detail: "Tool call failed" });
    expect(ownMessage.tool?.results[0]).toMatchObject({ recordKeys: null, error: "The tool call failed: get_daily_logs timed out after 5 seconds." });
    // Text that did not come from the tool's own messages is not shown.
    expect(other.tool?.results[0].error).toBe("The tool call failed. No evidence was accepted from this result.");
    expect(JSON.stringify(view)).not.toContain("/Users/someone");
    expect(view.evidence).toEqual([]);
  });
});

function describeOf(view: DailyRunView, callId: string) {
  return view.activity.find((item) => item.tool?.callId === callId)?.tool?.request;
}

describe("coverage in the workbench", () => {
  it("offers Check coverage for a terminal run without an assessment, then shows the saved rows", async () => {
    // Retrieved failures and the early success only: recovery is missed.
    const id = await dailyRun(call("call-1", "get_daily_http_observations", { path: "/feed" }, pick("http-0001", "http-0002", "http-0003", "http-0004")),
      { final: { ...answer, evidenceIds: ["http-0002"] } });
    const before = await daily(id);
    expect(before.coverage).toMatchObject({ state: "not_checked", action: "check", blocked: null, error: null, assessment: null });

    await createCoverageStore(pool).assess(id, { capturesDir: dir });
    const view = await daily(id);
    expect(view.coverage).toMatchObject({ state: "missed", action: null, assessment: { result: "missed", integrity: { matchesCurrentRecord: true } } });
    const facts = view.coverage.assessment!.facts;
    expect(facts.map((fact) => [fact.id, fact.status])).toEqual([["server_errors", "covered"], ["no_response", "covered"], ["recovery", "missed"]]);
    // Recovery's missing requirement lists the recording's later successes. They
    // are labeled as not retrieved and never become received evidence or records.
    expect(Object.keys(view.coverage.assessment!.notRetrieved)).toEqual(["http-0009", "http-0011"]);
    expect(view.coverage.assessment!.notRetrieved["http-0009"]).toEqual(recorded["http-0009"]);
    expect(view.evidence.map((entry) => entry.id)).not.toContain("http-0009");
    expect(Object.keys(view.records)).not.toContain("http-0009");
    expect(view.activity.find((item) => item.kind === "coverage")).toMatchObject({ title: "Coverage saved: missed", detail: "Saved by pnpm lab:coverage · no model request" });
    expect(JSON.stringify(view.coverage)).not.toMatch(/correct/i);
    expect((await web.list()).items.find((item) => item.id === id)).toMatchObject({ coverage: { state: "missed", missedFacts: ["Recovery evidence"] } });
  });

  it("marks a saved assessment historical when the record stops verifying, and offers no new assessment", async () => {
    const id = await dailyRun(call("call-1", "get_daily_http_observations", { path: "/feed" }, pick("http-0002")));
    await createCoverageStore(pool).assess(id, { capturesDir: dir });
    const fresh = await daily(id);
    await bypassingTriggers(pool, "lab_investigation_events", () => pool.query(
      `UPDATE lab_investigation_events SET payload = jsonb_set(payload, '{data,result,output,observations,0,elapsedMs}', '7') WHERE run_id = $1 AND payload ->> 'type' = 'action.result'`, [id]));
    const view = await daily(id);
    expect(view.integrity.status).toBe("mismatch");
    expect(view.coverage.assessment).toMatchObject({ id: fresh.coverage.assessment!.id, integrity: { matchesCurrentRecord: false } });
    expect(view.reviewEligible).toBe(false);
    await withWorker(async (jobs) => {
      await expect(jobs.submit({ requestId: randomUUID(), kind: "coverage", runId: id })).rejects.toMatchObject({ code: "invalid" });
    });
    // Without an assessment, the action exists but is blocked by the record.
    const other = await dailyRun(call("call-1", "get_daily_http_observations", { path: "/feed" }, pick("http-0002")));
    await bypassingTriggers(pool, "lab_investigation_runs", () =>
      pool.query("UPDATE lab_investigation_runs SET answer = jsonb_set(answer, '{uncertainty}', '\"Edited.\"') WHERE id = $1", [other]));
    expect((await daily(other)).coverage).toMatchObject({ state: "not_checked", action: "check", blocked: expect.stringContaining("integrity fingerprint") });
  });

  it("never writes when the view is read or reread", async () => {
    const id = await dailyRun(call("call-1", "get_daily_http_observations", {}, pick("http-0002")));
    const first = await web.get(id);
    const second = await web.get(id);
    expect(second).toEqual(first);
    expect(await count("lab_coverage_assessments", id)).toBe(0);
    expect(await count("lab_execution_jobs", id)).toBe(0);
    expect(await count("lab_investigation_reviews", id)).toBe(0);
  });
});

describe("browser operations for Daily recordings", () => {
  it("verifies a chosen recording at admission and refuses an invalid or unknown one", async () => {
    await withWorker(async (jobs) => {
      const command = { requestId: randomUUID(), kind: "investigate" as const, source: "daily_capture" as const, captureId: CAPTURE_ID };
      const job = await jobs.submit(command);
      expect(job).toMatchObject({ kind: "investigate", runId: null, status: "queued", command });
      expect((await jobs.submit(command)).id).toBe(job.id);
      await jobs.finish(job.id, "cancelled", "Test cleanup.");
      const invalid = jobs.submit({ ...command, requestId: randomUUID(), captureId: INVALID_ID });
      await expect(invalid).rejects.toThrow(JobError);
      await expect(invalid).rejects.toMatchObject({ code: "invalid", message: `Capture ${INVALID_ID} is cancelled; only a completed recording is served as evidence. Choose another recording.` });
      await expect(jobs.submit({ ...command, requestId: randomUUID(), captureId: "20991231T000000Z-000000" })).rejects.toMatchObject({ code: "missing" });
      await expect(jobs.submit({ ...command, requestId: randomUUID(), captureId: "../" + CAPTURE_ID } as never)).rejects.toThrow();
      await expect(jobs.submit({ ...command, requestId: randomUUID(), caseId: "no-logs" } as never)).rejects.toThrow();
    });
  });

  it("links the run to its job in the same transaction that creates it", async () => {
    await withWorker(async (jobs) => {
      const job = await jobs.submit({ requestId: randomUUID(), kind: "investigate", source: "daily_capture", captureId: CAPTURE_ID });
      const runCount = async () => (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM lab_investigation_runs")).rows[0].n;
      const before = await runCount();
      // A job that is not running cannot take a run, and the run is not saved either.
      await expect(dailyRun([], { finish: null, jobId: job.id })).rejects.toThrow(/attach/);
      expect(await runCount()).toBe(before);
      const owner = (await pool.query<{ owner: string }>("SELECT owner FROM lab_worker")).rows[0].owner;
      expect((await jobs.claim(owner))?.id).toBe(job.id);
      const id = await dailyRun([], { finish: null, jobId: job.id });
      expect((await jobs.get(job.id)).runId).toBe(id);
      await expect(dailyRun([], { finish: null, jobId: job.id })).rejects.toThrow(/attach/);
      const view = await daily(id);
      expect(view.activeJobId).toBe(job.id);
      expect(snapshotSettled(view)).toBe(false);
    });
  });

  it("queues coverage in the commit that finishes a completed investigation, once, unless cancellation was requested", async () => {
    await withWorker(async (jobs) => {
      const owner = (await pool.query<{ owner: string }>("SELECT owner FROM lab_worker")).rows[0].owner;
      const start = async () => {
        const job = await jobs.submit({ requestId: randomUUID(), kind: "investigate", source: "daily_capture", captureId: CAPTURE_ID });
        await jobs.claim(owner);
        const id = await dailyRun([], { finish: null, jobId: job.id });
        for (const step of [...call("call-1", "get_daily_http_observations", {}, pick("http-0002")), event("result.completed", { result: answer })]) await runs.appendEvent(id, step);
        await runs.finish(id, { status: "completed", answer, message: "" });
        return { job, id };
      };
      const { job, id } = await start();
      // Watch for a moment with no active operation while the job finishes.
      let gap = false;
      const watching = (async () => {
        for (let index = 0; index < 40; index++) if (!(await daily(id)).activeJobId) gap = true;
      })();
      await jobs.finish(job.id, "completed", undefined, { kind: "coverage", runId: id });
      await watching;
      const queued = await pool.query("SELECT id, kind, status, run_id AS \"runId\", scheduled_by AS \"scheduledBy\", command FROM lab_execution_jobs WHERE scheduled_by = $1", [job.id]);
      expect(queued.rows).toHaveLength(1);
      expect(queued.rows[0]).toMatchObject({ kind: "coverage", status: "queued", runId: id, command: { kind: "coverage", runId: id } });
      expect(gap).toBe(false);
      const view = await daily(id);
      expect(view.coverage.state).toBe("checking");
      expect(view.operations.map((operation) => [operation.kind, operation.status, operation.automatic])).toEqual([["investigate", "completed", false], ["coverage", "queued", true]]);
      expect(view.activity.find((item) => item.kind === "coverage")).toMatchObject({ title: "Coverage check queued", detail: expect.stringContaining("Automatic after the answer") });
      expect(snapshotSettled(view)).toBe(false);
      // A repeated finish queues nothing more.
      await jobs.finish(job.id, "completed", undefined, { kind: "coverage", runId: id });
      expect((await pool.query("SELECT count(*)::int AS n FROM lab_execution_jobs WHERE run_id = $1 AND kind = 'coverage'", [id])).rows[0].n).toBe(1);
      // The coverage job is claimed next; a missed fact is a completed job.
      const coverageJob = await jobs.claim(owner);
      expect(coverageJob).toMatchObject({ kind: "coverage", runId: id, scheduledBy: job.id });
      await createCoverageStore(pool).assess(id, { capturesDir: dir });
      await jobs.finish(coverageJob!.id, "completed");
      const settled = await daily(id);
      expect(settled.coverage.state).toBe("missed");
      expect(snapshotSettled(settled)).toBe(true);

      // Cancellation requested before the answer was saved: no automatic coverage.
      const second = await start();
      await jobs.cancel(second.job.id);
      await jobs.finish(second.job.id, "completed", undefined, { kind: "coverage", runId: second.id });
      expect((await pool.query("SELECT count(*)::int AS n FROM lab_execution_jobs WHERE run_id = $1 AND kind = 'coverage'", [second.id])).rows[0].n).toBe(0);
      expect((await daily(second.id)).coverage).toMatchObject({ state: "not_checked", action: "check" });
    });
  });

  it("admits an explicit coverage job only for a completed, verified run without an assessment", async () => {
    const id = await dailyRun(call("call-1", "get_daily_http_observations", {}, pick("http-0002")));
    const failed = await dailyRun(call("call-1", "get_daily_http_observations", {}, pick("http-0002")), { finish: "failed" });
    await withWorker(async (jobs) => {
      const job = await jobs.submit({ requestId: randomUUID(), kind: "coverage", runId: id });
      expect(job).toMatchObject({ kind: "coverage", runId: id, scheduledBy: null, status: "queued" });
      await jobs.finish(job.id, "failed", "Coverage could not be checked. Fixture failure.");
      const view = await daily(id);
      expect(view.coverage).toMatchObject({ state: "check_failed", action: "retry", error: "Coverage could not be checked. Fixture failure." });
      expect(view.activity.find((item) => item.kind === "coverage")).toMatchObject({ title: "Coverage check failed", error: "Coverage could not be checked. Fixture failure." });
      await expect(jobs.submit({ requestId: randomUUID(), kind: "coverage", runId: failed })).rejects.toMatchObject({ code: "invalid" });
      expect((await daily(failed)).coverage).toMatchObject({ state: "not_applicable", action: null });
      await createCoverageStore(pool).assess(id, { capturesDir: dir });
      await expect(jobs.submit({ requestId: randomUUID(), kind: "coverage", runId: id })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("already has a saved coverage assessment") });
      await expect(jobs.submit({ requestId: randomUUID(), kind: "coverage", runId: randomUUID() })).rejects.toMatchObject({ code: "missing" });
    });
  });
});

describe("review input size", () => {
  it("explains before the click, and refuses at admission, a review whose exact input would exceed the limit", async () => {
    const lines = Array.from({ length: 40 }, (_, index) => log(100 + index, `ERROR fixture line ${index} ${"y".repeat(2_000)}`));
    const id = await dailyRun([
      ...call("call-1", "get_daily_logs", {}, lines.slice(0, 20), { nextCursor: "page-2" }),
      ...call("call-2", "get_daily_logs", { cursor: "page-2" }, lines.slice(20)),
    ], { final: { ...answer, evidenceIds: ["log-api-0100"] } });
    const view = await daily(id);
    expect(view.checks).toMatchObject({ execution: { status: "pass" }, answer: { status: "pass" }, toolTrace: { status: "pass" } });
    expect(view.reviewEligible).toBe(false);
    expect(view.reviewBlocked).toMatch(/^The review input would be [\d,]+ bytes, over the 65,536-byte limit\. Evidence is never truncated/);
    await withWorker(async (jobs) => {
      const refused = jobs.submit({ requestId: randomUUID(), kind: "review", runId: id });
      await expect(refused).rejects.toThrow(JobError);
      await expect(refused).rejects.toMatchObject({ code: "invalid", message: view.reviewBlocked });
    });
    expect(await count("lab_execution_jobs", id)).toBe(0);
    expect(await count("lab_investigation_reviews", id)).toBe(0);
  });
});

describe("worker recovery", () => {
  it("finishes an interrupted Daily run with its frozen report, revokes its grant, and keeps its evidence", async () => {
    const access = createCaptureAccess(pool, dir);
    const own = await access.grant(CAPTURE_ID);
    await withWorker(async (jobs) => {
      const owner = (await pool.query<{ owner: string }>("SELECT owner FROM lab_worker")).rows[0].owner;
      const job = await jobs.submit({ requestId: randomUUID(), kind: "investigate", source: "daily_capture", captureId: CAPTURE_ID });
      await jobs.claim(owner);
      const id = await runs.createDaily({
        captureId: own.grant.captureId, grantId: own.grant.id, sha256: own.grant.sha256, task: "Fixture task.",
        instructions: "Fixture.", agentConfigSource: "{}", configuration: { toolMode: "daily_capture" },
      }, job.id);
      for (const step of call("call-1", "get_daily_http_observations", {}, pick("http-0002"))) await runs.appendEvent(id, step);
      await jobs.recover();
      const run = await runs.getDaily(id);
      expect(run).toMatchObject({ status: "failed", error: expect.stringContaining("Local worker stopped"), answer: null });
      expect(run.evidenceReport?.checks).toMatchObject({ execution: { status: "fail" }, retrieval: { status: "pass" } });
      expect(run.integrity).toMatchObject({ status: "verified", fingerprint: { origin: "finalization", eventCount: 2 } });
      expect(run.grantRevokedAt).not.toBeNull();
      await expect(access.resolve(own.token)).rejects.toThrow(/revoked/);
      expect(await jobs.get(job.id)).toMatchObject({ status: "failed" });
      const view = await daily(id);
      expect(view.error).toContain("Local worker stopped");
      expect(view.coverage.state).toBe("not_applicable");
    });
  });

  it("keeps a completed answer, settles running coverage by what it saved, and leaves queued coverage to run", async () => {
    await withWorker(async (jobs) => {
      const owner = (await pool.query<{ owner: string }>("SELECT owner FROM lab_worker")).rows[0].owner;
      const id = await dailyRun(call("call-1", "get_daily_http_observations", {}, pick("http-0002")));
      // Interrupted after the assessment was saved: the job counts as completed.
      const saved = await jobs.submit({ requestId: randomUUID(), kind: "coverage", runId: id });
      await jobs.claim(owner);
      await createCoverageStore(pool).assess(id, { capturesDir: dir });
      await jobs.recover();
      expect(await jobs.get(saved.id)).toMatchObject({ status: "completed", error: null });
      // Interrupted before saving: failed, and Retry coverage is offered.
      const other = await dailyRun(call("call-1", "get_daily_http_observations", {}, pick("http-0002")));
      const interrupted = await jobs.submit({ requestId: randomUUID(), kind: "coverage", runId: other });
      await jobs.claim(owner);
      await jobs.recover();
      expect(await jobs.get(interrupted.id)).toMatchObject({ status: "failed", error: expect.stringContaining("Retry coverage") });
      expect((await daily(other)).coverage).toMatchObject({ state: "check_failed", action: "retry" });
      expect((await runs.getDaily(other)).status).toBe("completed");
      // Never claimed: it stays queued for the restarted worker.
      const queued = await jobs.submit({ requestId: randomUUID(), kind: "coverage", runId: other });
      await jobs.recover();
      expect(await jobs.get(queued.id)).toMatchObject({ status: "queued" });
    });
  });
});

describe("listing saved recordings", () => {
  it("lists capture-ID entries newest first through the evidence checks, with metadata only", async () => {
    const root = await capturesDir();
    await writeCapture(root, { captureId: CAPTURE_ID, evidence: feedAvailabilityEvidence() });
    await writeCapture(root, { captureId: INVALID_ID, manifest: (manifest) => ({ ...manifest, status: "interrupted" }) });
    const elsewhere = await capturesDir();
    await writeCapture(elsewhere, { captureId: "20261031T131000Z-fade03" });
    await symlink(join(elsewhere, "20261031T131000Z-fade03"), join(root, "20261031T131000Z-fade03"));
    await mkdir(join(root, "not-a-capture"));
    await writeFile(join(root, "notes.txt"), "ignored");
    const listed = await listDailyCaptures(root);
    expect(listed.map((item) => [item.captureId, item.available])).toEqual([
      ["20261031T131000Z-fade03", false],
      [INVALID_ID, false],
      [CAPTURE_ID, true],
    ]);
    expect(listed[2]).toEqual({ captureId: CAPTURE_ID, available: true, recordedAt: "2026-10-22T05:01:00.000Z", finishedAt: "2026-10-22T05:03:00.000Z", httpObservations: 12, logLines: 3 });
    expect(listed[0]).toMatchObject({ available: false, recordedAt: "2026-10-31T13:10:00.000Z", problem: { code: "invalid", message: expect.stringContaining("symbolic link") } });
    expect(listed[1]).toMatchObject({ problem: { code: "rejected", message: `Capture ${INVALID_ID} is interrupted; only a completed recording is served as evidence.` } });
    const json = JSON.stringify(listed);
    for (const hidden of [root, elsewhere, CONTROLLER_ONLY, "sha256", "manifest", "notes.txt", "not-a-capture"]) expect(json).not.toContain(hidden);
    expect(await listDailyCaptures(join(root, "missing"))).toEqual([]);
    await rm(join(root, "20261031T131000Z-fade03"));
  });
});
