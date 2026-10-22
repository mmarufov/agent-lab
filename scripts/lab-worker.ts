import { createPool } from "@agent-lab/lab/database";
import { runInvestigation } from "./lib/investigation";
import { runReview } from "./lib/review";
import { serveWorker } from "./lib/worker";

async function main() {
  if (process.env.VERCEL || process.env.LAB_LOCAL_EXECUTION === "0")
    throw new Error("The local worker is disabled in this environment.");
  const pool = createPool(),
    shutdown = new AbortController();
  const interrupt = () => shutdown.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await serveWorker(pool, {
      signal: shutdown.signal,
      log: console.log,
      execute: (job, signal) =>
        job.command.kind === "investigate"
          ? runInvestigation(pool, "caseId" in job.command ? { caseId: job.command.caseId } : job.command.deploymentId, {
              signal,
              jobId: job.id,
            })
          : runReview(pool, job.command.runId, { signal, jobId: job.id }),
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await pool.end();
  }
}
void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Local worker failed.",
  );
  process.exitCode = 1;
});
