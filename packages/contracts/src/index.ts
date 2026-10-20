import { z } from "zod";

export const getLogsInputSchema = z.strictObject({
  deploymentId: z.string().min(1).max(100),
});

export const deploymentLogSchema = z.object({
  id: z.string().min(1),
  deploymentId: z.string().min(1).max(100),
  level: z.enum(["info", "warn", "error"]),
  message: z.string().min(1),
});

export const getLogsOutputSchema = z.object({
  logs: z.array(deploymentLogSchema),
});

export const deploymentStateSchema = z.object({
  trialId: z.uuid(),
  currentDeploymentId: z.string(),
  revision: z.number().int().nonnegative(),
  deployments: z.array(z.object({
    id: z.string(),
    healthy: z.boolean(),
    sequence: z.number().int().positive(),
  })),
});

export const rollbackInputSchema = z.strictObject({
  targetDeploymentId: z.string().min(1).max(100),
  // Optional only to let the simulation compare guarded and unguarded clients.
  // All compared clients have access to this same public contract.
  expectedRevision: z.number().int().nonnegative().max(2_147_483_647).optional(),
});

export const actionSchema = z.object({
  trialId: z.uuid(),
  actor: z.enum(["agent", "controller"]),
  kind: z.enum(["rollback", "promote"]),
  fromDeploymentId: z.string(),
  toDeploymentId: z.string(),
  revisionBefore: z.number().int().nonnegative(),
  revisionAfter: z.number().int().positive(),
});

export type DeploymentState = z.infer<typeof deploymentStateSchema>;
export type RollbackInput = z.infer<typeof rollbackInputSchema>;
export type CommittedAction = z.infer<typeof actionSchema>;
export type GetLogsInput = z.infer<typeof getLogsInputSchema>;
export type DeploymentLog = z.infer<typeof deploymentLogSchema>;
