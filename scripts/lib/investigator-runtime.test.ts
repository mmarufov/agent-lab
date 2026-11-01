import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { investigationAnswerV1Schema } from "@agent-lab/contracts";
import { dailyInvestigationAnswerSchema } from "@agent-lab/contracts/daily-investigation";
import { createCaptureAccess } from "@agent-lab/lab/capture-access";
import { createPool } from "@agent-lab/lab/database";
import { migrate } from "@agent-lab/lab/migrate";
import { evidenceTools } from "../../my-agent/agent/lib/tool-mode";
import { investigatorInstructions } from "../../my-agent/client/instructions";
import {
  dailyCaptureTask,
  investigationTask,
  runInvestigatorSession,
  type InvestigatorSettings,
  type MessageStreamEvent,
} from "../../my-agent/client/investigate";
import { CLEAN_CAPTURE_ID, CONTROLLER_ONLY, capturesDir, removeCaptureDirs, writeCapture } from "../../packages/lab/test/daily-capture-fixture";
import { createInvestigatorFixture, startEvidenceService, type ModelCall } from "./investigator-fixture";

// The real investigator files, compiled and run by `eve dev`, with Eve's
// mockModel in place of the provider model. Each test sees exactly what Eve
// presents to the model: its instructions, tools, and the tool results.

const admin = createPool();
const schema = `investigator_runtime_${randomUUID().replaceAll("-", "")}`;
const url = new URL(process.env.DATABASE_URL!);
url.searchParams.set("options", `-c search_path=${schema}`);
const pool = createPool(url.toString());
let fixture: Awaited<ReturnType<typeof createInvestigatorFixture>>;
let service: Awaited<ReturnType<typeof startEvidenceService>>;
let daily: InvestigatorSettings & { mode: "daily_capture" };

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  const dir = await capturesDir();
  await writeCapture(dir);
  const { token, grant } = await createCaptureAccess(pool, dir).grant(CLEAN_CAPTURE_ID);
  service = await startEvidenceService({ pool, capturesDir: dir });
  daily = { mode: "daily_capture", baseUrl: service.baseUrl, captureToken: token, captureId: grant.captureId, evidenceSha256: grant.sha256["evidence.jsonl"] };
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

const names = (call: ModelCall) => call.tools.map((tool) => tool.name);
const system = (call: ModelCall) => call.messages.filter((message) => message.role === "system").map((message) => message.text);

async function session(settings: InvestigatorSettings, task: string, answerSchema: typeof dailyInvestigationAnswerSchema) {
  service.requests.length = 0;
  const eve = await fixture.start(settings, AbortSignal.timeout(60_000));
  const events: MessageStreamEvent[] = [];
  try {
    const result = await runInvestigatorSession({
      host: eve.host,
      task,
      answerSchema,
      signal: AbortSignal.timeout(30_000),
      onEvent: (event) => {
        events.push(event);
      },
    }).catch((error: unknown) => error as Error);
    return { result, events };
  } finally {
    await eve.stop();
  }
}

describe("daily_capture mode", () => {
  it("presents only the Daily evidence tools and instructions, follows the model's paging, and blocks every other tool", async () => {
    const answer = { diagnosis: "Scripted diagnosis.", evidenceIds: ["log-api-0002", "log-api-0003"], uncertainty: "Scripted uncertainty." };
    fixture.reply((call, index) => {
      if (index === 0) return { toolCalls: [{ name: "get_daily_logs", input: { limit: 2 } }] };
      if (index === 1) {
        const { nextCursor } = call.toolResults[0].output as { nextCursor: string };
        return { toolCalls: [{ name: "get_daily_logs", input: { limit: 2, cursor: nextCursor } }] };
      }
      if (index === 2)
        return {
          toolCalls: [
            { name: "bash", input: { command: "env" } },
            { name: "get_logs", input: { deploymentId: "B" } },
            { name: "web_fetch", input: { url: "http://127.0.0.1:8081/feed" } },
            { name: "agent", input: { message: "Investigate for me." } },
          ],
        };
      return { toolCalls: [{ name: "final_output", input: answer }] };
    });
    const { result, events } = await session(daily, dailyCaptureTask, dailyInvestigationAnswerSchema);
    expect(result).toMatchObject({ answer });

    // What the model was shown on every call.
    const instructions = await investigatorInstructions("daily_capture");
    expect(fixture.calls).toHaveLength(4);
    for (const call of fixture.calls) {
      expect(names(call)).toEqual([...evidenceTools.daily_capture, "final_output"]);
      expect(system(call)).toEqual([instructions.trimEnd()]);
      expect(call.userMessages).toEqual([dailyCaptureTask]);
    }
    expect(fixture.calls[0].tools[0].description).toContain("one recorded capture");

    // Paging: the second page starts after the first, through the real service.
    const pages = fixture.calls[2].toolResults.map((result) => (result.output as { logs: { id: string }[] }).logs.map((log) => log.id));
    expect(pages).toEqual([
      ["log-api-0001", "log-api-0002"],
      ["log-api-0003", "log-api-0004"],
    ]);
    expect(service.requests.map((request) => request.path)).toEqual(["/api/tools/daily/get-logs", "/api/tools/daily/get-logs"]);
    expect(service.requests[1].search).toContain("cursor=");
    expect(service.requests.every((request) => request.authorization === `Bearer ${daily.captureToken}`)).toBe(true);

    // Unavailable tools never ran: each returned an error to the model, and none reached a service.
    const blocked = fixture.calls[3].toolResults.slice(2);
    expect(blocked.map(({ name, isError }) => ({ name, isError }))).toEqual(
      ["bash", "get_logs", "web_fetch", "agent"].map((name) => ({ name, isError: true })),
    );
    for (const { output } of blocked) expect(String(output)).toContain("unavailable tool");
    // Eve emits no event for a call to a tool it does not offer, so the saved trace cannot show these attempts.
    const requested = events.flatMap((event) =>
      event.type === "actions.requested" ? event.data.actions.map((action) => ("toolName" in action ? action.toolName : action.kind)) : [],
    );
    expect(requested).toEqual(["get_daily_logs", "get_daily_logs"]);

    // The model never saw the capture token or the controller's records.
    const shown = JSON.stringify(fixture.calls);
    expect(shown).not.toContain(daily.captureToken);
    expect(shown).not.toContain(CONTROLLER_ONLY);
  }, 90_000);

  it("stops at the input-token limit and never approves more usage", async () => {
    fixture.reply(() => ({ toolCalls: [{ name: "get_daily_http_observations", input: { limit: 1 } }], usage: { inputTokens: 600_000, outputTokens: 5 } }));
    const { result, events } = await session(daily, dailyCaptureTask, dailyInvestigationAnswerSchema);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/session usage limit, and more usage was not approved\. This session has hit the input-token limit \(500K\)/);
    // The call that crossed the limit finished; Eve asked before the next call, and no other call happened.
    expect(fixture.calls).toHaveLength(1);
    const request = events.find((event) => event.type === "input.requested");
    expect(request?.type === "input.requested" && request.data.requests.map((item) => item.kind)).toEqual(["session-limit"]);
  }, 90_000);
});

describe("simulated mode", () => {
  it("still presents only get_logs and the unchanged simulated instructions", async () => {
    const answer = { diagnosis: "Scripted diagnosis.", evidenceIds: ["log-17"], uncertainty: "Scripted uncertainty." };
    fixture.reply((_call, index) =>
      index === 0
        ? { toolCalls: [{ name: "get_logs", input: { deploymentId: "B" } }, { name: "get_daily_logs", input: {} }, { name: "bash", input: { command: "env" } }] }
        : { toolCalls: [{ name: "final_output", input: answer }] },
    );
    const settings: InvestigatorSettings = { mode: "simulated", baseUrl: service.baseUrl, trialToken: "trial-token-for-runtime-test" };
    const { result } = await session(settings, investigationTask("B"), investigationAnswerV1Schema);
    expect(result).toMatchObject({ answer });

    const instructions = await investigatorInstructions("simulated");
    // The same file earlier simulated runs saved, byte for byte.
    expect(createHash("sha256").update(instructions).digest("hex")).toBe("c7d203bd2fa14cfc72f19389b136990295b938584f20bd961937c0b9477f771a");
    expect(fixture.calls).toHaveLength(2);
    for (const call of fixture.calls) {
      expect(names(call)).toEqual([...evidenceTools.simulated, "final_output"]);
      expect(system(call)).toEqual([instructions.trimEnd()]);
      expect(call.userMessages).toEqual([investigationTask("B")]);
    }
    expect(fixture.calls[1].toolResults.map(({ name, isError }) => ({ name, isError }))).toEqual([
      { name: "get_logs", isError: false },
      { name: "get_daily_logs", isError: true },
      { name: "bash", isError: true },
    ]);
    expect(service.requests.map((request) => [request.path, request.authorization])).toEqual([
      ["/api/tools/get-logs", "Bearer trial-token-for-runtime-test"],
    ]);
  }, 90_000);
});
