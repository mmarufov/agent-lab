import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { investigationAnswerSchema, investigationAnswerV2Schema, investigationEventSchema, type InvestigationAnswer, type InvestigationEvent } from "@agent-lab/contracts";
import {
  DAILY_ANSWER_SCHEMA_VERSION,
  dailyInvestigationAnswerSchema,
  type DailyInvestigationAnswer,
} from "@agent-lab/contracts/daily-investigation";
import { transaction } from "./database";
import type { CaseSnapshot } from "./cases";
import { evaluateDailyRun, type DailyEvidenceReport } from "./daily-evaluate";
import { CONTROLLER, EVIDENCE, MANIFEST, type CaptureFileHashes } from "./daily-evidence";
import { evaluateOutcome, type OutcomeReport } from "./outcome";

type RunStatus = "running" | "completed" | "failed" | "cancelled";
export type RunSource = "simulated" | "daily_capture";

/** A run of another source where only simulated deployment runs are supported. */
export class UnsupportedRunSourceError extends Error {
  constructor(readonly runId: string) {
    super(
      `Investigation ${runId} read a recorded Daily capture. This view supports simulated deployment investigations only; read it with pnpm lab run ${runId}.`,
    );
    this.name = "UnsupportedRunSourceError";
  }
}

/**
 * Whether the saved record still matches the fingerprint saved when the run
 * finished (migration 010). PostgreSQL recomputes it from the same versioned
 * document in the query that reads the run, so both describe one snapshot.
 */
export interface RunIntegrity {
  /** not_finished: a running run has no fingerprint yet. missing: a finished run without one. */
  status: "verified" | "mismatch" | "missing" | "not_finished";
  fingerprint: {
    version: number;
    sha256: string;
    eventCount: number;
    createdAt: string;
    /** finalization: saved with the final status. legacy_snapshot: saved by migration 010 for a run that had already finished. */
    origin: "finalization" | "legacy_snapshot";
  } | null;
  /** Recomputed now with the fingerprint's version; null without a fingerprint. */
  currentSha256: string | null;
  currentEventCount: number;
}

// Columns every source shares: what ran, how it went, and its event record.
interface CommonRun {
  id: string;
  task: string;
  instructions: string;
  instructionsHash: string;
  agentConfigSource: string;
  resultSchemaVersion: number;
  sessionId: string | null;
  modelId: string | null;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  message: string | null;
  usage: Record<string, unknown> | null;
  error: string | null;
  events: InvestigationEvent[];
  integrity: RunIntegrity;
}

export interface SimulatedRun extends CommonRun {
  source: "simulated";
  trialId: string;
  deploymentId: string;
  caseId: string | null;
  caseVersion: number | null;
  caseSnapshot: CaseSnapshot | null;
  outcomeReport: OutcomeReport | null;
  answer: InvestigationAnswer | null;
}

export interface DailyRun extends CommonRun {
  source: "daily_capture";
  captureId: string;
  /** The finalized files the run's access grant pinned, keyed by file name. */
  captureSha256: CaptureFileHashes;
  grantId: string;
  /** The grant's current state, read from lab_capture_access_grants. */
  grantExpiresAt: string;
  grantRevokedAt: string | null;
  /** Effective settings: tool mode, agent settings, deadlines, and usage limits. */
  configuration: Record<string, unknown>;
  /** The daily-evidence-v1 report frozen when the run finished; null while it runs. */
  evidenceReport: DailyEvidenceReport | null;
  answer: DailyInvestigationAnswer | null;
}

interface RunRow extends Omit<CommonRun, "startedAt" | "finishedAt" | "integrity"> {
  source: RunSource;
  integrityVersion: number | null;
  integritySha256: string | null;
  integrityEventCount: number | null;
  integrityCreatedAt: Date | null;
  integrityOrigin: "finalization" | "legacy_snapshot" | null;
  currentIntegritySha256: string | null;
  trialId: string | null;
  deploymentId: string | null;
  caseId: string | null;
  caseVersion: number | null;
  caseSnapshot: CaseSnapshot | null;
  outcomeReport: OutcomeReport | null;
  captureId: string | null;
  manifestSha256: string | null;
  evidenceSha256: string | null;
  controllerSha256: string | null;
  grantId: string | null;
  grantExpiresAt: Date | null;
  grantRevokedAt: Date | null;
  configuration: Record<string, unknown> | null;
  evidenceReport: DailyEvidenceReport | null;
  answer: InvestigationAnswer | DailyInvestigationAnswer | null;
  startedAt: Date;
  finishedAt: Date | null;
}

function integrityOf(row: RunRow): RunIntegrity {
  const fingerprint = row.integritySha256 === null ? null : {
    version: row.integrityVersion!, sha256: row.integritySha256, eventCount: row.integrityEventCount!,
    createdAt: row.integrityCreatedAt!.toISOString(), origin: row.integrityOrigin!,
  };
  const matches = fingerprint !== null && row.currentIntegritySha256 === fingerprint.sha256 && row.events.length === fingerprint.eventCount;
  return {
    status: row.status === "running" ? "not_finished" : !fingerprint ? "missing" : matches ? "verified" : "mismatch",
    fingerprint,
    currentSha256: row.currentIntegritySha256,
    currentEventCount: row.events.length,
  };
}

function toRun(row: RunRow): SimulatedRun | DailyRun {
  const common: CommonRun = {
    id: row.id, task: row.task, instructions: row.instructions, instructionsHash: row.instructionsHash,
    agentConfigSource: row.agentConfigSource, resultSchemaVersion: row.resultSchemaVersion, sessionId: row.sessionId,
    modelId: row.modelId, status: row.status, startedAt: row.startedAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs: row.durationMs, message: row.message, usage: row.usage, error: row.error, events: row.events, integrity: integrityOf(row),
  };
  if (row.source === "daily_capture") {
    return {
      ...common, source: row.source, captureId: row.captureId!, grantId: row.grantId!,
      grantExpiresAt: row.grantExpiresAt!.toISOString(), grantRevokedAt: row.grantRevokedAt?.toISOString() ?? null, configuration: row.configuration!,
      captureSha256: { [MANIFEST]: row.manifestSha256!, [EVIDENCE]: row.evidenceSha256!, [CONTROLLER]: row.controllerSha256! },
      evidenceReport: row.evidenceReport, answer: row.answer,
    };
  }
  return {
    ...common, source: row.source, trialId: row.trialId!, deploymentId: row.deploymentId!, caseId: row.caseId,
    caseVersion: row.caseVersion, caseSnapshot: row.caseSnapshot, outcomeReport: row.outcomeReport, answer: row.answer,
  };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * The verified fingerprint of a finished run, or an error naming what is wrong.
 * New reviews and coverage assessments are built only from verified records.
 */
export function requireVerifiedIntegrity(run: { id: string; integrity: RunIntegrity }, consequence: string) {
  const { status, fingerprint } = run.integrity;
  if (status === "verified") return fingerprint!;
  const problem = status === "not_finished" ? "has not finished, so it has no integrity fingerprint yet"
    : status === "missing" ? "finished without an integrity fingerprint"
    : "no longer matches its integrity fingerprint: its saved events or final fields changed after it was sealed";
  throw new Error(`Investigation ${run.id} ${problem}. ${consequence}; inspect it with pnpm lab run ${run.id}.`);
}

/** One terminal line for a run's integrity, shared by pnpm lab run, lab evaluate, and the investigation commands. */
export function describeIntegrity({ status, fingerprint, currentSha256, currentEventCount }: RunIntegrity) {
  if (status === "not_finished") return "Integrity: not sealed yet; a fingerprint is saved when the run finishes.";
  if (!fingerprint) return "Integrity: MISSING; the run finished without a fingerprint. New reviews and coverage assessments are refused.";
  const saved = fingerprint.origin === "finalization"
    ? `saved when the run finished, ${fingerprint.createdAt}`
    : `saved by migration 010 at ${fingerprint.createdAt} for a run that had already finished; it protects the record from then on, not its earlier history`;
  const sealed = `fingerprint v${fingerprint.version} of ${fingerprint.eventCount} event(s), ${saved}`;
  if (status === "verified") return `Integrity: verified (${sealed}; SHA-256 ${fingerprint.sha256})`;
  return `Integrity: MISMATCH (${sealed}; SHA-256 ${fingerprint.sha256}). The saved record now has ${currentEventCount} event(s) and SHA-256 ${currentSha256 ?? "unavailable"}. New reviews and coverage assessments are refused.`;
}

// Trusted runner access only. This store is not an agent tool or public route.
export function createRunStore(pool: Pool) {
  async function read(id: string) {
    // One query gives a consistent view of the summary and its events while
    // another process is still writing. Only the fixed 'latest' branch is SQL.
    const result = await pool.query<RunRow>(
      `SELECT r.id, r.source, r.trial_id AS "trialId", r.deployment_id AS "deploymentId", r.task,
         r.instructions, r.instructions_sha256 AS "instructionsHash", r.agent_config_source AS "agentConfigSource",
         r.result_schema_version AS "resultSchemaVersion", r.case_id AS "caseId", r.case_version AS "caseVersion",
         r.case_snapshot AS "caseSnapshot", r.outcome_report AS "outcomeReport",
         r.capture_id AS "captureId", r.capture_manifest_sha256 AS "manifestSha256", r.capture_evidence_sha256 AS "evidenceSha256",
         r.capture_controller_sha256 AS "controllerSha256", r.capture_grant_id AS "grantId",
         g.expires_at AS "grantExpiresAt", g.revoked_at AS "grantRevokedAt", r.configuration,
         r.evidence_report AS "evidenceReport", r.session_id AS "sessionId", r.model_id AS "modelId",
         r.status, r.started_at AS "startedAt", r.finished_at AS "finishedAt",
         (EXTRACT(EPOCH FROM (r.finished_at - r.started_at)) * 1000)::float8 AS "durationMs",
         r.answer, r.assistant_message AS message, r.usage, r.error,
         COALESCE((SELECT jsonb_agg(payload ORDER BY sequence) FROM lab_investigation_events WHERE run_id = r.id), '[]'::jsonb) AS events,
         r.integrity_version AS "integrityVersion", r.integrity_sha256 AS "integritySha256",
         r.integrity_event_count AS "integrityEventCount", r.integrity_created_at AS "integrityCreatedAt",
         r.integrity_origin AS "integrityOrigin",
         lab_integrity_sha256(lab_run_integrity_document(r, r.integrity_version)) AS "currentIntegritySha256"
       FROM lab_investigation_runs r LEFT JOIN lab_capture_access_grants g ON g.id = r.capture_grant_id
       ${id === "latest" ? "ORDER BY r.started_at DESC, r.id DESC LIMIT 1" : "WHERE r.id = $1"}`,
      id === "latest" ? [] : [id],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Investigation run not found.");
    return toRun(row);
  }

  return {
    async create(input: {
      trialId: string;
      deploymentId: string;
      task: string;
      instructions: string;
      agentConfigSource: string;
      caseSnapshot?: CaseSnapshot | null;
    }, jobId?: string) {
      const snapshot = input.caseSnapshot;
      if (snapshot && (snapshot.trialId !== input.trialId || snapshot.deploymentId !== input.deploymentId)) throw new Error("Case snapshot belongs to a different trial or deployment.");
      const id = randomUUID();
      await transaction(pool, async (client) => {
        await client.query(
          `INSERT INTO lab_investigation_runs
             (id, trial_id, deployment_id, task, instructions, instructions_sha256, agent_config_source, result_schema_version, case_id, case_version, case_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
          [id, input.trialId, input.deploymentId, input.task, input.instructions, sha256(input.instructions), input.agentConfigSource, snapshot ? 2 : 1, snapshot?.id ?? null, snapshot?.version ?? null, snapshot ? JSON.stringify(snapshot) : null],
        );
        if (jobId) {
          const linked = await client.query("UPDATE lab_execution_jobs SET run_id = $2 WHERE id = $1 AND kind = 'investigate' AND status = 'running' AND run_id IS NULL", [jobId, id]);
          if (linked.rowCount !== 1) throw new Error("Cannot attach this investigation to its operation.");
        }
      });
      return id;
    },

    /** A run that reads one recorded Daily capture through an access grant. It has no trial or deployment. */
    async createDaily(input: {
      captureId: string;
      grantId: string;
      sha256: CaptureFileHashes;
      task: string;
      instructions: string;
      agentConfigSource: string;
      configuration: Record<string, unknown>;
    }) {
      const id = randomUUID();
      // The foreign key also checks that these are the hashes the grant pinned.
      await pool.query(
        `INSERT INTO lab_investigation_runs
           (id, source, capture_id, capture_manifest_sha256, capture_evidence_sha256, capture_controller_sha256, capture_grant_id,
            task, instructions, instructions_sha256, agent_config_source, result_schema_version, configuration)
         VALUES ($1, 'daily_capture', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
        [id, input.captureId, input.sha256[MANIFEST], input.sha256[EVIDENCE], input.sha256[CONTROLLER], input.grantId, input.task,
          input.instructions, sha256(input.instructions), input.agentConfigSource, DAILY_ANSWER_SCHEMA_VERSION, JSON.stringify(input.configuration)],
      );
      return id;
    },

    async setSession(runId: string, sessionId: string) {
      const result = await pool.query(
        `UPDATE lab_investigation_runs SET session_id = $2
         WHERE id = $1 AND status = 'running' AND (session_id IS NULL OR session_id = $2)`,
        [runId, sessionId],
      );
      if (result.rowCount !== 1) throw new Error("Cannot attach this session to the investigation run.");
    },

    async appendEvent(runId: string, input: unknown) {
      const event = investigationEventSchema.parse(input);
      const payload = JSON.stringify(event);
      return transaction(pool, async (client) => {
        const run = await client.query<{ status: RunStatus }>("SELECT status FROM lab_investigation_runs WHERE id = $1 FOR UPDATE", [runId]);
        if (!run.rows[0]) throw new Error("Investigation run not found.");
        // Reconnection may replay the same event. Preserve it once; never
        // silently replace its evidence if the same ID has a different payload.
        const existing = await client.query<{ matches: boolean }>(
          "SELECT payload = $3::jsonb AS matches FROM lab_investigation_events WHERE run_id = $1 AND event_id = $2",
          [runId, event.meta.id, payload],
        );
        if (existing.rows[0]) {
          if (!existing.rows[0].matches) throw new Error("Event ID was replayed with a different payload.");
          return;
        }
        if (run.rows[0].status !== "running") throw new Error("Investigation run is already finished.");
        await client.query("INSERT INTO lab_investigation_events (run_id, event_id, payload) VALUES ($1, $2, $3::jsonb)", [runId, event.meta.id, payload]);

        const data = event.data as Record<string, unknown> | undefined;
        const modelId = event.type === "step.started" && typeof data?.modelId === "string" ? data.modelId : null;
        const terminalUsage = ["session.waiting", "session.completed", "session.failed", "turn.waiting"].includes(event.type) ? data?.usage : null;
        const usage = terminalUsage && typeof terminalUsage === "object" && !Array.isArray(terminalUsage) ? JSON.stringify(terminalUsage) : null;
        if (modelId || usage) {
          await client.query(
            "UPDATE lab_investigation_runs SET model_id = COALESCE(model_id, $2), usage = COALESCE($3::jsonb, usage) WHERE id = $1",
            [runId, modelId, usage],
          );
        }
      });
    },

    async finish(runId: string, outcome:
      | { status: "completed"; answer: InvestigationAnswer | DailyInvestigationAnswer; message: string }
      | { status: "failed" | "cancelled"; error: string }
    ) {
      await transaction(pool, async (client) => {
        // This row lock also serializes every event insert, including direct SQL,
        // so the assessment, the answer, and the integrity fingerprint the UPDATE
        // below seals share exactly the same trace and become visible in one commit.
        const selected = await client.query<{
          id: string; source: RunSource; trialId: string; deploymentId: string; status: RunStatus;
          caseSnapshot: CaseSnapshot | null; captureId: string; evidenceSha256: string;
        }>(
          `SELECT id, source, trial_id AS "trialId", deployment_id AS "deploymentId", status, case_snapshot AS "caseSnapshot",
             capture_id AS "captureId", capture_evidence_sha256 AS "evidenceSha256"
           FROM lab_investigation_runs WHERE id = $1 FOR UPDATE`, [runId]);
        const run = selected.rows[0];
        if (!run || run.status !== "running") throw new Error("Investigation run is missing or already finished.");
        const answerSchema = run.source === "daily_capture" ? dailyInvestigationAnswerSchema
          : run.caseSnapshot ? investigationAnswerV2Schema : investigationAnswerSchema;
        const answer = outcome.status === "completed" ? answerSchema.parse(outcome.answer) : null;
        const events = (await client.query<{ payload: InvestigationEvent }>("SELECT payload FROM lab_investigation_events WHERE run_id = $1 ORDER BY sequence", [runId]))
          .rows.map((row) => row.payload);
        const finished = { ...run, status: outcome.status, answer, events };
        // Daily runs freeze their evidence report; case runs freeze their outcome report.
        const evidenceReport = run.source === "daily_capture" ? evaluateDailyRun(finished) : null;
        const outcomeReport = run.source === "simulated" && run.caseSnapshot ? evaluateOutcome(finished) : null;
        await client.query(
          `UPDATE lab_investigation_runs SET status = $2, finished_at = clock_timestamp(), answer = $3::jsonb,
           assistant_message = $4, error = $5, outcome_report = $6::jsonb, evidence_report = $7::jsonb WHERE id = $1`,
          [runId, outcome.status, answer ? JSON.stringify(answer) : null, outcome.status === "completed" ? outcome.message : null,
            outcome.status === "completed" ? null : outcome.error, outcomeReport ? JSON.stringify(outcomeReport) : null,
            evidenceReport ? JSON.stringify(evidenceReport) : null]);
      });
    },

    /** A simulated deployment run. Throws UnsupportedRunSourceError for a run of another source. */
    async get(id: string): Promise<SimulatedRun> {
      const run = await read(id);
      if (run.source !== "simulated") throw new UnsupportedRunSourceError(run.id);
      return run;
    },

    /** A run of one recorded Daily capture. */
    async getDaily(id: string): Promise<DailyRun> {
      const run = await read(id);
      if (run.source !== "daily_capture") throw new Error(`Investigation ${run.id} is a simulated deployment run, not a Daily capture run.`);
      return run;
    },

    /** A run of either source, for readers that handle both. */
    getAny: read,
  };
}
