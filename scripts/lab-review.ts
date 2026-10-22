import { createPool } from "@agent-lab/lab/database";
import { runReview } from "./lib/review";

async function main() {
  const [runId, ...extra] = process.argv.slice(2);
  if (!runId || extra.length) throw new Error("Usage: pnpm lab:review <run-id|latest>");
  const pool = createPool();
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Review interrupted."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const saved = await runReview(pool, runId, {
      signal: controller.signal,
      onCreated: (id) => console.log(`Review: ${id}\nRead later: pnpm lab review ${id}`),
    });
    console.log(`Run: ${saved.runId}\nStatus: ${saved.status}`);
    if (saved.review) console.log(JSON.stringify(saved.review, null, 2));
    if (saved.observation) {
      const usage = saved.observation.usage;
      console.log(`Review tokens: ${usage.inputTokens ?? "unknown"} input, ${usage.outputTokens ?? "unknown"} output.`);
      console.log(`Reported review cost: ${usage.costUsd === null ? "unavailable" : `$${usage.costUsd.toFixed(6)}`}.`);
    }
    const failedChecks = Object.entries(saved.evidenceCheck.checks).filter(([, check]) => check.status === "fail").map(([name]) => name);
    if (failedChecks.length) console.log(`Evidence checks still failed: ${failedChecks.join(", ")}. The review cannot override them.`);
    if (saved.error) console.error(saved.error);
    console.log("Model judgments are advisory; review completion is not proof that the diagnosis is correct.");
    if (saved.status !== "completed" || failedChecks.length) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Review command failed.");
  process.exitCode = 1;
});
