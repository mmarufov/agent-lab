import { readFile } from "node:fs/promises";
import { dailyCaptureIdSchema } from "@agent-lab/contracts/daily-capture";
import { DAILY_ANSWER_SCHEMA_VERSION, dailyInvestigationAnswerSchema } from "@agent-lab/contracts/daily-investigation";
import { createCaptureAccess, type CaptureGrant } from "@agent-lab/lab/capture-access";
import { createPool } from "@agent-lab/lab/database";
import { dailyCapturesDir } from "@agent-lab/lab/daily-evidence";
import { acquireExecution } from "@agent-lab/lab/jobs";
import { createRunStore } from "@agent-lab/lab/runs";
import investigator from "../../my-agent/agent/agent";
import { DAILY_TOOL_DEADLINE_MS, getDailyHttpObservations } from "../../my-agent/agent/lib/daily-evidence";
import { evidenceTools } from "../../my-agent/agent/lib/tool-mode";
import { investigatorInstructions } from "../../my-agent/client/instructions";
import {
  EVE_STARTUP_MS,
  dailyCaptureTask,
  runInvestigatorSession,
  startInvestigator,
  type InvestigatorSettings,
  type MessageStreamEvent,
} from "../../my-agent/client/investigate";

export const DAILY_INVESTIGATION_MS = 5 * 60_000;

type Eve = { host: string; stop: () => Promise<void> };

/**
 * One fresh Eve investigation of one recorded Daily capture. The capture ID
 * comes from the caller, never from the model; the access grant behind the
 * tools' token is the only way Eve can read the recording.
 */
export async function runDailyInvestigation(
  pool: ReturnType<typeof createPool>,
  captureId: string,
  options: {
    signal?: AbortSignal;
    baseUrl?: string;
    capturesDir?: string;
    timeoutMs?: number;
    /** Starts Eve with these settings; tests run a fixture copy of the agent. */
    startEve?: (settings: InvestigatorSettings, signal: AbortSignal) => Promise<Eve>;
    onCreated?: (value: { runId: string; grant: CaptureGrant }) => void | Promise<void>;
    onEvent?: (event: MessageStreamEvent) => void | Promise<void>;
    onProgress?: (message: string) => void;
  } = {},
) {
  if (!dailyCaptureIdSchema.safeParse(captureId).success)
    throw new Error("A capture is selected by an ID like 20261022T050138Z-39b307.");
  const baseUrl = options.baseUrl ?? process.env.LAB_BASE_URL ?? "http://127.0.0.1:3000";
  const timeoutMs = options.timeoutMs ?? DAILY_INVESTIGATION_MS;
  const startEve = options.startEve ?? startInvestigator;
  const progress = options.onProgress ?? (() => undefined);
  // One model operation at a time, shared with simulated runs and the web worker.
  const lease = await acquireExecution(pool);
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([deadline, lease.signal, ...(options.signal ? [options.signal] : [])]);
  const access = createCaptureAccess(pool, options.capturesDir ?? dailyCapturesDir());
  const runs = createRunStore(pool);
  let grant: CaptureGrant | undefined;
  let token = "";
  let runId: string | undefined;
  let eve: Eve | undefined;
  try {
    signal.throwIfAborted();
    // 1-2. Verify the finalized files, then grant access pinned to exactly them.
    const granted = await access.grant(captureId);
    ({ token, grant } = granted);
    const evidenceSha256 = grant.sha256["evidence.jsonl"];
    progress(
      `Capture ${captureId}: completed recording with complete evidence; ` +
        `${granted.capture.observations.length} HTTP observations and ${granted.capture.logs.length} log lines.`,
    );
    progress(`Access grant ${grant.id} pins evidence.jsonl ${evidenceSha256} and expires ${grant.expiresAt}.`);

    // 3. What this run is and how it is configured, saved before any model call.
    const [instructions, agentConfigSource] = await Promise.all([
      investigatorInstructions("daily_capture"),
      readFile(new URL("../../my-agent/agent/agent.ts", import.meta.url), "utf8"),
    ]);
    runId = await runs.createDaily({
      captureId,
      grantId: grant.id,
      sha256: grant.sha256,
      task: dailyCaptureTask,
      instructions,
      agentConfigSource,
      configuration: {
        toolMode: "daily_capture",
        tools: evidenceTools.daily_capture,
        agent: investigator,
        answerSchemaVersion: DAILY_ANSWER_SCHEMA_VERSION,
        deadlines: { investigationMs: timeoutMs, eveStartupMs: EVE_STARTUP_MS, toolRequestMs: DAILY_TOOL_DEADLINE_MS },
        evidenceService: baseUrl,
      },
    });
    await options.onCreated?.({ runId, grant });

    // 4. The evidence service answers with this grant. Its page is not given to
    // the model; the investigator must retrieve evidence with its own tools.
    const settings: InvestigatorSettings = { mode: "daily_capture", baseUrl, captureToken: token, captureId, evidenceSha256 };
    await getDailyHttpObservations({ limit: 1 }, { baseUrl, token, captureId, evidenceSha256, signal });
    signal.throwIfAborted();
    progress(`Evidence service at ${baseUrl} serves this capture. Starting Eve...`);

    // 5-6. A fresh Eve process and session; every event is saved before the next is read.
    eve = await startEve(settings, signal);
    progress("Investigating through AI Gateway...\n");
    const id = runId;
    const result = await runInvestigatorSession({
      host: eve.host,
      task: dailyCaptureTask,
      answerSchema: dailyInvestigationAnswerSchema,
      signal,
      onSession: (sessionId) => runs.setSession(id, sessionId),
      onEvent: async (event) => {
        await runs.appendEvent(id, event);
        await options.onEvent?.(event);
      },
    });

    // 7. Finishing validates the answer and freezes its evidence report.
    await runs.finish(id, { status: "completed", answer: result.answer, message: result.message });
  } catch (error) {
    let message = options.signal?.aborted
      ? "Investigation cancelled."
      : deadline.aborted
        ? `Investigation exceeded its ${timeoutMs % 60_000 ? `${timeoutMs / 1000}-second` : `${timeoutMs / 60_000}-minute`} limit.`
        : lease.signal.aborted
          ? "The execution lock connection was lost."
          : error instanceof Error
            ? error.message
            : "Investigation failed.";
    if (/capture_missing|capture_changed/.test(message))
      message += " The lab service reads captures from its own working directory; run pnpm dev from this checkout.";
    const safe = token ? message.replaceAll(token, "[redacted]") : message;
    if (!runId) throw new Error(safe);
    // Save what was recorded before cleanup, without inventing an answer.
    try {
      await runs.finish(runId, { status: options.signal?.aborted ? "cancelled" : "failed", error: safe });
    } catch {
      throw new Error(`${safe}\nIts final status could not be saved; run ${runId} remains unfinished.`);
    }
  } finally {
    // 8. Stop Eve, revoke the grant, release the lock: each one even if an earlier one fails.
    try {
      await eve?.stop();
    } catch {
      progress("Could not confirm that Eve stopped; check for an eve process on its port.");
    }
    if (grant) {
      const { id, expiresAt } = grant;
      await access.revoke(id).then(
        () => progress(`Access grant ${id} revoked.`),
        () => progress(`Could not revoke access grant ${id}; it expires ${expiresAt}.`),
      );
    }
    await lease.release();
  }
  // Read after cleanup, so the record shows the grant's final state.
  return runs.getDaily(runId);
}
