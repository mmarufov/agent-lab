import { caseIdSchema, caseNames, type CaseId, type DeploymentLog, type InvestigationOutcome } from "@agent-lab/contracts";

export interface InvestigationCase {
  id: CaseId;
  name: string;
  version: number;
  deploymentId: "B";
  logs: DeploymentLog[];
  expected: InvestigationOutcome;
  decisiveEvidenceIds: string[];
}
export interface CaseSnapshot extends InvestigationCase { trialId: string }
const log = (id: string, level: DeploymentLog["level"], message: string): DeploymentLog => ({ id, deploymentId: "B", level, message });
const starting = log("log-15", "info", "Starting application.");
const optional = log("log-16", "warn", "Optional telemetry is disabled.");
const failure = log("log-17", "error", "Startup failed: DATABASE_URL is missing.");
const success = log("log-20", "info", "Application started. Health check passed.");
const cases: Record<CaseId, InvestigationCase> = {
  "missing-config": {
    id: "missing-config", name: caseNames["missing-config"], version: 1, deploymentId: "B",
    logs: [starting, optional, failure],
    expected: { state: "failed", cause: "missing_configuration", configurationKey: "DATABASE_URL" }, decisiveEvidenceIds: ["log-17"],
  },
  "healthy-startup": {
    id: "healthy-startup", name: caseNames["healthy-startup"], version: 1, deploymentId: "B",
    logs: [starting, optional, success],
    expected: { state: "healthy", cause: "none", configurationKey: null }, decisiveEvidenceIds: ["log-20"],
  },
  "recovered-startup": {
    id: "recovered-startup", name: caseNames["recovered-startup"], version: 1, deploymentId: "B",
    logs: [starting, optional, failure, log("log-18", "info", "Configuration restored: DATABASE_URL is now set."), log("log-19", "info", "Restarting application."), success],
    expected: { state: "recovered", cause: "missing_configuration", configurationKey: "DATABASE_URL" }, decisiveEvidenceIds: ["log-17", "log-20"],
  },
  "no-logs": {
    id: "no-logs", name: caseNames["no-logs"], version: 1, deploymentId: "B", logs: [],
    expected: { state: "unknown", cause: "unknown", configurationKey: null }, decisiveEvidenceIds: [],
  },
};

// Trusted controller only. Never send this registry or snapshot to a model.
export function getCase(id: string): InvestigationCase {
  return structuredClone(cases[caseIdSchema.parse(id)]);
}
export function bindCase(definition: InvestigationCase, trialId: string): CaseSnapshot {
  const copy = structuredClone(definition);
  return { ...copy, trialId,
    logs: copy.logs.map((log) => ({ ...log, id: `${trialId}:${log.id}` })),
    decisiveEvidenceIds: copy.decisiveEvidenceIds.map((id) => `${trialId}:${id}`),
  };
}
