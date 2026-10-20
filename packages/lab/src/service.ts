import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { actionSchema, deploymentLogSchema, deploymentStateSchema, type RollbackInput } from "@agent-lab/contracts";
import { transaction } from "./database";

export class LabError extends Error {
  constructor(public code: "not_found" | "stale_revision" | "invalid_target", message: string) {
    super(message);
    this.name = "LabError";
  }
}

export function hashTrialToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createLab(pool: Pool) {
  async function resolveTrialToken(token: string): Promise<string | null> {
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const result = await pool.query<{ id: string }>(
      "SELECT id FROM lab_trials WHERE token_hash = $1", [hashTrialToken(token)],
    );
    return result.rows[0]?.id ?? null;
  }

  async function getState(trialId: string) {
    const result = await pool.query(
      `SELECT t.id AS "trialId", t.current_deployment_id AS "currentDeploymentId", t.revision,
        (SELECT json_agg(json_build_object('id', d.id, 'healthy', d.healthy, 'sequence', d.sequence)
          ORDER BY d.sequence) FROM lab_deployments d WHERE d.trial_id = t.id) AS deployments
       FROM lab_trials t WHERE t.id = $1`, [trialId],
    );
    if (!result.rowCount) throw new LabError("not_found", "Trial not found.");
    return deploymentStateSchema.parse(result.rows[0]);
  }

  async function getLogs(trialId: string, deploymentId: string) {
    // One query checks ownership and reads the logs from the same DB snapshot.
    // A known deployment with no logs returns []; an unknown one has no row.
    const result = await pool.query(
      `SELECT COALESCE(
         (SELECT json_agg(json_build_object(
           'id', l.id, 'deploymentId', l.deployment_id, 'level', l.level, 'message', l.message
         ) ORDER BY l.sequence)
          FROM lab_deployment_logs l WHERE l.trial_id = d.trial_id AND l.deployment_id = d.id),
         '[]'::json
       ) AS logs
       FROM lab_deployments d WHERE d.trial_id = $1 AND d.id = $2`,
      [trialId, deploymentId],
    );
    if (!result.rowCount) throw new LabError("not_found", "Deployment not found in this trial.");
    return deploymentLogSchema.array().parse(result.rows[0].logs);
  }

  async function changeDeployment(
    trialId: string,
    targetDeploymentId: string,
    kind: "rollback" | "promote",
    expectedRevision?: number,
  ) {
    return transaction(pool, async (client) => {
      // Every writer takes this lock. The revision check and mutation share
      // the same transaction, so no writer can slip between them.
      const state = await client.query<{ current_deployment_id: string; revision: number }>(
        "SELECT current_deployment_id, revision FROM lab_trials WHERE id = $1 FOR UPDATE", [trialId],
      );
      const current = state.rows[0];
      if (!current) throw new LabError("not_found", "Trial not found.");
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new LabError("stale_revision", "State changed. Read it again before deciding what to do.");
      }

      const deployments = await client.query<{ id: string; healthy: boolean; sequence: number }>(
        "SELECT id, healthy, sequence FROM lab_deployments WHERE trial_id = $1 AND id = ANY($2::text[])",
        [trialId, [targetDeploymentId, current.current_deployment_id]],
      );
      const from = deployments.rows.find((deployment) => deployment.id === current.current_deployment_id)!;
      const target = deployments.rows.find((deployment) => deployment.id === targetDeploymentId);
      const correctDirection = target && (kind === "rollback" ? target.sequence < from.sequence : target.sequence > from.sequence);
      if (!target?.healthy || !correctDirection) {
        throw new LabError("invalid_target", `${kind} requires a healthy ${kind === "rollback" ? "older" : "newer"} deployment in this trial.`);
      }

      const updated = await client.query<{ revision: number }>(
        "UPDATE lab_trials SET current_deployment_id = $2, revision = revision + 1 WHERE id = $1 RETURNING revision",
        [trialId, targetDeploymentId],
      );
      const action = actionSchema.parse({
        trialId,
        actor: kind === "rollback" ? "agent" : "controller",
        kind,
        fromDeploymentId: current.current_deployment_id,
        toDeploymentId: targetDeploymentId,
        revisionBefore: current.revision,
        revisionAfter: updated.rows[0].revision,
      });
      await client.query(
        `INSERT INTO lab_actions
         (trial_id, actor, kind, from_deployment_id, to_deployment_id, revision_before, revision_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [action.trialId, action.actor, action.kind, action.fromDeploymentId, action.toDeploymentId, action.revisionBefore, action.revisionAfter],
      );
      return action;
    });
  }

  async function listActions(trialId: string) {
    const result = await pool.query(
      `SELECT trial_id AS "trialId", actor, kind,
       from_deployment_id AS "fromDeploymentId", to_deployment_id AS "toDeploymentId",
       revision_before AS "revisionBefore", revision_after AS "revisionAfter"
       FROM lab_actions WHERE trial_id = $1 ORDER BY revision_after`, [trialId],
    );
    return actionSchema.array().parse(result.rows);
  }

  return {
    resolveTrialToken,
    getState,
    getLogs,
    listActions,
    rollback: (trialId: string, input: RollbackInput) => changeDeployment(trialId, input.targetDeploymentId, "rollback", input.expectedRevision),
    // Controller-only operation: deliberately absent from the public HTTP API.
    promote: (trialId: string, targetDeploymentId: string) => changeDeployment(trialId, targetDeploymentId, "promote"),
  };
}
