import { z } from "zod";

export const runListInputSchema = z.object({
  deploymentId: z.enum(["A", "B", "C"]).optional(),
  status: z.enum(["running", "completed", "failed", "cancelled"]).optional(),
  cursor: z.uuid().optional(),
});
export const recordIdSchema = z.uuid();
// Public selectors contain no fixtures or expected answers.
export const caseIdSchema = z.enum(["missing-config", "healthy-startup", "recovered-startup", "no-logs"]);
export type CaseId = z.infer<typeof caseIdSchema>;
export const caseNames: Record<CaseId, string> = {
  "missing-config": "Missing configuration",
  "healthy-startup": "Healthy startup",
  "recovered-startup": "Recovered startup",
  "no-logs": "No logs",
};
export const executionRequestSchema = z.union([
  z.strictObject({ requestId: z.uuid(), kind: z.literal("investigate"), caseId: caseIdSchema }),
  z.strictObject({ requestId: z.uuid(), kind: z.literal("investigate"), deploymentId: z.enum(["A", "B", "C"]) }),
  z.strictObject({ requestId: z.uuid(), kind: z.literal("review"), runId: z.uuid() }),
]);
export type ExecutionRequest = z.infer<typeof executionRequestSchema>;

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

// Shape validation is not an evaluation of whether these claims are true.
export const investigationAnswerV1Schema = z.strictObject({
  diagnosis: z.string().min(1).describe("What the retrieved evidence supports, or that the cause is undetermined."),
  evidenceIds: z.array(z.string().min(1)).describe("Supporting log IDs actually returned by tools. Use an empty list when no evidence was retrieved."),
  uncertainty: z.string().min(1).describe("What the available evidence does not establish."),
});

export const investigationOutcomeSchema = z.strictObject({
  state: z.enum(["failed", "healthy", "recovered", "unknown"]).describe("State established by the supplied logs. Recovery requires earlier failure and later successful startup. Empty logs establish unknown, not health."),
  cause: z.enum(["missing_configuration", "other", "none", "unknown"]).describe("Cause established by the logs; for recovery, the cause of the earlier failure. None means no observed failure; unknown means insufficient evidence."),
  configurationKey: z.string().min(1).nullable().describe("Missing configuration variable explicitly identified by the evidence, otherwise null."),
});
export const investigationAnswerV2Schema = investigationAnswerV1Schema.extend({ outcome: investigationOutcomeSchema });
export const investigationAnswerSchema = z.union([investigationAnswerV2Schema, investigationAnswerV1Schema]);
export type InvestigationOutcome = z.infer<typeof investigationOutcomeSchema>;

// Preserve the complete Eve event, including fields added by its runtime.
export const investigationEventSchema = z.looseObject({
  type: z.string().min(1),
  meta: z.looseObject({ id: z.string().min(1), at: z.iso.datetime({ offset: true }) }),
  data: z.unknown().optional(),
});

export type InvestigationAnswer = z.infer<typeof investigationAnswerSchema>;
export type InvestigationEvent = z.infer<typeof investigationEventSchema>;

export const reviewInputSchema = z.strictObject({
  task: z.string().min(1),
  deploymentId: z.string().min(1),
  answer: investigationAnswerSchema,
  evidence: z.array(deploymentLogSchema),
});

export const investigationReviewSchema = z.strictObject({
  claims: z.array(z.strictObject({
    field: z.enum(["diagnosis", "uncertainty"]),
    quote: z.string().trim().min(1).describe("An exact quotation from the specified answer field."),
    verdict: z.enum(["supported", "unsupported", "uncertain"]),
    evidenceIds: z.array(z.string().min(1)).describe("Only IDs from the supplied evidence. May be empty when judging absence of evidence."),
    explanation: z.string().trim().min(1),
  })).min(2).max(20),
  missingEvidence: z.array(z.string().trim().min(1)).max(20),
  summary: z.string().trim().min(1),
});

// These checks establish reference integrity, not the truth of a model's judgment.
export function reviewSchemaFor(input: ReviewInput) {
  const ids = new Set(input.evidence.map((log) => log.id));
  return investigationReviewSchema.superRefine((review, context) => {
    for (const field of ["diagnosis", "uncertainty"] as const) {
      if (!review.claims.some((claim) => claim.field === field)) {
        context.addIssue({ code: "custom", path: ["claims"], message: `Review must assess ${field}.` });
      }
    }
    review.claims.forEach((claim, index) => {
      if (!input.answer[claim.field].includes(claim.quote)) {
        context.addIssue({ code: "custom", path: ["claims", index, "quote"], message: "Quotation is absent from the answer field." });
      }
      if (claim.evidenceIds.some((id) => !ids.has(id))) {
        context.addIssue({ code: "custom", path: ["claims", index, "evidenceIds"], message: "Reviewer cited evidence it was not supplied." });
      }
    });
  });
}

export const reviewObservationSchema = z.strictObject({
  responseId: z.string().nullable(),
  resolvedModelId: z.string().nullable(),
  finishReason: z.string(),
  usage: z.strictObject({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
    costUsd: z.number().nonnegative().nullable(),
  }),
});

export const reviewConfigSchema = z.strictObject({
  modelId: z.string().min(1),
  promptVersion: z.string().min(1),
  schemaVersion: z.literal(1),
  system: z.string().min(1),
  settings: z.strictObject({
    maxOutputTokens: z.number().int().positive(), maxRetries: z.literal(0),
    timeoutMs: z.number().int().positive(), maxInputBytes: z.number().int().positive(),
  }),
});
export type ReviewInput = z.infer<typeof reviewInputSchema>;
export type InvestigationReview = z.infer<typeof investigationReviewSchema>;
export type ReviewObservation = z.infer<typeof reviewObservationSchema>;
export type ReviewConfig = z.infer<typeof reviewConfigSchema>;

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
