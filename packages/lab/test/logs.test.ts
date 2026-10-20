import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../src/database";
import { createTrial, deleteTrials } from "../src/fixtures";
import { migrate } from "../src/migrate";
import { createLab } from "../src/service";

const pool = createPool();
const lab = createLab(pool);
const trialIds: string[] = [];

async function fixture() {
  const trial = await createTrial(pool);
  trialIds.push(trial.trialId);
  return trial;
}

beforeAll(() => migrate(pool));
afterAll(async () => {
  try { await deleteTrials(pool, trialIds); } finally { await pool.end(); }
});

describe("saved deployment logs", () => {
  it("persists and retrieves all of B's log levels in their recorded order", async () => {
    const { trialId } = await fixture();
    const expected = [
      { id: "log-15", deploymentId: "B", level: "info", message: "Starting application." },
      { id: "log-16", deploymentId: "B", level: "warn", message: "Optional telemetry is disabled." },
      { id: "log-17", deploymentId: "B", level: "error", message: "Startup failed: DATABASE_URL is missing." },
    ];
    const stored = await pool.query(
      `SELECT id, deployment_id AS "deploymentId", level, message
       FROM lab_deployment_logs WHERE trial_id = $1 AND deployment_id = 'B' ORDER BY sequence`,
      [trialId],
    );
    expect(stored.rows).toEqual(expected);
    expect(await lab.getLogs(trialId, "B")).toEqual(expected);
  });

  it("returns A's different logs and an empty list for known deployment C", async () => {
    const { trialId } = await fixture();
    expect(await lab.getLogs(trialId, "A")).toEqual([
      { id: "log-1", deploymentId: "A", level: "info", message: "Starting application." },
      { id: "log-2", deploymentId: "A", level: "info", message: "Health check passed." },
    ]);
    expect(await lab.getLogs(trialId, "C")).toEqual([]);
  });

  it("keeps logs with the same deployment and log IDs separate across trials", async () => {
    const first = await fixture();
    const second = await fixture();
    await pool.query(
      "UPDATE lab_deployment_logs SET message = 'Only visible in the second trial.' WHERE trial_id = $1 AND id = 'log-17'",
      [second.trialId],
    );
    expect(await lab.getLogs(first.trialId, "B")).toHaveLength(3);
    expect((await lab.getLogs(first.trialId, "B"))[2].message).toBe("Startup failed: DATABASE_URL is missing.");
    expect((await lab.getLogs(second.trialId, "B"))[2].message).toBe("Only visible in the second trial.");
  });

  it("treats unknown deployments and deployments owned by another trial as not found", async () => {
    const first = await fixture();
    const second = await fixture();
    await pool.query(
      "INSERT INTO lab_deployments (trial_id, id, healthy, sequence) VALUES ($1, 'private-only', true, 4)",
      [second.trialId],
    );
    await expect(lab.getLogs(first.trialId, "missing")).rejects.toMatchObject({ code: "not_found" });
    await expect(lab.getLogs(first.trialId, "private-only")).rejects.toMatchObject({ code: "not_found" });
  });

  it("enforces deployment ownership in the database too", async () => {
    const first = await fixture();
    const second = await fixture();
    await pool.query(
      "INSERT INTO lab_deployments (trial_id, id, healthy, sequence) VALUES ($1, 'private-only', true, 4)",
      [second.trialId],
    );
    await expect(pool.query(
      `INSERT INTO lab_deployment_logs (trial_id, id, deployment_id, level, message, sequence)
       VALUES ($1, 'foreign-log', 'private-only', 'info', 'Invalid ownership.', 1)`,
      [first.trialId],
    )).rejects.toMatchObject({ code: "23503" });
  });

  it("removes only the deleted trial's logs", async () => {
    const first = await fixture();
    const second = await fixture();
    await deleteTrials(pool, [first.trialId]);
    expect((await pool.query("SELECT id FROM lab_deployment_logs WHERE trial_id = $1", [first.trialId])).rows).toEqual([]);
    expect(await lab.getLogs(second.trialId, "B")).toHaveLength(3);
  });
});
