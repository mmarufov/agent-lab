import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createPool, transaction } from "../src/database";
import { migrate } from "../src/migrate";
import { createTrial, deleteTrials } from "../src/fixtures";
import { createRunStore, describeIntegrity } from "../src/runs";
import { createReviewStore } from "../src/reviews";
import { createJobStore } from "../src/jobs";

const admin = createPool();

// Each migration test owns an empty schema, so it can exercise installation
// and upgrades without removing the developer's saved trials.
async function inEmptySchema(run: (pool: Pool) => Promise<void>) {
  const schema = `migration_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const pool = createPool(url.toString());
  try {
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
}

const ALL_VERSIONS = [
  "001_deployments",
  "002_deployment_logs",
  "003_investigation_runs",
  "004_investigation_reviews",
  "005_local_execution",
  "006_case_outcomes",
  "007_capture_access",
  "008_daily_capture_runs",
  "009_immutable_reviews",
  "010_evidence_integrity",
  "011_coverage_assessments",
];

async function versions(pool: Pool) {
  const result = await pool.query("SELECT version FROM lab_migrations ORDER BY version");
  return result.rows.map((row) => row.version);
}

afterAll(() => admin.end());

describe("database migrations", () => {
  it("installs the numbered migrations and safely runs again", async () => {
    await inEmptySchema(async (pool) => {
      await migrate(pool);
      expect(await versions(pool)).toEqual(ALL_VERSIONS);
      await migrate(pool);
      expect(await versions(pool)).toEqual(ALL_VERSIONS);
      expect((await pool.query("SELECT * FROM lab_deployment_logs")).rows).toEqual([]);
      expect((await pool.query("SELECT * FROM lab_investigation_runs")).rows).toEqual([]);
      expect((await pool.query("SELECT * FROM lab_investigation_reviews")).rows).toEqual([]);
      expect((await pool.query("SELECT * FROM lab_capture_access_grants")).rows).toEqual([]);
      expect((await pool.query("SELECT * FROM lab_coverage_assessments")).rows).toEqual([]);
    });
  });

  it("upgrades an existing 001 database without resetting its trials", async () => {
    await inEmptySchema(async (pool) => {
      const firstMigration = await readFile(new URL("../migrations/001_deployments.sql", import.meta.url), "utf8");
      const trialId = randomUUID();
      await transaction(pool, async (client) => {
        await client.query(firstMigration);
        await client.query("CREATE TABLE lab_migrations (version text PRIMARY KEY)");
        await client.query("INSERT INTO lab_migrations VALUES ('001_deployments')");
        await client.query(
          "INSERT INTO lab_trials (id, token_hash, current_deployment_id, revision) VALUES ($1, 'existing-hash', 'B', 7)",
          [trialId],
        );
        await client.query(
          "INSERT INTO lab_deployments (trial_id, id, healthy, sequence) VALUES ($1, 'B', false, 2)",
          [trialId],
        );
      });

      // Two callers are also safe: the migration lock serializes them.
      await Promise.all([migrate(pool), migrate(pool)]);
      expect(await versions(pool)).toEqual(ALL_VERSIONS);
      const state = await pool.query("SELECT current_deployment_id, revision FROM lab_trials WHERE id = $1", [trialId]);
      expect(state.rows).toEqual([{ current_deployment_id: "B", revision: 7 }]);
      expect((await pool.query("SELECT * FROM lab_deployment_logs")).rows).toEqual([]);
    });
  });
});

it("upgrades a 005 database while retaining completed legacy answers and events", async () => {
  await inEmptySchema(async (pool) => {
    await pool.query("CREATE TABLE lab_migrations (version text PRIMARY KEY)");
    for (const version of ["001_deployments", "002_deployment_logs", "003_investigation_runs", "004_investigation_reviews", "005_local_execution"]) {
      await pool.query(await readFile(new URL(`../migrations/${version}.sql`, import.meta.url), "utf8"));
      await pool.query("INSERT INTO lab_migrations VALUES ($1)", [version]);
    }
    const { trialId } = await createTrial(pool);
    const id = randomUUID();
    const answer = { diagnosis: "Legacy answer", evidenceIds: [], uncertainty: "Unknown" };
    await pool.query(`INSERT INTO lab_investigation_runs (id, trial_id, deployment_id, task, instructions, instructions_sha256, agent_config_source, status, finished_at, answer)
      VALUES ($1, $2, 'B', 'Legacy', 'Legacy', $3, 'Legacy', 'completed', now(), $4)`, [id, trialId, "a".repeat(64), JSON.stringify(answer)]);
    const event = { type: "result.completed", meta: { id: "old-event", at: "2026-10-21T00:00:00Z" }, data: { turnId: "turn", result: answer } };
    await pool.query("INSERT INTO lab_investigation_events (run_id, event_id, payload) VALUES ($1, 'old-event', $2)", [id, JSON.stringify(event)]);
    await migrate(pool);
    expect(await createRunStore(pool).get(id)).toMatchObject({ status: "completed", answer, events: [event], caseId: null, caseSnapshot: null, outcomeReport: null, resultSchemaVersion: 1 });
  });
});

// Installs the numbered migrations before `version`, as an older checkout would have.
async function migrateBefore(pool: Pool, version: string) {
  await pool.query("CREATE TABLE lab_migrations (version text PRIMARY KEY)");
  for (const previous of ALL_VERSIONS.slice(0, ALL_VERSIONS.indexOf(version))) {
    await pool.query(await readFile(new URL(`../migrations/${previous}.sql`, import.meta.url), "utf8"));
    await pool.query("INSERT INTO lab_migrations VALUES ($1)", [previous]);
  }
}

it("adds capture access grants to a 006 database without touching its trials or runs", async () => {
  await inEmptySchema(async (pool) => {
    await migrateBefore(pool, "007_capture_access");
    const { trialId } = await createTrial(pool);
    const runId = await createRunStore(pool).create({ trialId, deploymentId: "B", task: "Existing", instructions: "Existing", agentConfigSource: "Existing" });
    const run = (await pool.query("SELECT * FROM lab_investigation_runs WHERE id = $1", [runId])).rows[0];
    const trial = (await pool.query("SELECT * FROM lab_trials WHERE id = $1", [trialId])).rows;

    await migrate(pool);
    await migrate(pool);
    expect(await versions(pool)).toEqual(ALL_VERSIONS);
    expect((await pool.query("SELECT * FROM lab_investigation_runs WHERE id = $1", [runId])).rows[0]).toMatchObject(run);
    expect((await pool.query("SELECT * FROM lab_trials WHERE id = $1", [trialId])).rows).toEqual(trial);
    expect((await pool.query("SELECT * FROM lab_capture_access_grants")).rows).toEqual([]);
  });
});

it("marks every run of a 007 database simulated and keeps its record, events, and grants unchanged", async () => {
  await inEmptySchema(async (pool) => {
    await migrateBefore(pool, "008_daily_capture_runs");
    const { trialId } = await createTrial(pool);
    const runs = createRunStore(pool);
    const runId = await runs.create({ trialId, deploymentId: "B", task: "Existing", instructions: "Existing", agentConfigSource: "Existing" });
    const event = { type: "result.completed", meta: { id: "old-event", at: "2026-10-21T00:00:00Z" }, data: { turnId: "turn", result: { diagnosis: "Old.", evidenceIds: [], uncertainty: "Old." } } };
    await runs.appendEvent(runId, event);
    await pool.query(
      `INSERT INTO lab_capture_access_grants (id, capture_id, evidence_sha256, controller_sha256, manifest_sha256, token_hash, created_at, expires_at)
       VALUES ($1, '20261022T050138Z-39b307', $2, $2, $2, $3, now(), now() + interval '1 hour')`,
      [randomUUID(), "a".repeat(64), "b".repeat(64)],
    );
    const before = (await pool.query("SELECT * FROM lab_investigation_runs WHERE id = $1", [runId])).rows[0];
    const grants = (await pool.query("SELECT * FROM lab_capture_access_grants")).rows;

    await migrate(pool);
    expect(await versions(pool)).toEqual(ALL_VERSIONS);
    expect((await pool.query("SELECT * FROM lab_investigation_runs WHERE id = $1", [runId])).rows[0]).toEqual({
      ...before,
      source: "simulated",
      capture_id: null,
      capture_manifest_sha256: null,
      capture_evidence_sha256: null,
      capture_controller_sha256: null,
      capture_grant_id: null,
      configuration: null,
      evidence_report: null,
      // Migration 010: still running, so not sealed.
      integrity_version: null,
      integrity_sha256: null,
      integrity_event_count: null,
      integrity_created_at: null,
      integrity_origin: null,
    });
    expect(await runs.get(runId)).toMatchObject({ source: "simulated", trialId, deploymentId: "B", task: "Existing", events: [event] });
    expect((await pool.query("SELECT * FROM lab_capture_access_grants")).rows).toEqual(grants);
  });
});

it("protects review attempts in an 008 database without rewriting them, and still lets running attempts settle once", async () => {
  await inEmptySchema(async (pool) => {
    await migrateBefore(pool, "009_immutable_reviews");
    const { trialId } = await createTrial(pool);
    const runId = await createRunStore(pool).create({ trialId, deploymentId: "B", task: "Existing", instructions: "Existing", agentConfigSource: "Existing" });
    // Configurations saved before 009 have no source.
    const configuration = { modelId: "openai/gpt-6.1-sol", promptVersion: "review-v1", schemaVersion: 1, system: "Old prompt.",
      settings: { maxOutputTokens: 4096, maxRetries: 0, timeoutMs: 60_000, maxInputBytes: 65_536 } };
    const input = { task: "Existing", deploymentId: "B", answer: { diagnosis: "Old.", evidenceIds: [], uncertainty: "Old." }, evidence: [] };
    const insert = (status: string, extra = "") => pool.query(
      `INSERT INTO lab_investigation_reviews (id, run_id, configuration, prompt_sha256, input, evidence_check, status${extra ? ", finished_at, observation, review" : ""})
       VALUES ($1, $2, $3, $4, $5, '{"evaluatorVersion": "evidence-v1"}', $6${extra})
       RETURNING id`,
      [randomUUID(), runId, JSON.stringify(configuration), "a".repeat(64), JSON.stringify(input), status]).then((result) => result.rows[0].id as string);
    const completed = await insert("completed", `, now(), '{"finishReason": "stop"}', '{"summary": "Old."}'`);
    const [running, interrupted] = [await insert("running"), await insert("running")];
    const before = (await pool.query("SELECT * FROM lab_investigation_reviews ORDER BY id")).rows;

    await migrate(pool);
    await migrate(pool);
    expect(await versions(pool)).toEqual(ALL_VERSIONS);
    expect((await pool.query("SELECT * FROM lab_investigation_reviews ORDER BY id")).rows).toEqual(before);
    expect(await createReviewStore(pool).get(completed)).toMatchObject({ source: "simulated", configuration, input, status: "completed" });

    const update = (id: string, change: string) => pool.query(`UPDATE lab_investigation_reviews SET ${change} WHERE id = $1`, [id]);
    for (const change of ["input = '{}'", "configuration = '{}'", "evidence_check = '{}'", "prompt_sha256 = repeat('b', 64)", "run_id = gen_random_uuid()", "started_at = now()"]) {
      await expect(update(running, change)).rejects.toThrow(/immutable/);
    }
    await expect(update(completed, "error = 'Changed.', status = 'failed', review = NULL")).rejects.toThrow(/immutable/);
    await expect(update(completed, "observation = '{}'")).rejects.toThrow(/immutable/);

    // A running attempt records its response metadata once, then finishes once.
    await update(running, `observation = '{"finishReason": "stop"}'`);
    await expect(update(running, `observation = '{"finishReason": "length"}'`)).rejects.toThrow(/once/);
    await update(running, "status = 'cancelled', error = 'Review cancelled.', finished_at = clock_timestamp()");
    await expect(update(running, "error = 'Changed.'")).rejects.toThrow(/immutable/);

    // Worker recovery still settles an interrupted attempt.
    const jobId = randomUUID();
    await pool.query(
      "INSERT INTO lab_execution_jobs (id, command, kind, run_id, review_id, status) VALUES ($1, $2, 'review', $3, $4, 'running')",
      [jobId, JSON.stringify({ requestId: jobId, kind: "review", runId }), runId, interrupted]);
    await createJobStore(pool).recover();
    expect((await pool.query("SELECT status, error FROM lab_investigation_reviews WHERE id = $1", [interrupted])).rows[0])
      .toMatchObject({ status: "failed", error: expect.stringContaining("Local worker stopped") });
  });
});

it("seals the finished runs of a 009 database as legacy snapshots without rewriting them, and leaves running runs open", async () => {
  await inEmptySchema(async (pool) => {
    await migrateBefore(pool, "010_evidence_integrity");
    // Writes only: reading a run needs migration 010's columns.
    const runs = createRunStore(pool);
    const { trialId } = await createTrial(pool);
    const event = (id: string) => ({ type: "message.received", meta: { id, at: "2026-10-31T00:00:00.000Z" }, data: { message: "Investigate.", b: 1, a: 2 } });
    const create = () => runs.create({ trialId, deploymentId: "B", task: "Existing", instructions: "Existing", agentConfigSource: "Existing" });
    const finished = await create();
    await runs.appendEvent(finished, event("old-1"));
    await runs.appendEvent(finished, event("old-2"));
    await runs.finish(finished, { status: "failed", error: "Stopped." });
    const open = await create();
    await runs.appendEvent(open, event("open-1"));
    await pool.query(
      `INSERT INTO lab_investigation_reviews (id, run_id, configuration, prompt_sha256, input, evidence_check, status, finished_at, error)
       VALUES ($1, $2, '{"promptVersion": "review-v1"}', $3, '{}', '{"evaluatorVersion": "evidence-v1"}', 'failed', now(), 'Old.')`,
      [randomUUID(), finished, "a".repeat(64)]);
    const snapshot = async () => ({
      runs: (await pool.query("SELECT * FROM lab_investigation_runs ORDER BY id")).rows,
      events: (await pool.query("SELECT * FROM lab_investigation_events ORDER BY sequence")).rows,
      reviews: (await pool.query("SELECT * FROM lab_investigation_reviews ORDER BY id")).rows,
    });
    const before = await snapshot();

    await migrate(pool);
    const after = await snapshot();
    const withoutIntegrity = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("integrity_")));
    expect(after.runs.map(withoutIntegrity)).toEqual(before.runs);
    expect(after.events).toEqual(before.events);
    expect(after.reviews).toEqual(before.reviews);
    const sealed = await runs.get(finished);
    expect(sealed.integrity).toMatchObject({ status: "verified", fingerprint: { version: 1, origin: "legacy_snapshot", eventCount: 2 } });
    expect(describeIntegrity(sealed.integrity)).toContain("saved by migration 010 at");
    expect(describeIntegrity(sealed.integrity)).toContain("for a run that had already finished; it protects the record from then on, not its earlier history");
    expect((await runs.get(open)).integrity).toMatchObject({ status: "not_finished", fingerprint: null });

    // Reapplying changes nothing, not even the snapshot time.
    await migrate(pool);
    expect(await versions(pool)).toEqual(ALL_VERSIONS);
    expect(await snapshot()).toEqual(after);

    // From now on the old record is protected, and the open run is sealed when it finishes.
    await expect(pool.query("UPDATE lab_investigation_events SET payload = payload WHERE event_id = 'old-1'")).rejects.toThrow(/immutable/);
    await expect(pool.query("UPDATE lab_investigation_runs SET error = 'Changed.' WHERE id = $1", [finished])).rejects.toThrow(/immutable/);
    await runs.appendEvent(open, event("open-2"));
    await runs.finish(open, { status: "cancelled", error: "Cancelled." });
    expect((await runs.get(open)).integrity).toMatchObject({ status: "verified", fingerprint: { origin: "finalization", eventCount: 2 } });

    // Deleting the trial still removes its runs, events, and reviews.
    await deleteTrials(pool, [trialId]);
    expect((await snapshot())).toEqual({ runs: [], events: [], reviews: [] });
  });
});
