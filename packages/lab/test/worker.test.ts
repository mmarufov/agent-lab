import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { createPool } from "../src/database";
import { createJobStore } from "../src/jobs";
import { migrate } from "../src/migrate";

const admin = createPool(),
  schema = `worker_test_${randomUUID().replaceAll("-", "")}`;
const url = new URL(process.env.DATABASE_URL!);
url.searchParams.set("options", `-c search_path=${schema}`);
const pool = createPool(url.toString());
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

it("delivers cancellation to the running operation, records its outcome, and shuts down cleanly", async () => {
  const { serveWorker } = await import("../../../scripts/lib/worker");
  const jobs = createJobStore(pool),
    shutdown = new AbortController();
  const execute = vi.fn(async (_job, signal: AbortSignal) => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { status: "cancelled" as const };
  });
  const running = serveWorker(pool, { signal: shutdown.signal, execute });
  try {
    await expect
      .poll(async () => (await jobs.availability()).online)
      .toBe(true);
    const command = {
      requestId: randomUUID(),
      kind: "investigate" as const,
      deploymentId: "B" as const,
    };
    const job = await jobs.submit(command);
    await expect.poll(() => execute.mock.calls.length).toBe(1);
    await jobs.cancel(job.id);
    await expect
      .poll(async () => (await jobs.get(job.id)).status)
      .toBe("cancelled");
    expect((await jobs.submit(command)).id).toBe(job.id);
    expect(execute).toHaveBeenCalledTimes(1);
    const second = await jobs.submit({ ...command, requestId: randomUUID() });
    await expect.poll(() => execute.mock.calls.length).toBe(2);
    shutdown.abort();
    await running;
    expect((await jobs.get(second.id)).status).toBe("cancelled");
    expect((await jobs.availability()).online).toBe(false);
  } finally {
    shutdown.abort();
    await running;
  }
});
