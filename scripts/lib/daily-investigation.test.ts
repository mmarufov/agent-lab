import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAILY_ANSWER_SCHEMA_VERSION } from "@agent-lab/contracts/daily-investigation";
import { createPool } from "@agent-lab/lab/database";
import { describeDailyEvent } from "@agent-lab/lab/daily-trace";
import { acquireExecution } from "@agent-lab/lab/jobs";
import { migrate } from "@agent-lab/lab/migrate";
import { createRunStore } from "@agent-lab/lab/runs";
import { investigatorInstructions } from "../../my-agent/client/instructions";
import { dailyCaptureTask, type InvestigatorSettings } from "../../my-agent/client/investigate";
import {
  CLEAN_CAPTURE_ID,
  CONTROLLER_ONLY,
  capturesDir,
  fileHash,
  incidentEvidence,
  log,
  removeCaptureDirs,
  writeCapture,
} from "../../packages/lab/test/daily-capture-fixture";
import { runDailyInvestigation } from "./daily-investigation";
import { createInvestigatorFixture, startEvidenceService } from "./investigator-fixture";

// pnpm lab:daily-investigate's path with real PostgreSQL, the real evidence
// handler over synthetic captures, and a real `eve dev` of the investigator
// whose model is scripted by each test. No model provider is called.

const admin = createPool();
const schema = `daily_investigation_${randomUUID().replaceAll("-", "")}`;
const url = new URL(process.env.DATABASE_URL!);
url.searchParams.set("options", `-c search_path=${schema}`);
const pool = createPool(url.toString());
const runs = createRunStore(pool);
const OVERSIZED = "20261022T060000Z-0b5e55";
const INCOMPLETE = "20261022T070000Z-1c0de0";
const CHANGING = "20261022T080000Z-c4a4ed";
let dir: string;
let fixture: Awaited<ReturnType<typeof createInvestigatorFixture>>;
let service: Awaited<ReturnType<typeof startEvidenceService>>;

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  dir = await capturesDir();
  await writeCapture(dir);
  await writeCapture(dir, { captureId: CHANGING });
  await writeCapture(dir, { captureId: OVERSIZED, evidence: [...incidentEvidence(), log(7, "x".repeat(70_000))] });
  await writeCapture(dir, {
    captureId: INCOMPLETE,
    manifest: (manifest) => ({
      ...manifest,
      outcomes: { ...manifest.outcomes, evidenceComplete: { status: "failed", detail: "logs missing", at: null, elapsedMs: null } },
    }),
  });
  service = await startEvidenceService({ pool, capturesDir: dir });
  fixture = await createInvestigatorFixture();
}, 30_000);
afterAll(async () => {
  await fixture?.close();
  await service?.close();
  await removeCaptureDirs();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

/** runDailyInvestigation against the test service and fixture, remembering the token Eve was given. */
async function investigate(captureId: string, options: Parameters<typeof runDailyInvestigation>[2] = {}) {
  service.requests.length = 0;
  const seen = { token: "" };
  const saved = await runDailyInvestigation(pool, captureId, {
    baseUrl: service.baseUrl,
    capturesDir: dir,
    startEve: (settings, signal) => {
      if (settings.mode === "daily_capture") seen.token = settings.captureToken;
      return fixture.start(settings, signal);
    },
    ...options,
  });
  return { saved, token: seen.token };
}

const final = (input: unknown) => ({ toolCalls: [{ name: "final_output", input }] });
const count = async (table: string) => Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

function cli(...args: string[]) {
  const env = { ...process.env, DATABASE_URL: url.toString() };
  return new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, ["--import", "tsx", ...args], { env, timeout: 20_000 }, (error, stdout, stderr) =>
      resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}

async function lockIsFree() {
  const lease = await acquireExecution(pool);
  await lease.release();
  return true;
}

describe("a completed investigation", () => {
  it("saves its source, settings, every event, the answer, and a frozen evidence report, then reopens without Eve", async () => {
    const answer = {
      diagnosis: "Scripted: /feed failed with 500 while the logs show AdminShutdown.",
      evidenceIds: ["http-0005", "log-api-0003"],
      uncertainty: "Scripted uncertainty.",
    };
    fixture.reply((_call, index) =>
      index === 0
        ? { toolCalls: [{ name: "get_daily_http_observations", input: { path: "/feed" } }] }
        : index === 1
          ? { toolCalls: [{ name: "get_daily_logs", input: { messageContains: "adminshutdown", limit: 10 } }] }
          : final(answer),
    );
    const printed: string[] = [];
    const { saved, token } = await investigate(CLEAN_CAPTURE_ID, {
      onEvent: (event) => {
        printed.push(...describeDailyEvent(event));
      },
    });

    const instructions = await investigatorInstructions("daily_capture");
    expect(saved).toMatchObject({
      source: "daily_capture",
      captureId: CLEAN_CAPTURE_ID,
      status: "completed",
      task: dailyCaptureTask,
      instructions,
      instructionsHash: createHash("sha256").update(instructions).digest("hex"),
      agentConfigSource: await readFile(new URL("../../my-agent/agent/agent.ts", import.meta.url), "utf8"),
      resultSchemaVersion: DAILY_ANSWER_SCHEMA_VERSION,
      modelId: "agent-lab-test/model-double",
      answer,
      error: null,
      configuration: {
        toolMode: "daily_capture",
        tools: ["get_daily_logs", "get_daily_http_observations"],
        agent: {
          model: "openai/gpt-6-luna-fast",
          reasoning: "high",
          defaultTools: false,
          tool: false,
          limits: { maxInputTokensPerSession: 500_000, maxOutputTokensPerSession: 20_000, maxTokenCostUsdPerSession: 0.1 },
        },
        answerSchemaVersion: DAILY_ANSWER_SCHEMA_VERSION,
        deadlines: { investigationMs: 300_000, eveStartupMs: 60_000, toolRequestMs: 5_000 },
        evidenceService: service.baseUrl,
      },
    });
    const files = join(dir, CLEAN_CAPTURE_ID);
    expect(saved.captureSha256).toEqual({
      "manifest.json": fileHash(await readFile(join(files, "manifest.json"), "utf8")),
      "evidence.jsonl": fileHash(await readFile(join(files, "evidence.jsonl"), "utf8")),
      "controller.jsonl": fileHash(await readFile(join(files, "controller.jsonl"), "utf8")),
    });
    expect(saved.sessionId).toBeTruthy();
    expect(saved.usage).toMatchObject({ inputTokens: expect.any(Number), outputTokens: expect.any(Number) });
    expect(saved.grantRevokedAt).not.toBeNull();
    expect(saved.events.map((event) => event.type)).toEqual(expect.arrayContaining(["session.started", "actions.requested", "action.result", "result.completed", "session.waiting"]));

    expect(saved.evidenceReport).toMatchObject({
      evaluatorVersion: "daily-evidence-v1",
      checks: {
        execution: { status: "pass" },
        answer: { status: "pass" },
        toolTrace: { status: "pass" },
        retrieval: { status: "pass" },
        citations: { status: "pass" },
      },
      citedEvidenceIds: ["http-0005", "log-api-0003"],
      missingEvidenceIds: [],
      diagnosisAssessment: { status: "not_evaluated" },
    });
    expect(saved.evidenceReport!.retrievedEvidence.map((record) => record.id)).toEqual(["http-0002", "http-0005", "http-0009", "http-0010", "log-api-0003", "log-api-0004"]);

    // The readiness check used the grant, and its page never reached the model.
    expect(service.requests.map((request) => request.path + request.search)).toEqual([
      "/api/tools/daily/get-http-observations?limit=1",
      "/api/tools/daily/get-http-observations?path=%2Ffeed",
      "/api/tools/daily/get-logs?messageContains=adminshutdown&limit=10",
    ]);
    expect(fixture.calls[0].toolResults).toEqual([]);
    expect(JSON.stringify(fixture.calls)).not.toContain("http-0001");

    // The token reached Eve's tools only: not the model, the record, or the terminal.
    expect(service.requests[0].authorization).toBe(`Bearer ${token}`);
    for (const shown of [JSON.stringify(fixture.calls), JSON.stringify(saved), printed.join("\n")]) {
      expect(shown).not.toContain(token);
      expect(shown).not.toContain(CONTROLLER_ONLY);
    }
    expect(await lockIsFree()).toBe(true);

    // Reopen in fresh processes: only PostgreSQL, no Eve or model.
    const calls = fixture.calls.length;
    const json = await cli("packages/lab/src/cli.ts", "run", saved.id, "--json");
    expect(json).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(json.stdout)).toEqual(await runs.getDaily(saved.id));
    // PostgreSQL's jsonb reorders object keys; the reopened trace must still read identically.
    const text = await cli("packages/lab/src/cli.ts", "run", saved.id);
    expect(printed).toContain('Tool request get_daily_logs {"limit":10,"messageContains":"adminshutdown"}');
    for (const line of printed) expect(text.stdout).toContain(line);
    const evaluation = await cli("packages/lab/src/cli.ts", "evaluate", saved.id, "--json");
    expect(evaluation.code).toBe(0);
    expect(JSON.parse(evaluation.stdout)).toEqual({ ...saved.evidenceReport, frozen: true, integrity: saved.integrity });
    // The runner's finish sealed the run in the same commit as its final status.
    expect(saved.integrity).toMatchObject({ status: "verified", fingerprint: { version: 1, origin: "finalization", eventCount: saved.events.length } });
    expect(text.stdout).toContain(`Integrity: verified (fingerprint v1 of ${saved.events.length} event(s), saved when the run finished`);
    expect(fixture.calls).toHaveLength(calls);
  }, 90_000);

  it("freezes failing citations: an invented ID and an ID listed only as oversized", async () => {
    fixture.reply((_call, index) =>
      index === 0
        ? { toolCalls: [{ name: "get_daily_logs", input: {} }] }
        : final({ diagnosis: "Scripted.", evidenceIds: ["log-api-0001", "log-api-0007", "log-api-9999"], uncertainty: "Scripted." }),
    );
    const { saved } = await investigate(OVERSIZED);
    expect(saved.status).toBe("completed");
    expect(saved.evidenceReport).toMatchObject({
      checks: { retrieval: { status: "pass" }, citations: { status: "fail" } },
      missingEvidenceIds: ["log-api-0007", "log-api-9999"],
      oversizedOnlyEvidenceIds: ["log-api-0007"],
    });
    expect(saved.evidenceReport!.checks.citations.reason).toContain("listed only as oversized");
    const evaluation = await cli("packages/lab/src/cli.ts", "evaluate", saved.id);
    expect(evaluation.code).toBe(1);
    expect(evaluation.stdout).toContain("FAIL citations");
  }, 90_000);

  it("leaves an empty citation list unassessed rather than evidence-backed", async () => {
    fixture.reply((_call, index) =>
      index === 0
        ? { toolCalls: [{ name: "get_daily_http_observations", input: { limit: 3 } }] }
        : final({ diagnosis: "Scripted.", evidenceIds: [], uncertainty: "Scripted." }),
    );
    const { saved } = await investigate(CLEAN_CAPTURE_ID);
    expect(saved.evidenceReport?.checks.citations).toEqual({
      status: "not_evaluated",
      reason: "No evidence IDs were cited; this does not establish that the diagnosis is supported.",
    });
  }, 90_000);

  it("records a failed tool call without counting it as evidence", async () => {
    let requests = 0;
    service.intercept((path) =>
      path.startsWith("/api/tools/daily/") && ++requests === 3 ? Response.json({ error: { code: "internal_error", message: "Scripted failure." } }, { status: 500 }) : undefined,
    );
    fixture.reply((call, index) =>
      index === 0
        ? { toolCalls: [{ name: "get_daily_http_observations", input: { limit: 2 } }] }
        : index === 1
          ? { toolCalls: [{ name: "get_daily_logs", input: { limit: 2 } }] }
          : final({ diagnosis: "Scripted.", evidenceIds: ["http-0001", "log-api-0001"], uncertainty: String(call.toolResults[1].output) }),
    );
    try {
      const { saved } = await investigate(CLEAN_CAPTURE_ID);
      expect(saved.status).toBe("completed");
      // The failure reached the model as a tool error and is saved as a failed result.
      expect(saved.answer?.uncertainty).toContain("HTTP 500");
      const failed = saved.events.find((event) => event.type === "action.result" && (event.data as { status: string }).status === "failed");
      expect(failed).toBeTruthy();
      expect(saved.evidenceReport).toMatchObject({
        checks: { toolTrace: { status: "pass" }, retrieval: { status: "pass" }, citations: { status: "fail" } },
        missingEvidenceIds: ["log-api-0001"],
      });
      expect(saved.evidenceReport!.checks.retrieval.reason).toContain("1 call(s) failed");
    } finally {
      service.intercept(undefined);
    }
  }, 90_000);
});

describe("recordings that cannot be investigated", () => {
  it("refuses an invalid, missing, or incomplete capture before saving a run, granting access, or starting Eve", async () => {
    const before = { runs: await count("lab_investigation_runs"), grants: await count("lab_capture_access_grants") };
    fixture.reply(() => final({ diagnosis: "Unreachable.", evidenceIds: [], uncertainty: "Unreachable." }));
    await expect(investigate("../20261022T050138Z-39b307")).rejects.toThrow("A capture is selected by an ID like");
    await expect(investigate("20991231T000000Z-000000")).rejects.toThrow("is not in the captures directory");
    await expect(investigate(INCOMPLETE)).rejects.toThrow("its logs and observations were not all collected");
    expect({ runs: await count("lab_investigation_runs"), grants: await count("lab_capture_access_grants") }).toEqual(before);
    expect(fixture.calls).toHaveLength(0);
    expect(await lockIsFree()).toBe(true);
  }, 30_000);

  it("fails before Eve starts when a pinned file changes after access was granted", async () => {
    fixture.reply(() => final({ diagnosis: "Unreachable.", evidenceIds: [], uncertainty: "Unreachable." }));
    const { saved } = await investigate(CHANGING, {
      onCreated: () => appendFile(join(dir, CHANGING, "evidence.jsonl"), "\n"),
    });
    expect(saved).toMatchObject({ status: "failed", sessionId: null, events: [], answer: null });
    expect(saved.error).toContain("capture_changed");
    expect(saved.error).toContain("run pnpm dev from this checkout");
    expect(saved.grantRevokedAt).not.toBeNull();
    expect(saved.evidenceReport?.checks.execution.status).toBe("fail");
    expect(fixture.calls).toHaveLength(0);
  }, 30_000);

  it("fails before Eve starts when the evidence service is unreachable or reads another captures directory", async () => {
    fixture.reply(() => final({ diagnosis: "Unreachable.", evidenceIds: [], uncertainty: "Unreachable." }));
    const closed = createServer();
    closed.listen(0, "127.0.0.1");
    await once(closed, "listening");
    const { port } = closed.address() as { port: number };
    await new Promise((resolve) => closed.close(resolve));
    const unreachable = await investigate(CLEAN_CAPTURE_ID, { baseUrl: `http://127.0.0.1:${port}` });
    expect(unreachable.saved).toMatchObject({ status: "failed", sessionId: null });
    expect(unreachable.saved.error).toContain("could not reach the lab service");

    const elsewhere = await startEvidenceService({ pool, capturesDir: await capturesDir() });
    try {
      const { saved } = await investigate(CLEAN_CAPTURE_ID, { baseUrl: elsewhere.baseUrl });
      expect(saved.status).toBe("failed");
      expect(saved.error).toContain("capture_missing");
      expect(saved.error).toContain("reads captures from its own working directory");
    } finally {
      await elsewhere.close();
    }
    expect(fixture.calls).toHaveLength(0);
  }, 30_000);
});

describe("an interrupted investigation", () => {
  it("cancels the Eve session, saves the partial run before cleanup, and revokes the grant", async () => {
    const controller = new AbortController();
    fixture.reply((_call, index) =>
      index === 0 ? { toolCalls: [{ name: "get_daily_logs", input: { limit: 2 } }] } : new Promise(() => undefined),
    );
    const { saved } = await investigate(CLEAN_CAPTURE_ID, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "action.result") controller.abort();
      },
    });
    expect(saved).toMatchObject({ status: "cancelled", error: "Investigation cancelled.", answer: null });
    // Events Eve had already sent are saved too; no answer was ever recorded.
    expect(saved.events.map((event) => event.type)).toContain("action.result");
    expect(saved.events.map((event) => event.type)).not.toContain("result.completed");
    expect(saved.grantRevokedAt).not.toBeNull();
    // The page it received before the cancellation still counts as retrieved.
    expect(saved.evidenceReport?.checks).toMatchObject({ execution: { status: "fail" }, retrieval: { status: "pass" }, citations: { status: "not_evaluated" } });
    expect(await lockIsFree()).toBe(true);
  }, 90_000);

  it("fails at its deadline with the evidence saved so far", async () => {
    fixture.reply((_call, index) =>
      index === 0 ? { toolCalls: [{ name: "get_daily_logs", input: { limit: 1 } }] } : new Promise(() => undefined),
    );
    const { saved } = await investigate(CLEAN_CAPTURE_ID, { timeoutMs: 8_000 });
    expect(saved).toMatchObject({ status: "failed", error: "Investigation exceeded its 8-second limit." });
    expect(saved.events.some((event) => event.type === "action.result")).toBe(true);
    expect(saved.grantRevokedAt).not.toBeNull();
  }, 90_000);

  it("fails when Eve stops at a usage limit, without approving more usage", async () => {
    fixture.reply(() => ({ toolCalls: [{ name: "get_daily_logs", input: { limit: 1 } }], usage: { inputTokens: 600_000 } }));
    const { saved } = await investigate(CLEAN_CAPTURE_ID);
    expect(saved.status).toBe("failed");
    expect(saved.error).toContain("session usage limit, and more usage was not approved");
    expect(saved.events.some((event) => event.type === "input.requested")).toBe(true);
    expect(fixture.calls).toHaveLength(1);
  }, 90_000);
});

/** An Eve stand-in that streams fixed events, for event-stream faults real Eve does not produce. */
async function fakeEve(events: (grant: { captureId: string; evidenceSha256: string }) => object[]) {
  const cancels: string[] = [];
  let source = { captureId: "", evidenceSha256: "" };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://127.0.0.1").pathname;
    for await (const chunk of request) void chunk;
    if (path.endsWith("/cancel")) {
      cancels.push(path);
      return response.end(JSON.stringify({ status: "accepted", sessionId: "session-fake" }));
    }
    if (request.method === "POST") return response.end(JSON.stringify({ sessionId: "session-fake" }));
    response.writeHead(200, { "content-type": "application/x-ndjson", "x-eve-stream-version": "26" });
    response.end(events(source).map((event) => JSON.stringify(event)).join("\n") + "\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  return {
    cancels,
    startEve: async (settings: InvestigatorSettings) => {
      if (settings.mode === "daily_capture") source = { captureId: settings.captureId, evidenceSha256: settings.evidenceSha256 };
      return { host: `http://127.0.0.1:${port}`, stop: async () => undefined };
    },
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

const at = "2026-10-30T00:00:00.000Z";
const turn = { turnId: "turn_0", sequence: 0, stepIndex: 0 };
const event = (type: string, id: string, data: object) => ({ type, meta: { id, at }, data });
const request = event("actions.requested", "event-request", {
  ...turn,
  actions: [{ kind: "tool-call", toolName: "get_daily_logs", callId: "call-1", input: { limit: 1 } }],
});
const result = (source: { captureId: string; evidenceSha256: string }) =>
  event("action.result", "event-result", {
    ...turn,
    status: "completed",
    result: { kind: "tool-result", toolName: "get_daily_logs", callId: "call-1", output: { ...source, logs: [log(1, 'INFO:     172.21.0.4:1 - "GET /healthz HTTP/1.1" 200 OK')], oversized: [], nextCursor: null } },
  });

describe("event-stream faults", () => {
  it("saves a repeated event once, and fails the run when the structured answer is invalid", async () => {
    const eve = await fakeEve((source) => [
      event("turn.started", "event-turn", turn),
      request,
      result(source),
      result(source),
      event("result.completed", "event-answer", { ...turn, result: { diagnosis: "Plausible.", evidenceIds: "log-api-0001", uncertainty: "None." } }),
      event("turn.completed", "event-done", turn),
      event("session.waiting", "event-wait", { wait: "next-user-message", usage: { inputTokens: 10, outputTokens: 2 } }),
    ]);
    try {
      const { saved } = await investigate(CLEAN_CAPTURE_ID, { startEve: eve.startEve });
      expect(saved).toMatchObject({ status: "failed", error: "Eve returned an invalid structured answer.", answer: null });
      expect(saved.events.map((item) => item.meta.id)).toEqual(["event-turn", "event-request", "event-result", "event-answer"]);
      expect(eve.cancels).toEqual(["/eve/v1/session/session-fake/cancel"]);
      expect(saved.evidenceReport?.checks.toolTrace.status).toBe("pass");
    } finally {
      await eve.close();
    }
  }, 30_000);

  it("fails the run instead of replacing evidence when an event ID returns with different contents", async () => {
    const eve = await fakeEve((source) => [request, result(source), { ...result(source), data: { ...turn, status: "failed", error: { code: "X", message: "Changed." } } }]);
    try {
      const { saved } = await investigate(CLEAN_CAPTURE_ID, { startEve: eve.startEve });
      expect(saved).toMatchObject({ status: "failed", error: "Event ID was replayed with a different payload." });
      expect(saved.events.map((item) => item.meta.id)).toEqual(["event-request", "event-result"]);
    } finally {
      await eve.close();
    }
  }, 30_000);
});

describe("pnpm lab:daily-investigate", () => {
  it("validates its one argument and refuses a missing capture before any model work", async () => {
    const usage = await cli("scripts/lab-daily-investigate.ts", "latest");
    expect(usage).toMatchObject({ code: 1 });
    expect(usage.stderr).toContain("Usage: pnpm lab:daily-investigate <capture-id>");
    const missing = await cli("scripts/lab-daily-investigate.ts", "20991231T000000Z-000000");
    expect(missing).toMatchObject({ code: 1, stdout: "" });
    expect(missing.stderr).toContain("Capture 20991231T000000Z-000000 is not in the captures directory.");
  }, 30_000);
});
