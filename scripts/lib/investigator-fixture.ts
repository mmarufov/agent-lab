import { once } from "node:events";
import { cp, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { createPool } from "@agent-lab/lab/database";
import { dailyEvidenceResponse, type DailyEvidenceTool } from "@agent-lab/lab/daily-tools";
import { startInvestigator, type InvestigatorSettings } from "../../my-agent/client/investigate";

// Test-only. A copy of the real investigator (my-agent/agent and
// my-agent/prompts) whose agent.ts keeps every real setting but uses Eve's
// mockModel. Each model call is sent to this process, so a test sees exactly
// what Eve presents to the model and decides the reply. No provider is called.

/** What Eve presents to the model for one call, as mockModel reports it. */
export interface ModelCall {
  messages: { role: "assistant" | "system" | "tool" | "user"; text: string }[];
  userMessages: string[];
  tools: { name: string; description?: string; inputSchema?: unknown }[];
  toolResults: { id: string; name: string; output: unknown; isError: boolean }[];
}

/** A mockModel reply: text, tool calls (final_output carries a structured answer), and optional reported usage. */
export type ModelReply =
  | string
  | {
      text?: string;
      toolCalls?: { name: string; input?: unknown; id?: string }[];
      usage?: { inputTokens?: number; outputTokens?: number };
    };

const myAgent = fileURLToPath(new URL("../../my-agent/", import.meta.url));

const mockAgent = `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
import configured from "./lib/configured-agent";

// The real agent.ts settings; every model call is answered by the test process.
export default defineAgent({
  ...configured,
  // The mock is not in the AI Gateway catalog, so its context window is stated.
  modelContextWindowTokens: 128_000,
  model: mockModel({
    modelId: "model-double",
    provider: "agent-lab-test",
    async respond(request) {
      const response = await fetch(process.env.AGENT_LAB_MODEL_DOUBLE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw new Error("The model double answered HTTP " + response.status + ".");
      return response.json();
    },
  }),
});
`;

async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");
  return `http://127.0.0.1:${address.port}`;
}

async function freePort() {
  const probe = createNetServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");
  return address.port;
}

async function close(server: ReturnType<typeof createServer>) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

export async function createInvestigatorFixture() {
  const appDir = await mkdtemp(join(tmpdir(), "investigator-fixture-"));
  await cp(join(myAgent, "agent"), join(appDir, "agent"), { recursive: true });
  await cp(join(myAgent, "prompts"), join(appDir, "prompts"), { recursive: true });
  await rename(join(appDir, "agent/agent.ts"), join(appDir, "agent/lib/configured-agent.ts"));
  await writeFile(join(appDir, "agent/agent.ts"), mockAgent);
  await writeFile(
    join(appDir, "package.json"),
    JSON.stringify({ name: "investigator-fixture", private: true, type: "module", dependencies: { eve: "0.71.0" } }),
  );
  await symlink(join(myAgent, "node_modules"), join(appDir, "node_modules"));

  const calls: ModelCall[] = [];
  let respond: (call: ModelCall, index: number) => ModelReply | Promise<ModelReply> = () => "No reply was scripted.";
  const model = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const call = JSON.parse(body) as ModelCall;
    calls.push(call);
    try {
      const reply = await respond(call, calls.length - 1);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
    } catch (error) {
      response.writeHead(500).end(error instanceof Error ? error.message : "Model double failed.");
    }
  });
  const modelUrl = await listen(model);

  return {
    appDir,
    /** Every model call, in order. */
    calls,
    /** Set how the model replies to each call. */
    reply(next: typeof respond) {
      calls.length = 0;
      respond = next;
    },
    /** startInvestigator for the fixture app on a free port. */
    async start(settings: InvestigatorSettings, signal: AbortSignal) {
      return startInvestigator(settings, signal, {
        appDir,
        port: await freePort(),
        // With NODE_ENV=test, as under Vitest, Eve replaces every authored model
        // with its own built-in mock, which would ignore this fixture's replies.
        env: { AGENT_LAB_MODEL_DOUBLE_URL: modelUrl, NODE_ENV: undefined },
      });
    },
    async close() {
      await close(model);
      await rm(appDir, { recursive: true, force: true });
    },
  };
}

/**
 * The lab service's evidence routes: the real Daily handler over a test
 * captures directory, and a fixed simulated get_logs page. It records each
 * request, and `override` can answer a request instead.
 */
export async function startEvidenceService(options: { pool: ReturnType<typeof createPool>; capturesDir: string }) {
  const requests: { path: string; search: string; authorization: string | undefined }[] = [];
  let override: ((path: string) => Response | Promise<Response> | undefined) | undefined;
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    requests.push({ path: url.pathname, search: url.search, authorization: request.headers.authorization });
    const tool: Record<string, DailyEvidenceTool> = {
      "/api/tools/daily/get-logs": "get_daily_logs",
      "/api/tools/daily/get-http-observations": "get_daily_http_observations",
    };
    const answer =
      (await override?.(url.pathname)) ??
      (tool[url.pathname]
        ? await dailyEvidenceResponse(new Request(url, { headers: { authorization: request.headers.authorization ?? "" } }), tool[url.pathname], {
            pool: () => options.pool,
            capturesDir: options.capturesDir,
          })
        : url.pathname === "/api/tools/get-logs"
          ? Response.json({ logs: [{ id: "log-17", deploymentId: "B", level: "error", message: "Startup failed: DATABASE_URL is missing." }] })
          : Response.json({ error: { message: "Not found." } }, { status: 404 }));
    response.writeHead(answer.status, { "content-type": "application/json" }).end(await answer.text());
  });
  const baseUrl = await listen(server);
  return {
    baseUrl,
    requests,
    /** Answer requests with this function while it returns a response. */
    intercept(next: typeof override) {
      override = next;
    },
    close: () => close(server),
  };
}
