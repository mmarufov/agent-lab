import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { investigationAnswerSchema, investigationAnswerV2Schema, investigationEventSchema, type InvestigationAnswer, type InvestigationEvent } from "@agent-lab/contracts";
import { transaction } from "./database";
import type { CaseSnapshot } from "./cases";
import { evaluateOutcome, type OutcomeReport } from "./outcome";

type RunStatus = "running" | "completed" | "failed" | "cancelled";
interface RunRow {
  id: string;
  trialId: string;
  deploymentId: string;
  task: string;
  instructions: string;
  instructionsHash: string;
  agentConfigSource: string;
  resultSchemaVersion: number;
  caseId: string | null;
  caseVersion: number | null;
  caseSnapshot: CaseSnapshot | null;
  outcomeReport: OutcomeReport | null;
  sessionId: string | null;
  modelId: string | null;
  status: RunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  answer: InvestigationAnswer | null;
  message: string | null;
  usage: Record<string, unknown> | null;
  error: string | null;
  events: InvestigationEvent[];
}

// Trusted runner access only. This store is not an agent tool or public route.
export function createRunStore(pool: Pool) {
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
      const hash = createHash("sha256").update(input.instructions).digest("hex");
      await transaction(pool, async (client) => {
        await client.query(
          `INSERT INTO lab_investigation_runs
             (id, trial_id, deployment_id, task, instructions, instructions_sha256, agent_config_source, result_schema_version, case_id, case_version, case_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
          [id, input.trialId, input.deploymentId, input.task, input.instructions, hash, input.agentConfigSource, snapshot ? 2 : 1, snapshot?.id ?? null, snapshot?.version ?? null, snapshot ? JSON.stringify(snapshot) : null],
        );
        if (jobId) {
          const linked = await client.query("UPDATE lab_execution_jobs SET run_id = $2 WHERE id = $1 AND kind = 'investigate' AND status = 'running' AND run_id IS NULL", [jobId, id]);
          if (linked.rowCount !== 1) throw new Error("Cannot attach this investigation to its operation.");
        }
      });
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
      | { status: "completed"; answer: InvestigationAnswer; message: string }
      | { status: "failed" | "cancelled"; error: string }
    ) {
      await transaction(pool, async (client) => {
        // This row lock also serializes appendEvent, so the assessment and answer
        // share exactly the same trace and become visible in one commit.
        const selected = await client.query<Pick<RunRow, "id" | "trialId" | "deploymentId" | "status" | "caseSnapshot">>(
          `SELECT id, trial_id AS "trialId", deployment_id AS "deploymentId", status, case_snapshot AS "caseSnapshot"
           FROM lab_investigation_runs WHERE id = $1 FOR UPDATE`, [runId]);
        const run = selected.rows[0];
        if (!run || run.status !== "running") throw new Error("Investigation run is missing or already finished.");
        const answer = outcome.status === "completed"
          ? (run.caseSnapshot ? investigationAnswerV2Schema : investigationAnswerSchema).parse(outcome.answer) : null;
        const events = await client.query<{ payload: InvestigationEvent }>("SELECT payload FROM lab_investigation_events WHERE run_id = $1 ORDER BY sequence", [runId]);
        const report = run.caseSnapshot ? evaluateOutcome({ ...run, status: outcome.status, answer, events: events.rows.map((row) => row.payload) }) : null;
        await client.query(
          `UPDATE lab_investigation_runs SET status = $2, finished_at = clock_timestamp(), answer = $3::jsonb,
           assistant_message = $4, error = $5, outcome_report = $6::jsonb WHERE id = $1`,
          [runId, outcome.status, answer ? JSON.stringify(answer) : null, outcome.status === "completed" ? outcome.message : null,
            outcome.status === "completed" ? null : outcome.error, report ? JSON.stringify(report) : null]);
      });
    },

    async get(id: string) {
      // One query gives a consistent view of the summary and its events while
      // another process is still writing. Only the fixed 'latest' branch is SQL.
      const result = await pool.query<RunRow>(
        `SELECT id, trial_id AS "trialId", deployment_id AS "deploymentId", task,
           instructions, instructions_sha256 AS "instructionsHash", agent_config_source AS "agentConfigSource",
           result_schema_version AS "resultSchemaVersion", case_id AS "caseId", case_version AS "caseVersion",
           case_snapshot AS "caseSnapshot", outcome_report AS "outcomeReport", session_id AS "sessionId", model_id AS "modelId",
           status, started_at AS "startedAt", finished_at AS "finishedAt",
           (EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)::float8 AS "durationMs",
           answer, assistant_message AS message, usage, error,
           COALESCE((SELECT jsonb_agg(payload ORDER BY sequence) FROM lab_investigation_events WHERE run_id = r.id), '[]'::jsonb) AS events
         FROM lab_investigation_runs r
         ${id === "latest" ? "ORDER BY started_at DESC, id DESC LIMIT 1" : "WHERE id = $1"}`,
        id === "latest" ? [] : [id],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Investigation run not found.");
      return { ...row, startedAt: row.startedAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null };
    },
  };
}
