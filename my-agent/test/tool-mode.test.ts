import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { labToolMode } from "../agent/lib/tool-mode";
import dailyCaptureTools from "../agent/tools/daily_capture";
import getLogsTool from "../agent/tools/get_logs";

// Calls the same session.started resolvers Eve runs, then the tools' execute
// callbacks, without a model. Eve's own build transform is checked by pnpm build:agent.

const captureId = "20261022T050138Z-39b307";
const evidenceSha256 = "b3021362880097f1c7acdfd7091f5cf59f0311408e68ff230bda697ebe2020e1";
const requests: IncomingMessage[] = [];
const server = createServer((request, response) => {
  requests.push(request);
  const path = new URL(request.url!, "http://127.0.0.1").pathname;
  response.setHeader("Content-Type", "application/json");
  if (path === "/api/tools/get-logs")
    return response.end(JSON.stringify({ logs: [{ id: "log-17", deploymentId: "B", level: "error", message: "Startup failed: DATABASE_URL is missing." }] }));
  const records = path.endsWith("get-logs") ? { logs: [] } : { observations: [] };
  response.end(JSON.stringify({ captureId, evidenceSha256, ...records, oversized: [], nextCursor: null }));
});
let baseUrl: string;

beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterEach(() => {
  vi.unstubAllEnvs();
  requests.length = 0;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

// The resolver's event and context are unused by these tools.
const resolve = (definition: typeof getLogsTool | typeof dailyCaptureTools) =>
  definition.events["session.started"]!({}, {} as never) as Promise<unknown> | unknown;
const toolContext = (signal = new AbortController().signal) => ({ abortSignal: signal }) as never;

interface Tool {
  description: string;
  execute: (input: unknown, ctx: never) => Promise<unknown>;
}

describe("tool selection by LAB_TOOL_MODE", () => {
  it("defaults to the simulated get_logs tool, unchanged", async () => {
    for (const mode of [undefined, "", "simulated"]) {
      if (mode !== undefined) vi.stubEnv("LAB_TOOL_MODE", mode);
      expect(labToolMode()).toBe("simulated");
      const tool = (await resolve(getLogsTool)) as Tool;
      expect(tool.description).toBe(
        "Read all saved logs for a simulated deployment in the configured Agent Lab trial. Returns info, warn, and error records in their recorded order.",
      );
      expect(await resolve(dailyCaptureTools)).toBeNull();
      vi.unstubAllEnvs();
    }
  });

  it("exposes exactly the two Daily tools in daily_capture mode, described as recorded observations", async () => {
    vi.stubEnv("LAB_TOOL_MODE", "daily_capture");
    expect(await resolve(getLogsTool)).toBeNull();
    const tools = (await resolve(dailyCaptureTools)) as Record<string, Tool>;
    expect(Object.keys(tools)).toEqual(["get_daily_logs", "get_daily_http_observations"]);
    for (const tool of Object.values(tools)) {
      expect(tool.description).toContain("during one recorded capture");
      expect(tool.description).toContain("not Daily's current health");
    }
  });

  it("fails closed on an unknown mode instead of guessing a tool set", async () => {
    vi.stubEnv("LAB_TOOL_MODE", "daily");
    expect(() => resolve(getLogsTool)).toThrow('LAB_TOOL_MODE must be "simulated" or "daily_capture", not "daily".');
    expect(() => resolve(dailyCaptureTools)).toThrow("LAB_TOOL_MODE");
  });
});

describe("tool execution", () => {
  it("runs the Daily tools with settings read when they execute, not when they are selected", async () => {
    vi.stubEnv("LAB_TOOL_MODE", "daily_capture");
    const tools = (await resolve(dailyCaptureTools)) as Record<string, Tool>;
    // Nothing secret existed at selection time, so nothing secret can be in the definitions.
    await expect(tools.get_daily_logs.execute({}, toolContext())).rejects.toThrow("Configure LAB_BASE_URL, LAB_DAILY_CAPTURE_TOKEN");

    vi.stubEnv("LAB_BASE_URL", baseUrl);
    vi.stubEnv("LAB_DAILY_CAPTURE_TOKEN", "capture-token-at-execution");
    vi.stubEnv("LAB_DAILY_CAPTURE_ID", captureId);
    vi.stubEnv("LAB_DAILY_EVIDENCE_SHA256", evidenceSha256);
    expect(await tools.get_daily_logs.execute({ messageContains: "PoolTimeout", limit: 5 }, toolContext())).toEqual({
      captureId,
      evidenceSha256,
      logs: [],
      oversized: [],
      nextCursor: null,
    });
    expect(await tools.get_daily_http_observations.execute({ path: "/feed" }, toolContext())).toMatchObject({ observations: [] });
    expect(requests.map((request) => [request.url, request.headers.authorization])).toEqual([
      ["/api/tools/daily/get-logs?messageContains=PoolTimeout&limit=5", "Bearer capture-token-at-execution"],
      ["/api/tools/daily/get-http-observations?path=%2Ffeed", "Bearer capture-token-at-execution"],
    ]);
    expect(JSON.stringify(tools)).not.toContain("capture-token-at-execution");

    // The agent's cancellation reaches the HTTP request.
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(tools.get_daily_logs.execute({}, toolContext(cancelled.signal))).rejects.toThrow("get_daily_logs was cancelled");
  });

  it("still runs the simulated get_logs tool with the trial settings", async () => {
    vi.stubEnv("LAB_BASE_URL", baseUrl);
    vi.stubEnv("LAB_TRIAL_TOKEN", "trial-token");
    const tool = (await resolve(getLogsTool)) as Tool;
    expect(await tool.execute({ deploymentId: "B" }, toolContext())).toEqual({
      logs: [{ id: "log-17", deploymentId: "B", level: "error", message: "Startup failed: DATABASE_URL is missing." }],
    });
    expect(requests.map((request) => request.headers.authorization)).toEqual(["Bearer trial-token"]);
  });
});
