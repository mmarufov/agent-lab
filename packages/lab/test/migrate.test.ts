import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createPool, transaction } from "../src/database";
import { migrate } from "../src/migrate";
import { createTrial } from "../src/fixtures";
import { createRunStore } from "../src/runs";

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

async function versions(pool: Pool) {
  const result = await pool.query("SELECT version FROM lab_migrations ORDER BY version");
  return result.rows.map((row) => row.version);
}

afterAll(() => admin.end());

describe("database migrations", () => {
  it("installs the numbered migrations and safely runs again", async () => {
    await inEmptySchema(async (pool) => {
      await migrate(pool);
      expect(await versions(pool)).toEqual(["001_deployments", "002_deployment_logs", "003_investigation_runs", "004_investigation_reviews", "005_local_execution", "006_case_outcomes"]);
      await migrate(pool);
      expect(await versions(pool)).toEqual(["001_deployments", "002_deployment_logs", "003_investigation_runs", "004_investigation_reviews", "005_local_execution", "006_case_outcomes"]);
      expect((await pool.query("SELECT * FROM lab_deployment_logs")).rows).toEqual([]);
      expect((await pool.query("SELECT * FROM lab_investigation_runs")).rows).toEqual([]);
      expect((await pool.query("SELECT * FROM lab_investigation_reviews")).rows).toEqual([]);
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
      expect(await versions(pool)).toEqual(["001_deployments", "002_deployment_logs", "003_investigation_runs", "004_investigation_reviews", "005_local_execution", "006_case_outcomes"]);
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
