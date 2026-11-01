import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client, type MessageStreamEvent, type SessionWaitingStreamEvent } from "eve/client";
import type { z } from "zod";
import { getLogsInputSchema, investigationAnswerV1Schema, investigationAnswerV2Schema, type InvestigationAnswer } from "@agent-lab/contracts";

export type { MessageStreamEvent } from "eve/client";
export const investigatorHost = "http://127.0.0.1:2000";
export const EVE_STARTUP_MS = 60_000;

/** The evidence one Eve process may read, and the credentials it reads it with. The model sees none of these values. */
export type InvestigatorSettings =
  | { mode: "simulated"; baseUrl: string; trialToken: string }
  | { mode: "daily_capture"; baseUrl: string; captureToken: string; captureId: string; evidenceSha256: string };

// Every evidence setting either mode reads. Eve receives only its own mode's
// values, so a credential inherited from this shell never reaches the other mode.
const EVIDENCE_SETTINGS = [
  "LAB_TOOL_MODE",
  "LAB_BASE_URL",
  "LAB_TRIAL_TOKEN",
  "LAB_DAILY_CAPTURE_TOKEN",
  "LAB_DAILY_CAPTURE_ID",
  "LAB_DAILY_EVIDENCE_SHA256",
];

/** The environment Eve starts with: the base environment minus every evidence setting, plus this run's. */
export function investigatorEnv(settings: InvestigatorSettings, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, EVE_TELEMETRY_DISABLED: "1" };
  for (const name of EVIDENCE_SETTINGS) delete env[name];
  if (settings.mode === "simulated")
    return { ...env, LAB_TOOL_MODE: "simulated", LAB_BASE_URL: settings.baseUrl, LAB_TRIAL_TOKEN: settings.trialToken };
  return {
    ...env,
    LAB_TOOL_MODE: "daily_capture",
    LAB_BASE_URL: settings.baseUrl,
    LAB_DAILY_CAPTURE_TOKEN: settings.captureToken,
    LAB_DAILY_CAPTURE_ID: settings.captureId,
    LAB_DAILY_EVIDENCE_SHA256: settings.evidenceSha256,
  };
}

// This is a local CLI supervisor, outside agent/. It is not a model tool.
// Tests pass another app directory and port to run a fixture copy of the agent.
export async function startInvestigator(
  settings: InvestigatorSettings,
  signal: AbortSignal,
  options: { appDir?: string; port?: number; env?: Record<string, string | undefined> } = {},
) {
  signal.throwIfAborted();
  const port = options.port ?? 2000;
  const host = `http://127.0.0.1:${port}`;
  const secret = settings.mode === "simulated" ? settings.trialToken : settings.captureToken;
  // Never attach a new run to an existing Eve process with another token.
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", () => reject(new Error(`Port ${port} is in use. Stop the existing Eve server before starting an investigation.`)));
    probe.listen(port, "127.0.0.1", () => probe.close((error) => error ? reject(error) : resolve()));
  });

  const require = createRequire(import.meta.url);
  const executable = join(dirname(require.resolve("eve/package.json")), "bin/eve.js");
  const child = spawn(process.execPath, [executable, "dev", "--host", "127.0.0.1", "--port", String(port), "--no-ui", "--no-default-extensions"], {
    cwd: options.appDir ?? fileURLToPath(new URL("..", import.meta.url)),
    // LAB_TOOL_MODE pins the tool set and instructions: an inherited value must not change them.
    env: investigatorEnv(settings, { ...process.env, ...options.env }),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let output = "";
  let exitDescription: string | undefined;
  let didClose = false;
  const closed = new Promise<void>((resolve) => {
    child.once("error", (error) => { exitDescription = error.message; });
    child.once("exit", (code, exitSignal) => { exitDescription = `exit ${code ?? exitSignal}`; });
    child.once("close", () => { didClose = true; resolve(); });
  });
  const record = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8_000); };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  function kill(exitSignal: NodeJS.Signals) {
    if (!child.pid || didClose) return;
    try {
      if (process.platform === "win32") child.kill(exitSignal);
      else process.kill(-child.pid, exitSignal); // Includes Eve's worker processes.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  async function stop() {
    kill("SIGTERM");
    const force = setTimeout(() => kill("SIGKILL"), 5_000);
    try { await closed; } finally { clearTimeout(force); }
  }

  const startup = AbortSignal.any([signal, AbortSignal.timeout(EVE_STARTUP_MS)]);
  try {
    while (true) {
      startup.throwIfAborted();
      if (exitDescription) throw new Error(`Eve stopped during startup (${exitDescription}).\n${output.replaceAll(secret, "[redacted]")}`);
      try {
        // Client.health() has no signal parameter in this installed version.
        const response = await fetch(`${host}/eve/v1/health`, {
          signal: AbortSignal.any([startup, AbortSignal.timeout(1_000)]), redirect: "error",
        });
        if (response.ok) {
          const health = await response.json();
          if (health.ok === true && health.status === "ready" && typeof health.workflowId === "string") break;
        } else {
          await response.body?.cancel();
        }
      } catch { startup.throwIfAborted(); }
      await delay(250, undefined, { signal: startup });
    }
    return { host, stop };
  } catch (error) {
    await stop();
    if (startup.aborted && !signal.aborted) throw new Error("Eve did not become ready within 60 seconds. Check pnpm --filter my-agent dev.");
    throw error;
  }
}

export function investigationTask(deploymentId: string) {
  const input = getLogsInputSchema.parse({ deploymentId });
  return `Investigate simulated deployment ${JSON.stringify(input.deploymentId)}. Report your diagnosis, supporting log IDs, and uncertainty.`;
}

/** The task for an investigation of one recorded Daily capture. The access grant, not the task, selects the capture. */
export const dailyCaptureTask =
  "Investigate Daily's feed API during the recorded period. Determine whether requests experienced problems, " +
  "explain the likely cause when evidence supports one, and assess whether requests subsequently recovered. " +
  "Cite supporting records and state what remains uncertain.";

export async function investigate(options: {
  host: string;
  deploymentId: string;
  resultSchemaVersion?: 1 | 2;
  signal: AbortSignal;
  onSession?: (sessionId: string) => void | Promise<void>;
  onEvent?: (event: MessageStreamEvent) => void | Promise<void>;
}) {
  const answerSchema: z.ZodType<InvestigationAnswer> = options.resultSchemaVersion === 2 ? investigationAnswerV2Schema : investigationAnswerV1Schema;
  return runInvestigatorSession({ ...options, task: investigationTask(options.deploymentId), answerSchema });
}

/**
 * Send the task to a fresh session and read its events until the answer. The
 * task is the only message; every event is passed to onEvent, and awaited,
 * before the next one is read.
 */
export async function runInvestigatorSession<Answer>(options: {
  host: string;
  task: string;
  answerSchema: z.ZodType<Answer>;
  signal: AbortSignal;
  onSession?: (sessionId: string) => void | Promise<void>;
  onEvent?: (event: MessageStreamEvent) => void | Promise<void>;
}) {
  const { answerSchema } = options;
  const client = new Client({ host: options.host, redirect: "error" });
  const { session, response } = await client.sessions.create({
    message: options.task,
    outputSchema: answerSchema,
    signal: options.signal,
  });
  const events: MessageStreamEvent[] = [];
  let message = "";
  let answer: Answer | undefined;
  let completed = false;
  let settled = false;
  let usage: SessionWaitingStreamEvent["data"]["usage"];
  try {
    await options.onSession?.(response.sessionId);
    for await (const event of response) {
      events.push(event);
      // A failed write must stop the run, not silently lose its evidence.
      await options.onEvent?.(event);
      if (event.type === "turn.failed" || event.type === "session.failed") throw new Error(`Investigation failed: ${event.data.message}`);
      if (event.type === "turn.cancelled") throw new Error("Investigation was cancelled.");
      if (event.type === "input.requested") {
        // Eve asks before exceeding a configured usage limit. Never approve it here.
        const limit = event.data.requests.find((request) => request.kind === "session-limit");
        if (limit) throw new Error(`Eve stopped at a session usage limit, and more usage was not approved. ${limit.prompt.split(". ")[0]}.`);
      }
      if (event.type === "authorization.required" || event.type === "input.requested") {
        throw new Error("Eve needs interactive input. Open pnpm --filter my-agent dev to complete setup, then stop it and retry.");
      }
      if (event.type === "message.completed" && event.data.finishReason !== "tool-calls") message = event.data.message;
      if (event.type === "result.completed") {
        const parsed = answerSchema.safeParse(event.data.result);
        if (!parsed.success) throw new Error("Eve returned an invalid structured answer.");
        answer = parsed.data;
      }
      if (event.type === "turn.completed") completed = true;
      if (event.type === "session.waiting" || event.type === "session.completed") {
        settled = true;
        usage = event.data?.usage;
      }
    }
    options.signal.throwIfAborted();
    if (!completed || !settled) throw new Error("Investigation ended without a completed answer.");
    if (answer === undefined) throw new Error("Investigation ended without a structured answer.");
    return { sessionId: response.sessionId, message, answer, events, usage };
  } catch (error) {
    // Aborting HTTP only detaches the client; explicitly cancel server work too.
    await session.cancel({ signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
    throw error;
  }
}
