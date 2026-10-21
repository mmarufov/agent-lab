import { readFile } from "node:fs/promises";
import { getLogsInputSchema } from "@agent-lab/contracts";
import { createPool } from "@agent-lab/lab/database";
import { createTrial } from "@agent-lab/lab/fixtures";
import { createRunStore } from "@agent-lab/lab/runs";
import { getLogs } from "../my-agent/agent/lib/get-logs";
import { investigate, investigationTask, investigatorHost, startInvestigator, type MessageStreamEvent } from "../my-agent/client/investigate";

function showEvent(event: MessageStreamEvent) {
  if (event.type === "step.started") console.log(`Model: ${event.data.modelId} (step ${event.data.stepIndex + 1})`);
  if (event.type === "actions.requested") {
    for (const action of event.data.actions) {
      if (action.kind === "tool-call") console.log(`Tool requested: ${action.toolName} ${JSON.stringify(action.input)}`);
    }
  }
  if (event.type === "action.result") {
    console.log(`Tool result (${event.data.status}): ${JSON.stringify(event.data.result.output, null, 2)}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const input = getLogsInputSchema.safeParse({ deploymentId: args[0] });
  if (args.length !== 1 || !input.success) throw new Error("Usage: pnpm lab:investigate <deployment-id> (for example: pnpm lab:investigate B)");

  const pool = createPool();
  const runs = createRunStore(pool);
  const controller = new AbortController();
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    controller.abort(new Error("Investigation interrupted."));
  };
  const deadline = setTimeout(() => controller.abort(new Error("Investigation exceeded the two-minute limit.")), 120_000);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let server: Awaited<ReturnType<typeof startInvestigator>> | undefined;
  let trialToken = "";
  let runId: string | undefined;
  let finished = false;
  const redact = (message: string) => trialToken ? message.replaceAll(trialToken, "[redacted]") : message;
  try {
    const [instructions, agentConfigSource] = await Promise.all([
      readFile(new URL("../my-agent/agent/instructions.md", import.meta.url), "utf8"),
      readFile(new URL("../my-agent/agent/agent.ts", import.meta.url), "utf8"),
    ]);
    const trial = await createTrial(pool);
    trialToken = trial.token;
    console.log(`Trial: ${trial.trialId}`);
    console.log(`Deployment: ${input.data.deploymentId} (simulated)`);
    const id = await runs.create({
      trialId: trial.trialId, deploymentId: input.data.deploymentId,
      task: investigationTask(input.data.deploymentId), instructions, agentConfigSource,
    });
    runId = id;
    console.log(`Run: ${id}\nRead later: pnpm lab run ${id}`);
    const config = { baseUrl: process.env.LAB_BASE_URL ?? "http://127.0.0.1:3000", trialToken };

    // Fail before spending model tokens if the service/credentials are broken.
    // This response is deliberately not included in the model's task.
    await getLogs(input.data, config);
    controller.signal.throwIfAborted();
    console.log(`Service access checked. Starting Eve at ${investigatorHost}...`);
    server = await startInvestigator(config, controller.signal);
    console.log("Investigating through AI Gateway...");
    const result = await investigate({
      host: server.host, deploymentId: input.data.deploymentId, signal: controller.signal,
      onSession: (sessionId) => runs.setSession(id, sessionId),
      onEvent: async (event) => {
        await runs.appendEvent(id, event);
        showEvent(event);
      },
    });
    await runs.finish(id, { status: "completed", answer: result.answer, message: result.message });
    finished = true;
    console.log(`\nSession: ${result.sessionId}`);
    console.log(`\nAnswer: ${JSON.stringify(result.answer, null, 2)}`);
    if (result.usage) {
      console.log(`\nTokens: ${result.usage.inputTokens} input, ${result.usage.outputTokens} output.`);
      console.log(`Reported model cost: ${result.usage.costUsd === undefined ? "unavailable" : `$${result.usage.costUsd.toFixed(6)}`}.`);
    }
    console.log("\nInvestigation saved. The answer has not been independently evaluated.");
    // Retain this trial for inspection, including when an investigation fails.
  } catch (error) {
    const message = redact(controller.signal.aborted ? String(controller.signal.reason.message) : error instanceof Error ? error.message : "Investigation failed.");
    if (runId && !finished) {
      try {
        await runs.finish(runId, { status: interrupted ? "cancelled" : "failed", error: message });
      } catch (saveError) {
        const detail = saveError instanceof Error ? saveError.message : "Unknown database error.";
        console.error(redact(`Could not save the final status of run ${runId}: ${detail} Inspect it before retrying.`));
      }
    }
    throw new Error(message);
  } finally {
    try { await server?.stop(); } finally {
      clearTimeout(deadline);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      await pool.end();
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Investigation failed.");
  process.exitCode = 1;
});
