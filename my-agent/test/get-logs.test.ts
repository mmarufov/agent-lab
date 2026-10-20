import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getLogs } from "../agent/lib/get-logs";

let respond: (request: IncomingMessage, response: ServerResponse) => void;
const server = createServer((request, response) => respond(request, response));
let baseUrl: string;
const trialToken = "test-trial-token";

async function listen(httpServer: ReturnType<typeof createServer>) {
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");
  return `http://127.0.0.1:${address.port}`;
}

async function close(httpServer: ReturnType<typeof createServer>) {
  httpServer.closeAllConnections();
  await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
}

beforeAll(async () => { baseUrl = await listen(server); });
beforeEach(() => {
  respond = (_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ logs: [] }));
  };
});
afterAll(() => close(server));

describe("getLogs HTTP client", () => {
  it("sends an encoded deployment ID and bearer token, then returns validated logs", async () => {
    const observed: { method?: string; path?: string; deploymentId?: string | null; authorization?: string } = {};
    respond = (request, response) => {
      const url = new URL(request.url!, baseUrl);
      Object.assign(observed, {
        method: request.method,
        path: url.pathname,
        deploymentId: url.searchParams.get("deploymentId"),
        authorization: request.headers.authorization,
      });
      response.end(JSON.stringify({ logs: [
        { id: "example-log", deploymentId: "B & C", level: "info", message: "An ordinary message." },
      ] }));
    };

    expect(await getLogs({ deploymentId: "B & C" }, { baseUrl, trialToken })).toEqual([
      { id: "example-log", deploymentId: "B & C", level: "info", message: "An ordinary message." },
    ]);
    expect(observed).toEqual({
      method: "GET", path: "/api/tools/get-logs", deploymentId: "B & C", authorization: `Bearer ${trialToken}`,
    });
  });

  it("accepts an empty list of logs", async () => {
    expect(await getLogs({ deploymentId: "C" }, { baseUrl, trialToken })).toEqual([]);
  });

  it.each([401, 404, 500])("reports HTTP %i even if its body is not JSON", async (status) => {
    respond = (_request, response) => { response.writeHead(status); response.end("Service error"); };
    await expect(getLogs({ deploymentId: "B" }, { baseUrl, trialToken })).rejects.toThrow(`HTTP ${status}`);
  });

  it("rejects malformed JSON", async () => {
    respond = (_request, response) => { response.end("{"); };
    await expect(getLogs({ deploymentId: "B" }, { baseUrl, trialToken })).rejects.toThrow("invalid JSON");
  });

  it.each([
    { logs: [{ id: "wrong-level", deploymentId: "B", level: "debug", message: "Not in our contract." }] },
    { logs: [{ id: "missing-message", deploymentId: "B", level: "info" }] },
    { logs: null },
  ])("rejects response data outside the shared log schema: %j", async (body) => {
    respond = (_request, response) => { response.end(JSON.stringify(body)); };
    await expect(getLogs({ deploymentId: "B" }, { baseUrl, trialToken })).rejects.toThrow("invalid log data");
  });

  it("rejects valid-looking logs for a different deployment", async () => {
    respond = (_request, response) => {
      response.end(JSON.stringify({ logs: [{ id: "other", deploymentId: "A", level: "info", message: "Wrong deployment." }] }));
    };
    await expect(getLogs({ deploymentId: "B" }, { baseUrl, trialToken })).rejects.toThrow("different deployment");
  });

  it("reports a stopped service clearly", async () => {
    const stoppedServer = createServer();
    const stoppedUrl = await listen(stoppedServer);
    await close(stoppedServer);
    await expect(getLogs({ deploymentId: "B" }, { baseUrl: stoppedUrl, trialToken })).rejects.toThrow("could not reach the lab service");
  });

  it.each(["before headers", "during the body"])("times out after five seconds %s", async (when) => {
    respond = (_request, response) => {
      if (when === "during the body") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"logs":');
      }
      // Keep the socket open. The client's deadline must actually cancel it.
    };
    const started = performance.now();
    await expect(getLogs({ deploymentId: "B" }, { baseUrl, trialToken })).rejects.toThrow("timed out after 5 seconds");
    expect(performance.now() - started).toBeGreaterThanOrEqual(4_900);
    expect(performance.now() - started).toBeLessThan(8_000);
  }, 10_000);

  it("rejects invalid input and missing runtime configuration before contacting the server", async () => {
    let requests = 0;
    respond = (_request, response) => { requests++; response.end('{"logs":[]}'); };
    await expect(getLogs({ deploymentId: "" }, { baseUrl, trialToken })).rejects.toThrow("deploymentId");
    await expect(getLogs({ deploymentId: "B" }, { baseUrl: "not-a-url", trialToken })).rejects.toThrow("LAB_BASE_URL");
    await expect(getLogs({ deploymentId: "B" }, { baseUrl, trialToken: "" })).rejects.toThrow("LAB_TRIAL_TOKEN");
    expect(requests).toBe(0);
  });
});
