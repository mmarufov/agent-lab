import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect, it } from "vitest";
import { createPool } from "../src/database";
import { migrate } from "../src/migrate";
import { createTrial } from "../src/fixtures";
import { createRunStore } from "../src/runs";
const admin = createPool(),
  schema = `jobs_test_${randomUUID().replaceAll("-", "")}`;
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

it("deduplicates a request and refuses a different operation while busy", async () => {
  const { createJobStore } = await import("../src/jobs");
  const jobs = createJobStore(pool);
  const owner = randomUUID();
  await jobs.register(owner);
  const command = {
    requestId: randomUUID(),
    kind: "investigate" as const,
    deploymentId: "B" as const,
  };
  const [a, b] = await Promise.all([
    jobs.submit(command),
    jobs.submit(command),
  ]);
  expect(a.id).toBe(b.id);
  await expect(jobs.submit({ ...command, deploymentId: "A" })).rejects.toThrow(
    /different/i,
  );
  await expect(
    jobs.submit({ ...command, requestId: randomUUID() }),
  ).rejects.toThrow(/busy/i);
  const claimed = await jobs.claim(owner);
  expect(claimed?.id).toBe(a.id);
  expect(await jobs.claim(owner)).toBeNull();
  await jobs.cancel(a.id);
  expect((await jobs.get(a.id)).cancelRequested).toBe(true);
  await jobs.finish(a.id, "cancelled", "Cancelled.");
  expect((await jobs.submit(command)).status).toBe("cancelled");
});

it("rejects new work when offline and does not replay interrupted work", async () => {
  const { createJobStore } = await import("../src/jobs");
  const jobs = createJobStore(pool);
  await pool.query(
    "UPDATE lab_worker SET heartbeat_at = now() - interval '1 minute'",
  );
  await expect(
    jobs.submit({
      requestId: randomUUID(),
      kind: "investigate",
      deploymentId: "B",
    }),
  ).rejects.toThrow(/offline/i);
  const owner = randomUUID();
  await jobs.register(owner);
  const job = await jobs.submit({
    requestId: randomUUID(),
    kind: "investigate",
    deploymentId: "C",
  });
  await jobs.claim(owner);
  await jobs.recover();
  expect((await jobs.get(job.id)).status).toBe("failed");
  expect(await jobs.claim(owner)).toBeNull();
});

it("cancels queued work without executing it and enforces the cross-process lock", async () => {
  const { createJobStore, acquireExecution } = await import("../src/jobs");
  const jobs = createJobStore(pool);
  const owner = randomUUID();
  await jobs.register(owner);
  const job = await jobs.submit({
    requestId: randomUUID(),
    kind: "investigate",
    deploymentId: "A",
  });
  expect((await jobs.cancel(job.id)).status).toBe("cancelled");
  expect(await jobs.claim(owner)).toBeNull();
  const lease = await acquireExecution(pool);
  try {
    await expect(acquireExecution(pool)).rejects.toThrow(/busy/i);
  } finally {
    await lease.release();
  }
  const second = await acquireExecution(pool);
  await second.release();
});

it("links a run atomically and preserves a completed result after a worker interruption", async () => {
  const { createJobStore } = await import("../src/jobs");
  const jobs = createJobStore(pool);
  const owner = randomUUID();
  await jobs.register(owner);
  const job = await jobs.submit({
    requestId: randomUUID(),
    kind: "investigate",
    deploymentId: "B",
  });
  await jobs.claim(owner);
  const trial = await createTrial(pool),
    runs = createRunStore(pool);
  const input = {
    trialId: trial.trialId,
    deploymentId: "B",
    task: "B",
    instructions: "",
    agentConfigSource: "",
  };
  const runId = await runs.create(input, job.id);
  expect((await jobs.get(job.id)).runId).toBe(runId);
  await expect(runs.create(input, job.id)).rejects.toThrow(/attach/);
  expect(
    (
      await pool.query(
        "SELECT id FROM lab_investigation_runs WHERE trial_id = $1",
        [trial.trialId],
      )
    ).rows,
  ).toHaveLength(1);
  await runs.finish(runId, {
    status: "completed",
    answer: {
      diagnosis: "Unknown",
      evidenceIds: [],
      uncertainty: "Missing logs",
    },
    message: "",
  });
  await jobs.recover();
  expect((await jobs.get(job.id)).status).toBe("completed");
  expect((await runs.get(runId)).status).toBe("completed");
});

it("marks interrupted runs failed and rejects reviews of unfinished evidence", async () => {
  const { createJobStore } = await import("../src/jobs");
  const jobs = createJobStore(pool);
  const owner = randomUUID();
  await jobs.register(owner);
  const trial = await createTrial(pool),
    runs = createRunStore(pool);
  const input = {
    trialId: trial.trialId,
    deploymentId: "B",
    task: "B",
    instructions: "",
    agentConfigSource: "",
  };
  const unfinished = await runs.create(input);
  await expect(
    jobs.submit({ requestId: randomUUID(), kind: "review", runId: unfinished }),
  ).rejects.toThrow(/completed answer/);
  const job = await jobs.submit({
    requestId: randomUUID(),
    kind: "investigate",
    deploymentId: "B",
  });
  await jobs.claim(owner);
  const id = await runs.create(input, job.id);
  await jobs.recover();
  expect((await runs.get(id)).status).toBe("failed");
  expect((await jobs.get(job.id)).status).toBe("failed");
});

it("accepts a single known case selector, preserves idempotency, and rejects conflicting selectors", async () => {
  const { createJobStore } = await import("../src/jobs");
  const jobs = createJobStore(pool), owner = randomUUID();
  await jobs.register(owner);
  const command = { requestId: randomUUID(), kind: "investigate" as const, caseId: "healthy-startup" as const };
  const job = await jobs.submit(command);
  expect((await jobs.submit(command)).id).toBe(job.id);
  expect((await jobs.claim(owner))?.command).toEqual(command);
  await jobs.finish(job.id, "cancelled");
  await expect(jobs.submit({ ...command, deploymentId: "B" })).rejects.toThrow();
  await expect(jobs.submit({ ...command, caseId: "bad-case" as "healthy-startup" })).rejects.toThrow();
});
