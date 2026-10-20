import assert from "node:assert/strict";
import { createLab } from "@agent-lab/lab";
import { createPool } from "@agent-lab/lab/database";
import { createTrial, deleteTrials } from "@agent-lab/lab/fixtures";

const baseUrl = process.env.LAB_BASE_URL ?? "http://127.0.0.1:3000";
const statePath = "/api/tools/get-deployment-state";
const rollbackPath = "/api/tools/rollback-deployment";

async function request(path: string, token?: string, body?: unknown) {
  return fetch(new URL(path, baseUrl), {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
}

async function main() {
  const pool = createPool();
  const lab = createLab(pool);
  const trialIds: string[] = [];

  try {
    const normal = await createTrial(pool);
    trialIds.push(normal.trialId);
    const stale = await createTrial(pool);
    trialIds.push(stale.trialId);

    assert.equal((await request(statePath)).status, 401);
    assert.equal((await request(statePath, "0".repeat(64))).status, 401);
    assert.equal((await request(rollbackPath, normal.token, { targetDeploymentId: "A", expectedRevision: "7" })).status, 400);
    // A caller cannot select a different trial through its payload.
    assert.equal((await request(rollbackPath, normal.token, { targetDeploymentId: "A", trialId: stale.trialId })).status, 400);

    const observed = await request(statePath, normal.token);
    assert.equal(observed.status, 200);
    assert.equal(observed.headers.get("cache-control"), "no-store");
    assert.equal((await observed.json()).revision, 7);
    const changed = await request(rollbackPath, normal.token, { targetDeploymentId: "A", expectedRevision: 7 });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).action.revisionAfter, 8);

    await lab.promote(stale.trialId, "C");
    const rejected = await request(rollbackPath, stale.token, { targetDeploymentId: "A", expectedRevision: 7 });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).error.code, "stale_revision");
    const state = await pool.query("SELECT current_deployment_id, revision FROM lab_trials WHERE id = $1", [stale.trialId]);
    assert.deepEqual(state.rows[0], { current_deployment_id: "C", revision: 8 });
    const actions = await pool.query("SELECT kind FROM lab_actions WHERE trial_id = $1 ORDER BY revision_after", [stale.trialId]);
    assert.deepEqual(actions.rows, [{ kind: "promote" }]);
    console.log("HTTP checks passed: token scope, validation, valid rollback, stale conflict, committed database evidence.");
  } finally {
    try { await deleteTrials(pool, trialIds); } finally { await pool.end(); }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
