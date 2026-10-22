import { readFile } from "node:fs/promises";
import { createPool } from "@agent-lab/lab/database";
import { getCase } from "@agent-lab/lab/cases";
import { createTrial } from "@agent-lab/lab/fixtures";
import { createRunStore } from "@agent-lab/lab/runs";
import { acquireExecution } from "@agent-lab/lab/jobs";
import { getLogs } from "../../my-agent/agent/lib/get-logs";
import {
  investigate,
  investigationTask,
  startInvestigator,
  type MessageStreamEvent,
} from "../../my-agent/client/investigate";

// The CLI and local web worker use the same investigation path.
export async function runInvestigation(
  pool: ReturnType<typeof createPool>,
  selector: string | { caseId: string },
  options: {
    signal?: AbortSignal;
    jobId?: string;
    onCreated?: (value: {
      runId: string;
      trialId: string;
    }) => void | Promise<void>;
    onEvent?: (event: MessageStreamEvent) => void | Promise<void>;
    onProgress?: (message: string) => void;
  } = {},
) {
  const definition = typeof selector === "string" ? undefined : getCase(selector.caseId);
  const deploymentId = typeof selector === "string" ? selector : definition!.deploymentId;
  const lease = await acquireExecution(pool);
  const deadline = AbortSignal.timeout(120_000);
  const signal = AbortSignal.any([
    deadline,
    lease.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  const runs = createRunStore(pool);
  let server: Awaited<ReturnType<typeof startInvestigator>> | undefined;
  let runId: string | undefined;
  let trialToken = "";
  try {
    signal.throwIfAborted();
    const [instructions, agentConfigSource] = await Promise.all([
      readFile(
        new URL("../../my-agent/agent/instructions.md", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../my-agent/agent/agent.ts", import.meta.url),
        "utf8",
      ),
    ]);
    const trial = await createTrial(pool, definition);
    trialToken = trial.token;
    runId = await runs.create(
      {
        trialId: trial.trialId,
        deploymentId,
        task: investigationTask(deploymentId),
        instructions,
        agentConfigSource,
        caseSnapshot: trial.caseSnapshot,
      },
      options.jobId,
    );
    await options.onCreated?.({ runId, trialId: trial.trialId });
    const config = {
      baseUrl: process.env.LAB_BASE_URL ?? "http://127.0.0.1:3000",
      trialToken,
    };
    // Verify the service before spending model tokens. This result is not
    // supplied to the model; the investigator must call its tool itself.
    await getLogs({ deploymentId }, config);
    signal.throwIfAborted();
    options.onProgress?.("Service access checked. Starting Eve...");
    server = await startInvestigator(config, signal);
    options.onProgress?.("Investigating through AI Gateway...");
    const id = runId;
    const result = await investigate({
      host: server.host,
      deploymentId,
      resultSchemaVersion: definition ? 2 : 1,
      signal,
      onSession: (sessionId) => runs.setSession(id, sessionId),
      onEvent: async (event) => {
        await runs.appendEvent(id, event);
        await options.onEvent?.(event);
      },
    });
    await runs.finish(id, {
      status: "completed",
      answer: result.answer,
      message: result.message,
    });
    return await runs.get(id);
  } catch (error) {
    const message = options.signal?.aborted
      ? "Investigation cancelled."
      : deadline.aborted
        ? "Investigation exceeded the two-minute limit."
        : lease.signal.aborted
          ? "The execution lock connection was lost."
          : error instanceof Error
            ? error.message
            : "Investigation failed.";
    const safe = trialToken
      ? message.replaceAll(trialToken, "[redacted]")
      : message;
    if (runId) {
      await runs.finish(runId, {
        status: options.signal?.aborted ? "cancelled" : "failed",
        error: safe,
      });
      return await runs.get(runId);
    }
    throw new Error(safe);
  } finally {
    try {
      await server?.stop();
    } finally {
      await lease.release();
    }
  }
}
