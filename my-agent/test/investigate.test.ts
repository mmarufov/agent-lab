import { once } from "node:events";
import { createServer } from "node:http";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import { investigate } from "../client/investigate";

const coordinates = { sequence: 1, stepIndex: 0, turnId: "turn-test" };
const usage = { inputTokens: 30, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };
const answer = { diagnosis: "The example logs indicate a startup failure.", evidenceIds: ["log-17"], uncertainty: "No later logs are available." };
let events: MessageStreamEvent[];
let requests: { path: string; body: unknown }[];
let holdStream: boolean;
let host: string;
function event(value: Omit<MessageStreamEvent, "meta">): MessageStreamEvent {
  return { ...value, meta: { id: crypto.randomUUID(), at: new Date().toISOString() } } as MessageStreamEvent;
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url!, "http://localhost").pathname;
  let body = "";
  for await (const chunk of request) body += chunk;
  requests.push({ path, body: body ? JSON.parse(body) : undefined });
  if (path.endsWith("/cancel")) {
    response.end(JSON.stringify({ status: "accepted", sessionId: "session-test" }));
  } else if (request.method === "POST") {
    response.end(JSON.stringify({ sessionId: "session-test" }));
  } else {
    response.writeHead(200, {
      "content-type": "application/x-ndjson",
      "x-eve-stream-version": "26",
    });
    response.flushHeaders();
    if (!holdStream) response.end(events.map((item) => JSON.stringify(item)).join("\n") + "\n");
  }
});

beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address.");
  host = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  requests = [];
  holdStream = false;
  events = [
    event({ type: "turn.started", data: coordinates }),
    event({ type: "actions.requested", data: { ...coordinates, actions: [
      { kind: "tool-call", toolName: "get_logs", callId: "call-1", input: { deploymentId: "B" } },
    ] } }),
    event({ type: "action.result", data: { ...coordinates, status: "completed", result: {
      kind: "tool-result", toolName: "get_logs", callId: "call-1", output: { logs: [
        { id: "log-17", deploymentId: "B", level: "error", message: "Example evidence." },
      ] },
    } } }),
    event({ type: "message.completed", data: { ...coordinates, finishReason: "stop", message: "Diagnosis supported by log-17." } }),
    event({ type: "result.completed", data: { ...coordinates, result: answer } }),
    event({ type: "turn.completed", data: coordinates }),
    event({ type: "session.waiting", data: { continuationToken: "session-test", wait: "next-user-message", usage } }),
  ];
});

it("sends only the investigation task and exposes the actual tool events, answer, and usage", async () => {
  const observed: MessageStreamEvent[] = [];
  const result = await investigate({ host, deploymentId: "B", signal: AbortSignal.timeout(3_000), onEvent: (item) => { observed.push(item); } });
  expect(requests[0]).toMatchObject({ path: "/eve/v1/session", body: {
    message: 'Investigate simulated deployment "B". Report your diagnosis, supporting log IDs, and uncertainty.',
    outputSchema: { type: "object", required: ["diagnosis", "evidenceIds", "uncertainty"] },
  } });
  expect(result).toMatchObject({ sessionId: "session-test", message: "Diagnosis supported by log-17.", answer, usage });
  expect(result.usage?.costUsd).toBeUndefined();
  expect(result.events).toEqual(events);
  expect(observed).toEqual(events);
  expect(requests.some((item) => item.path.endsWith("/cancel"))).toBe(false);
});

it("does not mistake pre-tool text for the final answer", async () => {
  events.splice(1, 0, event({ type: "message.completed", data: { ...coordinates, finishReason: "tool-calls", message: "I will read the logs." } }));
  const result = await investigate({ host, deploymentId: "B", signal: AbortSignal.timeout(3_000) });
  expect(result.message).toBe("Diagnosis supported by log-17.");
});

it.each(["turn.failed", "session.failed"] as const)("reports %s instead of treating a plausible partial answer as success", async (type) => {
  events.splice(5, 1, event({ type, data: { ...coordinates, sessionId: "session-test", code: "provider_error", message: "Provider unavailable." } }));
  await expect(investigate({ host, deploymentId: "B", signal: AbortSignal.timeout(3_000) })).rejects.toThrow("Provider unavailable.");
});

it("rejects a parked session that has no completed answer", async () => {
  events = [events[0], events[6]];
  await expect(investigate({ host, deploymentId: "B", signal: AbortSignal.timeout(3_000) })).rejects.toThrow("without a completed answer");
});

it("accepts a structured answer even when Eve produces no separate prose message", async () => {
  events = events.filter((item) => item.type !== "message.completed");
  const result = await investigate({ host, deploymentId: "B", signal: AbortSignal.timeout(3_000) });
  expect(result.answer).toEqual(answer);
});

it.each([undefined, { diagnosis: "Plausible answer", evidenceIds: "log-17", uncertainty: "Unknown" }])("rejects a missing or invalid structured answer: %j", async (payload) => {
  events = events.filter((item) => item.type !== "result.completed");
  if (payload) events.splice(4, 0, event({ type: "result.completed", data: { ...coordinates, result: payload } }));
  await expect(investigate({ host, deploymentId: "B", signal: AbortSignal.timeout(3_000) })).rejects.toThrow(/structured answer/);
});

it("waits for each event to be saved and cancels the session if saving fails", async () => {
  const saved: string[] = [];
  await expect(investigate({
    host, deploymentId: "B", signal: AbortSignal.timeout(3_000),
    onEvent: async (item) => {
      // A slow writer must finish before the next event is delivered.
      if (item.type === "action.result") {
        expect(saved).toEqual(["turn.started", "actions.requested"]);
        throw new Error("Database write failed.");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      saved.push(item.type);
    },
  })).rejects.toThrow("Database write failed.");
  expect(saved).toEqual(["turn.started", "actions.requested"]);
  expect(requests.some((item) => item.path.endsWith("/cancel"))).toBe(true);
});

it("requests server-side cancellation when the deadline expires during a stream", async () => {
  holdStream = true;
  await expect(investigate({ host, deploymentId: "B", signal: AbortSignal.timeout(100) })).rejects.toThrow();
  expect(requests.some((item) => item.path.endsWith("/cancel"))).toBe(true);
});

it("requests and validates v2 without including case names, fixtures, or expected values in the model request", async () => {
  const structured = { ...answer, outcome: { state: "failed", cause: "missing_configuration", configurationKey: "DATABASE_URL" } };
  events = events.map((item) => item.type === "result.completed" ? event({ type: "result.completed", data: { ...coordinates, result: structured } }) : item);
  const result = await investigate({ host, deploymentId: "B", resultSchemaVersion: 2, signal: AbortSignal.timeout(3_000) });
  expect(result.answer).toEqual(structured);
  expect(requests[0]).toMatchObject({ body: { outputSchema: { required: ["diagnosis", "evidenceIds", "uncertainty", "outcome"] } } });
  expect(JSON.stringify(requests[0].body)).not.toMatch(/DATABASE_URL|missing-config|healthy-startup|recovered-startup|no-logs|decisiveEvidenceIds|expected/);
});
it("rejects a legacy answer when the caller requires v2", async () => {
  await expect(investigate({ host, deploymentId: "B", resultSchemaVersion: 2, signal: AbortSignal.timeout(3_000) })).rejects.toThrow(/invalid structured answer/);
});
