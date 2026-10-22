import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createPool } from "@agent-lab/lab/database";
import {
  acquireExecution,
  createJobStore,
  type ExecutionJob,
} from "@agent-lab/lab/jobs";

export async function serveWorker(
  pool: ReturnType<typeof createPool>,
  options: {
    signal: AbortSignal;
    execute: (
      job: ExecutionJob,
      signal: AbortSignal,
    ) => Promise<{ status: "running" | "completed" | "failed" | "cancelled" }>;
    log?: (message: string) => void;
  },
) {
  const jobs = createJobStore(pool),
    owner = randomUUID();
  const shutdown = new AbortController();
  const interrupt = () => shutdown.abort(new Error("Local worker stopped."));
  options.signal.throwIfAborted();
  options.signal.addEventListener("abort", interrupt, { once: true });
  let leader: Awaited<ReturnType<typeof acquireExecution>> | undefined;
  let heartbeat: Promise<void> | undefined;
  let active: { job: ExecutionJob; controller: AbortController } | undefined;
  let fatal: Error | undefined;
  const loseOwnership = () => {
    fatal = new Error(
      "Worker lost its database connection; active work was stopped.",
    );
    interrupt();
  };
  try {
    leader = await acquireExecution(pool, "worker");
    leader.signal.addEventListener("abort", loseOwnership, { once: true });
    await jobs.recover();
    await jobs.register(owner);
    options.log?.(
      "Local worker ready. Open http://127.0.0.1:3000/runs. One operation runs at a time.",
    );
    heartbeat = (async () => {
      try {
        while (!shutdown.signal.aborted) {
          await jobs.heartbeat(owner);
          if (active && (await jobs.get(active.job.id)).cancelRequested)
            active.controller.abort(new Error("Cancellation requested."));
          await delay(750, undefined, { signal: shutdown.signal });
        }
      } catch {
        if (!shutdown.signal.aborted) loseOwnership();
      }
    })();
    while (!shutdown.signal.aborted) {
      const job = await jobs.claim(owner);
      if (!job) {
        await delay(250, undefined, { signal: shutdown.signal });
        continue;
      }
      const controller = new AbortController();
      active = { job, controller };
      const signal = AbortSignal.any([shutdown.signal, controller.signal]);
      options.log?.(`Starting ${job.kind} ${job.id}`);
      try {
        signal.throwIfAborted();
        const saved = await options.execute(job, signal);
        if (saved.status === "running")
          throw new Error("Operation did not settle.");
        await jobs.finish(
          job.id,
          saved.status,
          saved.status === "failed"
            ? "Operation failed. Open the saved record to inspect the available evidence."
            : undefined,
        );
        options.log?.(`${job.kind} ${job.id}: ${saved.status}`);
      } catch {
        await jobs.finish(
          job.id,
          signal.aborted ? "cancelled" : "failed",
          signal.aborted
            ? "Operation cancelled."
            : "Operation could not complete. Check the local service and Gateway configuration.",
        );
        options.log?.(
          `${job.kind} ${job.id}: ${signal.aborted ? "cancelled" : "failed"}`,
        );
      } finally {
        active = undefined;
      }
    }
  } catch (error) {
    if (!shutdown.signal.aborted) throw error;
  } finally {
    interrupt();
    await heartbeat;
    options.signal.removeEventListener("abort", interrupt);
    if (leader) {
      leader.signal.removeEventListener("abort", loseOwnership);
      await jobs.unregister(owner).catch(() => undefined);
      await leader.release();
    }
  }
  if (fatal) throw fatal;
}
