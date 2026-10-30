import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer, get as httpGet } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCaptureAccess } from "@agent-lab/lab/capture-access";
import { createPool } from "@agent-lab/lab/database";
import { dailyCapturesDir, type DailyCaptureRecords } from "@agent-lab/lab/daily-evidence";
import { migrate } from "@agent-lab/lab/migrate";
import { getDailyHttpObservations, getDailyLogs, type DailyEvidenceConfig } from "../my-agent/agent/lib/daily-evidence";

// The clean capture recorded by pnpm daily:capture, read through the running
// Next.js service (pnpm dev). Captures are gitignored, so this suite runs only
// on a machine that has this one.
const CAPTURE_ID = "20261022T050138Z-39b307";
const baseUrl = process.env.LAB_BASE_URL ?? "http://127.0.0.1:3000";
const capturesDir = dailyCapturesDir();
const pool = createPool();
const run = promisify(execFile);
const grantIds: string[] = [];
let config: DailyEvidenceConfig;
let source: DailyCaptureRecords;

async function grant() {
  const granted = await createCaptureAccess(pool, capturesDir).grant(CAPTURE_ID);
  grantIds.push(granted.grant.id);
  return granted;
}

async function request(tool: "get-logs" | "get-http-observations", query: Record<string, string | number>, token = config.token) {
  const url = new URL(`/api/tools/daily/${tool}`, baseUrl);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}

/** Every page through raw HTTP, checking the 64 KiB page limit on the way. */
async function pages(tool: "get-logs" | "get-http-observations", query: Record<string, string | number> = {}) {
  const records: { id: string }[] = [];
  let cursor: string | undefined;
  let count = 0;
  do {
    const page = await request(tool, { ...query, ...(cursor ? { cursor } : {}) });
    expect(page.status).toBe(200);
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(64 * 1024);
    expect(page.body.oversized).toEqual([]);
    records.push(...(tool === "get-logs" ? page.body.logs : page.body.observations));
    cursor = page.body.nextCursor ?? undefined;
    count++;
  } while (cursor);
  return { records, count };
}

describe.skipIf(!existsSync(join(capturesDir, CAPTURE_ID)))(`Daily evidence tools over real HTTP (capture ${CAPTURE_ID})`, () => {
  beforeAll(async () => {
    await migrate(pool);
    const granted = await grant();
    source = granted.capture;
    config = { baseUrl, token: granted.token, captureId: CAPTURE_ID, evidenceSha256: granted.grant.sha256["evidence.jsonl"] };
  });

  afterAll(async () => {
    try {
      await pool.query("DELETE FROM lab_capture_access_grants WHERE id = ANY($1::uuid[])", [grantIds]);
    } finally {
      await pool.end();
    }
  });

  it("retrieves all 821 log lines and 28 HTTP observations through the Eve clients, equal to the verified file", async () => {
    const logs: unknown[] = [];
    const observations: unknown[] = [];
    let logPages = 0;
    let httpPages = 0;
    let cursor: string | undefined;
    do {
      const page = await getDailyLogs({ cursor }, config);
      logs.push(...page.logs);
      cursor = page.nextCursor ?? undefined;
      logPages++;
    } while (cursor);
    do {
      const page = await getDailyHttpObservations({ cursor }, config);
      observations.push(...page.observations);
      cursor = page.nextCursor ?? undefined;
      httpPages++;
    } while (cursor);

    expect(logs).toHaveLength(821);
    expect(observations).toHaveLength(28);
    expect(logs).toEqual(source.logs);
    expect(observations).toEqual(source.observations);
    expect([logPages, httpPages]).toEqual([17, 2]);
  });

  it("returns the same records for other page sizes and filters, and the same page when repeated", async () => {
    const all = await pages("get-logs", { limit: 100 });
    expect(all.count).toBe(9);
    expect(all.records).toEqual(source.logs);
    expect((await pages("get-http-observations", { limit: 1 })).records).toEqual(source.observations);
    expect((await pages("get-logs", { service: "daily-api", messageContains: "pooltimeout" })).records).toEqual(
      source.logs.filter((record) => record.message.toLowerCase().includes("pooltimeout")),
    );
    expect((await pages("get-logs", { service: "daily-gateway" })).records).toEqual([]);
    const feed = await pages("get-http-observations", { path: "/feed", limit: 3 });
    expect(feed.records).toEqual(source.observations.filter((record) => record.path === "/feed"));

    const first = await request("get-logs", { limit: 10 });
    const later = await request("get-logs", { limit: 10, cursor: first.body.nextCursor });
    expect((await request("get-logs", { limit: 10, cursor: first.body.nextCursor })).text).toBe(later.text);
    expect(later.body.logs[0].id).toBe(source.logs[10].id);
  });

  it("keeps a 200 during the outage a 200, and a timeout distinct from an HTTP error", async () => {
    const { body } = await request("get-http-observations", { limit: 50 });
    const byId = new Map(body.observations.map((record: { id: string }) => [record.id, record]));
    expect(byId.get("http-0007")).toMatchObject({ path: "/healthz", outcome: "response", response: { status: 200 } });
    expect(byId.get("http-0008")).toMatchObject({ path: "/feed", outcome: "response", response: { status: 500 } });
    expect(byId.get("http-0012")).toMatchObject({ path: "/readyz", outcome: "timeout", elapsedMs: 5002.8 });
    expect(byId.get("http-0012")).not.toHaveProperty("response");
  });

  it("refuses unknown, revoked, and expired tokens, and cursors from another tool or filter", async () => {
    const access = createCaptureAccess(pool, capturesDir);
    const revoked = await grant();
    await access.revoke(revoked.grant.id);
    const expired = await grant();
    await pool.query(
      "UPDATE lab_capture_access_grants SET created_at = created_at - interval '2 hours', expires_at = expires_at - interval '2 hours' WHERE id = $1",
      [expired.grant.id],
    );
    for (const [token, message] of [
      ["0".repeat(64), "Invalid capture access token."],
      [revoked.token, "This capture access grant was revoked."],
      [expired.token, "This capture access grant expired at"],
    ]) {
      const response = await request("get-logs", {}, token);
      expect(response.status).toBe(401);
      expect(response.body.error.message).toContain(message);
    }
    const unauthenticated = await fetch(new URL("/api/tools/daily/get-logs", baseUrl));
    expect(unauthenticated.status).toBe(401);

    const cursor = (await request("get-logs", { limit: 5 })).body.nextCursor;
    for (const [tool, query] of [
      ["get-http-observations", { cursor }],
      ["get-logs", { service: "daily-api", cursor }],
    ] as const) {
      const response = await request(tool, query);
      expect([response.status, response.body.error.code]).toEqual([400, "invalid_cursor"]);
    }
    const selected = await request("get-logs", { captureId: "20261022T045819Z-89a170" });
    expect([selected.status, selected.body.error.code]).toEqual([400, "invalid_input"]);
  });

  it("explains a granted capture whose files are not in the service's captures directory", async () => {
    // A grant for a capture this machine does not have, made directly in the database.
    const token = randomBytes(32).toString("hex");
    const id = randomUUID();
    grantIds.push(id);
    await pool.query(
      `INSERT INTO lab_capture_access_grants (id, capture_id, evidence_sha256, controller_sha256, manifest_sha256, token_hash, created_at, expires_at)
       VALUES ($1, '20000101T000000Z-000000', $2, $2, $2, $3, now(), now() + interval '1 hour')`,
      [id, "0".repeat(64), createHash("sha256").update(token).digest("hex")],
    );
    const response = await request("get-logs", {}, token);
    expect(response.status).toBe(404);
    expect(response.body.error).toEqual({ code: "capture_missing", message: "Capture 20000101T000000Z-000000 is not in the captures directory." });
  });

  it("returns no controller records, outcomes, file paths, or credentials", async () => {
    const texts: string[] = [];
    for (const tool of ["get-logs", "get-http-observations"] as const) {
      let cursor: string | undefined;
      do {
        const page = await request(tool, { limit: tool === "get-logs" ? 100 : 50, ...(cursor ? { cursor } : {}) });
        texts.push(page.text);
        cursor = page.body.nextCursor ?? undefined;
      } while (cursor);
    }
    const all = texts.join("\n");
    for (const forbidden of ['"ctl-', '"log-db-', "stop-database", "outageObserved", "applicationRecovered", capturesDir, ".context/", config.token])
      expect(all).not.toContain(forbidden);
  });

  it("denies a request addressed to a non-local host before reading anything", async () => {
    // Node fetch normalizes Host; the HTTP client sends the untrusted value as written.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      httpGet(
        new URL("/api/tools/daily/get-logs", baseUrl),
        { headers: { Host: "untrusted.example", Authorization: `Bearer ${config.token}` } },
        (response) => {
          resolve(response.statusCode);
          response.resume();
        },
      ).on("error", reject);
    });
    expect(status).toBe(403);
  });

  it("runs pnpm lab:daily-evidence end to end and leaves its grant revoked", async () => {
    const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", "scripts/lab-daily-evidence.ts", CAPTURE_ID], {
      env: { ...process.env, LAB_BASE_URL: baseUrl },
      timeout: 30_000,
    });
    const id = stdout.match(/^Access grant ([0-9a-f-]{36}) expires/m)?.[1];
    if (id) grantIds.push(id);
    expect(stderr).toBe("");
    expect(stdout).toContain("28 HTTP observations, 821 log lines");
    expect(stdout).toContain("Every retrieved record matches the verified evidence.jsonl");
    expect(stdout).toContain("This capture access grant was revoked.");
    // The only 64-character hex value printed is the evidence hash, never the token.
    expect(new Set(stdout.match(/\b[a-f0-9]{64}\b/g))).toEqual(new Set([source.sha256["evidence.jsonl"]]));
    const { rows } = await pool.query("SELECT revoked_at FROM lab_capture_access_grants WHERE id = $1", [id]);
    expect(rows[0].revoked_at).toBeInstanceOf(Date);
  });

  it("revokes its grant when pnpm lab:daily-evidence is cancelled mid-request", async () => {
    // A service that accepts the connection and never answers keeps the command waiting.
    const silent = createServer(() => {});
    silent.listen(0, "127.0.0.1");
    await once(silent, "listening");
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/lab-daily-evidence.ts", CAPTURE_ID], {
      env: { ...process.env, LAB_BASE_URL: `http://127.0.0.1:${(silent.address() as AddressInfo).port}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const exited = once(child, "exit");
    try {
      for (let waited = 0; !/^Access grant [0-9a-f-]{36} expires/m.test(stdout); waited += 50) {
        if (waited > 20_000) throw new Error(`The command never created its grant.\n${stdout}\n${stderr}`);
        await delay(50);
      }
      const id = stdout.match(/^Access grant ([0-9a-f-]{36}) expires/m)![1];
      grantIds.push(id);
      await delay(300);
      child.kill("SIGINT");
      const [code] = await exited;
      expect(code).toBe(130);
      expect(stderr).toContain("SIGINT: stopping and revoking the access grant.");
      expect(stderr).toContain(`Access grant ${id} revoked.`);
      const { rows } = await pool.query("SELECT revoked_at FROM lab_capture_access_grants WHERE id = $1", [id]);
      expect(rows[0].revoked_at).toBeInstanceOf(Date);
    } finally {
      child.kill("SIGKILL");
      silent.closeAllConnections();
      silent.close();
    }
  });
});
