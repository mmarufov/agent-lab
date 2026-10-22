import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client, type MessageStreamEvent, type SessionWaitingStreamEvent } from "eve/client";
import { getLogsInputSchema, investigationAnswerV1Schema, investigationAnswerV2Schema, type InvestigationAnswer } from "@agent-lab/contracts";
import type { GetLogsConfig } from "../agent/lib/get-logs";

export type { MessageStreamEvent } from "eve/client";
export const investigatorHost = "http://127.0.0.1:2000";

// This is a local CLI supervisor, outside agent/. It is not a model tool.
export async function startInvestigator(config: GetLogsConfig, signal: AbortSignal) {
  signal.throwIfAborted();
  // Never attach a new trial to an existing Eve process with another token.
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", () => reject(new Error("Port 2000 is in use. Stop the existing Eve server before running lab:investigate.")));
    probe.listen(2000, "127.0.0.1", () => probe.close((error) => error ? reject(error) : resolve()));
  });

  const require = createRequire(import.meta.url);
  const executable = join(dirname(require.resolve("eve/package.json")), "bin/eve.js");
  const child = spawn(process.execPath, [executable, "dev", "--host", "127.0.0.1", "--port", "2000", "--no-ui", "--no-default-extensions"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, LAB_BASE_URL: config.baseUrl, LAB_TRIAL_TOKEN: config.trialToken, EVE_TELEMETRY_DISABLED: "1" },
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

  const startup = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  try {
    while (true) {
      startup.throwIfAborted();
      if (exitDescription) throw new Error(`Eve stopped during startup (${exitDescription}).\n${output.replaceAll(config.trialToken, "[redacted]")}`);
      try {
        // Client.health() has no signal parameter in this installed version.
        const response = await fetch(`${investigatorHost}/eve/v1/health`, {
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
    return { host: investigatorHost, stop };
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

export async function investigate(options: {
  host: string;
  deploymentId: string;
  resultSchemaVersion?: 1 | 2;
  signal: AbortSignal;
  onSession?: (sessionId: string) => void | Promise<void>;
  onEvent?: (event: MessageStreamEvent) => void | Promise<void>;
}) {
  const answerSchema = options.resultSchemaVersion === 2 ? investigationAnswerV2Schema : investigationAnswerV1Schema;
  const client = new Client({ host: options.host, redirect: "error" });
  const { session, response } = await client.sessions.create({
    message: investigationTask(options.deploymentId),
    outputSchema: answerSchema,
    signal: options.signal,
  });
  const events: MessageStreamEvent[] = [];
  let message = "";
  let answer: InvestigationAnswer | undefined;
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
    if (!answer) throw new Error("Investigation ended without a structured answer.");
    return { sessionId: response.sessionId, message, answer, events, usage };
  } catch (error) {
    // Aborting HTTP only detaches the client; explicitly cancel server work too.
    await session.cancel({ signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
    throw error;
  }
}
