import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@agent-lab/lab/database";
import { createTrial, deleteTrials } from "@agent-lab/lab/fixtures";
import { migrate } from "@agent-lab/lab/migrate";

const baseUrl = process.env.LAB_BASE_URL ?? "http://127.0.0.1:3000";
const pool = createPool();
const run = promisify(execFile);
const trialIds: string[] = [];
let first: Awaited<ReturnType<typeof createTrial>>;
let second: Awaited<ReturnType<typeof createTrial>>;

async function request(query: string, token?: string) {
  return fetch(new URL(`/api/tools/get-logs${query}`, baseUrl), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(20_000),
  });
}

beforeAll(async () => {
  await migrate(pool);
  first = await createTrial(pool);
  trialIds.push(first.trialId);
  second = await createTrial(pool);
  trialIds.push(second.trialId);
  // Deliberately distinct evidence makes a cross-trial leak observable.
  await pool.query(
    "UPDATE lab_deployment_logs SET message = 'Second trial only.' WHERE trial_id = $1 AND id = 'log-17'",
    [second.trialId],
  );
  await pool.query(
    "INSERT INTO lab_deployments (trial_id, id, healthy, sequence) VALUES ($1, 'private-only', true, 4)",
    [second.trialId],
  );
});

afterAll(async () => {
  try { await deleteTrials(pool, trialIds); } finally { await pool.end(); }
});

describe("GET /api/tools/get-logs over real HTTP", () => {
  it("runs the terminal demo through the client and retains a fresh trial for inspection", async () => {
    const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", "scripts/lab-logs.ts", "B"], {
      env: { ...process.env, LAB_BASE_URL: baseUrl },
      timeout: 10_000,
    });
    const trialId = stdout.match(/^Trial: ([a-f0-9-]+)$/m)?.[1];
    if (trialId) trialIds.push(trialId);
    expect(trialId).toBeDefined();
    expect(trialId).not.toBe(first.trialId);
    expect(trialId).not.toBe(second.trialId);
    expect(stderr).toBe("");
    expect(stdout).toContain("log-17: Startup failed: DATABASE_URL is missing.");
    const stored = await pool.query("SELECT message FROM lab_deployment_logs WHERE trial_id = $1 AND id = 'log-17'", [trialId]);
    expect(stored.rows).toEqual([{ message: "Startup failed: DATABASE_URL is missing." }]);
  });

  it("returns B's saved info, warning, and error records with no caching", async () => {
    const response = await request("?deploymentId=B", first.token);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({ logs: [
      { id: "log-15", deploymentId: "B", level: "info", message: "Starting application." },
      { id: "log-16", deploymentId: "B", level: "warn", message: "Optional telemetry is disabled." },
      { id: "log-17", deploymentId: "B", level: "error", message: "Startup failed: DATABASE_URL is missing." },
    ] });
    const stored = await pool.query(
      `SELECT id, deployment_id AS "deploymentId", level, message
       FROM lab_deployment_logs WHERE trial_id = $1 AND deployment_id = 'B' ORDER BY sequence`,
      [first.trialId],
    );
    expect(body.logs).toEqual(stored.rows);
  });

  it("uses the requested deployment and distinguishes empty logs from an unknown deployment", async () => {
    const a = await request("?deploymentId=A", first.token);
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ logs: [
      { id: "log-1", deploymentId: "A", level: "info", message: "Starting application." },
      { id: "log-2", deploymentId: "A", level: "info", message: "Health check passed." },
    ] });
    const c = await request("?deploymentId=C", first.token);
    expect(c.status).toBe(200);
    expect(await c.json()).toEqual({ logs: [] });
    const missing = await request("?deploymentId=missing", first.token);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("rejects missing and invalid tokens", async () => {
    for (const token of [undefined, "bad-token", "0".repeat(64)]) {
      const response = await request("?deploymentId=B", token);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
    }
  });

  it("rejects missing, empty, oversized, and ambiguous deployment inputs", async () => {
    for (const query of ["", "?deploymentId=", `?deploymentId=${"x".repeat(101)}`, "?deploymentId=A&deploymentId=B"]) {
      const response = await request(query, first.token);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_input" } });
    }
  });

  it("limits every request to the token's trial even when log IDs match", async () => {
    const one = await request("?deploymentId=B", first.token);
    const two = await request("?deploymentId=B", second.token);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect((await one.json()).logs[2].message).toBe("Startup failed: DATABASE_URL is missing.");
    expect((await two.json()).logs[2].message).toBe("Second trial only.");
    const foreign = await request("?deploymentId=private-only", first.token);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ error: { code: "not_found" } });
    const selectedTrial = await request(`?deploymentId=B&trialId=${second.trialId}`, first.token);
    expect(selectedTrial.status).toBe(400);
    expect(await selectedTrial.json()).toMatchObject({ error: { code: "invalid_input" } });
  });
});
