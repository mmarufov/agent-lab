import { createHash } from "node:crypto";
import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { DailyApplicationLog, DailyCaptureEvidence } from "@agent-lab/contracts/daily-capture";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CaptureAccessError, createCaptureAccess } from "../src/capture-access";
import { createPool } from "../src/database";
import { DailyCaptureError, readDailyCapture } from "../src/daily-evidence";
import { dailyEvidenceResponse, type DailyEvidenceTool } from "../src/daily-tools";
import { migrate } from "../src/migrate";
import {
  CLEAN_CAPTURE_ID,
  CONTROLLER_ONLY,
  capturesDir,
  http,
  incidentEvidence,
  log,
  removeCaptureDirs,
  writeCapture,
} from "./daily-capture-fixture";

const pool = createPool();
const grantIds: string[] = [];
const OTHER_ID = "20261022T060000Z-abcdef";
const PAGE_BYTES = 64 * 1024;

beforeAll(() => migrate(pool));
afterEach(removeCaptureDirs);
afterAll(async () => {
  try {
    await pool.query("DELETE FROM lab_capture_access_grants WHERE id = ANY($1::uuid[])", [grantIds]);
  } finally {
    await pool.end();
  }
});

async function granted(root: string, captureId = CLEAN_CAPTURE_ID) {
  const result = await createCaptureAccess(pool, root).grant(captureId);
  grantIds.push(result.grant.id);
  return result;
}

type Query = Record<string, string | number | undefined>;

function call(root: string, tool: DailyEvidenceTool, token: string | undefined, query: Query = {}) {
  const url = new URL(`http://127.0.0.1:3000/api/tools/daily/${tool === "get_daily_logs" ? "get-logs" : "get-http-observations"}`);
  for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.append(key, String(value));
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  return dailyEvidenceResponse(new Request(url, { headers }), tool, { pool: () => pool, capturesDir: root });
}

async function read(response: Response) {
  const text = await response.text();
  expect(response.headers.get("cache-control")).toBe("no-store");
  return { status: response.status, text, body: JSON.parse(text) };
}

/** Every page, following nextCursor from the first request. */
async function allPages(root: string, tool: DailyEvidenceTool, token: string, query: Query = {}) {
  const pages: { text: string; body: Record<string, unknown> & { nextCursor: string | null } }[] = [];
  let cursor: string | undefined;
  do {
    const page = await read(await call(root, tool, token, { ...query, cursor }));
    expect(page.status).toBe(200);
    pages.push(page);
    cursor = page.body.nextCursor ?? undefined;
  } while (cursor);
  return pages;
}

const ids = (records: { id: string }[]) => records.map((record) => record.id);

describe("capture access grants", () => {
  it("pins the verified capture's files for one hour and stores only a hash of the token", async () => {
    const root = await capturesDir();
    await writeCapture(root);
    const { token, grant, capture } = await granted(root);

    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(grant.sha256).toEqual((await readDailyCapture(root, CLEAN_CAPTURE_ID)).sha256);
    expect(capture.logs).toHaveLength(7);
    expect(Date.parse(grant.expiresAt) - Date.parse(grant.createdAt)).toBe(60 * 60 * 1000);
    const { rows } = await pool.query("SELECT * FROM lab_capture_access_grants WHERE id = $1", [grant.id]);
    expect(rows[0].token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(await createCaptureAccess(pool, root).resolve(token)).toEqual(grant);

    // The database itself refuses a grant that would outlive one hour.
    await expect(
      pool.query("UPDATE lab_capture_access_grants SET expires_at = created_at + interval '61 minutes' WHERE id = $1", [grant.id]),
    ).rejects.toThrow(/check constraint/);
  });

  it("grants nothing for a recording that is not accepted as evidence", async () => {
    const root = await capturesDir();
    const captureId = "20261022T070000Z-0c0c0c";
    await writeCapture(root, { captureId, manifest: (manifest) => ({ ...manifest, status: "cancelled" }) });
    await expect(createCaptureAccess(pool, root).grant(captureId)).rejects.toBeInstanceOf(DailyCaptureError);
    const { rows } = await pool.query("SELECT count(*)::int AS count FROM lab_capture_access_grants WHERE capture_id = $1", [captureId]);
    expect(rows[0].count).toBe(0);
  });

  it("refuses unknown, malformed, expired, and revoked tokens, over HTTP as well", async () => {
    const root = await capturesDir();
    await writeCapture(root);
    const access = createCaptureAccess(pool, root);
    const expired = await granted(root);
    await pool.query(
      "UPDATE lab_capture_access_grants SET created_at = created_at - interval '2 hours', expires_at = expires_at - interval '2 hours' WHERE id = $1",
      [expired.grant.id],
    );
    const revoked = await granted(root);
    expect(await access.revoke(revoked.grant.id)).toBe(true);
    expect(await access.revoke(revoked.grant.id)).toBe(false);

    const cases: [string | undefined, string][] = [
      [undefined, "A capture access token is required."],
      ["0".repeat(64), "Invalid capture access token."],
      ["not-a-token", "Invalid capture access token."],
      [expired.token, "This capture access grant expired at"],
      [revoked.token, "This capture access grant was revoked."],
    ];
    for (const [token, message] of cases) {
      const response = await read(await call(root, "get_daily_logs", token));
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("unauthorized");
      expect(response.body.error.message).toContain(message);
    }
    await expect(access.resolve(revoked.token)).rejects.toMatchObject({ reason: "revoked" });
    await expect(access.resolve(expired.token)).rejects.toBeInstanceOf(CaptureAccessError);
    const basic = await dailyEvidenceResponse(
      new Request("http://127.0.0.1:3000/api/tools/daily/get-logs", { headers: { Authorization: `Basic ${expired.token}` } }),
      "get_daily_logs",
      { pool: () => pool, capturesDir: root },
    );
    expect(basic.status).toBe(401);
  });
});

describe("Daily evidence pages", () => {
  // 257 lines: the incident's logs plus enough to need several pages.
  function manyLogs(): DailyCaptureEvidence[] {
    const extra: DailyApplicationLog[] = Array.from({ length: 250 }, (_, index) =>
      log(100 + index, index % 25 === 0 ? `ERROR request ${index} failed` : `INFO:     request ${index} ok`, index % 10 === 0 ? "daily-gateway" : "daily-api"),
    );
    return [...incidentEvidence(), ...extra];
  }

  it("returns every permitted record exactly once and in recorded order, whatever the limit or filter", async () => {
    const root = await capturesDir();
    await writeCapture(root, { evidence: manyLogs() });
    const { token, capture } = await granted(root);

    const logCases: [Query, DailyApplicationLog[]][] = [
      [{}, capture.logs],
      [{ limit: 1 }, capture.logs],
      [{ limit: 7 }, capture.logs],
      [{ limit: 100 }, capture.logs],
      [{ service: "daily-gateway" }, capture.logs.filter((record) => record.service === "daily-gateway")],
      [{ messageContains: "adminshutdown" }, capture.logs.filter((record) => record.message.includes("AdminShutdown"))],
      [
        { service: "daily-api", messageContains: "ERROR", limit: 3 },
        capture.logs.filter((record) => record.service === "daily-api" && record.message.toLowerCase().includes("error")),
      ],
      [{ messageContains: "nothing matches this" }, []],
    ];
    for (const [query, expected] of logCases) {
      const pages = await allPages(root, "get_daily_logs", token, query);
      const limit = Number(query.limit ?? 50);
      const logs = pages.flatMap((page) => page.body.logs as DailyApplicationLog[]);
      expect(logs).toEqual(expected);
      expect(pages.map((page) => (page.body.logs as unknown[]).length)).toEqual(
        expected.length ? Array.from({ length: Math.ceil(expected.length / limit) }, (_, index) => Math.min(limit, expected.length - index * limit)) : [0],
      );
      for (const page of pages) {
        expect(page.body).toMatchObject({ captureId: CLEAN_CAPTURE_ID, evidenceSha256: capture.sha256["evidence.jsonl"], oversized: [] });
        expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(PAGE_BYTES);
      }
      expect(pages.at(-1)?.body.nextCursor).toBeNull();
    }

    for (const [query, expected] of [
      [{}, capture.observations],
      [{ limit: 3 }, capture.observations],
      [{ limit: 50 }, capture.observations],
      [{ path: "/feed" }, capture.observations.filter((record) => record.path === "/feed")],
      [{ path: "/missing" }, []],
    ] as const) {
      const pages = await allPages(root, "get_daily_http_observations", token, query);
      expect(pages.flatMap((page) => page.body.observations as unknown[])).toEqual(expected);
    }
  });

  it("returns the same page for the same request, including later pages", async () => {
    const root = await capturesDir();
    await writeCapture(root, { evidence: manyLogs() });
    const { token } = await granted(root);
    const first = await read(await call(root, "get_daily_logs", token, { limit: 20 }));
    const second = await read(await call(root, "get_daily_logs", token, { limit: 20, cursor: first.body.nextCursor }));
    const again = await read(await call(root, "get_daily_logs", token, { limit: 20, cursor: first.body.nextCursor }));
    expect(second.text).toBe(again.text);
    expect(ids(second.body.logs)[0]).not.toBe(ids(first.body.logs)[0]);
    expect((await read(await call(root, "get_daily_logs", token, { limit: 20 }))).text).toBe(first.text);
  });

  it("keeps pages within 64 KiB with complete records, and reports a record too large for any page", async () => {
    const root = await capturesDir();
    const big = (n: number, size: number) => log(n, `${n}:`.padEnd(size, "x"));
    const evidence = [big(1, 20_000), big(2, 20_000), big(3, 20_000), big(4, 70_000), big(5, 20_000), big(6, 100), http(1, "/feed", 200, { text: "y".repeat(70_000) })];
    await writeCapture(root, { evidence });
    const { token, capture } = await granted(root);

    const pages = await allPages(root, "get_daily_logs", token, { limit: 100 });
    for (const page of pages) expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(PAGE_BYTES);
    // Three 20 KB lines fill the first page. The 70 KB line could never fit,
    // so that page identifies it instead of shortening it, and paging goes on.
    expect(pages.map((page) => ids(page.body.logs as DailyApplicationLog[]))).toEqual([
      ["log-api-0001", "log-api-0002", "log-api-0003"],
      ["log-api-0005", "log-api-0006"],
    ]);
    const tooLarge = capture.logs[3];
    expect(pages.map((page) => page.body.oversized)).toEqual([
      [{ id: "log-api-0004", bytes: Buffer.byteLength(JSON.stringify(tooLarge)) }],
      [],
    ]);
    expect(pages.flatMap((page) => page.body.logs as DailyApplicationLog[])).toEqual(capture.logs.filter((record) => record !== tooLarge));

    const observations = await read(await call(root, "get_daily_http_observations", token));
    expect(observations.body).toMatchObject({ observations: [], oversized: [{ id: "http-0001" }], nextCursor: null });
  });

  it("binds a cursor to its capture, tool, and filters", async () => {
    const root = await capturesDir();
    await writeCapture(root, { evidence: manyLogs() });
    await writeCapture(root, { captureId: OTHER_ID, evidence: manyLogs() });
    const { token } = await granted(root);
    const other = await granted(root, OTHER_ID);
    const cursor = (await read(await call(root, "get_daily_logs", token, { limit: 5 }))).body.nextCursor as string;
    const httpCursor = (await read(await call(root, "get_daily_http_observations", token, { limit: 2 }))).body.nextCursor as string;

    const forged = (fields: object) => Buffer.from(JSON.stringify(fields)).toString("base64url");
    const binding = JSON.parse(Buffer.from(cursor, "base64url").toString()).binding;
    const refused: [DailyEvidenceTool, string, Query][] = [
      // Same record IDs exist in the other capture; its grant still refuses this cursor.
      ["get_daily_logs", other.token, { limit: 5, cursor }],
      ["get_daily_http_observations", token, { cursor }],
      ["get_daily_logs", token, { cursor: httpCursor }],
      ["get_daily_logs", token, { service: "daily-api", cursor }],
      ["get_daily_logs", token, { messageContains: "info", cursor }],
      ["get_daily_logs", token, { cursor: "abc" }],
      ["get_daily_logs", token, { cursor: forged({ v: 1, binding, after: "log-api-9999" }) }],
      ["get_daily_logs", token, { cursor: forged({ v: 2, binding, after: "log-api-0001" }) }],
    ];
    for (const [tool, credential, query] of refused) {
      const response = await read(await call(root, tool, credential, query));
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("invalid_cursor");
    }
    // A changed limit is fine: the cursor only fixes where the next page starts.
    expect((await read(await call(root, "get_daily_logs", token, { limit: 9, cursor }))).body.logs).toHaveLength(9);
  });

  it("serves each token only its own capture; no request input selects another", async () => {
    const root = await capturesDir();
    await writeCapture(root);
    await writeCapture(root, { captureId: OTHER_ID, evidence: [...incidentEvidence(), log(50, "ONLY_IN_THE_OTHER_CAPTURE")] });
    const { token } = await granted(root);
    const other = await granted(root, OTHER_ID);

    const own = await read(await call(root, "get_daily_logs", token, { limit: 100 }));
    expect(own.body.captureId).toBe(CLEAN_CAPTURE_ID);
    expect(own.text).not.toContain("ONLY_IN_THE_OTHER_CAPTURE");
    const theirs = await read(await call(root, "get_daily_logs", other.token, { messageContains: "ONLY_IN" }));
    expect(theirs.body).toMatchObject({ captureId: OTHER_ID, logs: [{ id: "log-api-0050" }] });
    const selected = await read(await call(root, "get_daily_logs", token, { captureId: OTHER_ID }));
    expect(selected).toMatchObject({ status: 400, body: { error: { code: "invalid_input" } } });
  });

  it("explains a granted capture that went missing, changed, or became unsafe to read", async () => {
    const root = await capturesDir();
    const dir = await writeCapture(root);
    const { token } = await granted(root);
    expect((await call(root, "get_daily_logs", token)).status).toBe(200);

    await writeCapture(root, { evidence: [...incidentEvidence(), log(7, "written after the grant")] });
    const changed = await read(await call(root, "get_daily_logs", token));
    expect(changed).toMatchObject({ status: 409, body: { error: { code: "capture_changed" } } });

    await rm(dir, { recursive: true });
    const elsewhere = await capturesDir();
    await writeCapture(elsewhere);
    await symlink(join(elsewhere, CLEAN_CAPTURE_ID), dir);
    const linked = await read(await call(root, "get_daily_http_observations", token));
    expect(linked).toMatchObject({ status: 422, body: { error: { code: "capture_invalid" } } });

    await rm(dir);
    const missing = await read(await call(root, "get_daily_logs", token));
    expect(missing).toMatchObject({ status: 404, body: { error: { code: "capture_missing" } } });
    for (const response of [changed, linked, missing]) {
      expect(response.text).not.toContain(root);
      expect(response.text).not.toContain(elsewhere);
    }
  });

  it("validates every query parameter against the shared contract", async () => {
    const root = await capturesDir();
    await writeCapture(root);
    const { token } = await granted(root);
    const invalid: [DailyEvidenceTool, string][] = [
      ["get_daily_logs", "limit=0"],
      ["get_daily_logs", "limit=101"],
      ["get_daily_logs", "limit=1.5"],
      ["get_daily_logs", "limit=ten"],
      ["get_daily_logs", "service=daily-db"],
      ["get_daily_logs", "messageContains="],
      ["get_daily_logs", `messageContains=${"a".repeat(201)}`],
      ["get_daily_logs", "service=daily-api&service=daily-gateway"],
      ["get_daily_logs", "path=/feed"],
      ["get_daily_logs", "cursor=not.base64url"],
      ["get_daily_http_observations", "limit=51"],
      ["get_daily_http_observations", "path=feed"],
      ["get_daily_http_observations", "service=daily-api"],
    ];
    for (const [tool, query] of invalid) {
      const url = `http://127.0.0.1:3000/api/tools/daily/x?${query}`;
      const response = await read(
        await dailyEvidenceResponse(new Request(url, { headers: { Authorization: `Bearer ${token}` } }), tool, { pool: () => pool, capturesDir: root }),
      );
      expect([query, response.status, response.body.error.code]).toEqual([query, 400, "invalid_input"]);
    }
    expect((await call(root, "get_daily_logs", token, { limit: 100 })).status).toBe(200);
    expect((await call(root, "get_daily_http_observations", token, { limit: 50 })).status).toBe(200);
  });

  it("never returns controller records, outcomes, file paths, or credentials", async () => {
    const root = await capturesDir();
    await writeCapture(root, { evidence: manyLogs() });
    const { token } = await granted(root);
    const texts = [
      ...(await allPages(root, "get_daily_logs", token)).map((page) => page.text),
      ...(await allPages(root, "get_daily_http_observations", token)).map((page) => page.text),
      (await read(await call(root, "get_daily_logs", token, { cursor: "abc" }))).text,
      (await read(await call(root, "get_daily_logs", "f".repeat(64)))).text,
    ].join("\n");
    for (const secret of [CONTROLLER_ONLY, '"ctl-', '"log-db-', "outageObserved", "stop-database", root, token])
      expect(texts).not.toContain(secret);
  });

  it("hides internal failures behind a generic error", async () => {
    const root = await capturesDir();
    const response = await read(
      await dailyEvidenceResponse(
        new Request("http://127.0.0.1:3000/api/tools/daily/get-logs", { headers: { Authorization: `Bearer ${"a".repeat(64)}` } }),
        "get_daily_logs",
        {
          pool: () => {
            throw new Error("connect ECONNREFUSED postgres://agent_lab:secret@127.0.0.1:55432");
          },
          capturesDir: root,
        },
      ),
    );
    expect(response).toMatchObject({ status: 500, body: { error: { code: "internal_error" } } });
    expect(response.text).not.toContain("secret");
  });
});
