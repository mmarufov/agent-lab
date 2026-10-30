import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dailyEvidenceConfig, getDailyHttpObservations, getDailyLogs, type DailyEvidenceConfig } from "../agent/lib/daily-evidence";

let respond: (request: IncomingMessage, response: ServerResponse) => void;
const server = createServer((request, response) => respond(request, response));
let baseUrl: string;
const captureId = "20261022T050138Z-39b307";
const evidenceSha256 = "b3021362880097f1c7acdfd7091f5cf59f0311408e68ff230bda697ebe2020e1";
const token = "test-capture-token";
const config = (): DailyEvidenceConfig => ({ baseUrl, token, captureId, evidenceSha256 });

const line = (n: number, message: string, service: "daily-api" | "daily-gateway" = "daily-api") => ({
  kind: "log",
  id: `log-${service === "daily-api" ? "api" : "gateway"}-${String(n).padStart(4, "0")}`,
  service,
  stream: "stderr",
  timestamp: "2026-10-22T05:01:41.255956884Z",
  message,
});
const timeout = {
  kind: "http",
  id: "http-0012",
  method: "GET",
  path: "/readyz",
  authenticated: false,
  startedAt: "2026-10-22T05:01:43.283Z",
  endedAt: "2026-10-22T05:01:48.286Z",
  elapsedMs: 5002.8,
  deadlineMs: 5000,
  outcome: "timeout",
};
const logsPage = (logs: unknown[], extra: object = {}) => ({ captureId, evidenceSha256, logs, oversized: [], nextCursor: null, ...extra });
const send = (body: unknown, status = 200) => (_request: IncomingMessage, response: ServerResponse) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
};

async function listen(httpServer: ReturnType<typeof createServer>) {
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");
  return `http://127.0.0.1:${address.port}`;
}

async function close(httpServer: ReturnType<typeof createServer>) {
  httpServer.closeAllConnections();
  await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
}

beforeAll(async () => {
  baseUrl = await listen(server);
});
beforeEach(() => {
  respond = send(logsPage([]));
});
afterAll(() => close(server));

describe("Daily evidence HTTP clients", () => {
  it("send filters and the bearer token, then return the validated page and its source identity", async () => {
    const observed: { path?: string; query?: Record<string, string>; authorization?: string }[] = [];
    const returned = logsPage([line(11, "ERROR app.main: Unhandled error on GET /feed")], { nextCursor: "eyJ2IjoxfQ" });
    respond = (request, response) => {
      const url = new URL(request.url!, baseUrl);
      observed.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: request.headers.authorization });
      send(url.pathname.endsWith("get-logs") ? returned : { captureId, evidenceSha256, observations: [timeout], oversized: [], nextCursor: null })(request, response);
    };

    expect(await getDailyLogs({ service: "daily-api", messageContains: "unhandled ERROR on get /feed", cursor: "abc_-1", limit: 25 }, config())).toEqual(returned);
    expect(await getDailyHttpObservations({ path: "/readyz" }, config())).toEqual({
      captureId,
      evidenceSha256,
      observations: [timeout],
      oversized: [],
      nextCursor: null,
    });
    expect(observed).toEqual([
      {
        path: "/api/tools/daily/get-logs",
        query: { service: "daily-api", messageContains: "unhandled ERROR on get /feed", cursor: "abc_-1", limit: "25" },
        authorization: `Bearer ${token}`,
      },
      { path: "/api/tools/daily/get-http-observations", query: { path: "/readyz" }, authorization: `Bearer ${token}` },
    ]);
  });

  it("accept an empty page", async () => {
    expect(await getDailyLogs({ messageContains: "nothing" }, config())).toEqual(logsPage([]));
  });

  it("refuse records from any capture or evidence file other than the configured one", async () => {
    respond = send(logsPage([line(1, "x")], { captureId: "20261022T045819Z-89a170" }));
    await expect(getDailyLogs({}, config())).rejects.toThrow("received records from capture 20261022T045819Z-89a170");
    respond = send(logsPage([line(1, "x")], { evidenceSha256: "0".repeat(64) }));
    await expect(getDailyLogs({}, config())).rejects.toThrow("not the configured 20261022T050138Z-39b307");
  });

  it("refuse records that do not match the requested filters", async () => {
    respond = send(logsPage([line(1, "gateway line", "daily-gateway")]));
    await expect(getDailyLogs({ service: "daily-api" }, config())).rejects.toThrow("do not match the requested filters");
    respond = send(logsPage([line(1, "INFO: healthy")]));
    await expect(getDailyLogs({ messageContains: "timeout" }, config())).rejects.toThrow("do not match the requested filters");
    // Matching ignores letter case, as the service's does.
    expect((await getDailyLogs({ messageContains: "HEALTHY" }, config())).logs).toHaveLength(1);
    respond = send({ captureId, evidenceSha256, observations: [timeout], oversized: [], nextCursor: null });
    await expect(getDailyHttpObservations({ path: "/feed" }, config())).rejects.toThrow("different path");
  });

  it("refuse malformed responses", async () => {
    for (const body of ["{", "[]", JSON.stringify({ captureId, evidenceSha256, logs: [] }), JSON.stringify(logsPage([{ ...line(1, "x"), service: "daily-db" }]))]) {
      respond = send(body);
      await expect(getDailyLogs({}, config())).rejects.toThrow(/invalid (JSON|evidence)/);
    }
  });

  it("report the service's explanation of an HTTP error", async () => {
    respond = send({ error: { code: "capture_changed", message: `Capture ${captureId}: evidence.jsonl changed after access was granted.` } }, 409);
    await expect(getDailyLogs({}, config())).rejects.toThrow(
      `get_daily_logs received HTTP 409 from the lab service (capture_changed: Capture ${captureId}: evidence.jsonl changed after access was granted.)`,
    );
    respond = send({ error: { code: "unauthorized", message: "This capture access grant was revoked." } }, 401);
    await expect(getDailyHttpObservations({}, config())).rejects.toThrow("HTTP 401 from the lab service (unauthorized: This capture access grant was revoked.)");
    respond = send({ error: { message: "The local workbench is not available on this host." } }, 403);
    await expect(getDailyLogs({}, config())).rejects.toThrow("HTTP 403 from the lab service (The local workbench is not available on this host.)");
    respond = send("<html>Internal Server Error</html>", 500);
    await expect(getDailyLogs({}, config())).rejects.toThrow("HTTP 500 from the lab service with no readable error");
  });

  it("reject invalid input and runtime configuration before contacting the service", async () => {
    let requests = 0;
    respond = (request, response) => {
      requests++;
      send(logsPage([]))(request, response);
    };
    await expect(getDailyLogs({ limit: 101 }, config())).rejects.toThrow("get_daily_logs: limit");
    await expect(getDailyLogs({ captureId } as never, config())).rejects.toThrow("get_daily_logs:");
    await expect(getDailyHttpObservations({ limit: 51 }, config())).rejects.toThrow("get_daily_http_observations: limit");
    await expect(getDailyHttpObservations({ path: "feed" }, config())).rejects.toThrow("get_daily_http_observations: path");
    await expect(getDailyLogs({}, { ...config(), token: " " })).rejects.toThrow("LAB_DAILY_CAPTURE_TOKEN");
    await expect(getDailyLogs({}, { ...config(), captureId: "latest" })).rejects.toThrow("LAB_DAILY_CAPTURE_ID");
    await expect(getDailyLogs({}, { ...config(), evidenceSha256: "abc" })).rejects.toThrow("LAB_DAILY_EVIDENCE_SHA256");
    await expect(getDailyLogs({}, { ...config(), baseUrl: "file:///etc" })).rejects.toThrow("LAB_BASE_URL");
    expect(requests).toBe(0);
  });

  it("report a stopped service clearly", async () => {
    const stopped = createServer();
    const stoppedUrl = await listen(stopped);
    await close(stopped);
    await expect(getDailyLogs({}, { ...config(), baseUrl: stoppedUrl })).rejects.toThrow("get_daily_logs could not reach the lab service");
  });

  it.each(["before headers", "during the body"])(
    "time out after five seconds %s",
    async (when) => {
      respond = (_request, response) => {
        if (when === "during the body") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.write('{"captureId":');
        }
        // Keep the socket open. The client's deadline must actually cancel it.
      };
      const started = performance.now();
      await expect(getDailyHttpObservations({}, config())).rejects.toThrow("get_daily_http_observations timed out after 5 seconds");
      expect(performance.now() - started).toBeGreaterThanOrEqual(4_900);
      expect(performance.now() - started).toBeLessThan(8_000);
    },
    10_000,
  );

  it("stop when the caller cancels", async () => {
    respond = () => {
      // Never answers; only the cancellation can end this request.
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = performance.now();
    await expect(getDailyLogs({}, { ...config(), signal: controller.signal })).rejects.toThrow("get_daily_logs was cancelled");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("read their settings from the runtime environment", () => {
    const env = {
      LAB_BASE_URL: "http://127.0.0.1:3000",
      LAB_DAILY_CAPTURE_TOKEN: token,
      LAB_DAILY_CAPTURE_ID: captureId,
      LAB_DAILY_EVIDENCE_SHA256: evidenceSha256,
    };
    expect(dailyEvidenceConfig(env)).toEqual({ baseUrl: env.LAB_BASE_URL, token, captureId, evidenceSha256, signal: undefined });
    expect(() => dailyEvidenceConfig({ ...env, LAB_DAILY_CAPTURE_TOKEN: "" })).toThrow(
      "Configure LAB_BASE_URL, LAB_DAILY_CAPTURE_TOKEN, LAB_DAILY_CAPTURE_ID, and LAB_DAILY_EVIDENCE_SHA256",
    );
  });
});
