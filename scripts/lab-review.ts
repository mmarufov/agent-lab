import { createPool } from "@agent-lab/lab/database";
import { describeReview } from "@agent-lab/lab/review-report";
import { runReview } from "./lib/review";

// pnpm lab:review <run-id|latest>: one separate model review of a saved
// simulated or Daily investigation. It makes one real model request.

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
      onCreated: ({ id, runId, source, input, configuration }) => {
        const records = "deploymentId" in input ? input.evidence.length : input.evidence.length + input.untimedEvidence.length;
        const bytes = Buffer.byteLength(JSON.stringify(input), "utf8");
        console.log(`Review: ${id}\nRead later: pnpm lab review ${id}`);
        console.log(`Reviewing ${source === "daily_capture" ? "recorded Daily" : "simulated"} run ${runId}: ${records} retrieved record(s), ${bytes} of ${configuration.settings.maxInputBytes} bytes.`);
        console.log(`One request to ${configuration.modelId} with prompt ${configuration.promptVersion}; no tools, no retries, ${configuration.settings.timeoutMs / 1000}-second limit.\n`);
      },
    });
    console.log(describeReview(saved).join("\n"));
    const failedChecks = Object.entries(saved.evidenceCheck.checks).filter(([, check]) => check.status === "fail").map(([name]) => name);
    if (failedChecks.length) console.log(`Evidence checks still failed: ${failedChecks.join(", ")}. The review cannot override them.`);
    if (saved.error) console.error(saved.error);
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
