import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewConfig } from "@agent-lab/contracts";
import { createPool } from "../src/database";
import { createTrial } from "../src/fixtures";
import { createJobStore, JobError } from "../src/jobs";
import { migrate } from "../src/migrate";
import { createReviewStore } from "../src/reviews";
import { createRunStore } from "../src/runs";
import { bypassingTriggers } from "./administrator";

// Migration 010: append-only events and the fingerprint sealed when a run
// finishes. Everything here uses real PostgreSQL in a schema of its own.

const admin = createPool();
const schema = `integrity_${randomUUID().replaceAll("-", "")}`;
const url = new URL(process.env.DATABASE_URL!);
url.searchParams.set("options", `-c search_path=${schema}`);
const pool = createPool(url.toString());
const runs = createRunStore(pool);

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

const answer = { diagnosis: "Startup configuration was missing.", evidenceIds: ["log-17"], uncertainty: "No later evidence." };
const turn = { turnId: "turn-1", sequence: 0, stepIndex: 0 };
const event = <T extends object>(type: string, id: string, data: T) => ({ type, meta: { id, at: "2026-10-31T00:00:00.000Z" }, data: { ...turn, ...data } });
const request = () => event("actions.requested", "request", { actions: [{ kind: "tool-call", toolName: "get_logs", callId: "call-1", input: { deploymentId: "B" } }] });
const result = () => event("action.result", "result", { status: "completed", result: { kind: "tool-result", toolName: "get_logs", callId: "call-1", output: { logs: [
  { id: "log-17", deploymentId: "B", level: "error", message: "Startup failed: DATABASE_URL is missing." },
] } } });
const completed = () => event("result.completed", "answer", { result: answer });

async function running() {
  const { trialId } = await createTrial(pool);
  return runs.create({ trialId, deploymentId: "B", task: "Investigate B.", instructions: "Investigate.", agentConfigSource: "{}" });
}

/** A completed simulated run with a valid trace: a tool request, its result, and the answer. */
async function finished() {
  const id = await running();
  for (const value of [request(), result(), completed()]) await runs.appendEvent(id, value);
  await runs.finish(id, { status: "completed", answer, message: "Done." });
  return id;
}

const eventCount = async (id: string) =>
  (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM lab_investigation_events WHERE run_id = $1", [id])).rows[0].n;

function cli(...args: string[]) {
  return new Promise<{ code: number | string; stdout: string }>((resolve) => {
    execFile(process.execPath, ["--import", "tsx", "packages/lab/src/cli.ts", ...args], { env: { ...process.env, DATABASE_URL: url.toString() }, timeout: 15_000 },
      (error, stdout) => resolve({ code: error?.code ?? 0, stdout }));
  });
}

/** Waits until another backend is waiting for a lock held by this connection. */
async function untilSomeoneWaitsOn(holder: PoolClient) {
  const { rows: [{ pid }] } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  for (let attempt = 0; attempt < 200; attempt++) {
    const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid]);
    if (waiting.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("No other connection waited for the lock.");
}

describe("sealing a finished run", () => {
  it("saves the fingerprint with the final status and verifies it on every read", async () => {
    const id = await finished();
    const saved = await runs.get(id);
    expect(saved.integrity).toMatchObject({
      status: "verified",
      fingerprint: { version: 1, eventCount: 3, origin: "finalization", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      currentEventCount: 3,
    });
    expect(saved.integrity.currentSha256).toBe(saved.integrity.fingerprint!.sha256);
    // The fingerprint is saved no earlier than the final status, in the same commit.
    expect(Date.parse(saved.integrity.fingerprint!.createdAt)).toBeGreaterThanOrEqual(Date.parse(saved.finishedAt!));
    const text = await cli("run", id);
    expect(text.stdout).toContain(`Integrity: verified (fingerprint v1 of 3 event(s), saved when the run finished, ${saved.integrity.fingerprint!.createdAt}; SHA-256 ${saved.integrity.fingerprint!.sha256})`);
    const evaluation = await cli("evaluate", id, "--json");
    expect(evaluation.code).toBe(0);
    expect(JSON.parse(evaluation.stdout).integrity).toEqual(saved.integrity);
  }, 30_000);

  it("leaves a running run unsealed and refuses a fingerprint set by hand", async () => {
    const id = await running();
    expect((await runs.get(id)).integrity).toEqual({ status: "not_finished", fingerprint: null, currentSha256: null, currentEventCount: 0 });
    await expect(pool.query(
      "UPDATE lab_investigation_runs SET integrity_version = 1, integrity_sha256 = repeat('a', 64), integrity_event_count = 0, integrity_created_at = now(), integrity_origin = 'finalization' WHERE id = $1",
      [id])).rejects.toThrow(/run_integrity_fingerprint/);
  });

  it("seals cancellation, and a run inserted already finished with no events", async () => {
    const id = await running();
    await runs.appendEvent(id, request());
    await runs.finish(id, { status: "cancelled", error: "Cancelled." });
    expect((await runs.get(id)).integrity).toMatchObject({ status: "verified", fingerprint: { origin: "finalization", eventCount: 1 } });

    const { trialId } = await createTrial(pool);
    const inserted = randomUUID();
    await pool.query(
      `INSERT INTO lab_investigation_runs (id, trial_id, deployment_id, task, instructions, instructions_sha256, agent_config_source, status, finished_at, error)
       VALUES ($1, $2, 'B', 't', 'i', repeat('a', 64), '{}', 'failed', now(), 'Failed.')`, [inserted, trialId]);
    expect((await runs.get(inserted)).integrity).toMatchObject({ status: "verified", fingerprint: { origin: "finalization", eventCount: 0 } });
    await expect(pool.query("INSERT INTO lab_investigation_events (run_id, event_id, payload) VALUES ($1, 'late', $2)", [inserted, JSON.stringify(request())]))
      .rejects.toThrow(/already finished/);
  });

  it("seals interrupted work that worker recovery marks failed", async () => {
    const jobs = createJobStore(pool);
    const owner = randomUUID();
    await jobs.register(owner);
    try {
      const job = await jobs.submit({ requestId: randomUUID(), kind: "investigate", deploymentId: "B" });
      await jobs.claim(owner);
      const { trialId } = await createTrial(pool);
      const id = await runs.create({ trialId, deploymentId: "B", task: "Investigate B.", instructions: "Investigate.", agentConfigSource: "{}" }, job.id);
      await runs.appendEvent(id, request());
      await jobs.recover();
      expect(await runs.get(id)).toMatchObject({
        status: "failed", error: expect.stringContaining("Local worker stopped"),
        integrity: { status: "verified", fingerprint: { origin: "finalization", eventCount: 1 } },
      });
    } finally {
      await jobs.unregister(owner);
    }
  });
});

describe("append-only events", () => {
  it("rejects direct SQL changes to a saved event's contents, identity, order, and time, and its deletion", async () => {
    const id = await running();
    await runs.appendEvent(id, request());
    await runs.appendEvent(id, result());
    const before = (await pool.query("SELECT * FROM lab_investigation_events WHERE run_id = $1 ORDER BY sequence", [id])).rows;
    const where = `WHERE run_id = '${id}' AND event_id = 'result'`;
    for (const change of [
      `payload = jsonb_set(payload, '{data,status}', '"failed"')`,
      `event_id = 'renamed', payload = jsonb_set(payload, '{meta,id}', '"renamed"')`,
      "sequence = DEFAULT",
      "recorded_at = recorded_at - interval '1 hour'",
      "payload = payload",
    ]) await expect(pool.query(`UPDATE lab_investigation_events SET ${change} ${where}`)).rejects.toThrow(/Saved investigation events are immutable/);
    await expect(pool.query(`DELETE FROM lab_investigation_events ${where}`)).rejects.toThrow(/deleted only with their whole run/);
    await expect(pool.query("TRUNCATE lab_investigation_events")).rejects.toThrow(/deleted only with their whole run/);
    // Appended means after every saved event, even with an explicit sequence.
    await expect(pool.query(
      "INSERT INTO lab_investigation_events (run_id, event_id, payload, sequence) OVERRIDING SYSTEM VALUE VALUES ($1, 'early', $2, 1)",
      [id, JSON.stringify(event("message.received", "early", {}))])).rejects.toThrow(/appended after/);
    expect((await pool.query("SELECT * FROM lab_investigation_events WHERE run_id = $1 ORDER BY sequence", [id])).rows).toEqual(before);
  });

  it("refuses an event inserted directly after the run finished", async () => {
    const id = await finished();
    const sealed = (await runs.get(id)).integrity;
    await expect(pool.query("INSERT INTO lab_investigation_events (run_id, event_id, payload) VALUES ($1, 'late', $2)", [id, JSON.stringify(event("message.received", "late", {}))]))
      .rejects.toThrow(/already finished; its saved events are sealed/);
    expect((await runs.get(id)).integrity).toEqual(sealed);
  });

  it("keeps identical replay a no-op and refuses conflicting replay, before and after the run finishes", async () => {
    const id = await running();
    await Promise.all([runs.appendEvent(id, request()), runs.appendEvent(id, request())]);
    expect(await eventCount(id)).toBe(1);
    const conflicting = { ...request(), data: { ...turn, actions: [] } };
    await expect(runs.appendEvent(id, conflicting)).rejects.toThrow(/different payload/);
    for (const value of [result(), completed()]) await runs.appendEvent(id, value);
    await runs.finish(id, { status: "completed", answer, message: "Done." });
    const sealed = (await runs.get(id)).integrity;

    await runs.appendEvent(id, request());
    await runs.appendEvent(id, completed());
    await expect(runs.appendEvent(id, conflicting)).rejects.toThrow(/different payload/);
    await expect(runs.appendEvent(id, event("message.received", "late", {}))).rejects.toThrow(/already finished/);
    expect((await runs.get(id)).integrity).toEqual(sealed);
    expect(sealed).toMatchObject({ status: "verified", fingerprint: { eventCount: 3 } });
  });
});

describe("finished runs never change", () => {
  it.each([
    ["the answer", `answer = '{"diagnosis": "Changed.", "evidenceIds": [], "uncertainty": "None."}'`],
    ["the status", "status = 'running', finished_at = NULL, answer = NULL"],
    ["the usage", `usage = '{"costUsd": 0}'`],
    ["the message", "assistant_message = 'Changed.'"],
    ["the finish time", "finished_at = finished_at + interval '1 second'"],
    ["the model", "model_id = 'other/model'"],
    ["the fingerprint", "integrity_sha256 = repeat('0', 64)"],
    ["the fingerprint origin", "integrity_origin = 'legacy_snapshot'"],
    ["the fingerprint time", "integrity_created_at = now()"],
    ["the start time", "started_at = started_at - interval '1 hour'"],
  ])("rejects a change to %s", async (_name, change) => {
    const id = await finished();
    const before = (await pool.query("SELECT * FROM lab_investigation_runs WHERE id = $1", [id])).rows[0];
    await expect(pool.query(`UPDATE lab_investigation_runs SET ${change} WHERE id = $1`, [id])).rejects.toThrow(/Finished investigation runs are immutable/);
    expect((await pool.query("SELECT * FROM lab_investigation_runs WHERE id = $1", [id])).rows[0]).toEqual(before);
  });

  it("refuses to finish a run twice", async () => {
    const id = await finished();
    await expect(runs.finish(id, { status: "failed", error: "Overwrite." })).rejects.toThrow(/already finished/);
    await expect(pool.query("UPDATE lab_investigation_runs SET status = 'failed', answer = NULL, error = 'x' WHERE id = $1", [id])).rejects.toThrow(/immutable/);
  });
});

describe("inserting events while a run finishes, from separate connections", () => {
  it("an event committed first is part of the final fingerprint", async () => {
    const id = await running();
    await runs.appendEvent(id, request());
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("INSERT INTO lab_investigation_events (run_id, event_id, payload) VALUES ($1, 'result', $2)", [id, JSON.stringify(result())]);
      // The insert holds the run's row lock, so finishing waits for it.
      const finishing = runs.finish(id, { status: "failed", error: "Stopped." });
      await untilSomeoneWaitsOn(writer);
      await writer.query("COMMIT");
      await finishing;
    } finally {
      writer.release(true); // Closing the connection also ends any transaction a failure left open.
    }
    const saved = await runs.get(id);
    expect(saved.events.map((value) => value.meta.id)).toEqual(["request", "result"]);
    expect(saved.integrity).toMatchObject({ status: "verified", fingerprint: { eventCount: 2 } });
  });

  it("a direct SQL finish, as worker recovery does, waits for an event in flight and includes it", async () => {
    const id = await running();
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("INSERT INTO lab_investigation_events (run_id, event_id, payload) VALUES ($1, 'request', $2)", [id, JSON.stringify(request())]);
      const finishing = pool.query("UPDATE lab_investigation_runs SET status = 'failed', error = 'Recovered.', finished_at = clock_timestamp() WHERE id = $1 AND status = 'running'", [id]);
      await untilSomeoneWaitsOn(writer);
      await writer.query("COMMIT");
      await finishing;
    } finally {
      writer.release(true);
    }
    expect((await runs.get(id)).integrity).toMatchObject({ status: "verified", fingerprint: { eventCount: 1 } });
  });

  it("a REPEATABLE READ transaction, whose snapshot could miss a committed event, cannot finish a run", async () => {
    const id = await running();
    await runs.appendEvent(id, request());
    const finisher = await pool.connect();
    try {
      await finisher.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await finisher.query("SELECT count(*) FROM lab_investigation_events"); // The snapshot is taken here.
      await runs.appendEvent(id, result());
      await expect(finisher.query("UPDATE lab_investigation_runs SET status = 'failed', error = 'Stopped.', finished_at = clock_timestamp() WHERE id = $1", [id]))
        .rejects.toThrow(/finished at READ COMMITTED isolation/);
    } finally {
      finisher.release(true);
    }
    await runs.finish(id, { status: "failed", error: "Stopped." });
    expect((await runs.get(id)).integrity).toMatchObject({ status: "verified", fingerprint: { eventCount: 2 } });
  });

  it("an event that waits for the finish is refused", async () => {
    const id = await running();
    await runs.appendEvent(id, request());
    const finisher = await pool.connect();
    try {
      await finisher.query("BEGIN");
      // Direct SQL, as worker recovery finishes a run.
      await finisher.query("UPDATE lab_investigation_runs SET status = 'cancelled', error = 'Cancelled.', finished_at = clock_timestamp() WHERE id = $1", [id]);
      const inserting = pool.query("INSERT INTO lab_investigation_events (run_id, event_id, payload) VALUES ($1, 'late', $2)", [id, JSON.stringify(result())]);
      inserting.catch(() => undefined);
      await untilSomeoneWaitsOn(finisher);
      await finisher.query("COMMIT");
      await expect(inserting).rejects.toThrow(/already finished/);
    } finally {
      finisher.release(true);
    }
    const saved = await runs.get(id);
    expect(saved.events.map((value) => value.meta.id)).toEqual(["request"]);
    expect(saved.integrity).toMatchObject({ status: "verified", fingerprint: { eventCount: 1 } });
  });
});

describe("the fingerprint", () => {
  const reverseKeys = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(reverseKeys)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reverseKeys(inner)]))
        : value;

  it("is computed from PostgreSQL's jsonb, so JavaScript key order never changes it", async () => {
    const [a, b] = [await running(), await running()];
    const insert = (run: string, value: { meta: { id: string } }, text: string) =>
      pool.query("INSERT INTO lab_investigation_events (run_id, event_id, payload) VALUES ($1, $2, $3::jsonb)", [run, value.meta.id, text]);
    for (const value of [request(), result()]) {
      const reversed = JSON.stringify(reverseKeys(value));
      expect(reversed).not.toBe(JSON.stringify(value));
      await insert(a, value, JSON.stringify(value));
      await insert(b, value, reversed);
    }
    // Compared as text: the exact bytes the fingerprint hashes.
    const documents = await pool.query<{ id: string; events: string }>(
      "SELECT id, (lab_run_integrity_document(r, 1) -> 'events')::text AS events FROM lab_investigation_runs r WHERE id = ANY($1::uuid[])", [[a, b]]);
    expect(documents.rows).toHaveLength(2);
    expect(documents.rows[0].events).toBe(documents.rows[1].events);
  });

  it("still verifies after equal contents are rewritten in another key order, and detects a changed value", async () => {
    const id = await finished();
    const sealed = (await runs.get(id)).integrity;
    const rewrite = (payload: string) => bypassingTriggers(pool, "lab_investigation_events", () =>
      pool.query("UPDATE lab_investigation_events SET payload = $2::jsonb WHERE run_id = $1 AND event_id = 'result'", [id, payload]));

    await rewrite(JSON.stringify(reverseKeys(result())));
    expect((await runs.get(id)).integrity).toEqual(sealed);

    const changed = result();
    changed.data.result.output.logs[0].message = "Startup succeeded.";
    await rewrite(JSON.stringify(changed));
    const now = (await runs.get(id)).integrity;
    expect(now).toMatchObject({ status: "mismatch", fingerprint: sealed.fingerprint, currentEventCount: 3 });
    expect(now.currentSha256).not.toBe(sealed.fingerprint!.sha256);

    // Nothing new is built from the changed record.
    const reviewer: ReviewConfig = {
      source: "simulated", modelId: "test/reviewer", promptVersion: "test-v1", schemaVersion: 1, system: "Review.",
      settings: { maxOutputTokens: 100, maxRetries: 0, timeoutMs: 1_000, maxInputBytes: 65_536 },
    };
    await expect(createReviewStore(pool).start(id, reviewer)).rejects.toThrow(`Investigation ${id} no longer matches its integrity fingerprint`);
    const jobs = createJobStore(pool);
    const owner = randomUUID();
    await jobs.register(owner);
    try {
      const submitted = jobs.submit({ requestId: randomUUID(), kind: "review", runId: id });
      await expect(submitted).rejects.toThrow(JobError);
      await expect(submitted).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("integrity fingerprint") });
    } finally {
      await jobs.unregister(owner);
    }
    const evaluation = await cli("evaluate", id);
    expect(evaluation.code).toBe(1);
    expect(evaluation.stdout).toContain("Integrity: MISMATCH (fingerprint v1 of 3 event(s)");
  }, 30_000);

  it("detects a changed answer", async () => {
    const id = await finished();
    await bypassingTriggers(pool, "lab_investigation_runs", () => pool.query(
      `UPDATE lab_investigation_runs SET answer = jsonb_set(answer, '{diagnosis}', '"Something else."') WHERE id = $1`, [id]));
    expect((await runs.get(id)).integrity.status).toBe("mismatch");
  });
});

describe("whole-run deletion", () => {
  it("still removes a run's events with the run, or with its trial", async () => {
    const id = await finished();
    await pool.query("DELETE FROM lab_investigation_runs WHERE id = $1", [id]);
    expect(await eventCount(id)).toBe(0);

    const { trialId } = await createTrial(pool);
    const other = await runs.create({ trialId, deploymentId: "B", task: "t", instructions: "i", agentConfigSource: "{}" });
    await runs.appendEvent(other, request());
    await pool.query("DELETE FROM lab_trials WHERE id = $1", [trialId]);
    expect(await eventCount(other)).toBe(0);
    await expect(runs.get(other)).rejects.toThrow(/not found/);
  });

  // Last: empties this test schema.
  it("allows truncating the runs together with their events", async () => {
    await finished();
    await pool.query("TRUNCATE lab_investigation_runs CASCADE");
    expect((await pool.query("SELECT count(*)::int AS n FROM lab_investigation_events")).rows[0].n).toBe(0);
  });
});
