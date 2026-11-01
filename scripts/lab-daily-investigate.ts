import { dailyCaptureIdSchema } from "@agent-lab/contracts/daily-capture";
import { createPool } from "@agent-lab/lab/database";
import { describeDailyEvent } from "@agent-lab/lab/daily-trace";
import { describeIntegrity } from "@agent-lab/lab/runs";
import { runDailyInvestigation } from "./lib/daily-investigation";

// pnpm lab:daily-investigate <capture-id>: one Eve investigation of one
// recorded Daily capture through AI Gateway. It makes real model calls.

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !dailyCaptureIdSchema.safeParse(args[0]).success)
    throw new Error("Usage: pnpm lab:daily-investigate <capture-id>, for example: pnpm lab:daily-investigate 20261022T050138Z-39b307");
  const pool = createPool();
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Investigation interrupted."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const saved = await runDailyInvestigation(pool, args[0], {
      signal: controller.signal,
      onProgress: console.log,
      onCreated: ({ runId }) => console.log(`Run: ${runId}\nRead later: pnpm lab run ${runId}`),
      onEvent: (event) => {
        for (const line of describeDailyEvent(event)) console.log(line);
      },
    });
    console.log(`\nSession: ${saved.sessionId ?? "not started"}\nStatus: ${saved.status}`);
    console.log(describeIntegrity(saved.integrity));
    if (saved.answer) {
      console.log(`Diagnosis: ${saved.answer.diagnosis}`);
      console.log(`Evidence IDs: ${saved.answer.evidenceIds.join(", ") || "none"}`);
      console.log(`Uncertainty: ${saved.answer.uncertainty}`);
    }
    const usage = saved.usage ?? {};
    if (saved.usage) {
      console.log(`Tokens: ${usage.inputTokens ?? "unknown"} input, ${usage.outputTokens ?? "unknown"} output.`);
      console.log(`Reported model cost: ${typeof usage.costUsd === "number" ? `$${usage.costUsd.toFixed(6)}` : "unavailable"}.`);
    }
    if (saved.error) console.error(saved.error);
    const report = saved.evidenceReport;
    if (report) {
      console.log(`\nEvidence checks (${report.evaluatorVersion}):`);
      for (const [name, check] of Object.entries(report.checks)) console.log(`${check.status.toUpperCase()} ${name}: ${check.reason}`);
      console.log(`NOT ASSESSED diagnosis: ${report.diagnosisAssessment.reason}`);
    }
    console.log(`\nSaved. Reopen without a model call: pnpm lab run ${saved.id}, or check it again: pnpm lab evaluate ${saved.id}`);
    if (saved.status !== "completed" || (report && Object.values(report.checks).some((check) => check.status === "fail"))) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Investigation failed.");
  process.exitCode = 1;
});
