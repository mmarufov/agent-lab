import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPool } from "../src/database";
import { createTrial, deleteTrials } from "../src/fixtures";
import { migrate } from "../src/migrate";
import { createRunStore } from "../src/runs";

const pool = createPool();
const trials: string[] = [];
beforeAll(() => migrate(pool));
afterAll(async () => {
  await deleteTrials(pool, trials);
  await pool.end();
});

it("projects received evidence without leaking the runner's private configuration", async () => {
  const { createWebStore } = await import("../src/web");
  const trial = await createTrial(pool);
  trials.push(trial.trialId);
  const store = createRunStore(pool);
  const id = await store.create({
    trialId: trial.trialId,
    deploymentId: "B",
    task: "Investigate B",
    instructions: "PRIVATE_INSTRUCTIONS",
    agentConfigSource: "PRIVATE_CONFIGURATION",
  });
  const at = "2026-10-21T12:00:00.000Z";
  const event = (type: string, data: unknown) => ({
    type,
    data,
    meta: { id: randomUUID(), at },
  });
  await store.appendEvent(
    id,
    event("actions.requested", {
      turnId: "turn",
      actions: [
        {
          kind: "tool-call",
          toolName: "get_logs",
          callId: "call",
          input: { deploymentId: "B" },
        },
      ],
    }),
  );
  await store.appendEvent(
    id,
    event("action.result", {
      turnId: "turn",
      status: "completed",
      result: {
        kind: "tool-result",
        toolName: "get_logs",
        callId: "call",
        output: {
          logs: [
            {
              id: "log-17",
              deploymentId: "B",
              level: "error",
              message: "DATABASE_URL is missing.",
            },
          ],
        },
      },
    }),
  );
  const answer = {
    diagnosis: "Missing configuration.",
    evidenceIds: ["log-17"],
    uncertainty: "Why it is missing is unknown.",
  };
  await store.appendEvent(
    id,
    event("result.completed", { turnId: "turn", result: answer }),
  );
  await store.finish(id, { status: "completed", answer, message: "answer" });
  const web = createWebStore(pool);
  const view = await web.get(id);
  expect(view.checks.citations.status).toBe("pass");
  expect(view.evidence[0]).toMatchObject({
    callId: "call",
    log: { id: "log-17", message: "DATABASE_URL is missing." },
  });
  expect(view.usage.costUsd).toBeNull();
  expect(view.reviewEligible).toBe(true);
  for (const secret of [
    trial.token,
    "PRIVATE_INSTRUCTIONS",
    "PRIVATE_CONFIGURATION",
    "token_hash",
  ])
    expect(JSON.stringify(view)).not.toContain(secret);
  const page = await web.list({
    deploymentId: "B",
    status: "completed",
    limit: 50,
  });
  expect(page.items.some((run) => run.id === id)).toBe(true);
  expect(
    page.items.every(
      (run) => run.deploymentId === "B" && run.status === "completed",
    ),
  ).toBe(true);
  expect(JSON.stringify(page)).not.toContain("PRIVATE_CONFIGURATION");
});

it("keeps unavailable, empty and missing records distinct", async () => {
  const { createWebStore } = await import("../src/web");
  const trial = await createTrial(pool);
  trials.push(trial.trialId);
  const id = await createRunStore(pool).create({
    trialId: trial.trialId,
    deploymentId: "C",
    task: "Investigate C",
    instructions: "",
    agentConfigSource: "",
  });
  const view = await createWebStore(pool).get(id);
  expect(view.answer).toBeNull();
  expect(view.evidence).toEqual([]);
  expect(view.reviewEligible).toBe(false);
  await expect(createWebStore(pool).get(randomUUID())).rejects.toThrow(
    /not found/i,
  );
});
