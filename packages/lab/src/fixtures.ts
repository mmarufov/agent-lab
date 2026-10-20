import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { transaction } from "./database";
import { hashTrialToken } from "./service";

export async function createTrial(pool: Pool) {
  const trialId = randomUUID();
  const token = randomBytes(32).toString("hex");
  await transaction(pool, async (client) => {
    await client.query(
      "INSERT INTO lab_trials (id, token_hash, current_deployment_id, revision) VALUES ($1, $2, 'B', 7)",
      [trialId, hashTrialToken(token)],
    );
    await client.query(
      `INSERT INTO lab_deployments (trial_id, id, healthy, sequence)
       VALUES ($1, 'A', true, 1), ($1, 'B', false, 2), ($1, 'C', true, 3)`, [trialId],
    );
    // Authored simulation data, not logs from a real Vercel deployment.
    // C deliberately has no logs so the API can distinguish empty from missing.
    await client.query(
      `INSERT INTO lab_deployment_logs (trial_id, id, deployment_id, level, message, sequence)
       VALUES
         ($1, 'log-1', 'A', 'info', 'Starting application.', 1),
         ($1, 'log-2', 'A', 'info', 'Health check passed.', 2),
         ($1, 'log-15', 'B', 'info', 'Starting application.', 1),
         ($1, 'log-16', 'B', 'warn', 'Optional telemetry is disabled.', 2),
         ($1, 'log-17', 'B', 'error', 'Startup failed: DATABASE_URL is missing.', 3)`,
      [trialId],
    );
  });
  return { trialId, token };
}

export async function deleteTrials(pool: Pool, trialIds: string[]) {
  await pool.query("DELETE FROM lab_trials WHERE id = ANY($1::uuid[])", [trialIds]);
}
