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

// Read the tables directly so assertions do not depend on the service's
// interpretation of its own result. These are harness controls, not model evals.
async function evidence(trialId: string) {
  const state = await pool.query("SELECT current_deployment_id, revision FROM lab_trials WHERE id = $1", [trialId]);
  const actions = await pool.query("SELECT kind, from_deployment_id, to_deployment_id, revision_after FROM lab_actions WHERE trial_id = $1 ORDER BY revision_after", [trialId]);
  return { state: state.rows[0], actions: actions.rows };
}

beforeAll(() => migrate(pool));
afterAll(async () => {
  try { await deleteTrials(pool, trialIds); } finally { await pool.end(); }
});

describe("simulated rollback service", () => {
  it("performs the needed rollback and commits matching action evidence", async () => {
    const { trialId } = await fixture();
    await lab.rollback(trialId, { targetDeploymentId: "A", expectedRevision: 7 });
    expect(await evidence(trialId)).toEqual({
      state: { current_deployment_id: "A", revision: 8 },
      actions: [{ kind: "rollback", from_deployment_id: "B", to_deployment_id: "A", revision_after: 8 }],
    });
  });

  it("preserves a newer promotion when a stale rollback is submitted", async () => {
    const { trialId } = await fixture();
    await lab.promote(trialId, "C");
    await expect(lab.rollback(trialId, { targetDeploymentId: "A", expectedRevision: 7 }))
      .rejects.toMatchObject({ code: "stale_revision" });
    expect(await evidence(trialId)).toEqual({
      state: { current_deployment_id: "C", revision: 8 },
      actions: [{ kind: "promote", from_deployment_id: "B", to_deployment_id: "C", revision_after: 8 }],
    });
  });

  it("shows the unsafe control when a client omits the revision check", async () => {
    const { trialId } = await fixture();
    await lab.promote(trialId, "C");
    await lab.rollback(trialId, { targetDeploymentId: "A" });
    const result = await evidence(trialId);
    expect(result.state).toEqual({ current_deployment_id: "A", revision: 9 });
    expect(result.actions[1]).toMatchObject({ kind: "rollback", from_deployment_id: "C", to_deployment_id: "A" });
  });

  it("allows only one of two competing writes from the same revision", async () => {
    const { trialId } = await fixture();
    const outcomes = await Promise.allSettled([
      lab.rollback(trialId, { targetDeploymentId: "A", expectedRevision: 7 }),
      lab.rollback(trialId, { targetDeploymentId: "A", expectedRevision: 7 }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ code: "stale_revision" });
    const result = await evidence(trialId);
    expect(result.state.revision).toBe(8);
    expect(result.actions).toHaveLength(1);
  });

  it("rejects unhealthy or unknown targets without changing state", async () => {
    const { trialId } = await fixture();
    for (const targetDeploymentId of ["B", "missing"]) {
      await expect(lab.rollback(trialId, { targetDeploymentId, expectedRevision: 7 }))
        .rejects.toMatchObject({ code: "invalid_target" });
    }
    expect(await evidence(trialId)).toEqual({ state: { current_deployment_id: "B", revision: 7 }, actions: [] });
  });

  it("rolls back the state change when writing its action record fails", async () => {
    const { trialId } = await fixture();
    // A fixture-local conflicting record forces the next INSERT to fail.
    await pool.query(
      `INSERT INTO lab_actions (trial_id, actor, kind, from_deployment_id, to_deployment_id, revision_before, revision_after)
       VALUES ($1, 'controller', 'promote', 'B', 'C', 7, 8)`, [trialId],
    );
    await expect(lab.rollback(trialId, { targetDeploymentId: "A", expectedRevision: 7 }))
      .rejects.toMatchObject({ code: "23505" });
    expect((await evidence(trialId)).state).toEqual({ current_deployment_id: "B", revision: 7 });
  });

  it("binds tokens to their own trial and stores only token hashes", async () => {
    const first = await fixture();
    const second = await fixture();
    expect(await lab.resolveTrialToken(first.token)).toBe(first.trialId);
    expect(await lab.resolveTrialToken(second.token)).toBe(second.trialId);
    expect(await lab.resolveTrialToken("0".repeat(64))).toBeNull();
    const stored = await pool.query("SELECT token_hash FROM lab_trials WHERE id = $1", [first.trialId]);
    expect(stored.rows[0].token_hash).not.toBe(first.token);
    await lab.rollback(first.trialId, { targetDeploymentId: "A", expectedRevision: 7 });
    expect((await evidence(second.trialId)).state).toEqual({ current_deployment_id: "B", revision: 7 });
  });
});
