import { caseIdSchema, getLogsInputSchema } from "@agent-lab/contracts";
import { createPool } from "@agent-lab/lab/database";
import { runInvestigation } from "./lib/investigation";

async function main() {
  const args = process.argv.slice(2);
  const caseId = args[0] === "--case" && args.length === 2 ? caseIdSchema.parse(args[1]) : undefined;
  const input = getLogsInputSchema.safeParse({ deploymentId: args[0] });
  if (!caseId && (args.length !== 1 || !input.success))
    throw new Error("Usage: pnpm lab:investigate <deployment-id> | --case <case-id>");
  const deploymentId = caseId ? "B" : input.data!.deploymentId;
  const pool = createPool();
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(new Error("Investigation interrupted."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const saved = await runInvestigation(pool, caseId ? { caseId } : deploymentId, {
      signal: controller.signal,
      onCreated: ({ runId, trialId }) =>
        console.log(
          `Trial: ${trialId}\nDeployment: ${deploymentId} (simulated)\nRun: ${runId}\nRead later: pnpm lab run ${runId}`,
        ),
      onProgress: console.log,
      onEvent(event) {
        if (event.type === "step.started")
          console.log(
            `Model: ${event.data.modelId} (step ${event.data.stepIndex + 1})`,
          );
        if (event.type === "actions.requested")
          for (const action of event.data.actions) {
            if (action.kind === "tool-call")
              console.log(
                `Tool requested: ${action.toolName} ${JSON.stringify(action.input)}`,
              );
          }
        if (event.type === "action.result")
          console.log(
            `Tool result (${event.data.status}): ${JSON.stringify(event.data.result.output, null, 2)}`,
          );
      },
    });
    console.log(
      `\nSession: ${saved.sessionId ?? "not started"}\nStatus: ${saved.status}`,
    );
    if (saved.answer)
      console.log(`Answer: ${JSON.stringify(saved.answer, null, 2)}`);
    if (saved.usage) {
      console.log(`Tokens: ${saved.usage.inputTokens ?? "unknown"} input, ${saved.usage.outputTokens ?? "unknown"} output.`);
      console.log(`Reported model cost: ${typeof saved.usage.costUsd === "number" ? `$${saved.usage.costUsd.toFixed(6)}` : "unavailable"}.`);
    }
    if (saved.error) console.error(saved.error);
    if (saved.status !== "completed") process.exitCode = 1;
    if (saved.outcomeReport) {
      console.log(`Outcome: ${saved.outcomeReport.status}\n${saved.outcomeReport.reasons.join("\n")}`);
      if (saved.outcomeReport.status === "fail") process.exitCode = 1;
    }
    console.log("Investigation saved. AI review is a separate request.");
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await pool.end();
  }
}
void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Investigation failed.",
  );
  process.exitCode = 1;
});
