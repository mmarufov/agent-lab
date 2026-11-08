import { fileURLToPath } from "node:url";
import { createPool } from "@agent-lab/lab/database";
import { describeDailyEval, runDailyEval } from "./lib/daily-eval";

// pnpm lab:eval:daily: one native Eve Eval run of the Daily recovery case
// (my-agent/evals/daily/recovery.eval.ts) against its pinned recording. It
// makes real model calls through AI Gateway, limited by the agent's session
// limits; a usage-limit extension is never approved. Prerequisites: Agent
// Lab's PostgreSQL (pnpm db:up), the evidence service (pnpm dev), Eve's
// Gateway login, and the saved recording. Daily's containers are not needed.
//
// Ctrl+C or SIGTERM cancels the session turn, lets the eval save its
// artifacts, then revokes the grant and releases the lock; a second Ctrl+C
// kills eve eval at once but still cleans up. SIGKILL of this process cannot
// clean up: the eval notices its closed stdin and stops itself, the database
// releases the lock with the connection, and the access grant stays valid
// until it expires, within one hour.

async function main() {
  if (process.argv.length > 2)
    throw new Error("Usage: pnpm lab:eval:daily. It takes no arguments: the case pins recording 20261022T050138Z-39b307.");
  const pool = createPool();
  const stop = new AbortController();
  const force = new AbortController();
  const interrupt = (signal: NodeJS.Signals) => {
    if (!stop.signal.aborted) {
      console.error(`\n${signal}: cancelling the evaluation and cleaning up. Press Ctrl+C again to stop eve eval at once.`);
      stop.abort(new Error(`Interrupted by ${signal}.`));
    } else force.abort(new Error(`Interrupted again by ${signal}.`));
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
    const outcome = await runDailyEval(pool, {
      signal: stop.signal,
      force: force.signal,
      onProgress: console.log,
      onOutput: (text) => process.stdout.write(text),
    });
    for (const line of describeDailyEval(outcome, repositoryRoot)) console.log(line);
    if (!outcome.artifacts && outcome.exitCode !== 0) console.error(outcome.output.trim().split("\n").slice(-20).join("\n"));
    process.exitCode = outcome.exitCode;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "The Daily evaluation failed.");
  process.exitCode = 1;
});
