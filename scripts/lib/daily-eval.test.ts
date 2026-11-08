import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "@agent-lab/lab/database";
import type { DailyRecoveryCase } from "@agent-lab/lab/daily-recovery";
import { acquireExecution } from "@agent-lab/lab/jobs";
import { migrate } from "@agent-lab/lab/migrate";
import { evidenceTools } from "../../my-agent/agent/lib/tool-mode";
import { investigatorInstructions } from "../../my-agent/client/instructions";
import { dailyCaptureTask } from "../../my-agent/client/investigate";
import {
  CONTROLLER_ONLY,
  capturesDir,
  feedAvailabilityEvidence,
  removeCaptureDirs,
  writeCapture,
} from "../../packages/lab/test/daily-capture-fixture";
import { EVAL_STOP_GRACE_MS, describeDailyEval, runDailyEval, type DailyEvalOutcome } from "./daily-eval";
import { createInvestigatorFixture, startEvidenceService, type ModelReply } from "./investigator-fixture";

// The real launcher and the real evals/ directory, run by the native
// `eve eval` command in a fixture copy of the agent whose model is scripted
// by this process. The evidence tools call the real Daily HTTP handler over a
// labeled synthetic recording, in an isolated database schema. No provider is
// called and the saved history is never touched.

const SYNTHETIC_ID = "20261107T090000Z-5e5e5e";
const admin = createPool();
const schema = `daily_eval_${randomUUID().replaceAll("-", "")}`;
const url = new URL(process.env.DATABASE_URL!);
url.searchParams.set("options", `-c search_path=${schema}`);
const pool = createPool(url.toString());
let dir: string;
let evalCase: DailyRecoveryCase;
let fixture: Awaited<ReturnType<typeof createInvestigatorFixture>>;
let service: Awaited<ReturnType<typeof startEvidenceService>>;
let instructions: string;

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  dir = await capturesDir();
  await writeCapture(dir, { captureId: SYNTHETIC_ID, evidence: feedAvailabilityEvidence() });
  const file = async (name: string) => sha256(await readFile(join(dir, SYNTHETIC_ID, name)));
  evalCase = {
    id: "daily/recovery",
    recording: "SYNTHETIC test recording from packages/lab/test/daily-capture-fixture.ts, not a Daily capture",
    captureId: SYNTHETIC_ID,
    captureSha256: {
      "manifest.json": await file("manifest.json"),
      "evidence.jsonl": await file("evidence.jsonl"),
      "controller.jsonl": await file("controller.jsonl"),
    },
    expected: { availability: "recovered" },
  };
  service = await startEvidenceService({ pool, capturesDir: dir });
  fixture = await createInvestigatorFixture({ evalCase });
  instructions = await investigatorInstructions("daily_capture");
}, 60_000);

afterAll(async () => {
  await fixture?.close();
  await service?.close();
  await removeCaptureDirs();
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

beforeEach(async () => {
  service.requests.length = 0;
  service.intercept(undefined);
  fixture.reply(() => "No reply was scripted.");
  await fixture.setCase(evalCase);
});

const run = (options: Parameters<typeof runDailyEval>[1] = {}) =>
  runDailyEval(pool, { evalCase, appDir: fixture.appDir, baseUrl: service.baseUrl, capturesDir: dir, env: fixture.evalEnv, timeoutMs: 60_000, ...options });

/** Scripted replies: the given tool calls first, then this final answer. */
function script(answer: object, toolCalls: { name: string; input?: unknown }[][] = [[{ name: "get_daily_http_observations", input: { path: "/feed" } }]]) {
  fixture.reply((_call, index): ModelReply => (index < toolCalls.length ? { toolCalls: toolCalls[index] } : { toolCalls: [{ name: "final_output", input: answer }] }));
}

const answer = (state: string, failureEvidenceIds: string[], recoveryEvidenceIds: string[], evidenceIds = [...failureEvidenceIds, ...recoveryEvidenceIds]) => ({
  diagnosis: "Scripted diagnosis.",
  evidenceIds,
  uncertainty: "Scripted uncertainty.",
  availability: { state, failureEvidenceIds, recoveryEvidenceIds },
});

const gates = (outcome: DailyEvalOutcome) =>
  Object.fromEntries((outcome.artifacts?.assertions ?? []).map((assertion) => [assertion.name, assertion.passed]));

/** The bearer token the launcher's grant used, read from the evidence service's requests. */
const grantToken = () => service.requests.find((request) => request.authorization)?.authorization?.replace(/^Bearer /, "") ?? "";

async function artifactText(outcome: DailyEvalOutcome) {
  const root = outcome.artifacts!.dir;
  const files: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true }))
      if (entry.isDirectory()) await walk(join(path, entry.name));
      else files.push(join(path, entry.name));
  };
  await walk(root);
  return { files: files.map((file) => file.slice(root.length + 1)).sort(), text: (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n") };
}

async function grantRevoked(id: string) {
  const { rows } = await pool.query<{ revoked: boolean }>("SELECT revoked_at IS NOT NULL AS revoked FROM lab_capture_access_grants WHERE id = $1", [id]);
  return rows[0]?.revoked;
}

async function lockIsFree() {
  const lease = await acquireExecution(pool);
  await lease.release();
  return true;
}

const grantCount = async () => Number((await pool.query<{ count: string }>("SELECT count(*) FROM lab_capture_access_grants")).rows[0].count);

/** The event types of an artifact's saved session events, in order. */
async function savedEventTypes(artifactDir: string) {
  const lines = (await readFile(join(artifactDir, "evals/daily/recovery.events.ndjson"), "utf8")).split("\n").filter(Boolean);
  return lines.map((line) => (JSON.parse(line) as { type: string }).type);
}

/** Copy the synthetic recording into a new captures directory, changing what `change` returns. */
async function capturesWith(change?: (files: Record<string, string>) => Record<string, string>) {
  const copy = await capturesDir();
  if (!change) return copy;
  await writeCapture(copy, { captureId: SYNTHETIC_ID, evidence: feedAvailabilityEvidence() });
  const names = ["manifest.json", "evidence.jsonl", "controller.jsonl"];
  const files = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readFile(join(copy, SYNTHETIC_ID, name), "utf8")])));
  for (const [name, text] of Object.entries(change(files))) await writeFile(join(copy, SYNTHETIC_ID, name), text);
  return copy;
}

describe("pnpm lab:eval:daily through native eve eval", () => {
  it("passes a correct, evidence-backed recovery and keeps every expectation out of the model's request", async () => {
    script(answer("recovered", ["http-0002", "http-0003"], ["http-0009"]));
    const outcome = await run();
    expect(outcome.output).not.toContain("Error");
    expect(outcome).toMatchObject({ exitCode: 0, forced: false, stopped: undefined, grant: { revoked: true } });
    expect(outcome.artifacts?.verdict).toBe("passed");
    expect(gates(outcome)).toEqual({
      succeeded: true,
      outputMatches: true,
      "turn completed": true,
      "evidence checks": true,
      "availability outcome": true,
      "coverage (tracked)": true,
    });
    const evaluation = outcome.artifacts!.evaluation!;
    expect(evaluation.outcome).toMatchObject({ status: "pass", expected: "recovered", answered: "recovered" });
    expect(evaluation.outcome.failureCitations?.counted).toEqual(["http-0002", "http-0003"]);
    expect(evaluation.outcome.recoveryCitations?.counted).toEqual(["http-0009"]);
    expect(evaluation.coverage.facts.map((fact) => [fact.id, fact.status])).toEqual([
      ["server_errors", "covered"],
      ["no_response", "covered"],
      ["recovery", "covered"],
    ]);
    expect(evaluation.notAssessed.map((item) => item.label)).toEqual(["Root-cause correctness", "Free-text explanation correctness"]);
    expect(outcome.artifacts!.usage).toMatchObject({ modelSteps: 2, toolCalls: { total: 1, byTool: { get_daily_http_observations: 1 } }, costUsd: "unavailable" });
    expect(outcome.citedRecords["http-0009"]).toBe("GET /feed started 2026-10-22T05:02:30.000Z: HTTP 200");
    expect(await grantRevoked(outcome.grant.id)).toBe(true);
    expect(await lockIsFree()).toBe(true);

    // The model saw the unchanged task, instructions, and tools; the answer
    // schema describes the recorded period; and nothing from the case.
    const token = grantToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.calls).toHaveLength(2);
    for (const call of fixture.calls) {
      expect(call.userMessages).toEqual([dailyCaptureTask]);
      expect(call.messages.filter((message) => message.role === "system").map((message) => message.text)).toEqual([instructions.trimEnd()]);
      expect(call.tools.map((tool) => tool.name)).toEqual([...evidenceTools.daily_capture, "final_output"]);
    }
    const finalOutput = JSON.stringify(fixture.calls[0].tools.find((tool) => tool.name === "final_output")?.inputSchema);
    expect(finalOutput).toContain("recorded period, not Daily's current health");
    const shown = JSON.stringify(fixture.calls);
    for (const secret of [token, CONTROLLER_ONLY, evalCase.recording, evalCase.captureSha256["manifest.json"], evalCase.captureSha256["controller.jsonl"], "daily-recovery-v1", "expected"])
      expect(shown).not.toContain(secret);
    // Before retrieving anything, the model has no record IDs or times to cite.
    const first = JSON.stringify(fixture.calls[0]);
    expect(first).not.toMatch(/http-\d{4}|log-api-\d{4}/);
    expect(first).not.toContain(evaluation.outcome.lastFailureEndedAt!);

    // Eve's own artifacts hold the answer, original events, checks, and provenance, but no credentials or controller data.
    const { files, text } = await artifactText(outcome);
    expect(files).toEqual(["evals/daily/recovery.events.ndjson", "evals/daily/recovery.json", "results.jsonl", "summary.json"]);
    expect(text).toContain('"type":"result.completed"');
    expect(text).toContain(dailyCaptureTask);
    expect(text).not.toContain(token);
    expect(text).not.toContain(CONTROLLER_ONLY);
    expect(describeDailyEval(outcome).join("\n")).toMatch(/Result: PASSED[^]*NOT ASSESSED Root-cause correctness[^]*reported cost unavailable/);
  }, 120_000);
  it("fails a wrong availability conclusion through its gate and still saves everything", async () => {
    script(answer("failing", ["http-0002"], []));
    const outcome = await run();
    expect(outcome).toMatchObject({ exitCode: 1, grant: { revoked: true } });
    expect(outcome.artifacts?.verdict).toBe("failed");
    expect(gates(outcome)).toMatchObject({ succeeded: true, outputMatches: true, "turn completed": true, "evidence checks": true, "availability outcome": false });
    const failed = outcome.artifacts!.assertions.find((assertion) => assertion.name === "availability outcome");
    expect(failed?.message).toContain("The answer's availability state is failing; the recording establishes recovered.");
    expect(failed?.message).toContain("No cited recovery qualifies");
  }, 120_000);

  it("fails at a usage limit and never approves more usage", async () => {
    fixture.reply(() => ({ toolCalls: [{ name: "get_daily_http_observations", input: { limit: 1 } }], usage: { inputTokens: 600_000, outputTokens: 5 } }));
    const outcome = await run();
    expect(outcome.exitCode).toBe(1);
    // The call that crossed the limit finished; Eve asked before another, and nothing answered.
    expect(fixture.calls).toHaveLength(1);
    expect(gates(outcome)).toMatchObject({ succeeded: false, outputMatches: false, "turn completed": false, "evidence checks": false, "availability outcome": false });
    expect(outcome.artifacts!.evaluation!.turn).toMatchObject({ status: "waiting_for_input" });
    expect(outcome.artifacts!.evaluation!.turn.reason).toContain("session-limit");
  }, 120_000);

  it("fails a turn that ends without the structured answer", async () => {
    fixture.reply(() => "Only text, no structured answer.");
    const outcome = await run();
    expect(outcome.exitCode).toBe(1);
    expect(gates(outcome)).toMatchObject({ succeeded: false, outputMatches: false, "turn completed": false, "evidence checks": false, "availability outcome": false });
    expect(outcome.artifacts!.evaluation!.turn.status).toBe("failed");
    expect(outcome.artifacts!.answer).toBe("Only text, no structured answer.");
  }, 120_000);

  it("cancels the session on Ctrl+C, keeps the events it recorded, and cleans up", async () => {
    const stop = new AbortController();
    fixture.reply(async (_call, index) => {
      if (index === 0) {
        stop.abort(new Error("Interrupted by SIGINT."));
        await sleep(1_000);
        return { toolCalls: [{ name: "get_daily_http_observations", input: { path: "/feed" } }] };
      }
      return { toolCalls: [{ name: "final_output", input: answer("recovered", ["http-0002"], ["http-0009"]) }] };
    });
    const started = Date.now();
    const outcome = await run({ signal: stop.signal });
    expect(Date.now() - started).toBeLessThan(EVAL_STOP_GRACE_MS);
    expect(outcome).toMatchObject({ exitCode: 1, stopped: "Interrupted by SIGINT.", forced: false, grant: { revoked: true } });
    expect(fixture.calls).toHaveLength(1);
    expect(outcome.artifacts?.cancel?.reason).toBe("The evaluation received SIGTERM and is stopping.");
    expect(await savedEventTypes(outcome.artifacts!.dir)).toContain("turn.cancelled");
    expect(gates(outcome)).toMatchObject({ "turn completed": false, "availability outcome": false });
    expect(await lockIsFree()).toBe(true);
  }, 120_000);

  it("kills eve eval at once on a second Ctrl+C, then still revokes the grant and releases the lock", async () => {
    const stop = new AbortController();
    const force = new AbortController();
    fixture.reply(async () => {
      stop.abort(new Error("Interrupted by SIGINT."));
      force.abort(new Error("Interrupted again by SIGINT."));
      await sleep(3_000);
      return "Too late.";
    });
    const outcome = await run({ signal: stop.signal, force: force.signal });
    expect(outcome).toMatchObject({ exitCode: 1, forced: true, grant: { revoked: true }, artifacts: undefined });
    expect(describeDailyEval(outcome).join("\n")).toContain("eve eval wrote no artifacts for this launch.");
    expect(await grantRevoked(outcome.grant.id)).toBe(true);
    expect(await lockIsFree()).toBe(true);
  }, 120_000);

  it("fails a turn that exceeds the evaluation timeout, after cancelling it", async () => {
    fixture.reply(async () => {
      await sleep(5_000);
      return { toolCalls: [{ name: "final_output", input: answer("recovered", ["http-0002"], ["http-0009"]) }] };
    });
    const outcome = await run({ timeoutMs: 2_000 });
    expect(outcome).toMatchObject({ exitCode: 1, stopped: undefined, grant: { revoked: true } });
    expect(outcome.artifacts?.verdict).toBe("failed");
    expect(outcome.artifacts?.error).toMatch(/timeout/i);
    expect(outcome.artifacts?.cancel?.reason).toMatch(/timeout/i);
    expect(await savedEventTypes(outcome.artifacts!.dir)).toContain("turn.cancelled");
  }, 120_000);

  it.each([
    ["missing", () => capturesWith(), /is not in the captures directory/],
    [
      "changed",
      () => capturesWith((files) => ({ "evidence.jsonl": files["evidence.jsonl"].replace('"status":500', '"status":502') })),
      /does not match the SHA-256 recorded in its manifest/,
    ],
    [
      "replaced with another valid recording",
      () => capturesWith(() => ({})).then(async (copy) => {
        await writeCapture(copy, { captureId: SYNTHETIC_ID, evidence: feedAvailabilityEvidence().slice(0, -1) });
        return copy;
      }),
      /evidence\.jsonl, controller\.jsonl differ from the SHA-256 that case daily\/recovery pins|manifest\.json, evidence\.jsonl differ/,
    ],
    [
      "incomplete",
      () => capturesWith((files) => ({ "evidence.jsonl": files["evidence.jsonl"].split("\n").slice(0, 3).join("\n") + "\n" })),
      /does not match the SHA-256 recorded in its manifest/,
    ],
  ])("refuses a %s recording before granting access or starting eve eval", async (_name, make, error) => {
    const copy = await make();
    const grants = await grantCount();
    await expect(run({ capturesDir: copy })).rejects.toThrow(error);
    await expect(run({ capturesDir: copy })).rejects.toThrow(/No model work was started/);
    expect(fixture.calls).toHaveLength(0);
    expect(await grantCount()).toBe(grants);
    expect(await lockIsFree()).toBe(true);
  }, 60_000);

  it("refuses before starting eve eval when the evidence service does not serve the capture, and revokes the grant", async () => {
    service.intercept(() => Response.json({ error: { code: "capture_changed", message: "Files changed." } }, { status: 409 }));
    const grants = await grantCount();
    await expect(run()).rejects.toThrow(/HTTP 409 from the lab service \(capture_changed: Files changed\.\)[^]*run pnpm dev from this checkout\. No model work was started\./);
    expect(fixture.calls).toHaveLength(0);
    expect(await grantCount()).toBe(grants + 1);
    const { rows } = await pool.query<{ revoked: boolean }>("SELECT revoked_at IS NOT NULL AS revoked FROM lab_capture_access_grants ORDER BY created_at DESC LIMIT 1");
    expect(rows[0].revoked).toBe(true);
    expect(await lockIsFree()).toBe(true);
  }, 60_000);

  it.each([
    ["another evidence file", { "evidence.jsonl": "0".repeat(64) }, /not case daily\/recovery's pinned recording/],
    ["another manifest", { "manifest.json": "0".repeat(64) }, /manifest\.json differ from the SHA-256 that case daily\/recovery pins/],
  ])("stops in the eval's own setup, before the agent server or any model call, when its case pins %s", async (_name, pinned, error) => {
    await fixture.setCase({ ...evalCase, captureSha256: { ...evalCase.captureSha256, ...pinned } });
    script(answer("recovered", ["http-0002"], ["http-0009"]));
    const outcome = await run();
    expect(outcome).toMatchObject({ exitCode: 1, artifacts: undefined, grant: { revoked: true } });
    expect(outcome.output).toMatch(error);
    expect(outcome.output).not.toContain("EVALS 1");
    expect(fixture.calls).toHaveLength(0);
  }, 120_000);

  it("stops eve eval when the execution lock connection is lost", async () => {
    fixture.reply(async (_call, index) => {
      if (index === 0) {
        await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_locks
           WHERE locktype = 'advisory' AND granted AND objid = 713906422 AND classid = (hashtext($1)::bigint & 4294967295)::oid`,
          [schema],
        );
        await sleep(1_000);
        return { toolCalls: [{ name: "get_daily_http_observations", input: { path: "/feed" } }] };
      }
      return { toolCalls: [{ name: "final_output", input: answer("recovered", ["http-0002"], ["http-0009"]) }] };
    });
    const outcome = await run();
    expect(outcome).toMatchObject({ exitCode: 1, stopped: "The execution lock connection was lost.", forced: false, grant: { revoked: true } });
    expect(fixture.calls).toHaveLength(1);
    expect(await savedEventTypes(outcome.artifacts!.dir)).toContain("turn.cancelled");
    expect(await lockIsFree()).toBe(true);
  }, 120_000);

  it("stops itself when the launcher is killed; its grant then lasts until it expires", async () => {
    const firstCall = Promise.withResolvers<void>();
    fixture.reply(async (_call, index) => {
      if (index === 0) {
        firstCall.resolve();
        await sleep(1_000);
        return { toolCalls: [{ name: "get_daily_http_observations", input: { path: "/feed" } }] };
      }
      return { toolCalls: [{ name: "final_output", input: answer("recovered", ["http-0002"], ["http-0009"]) }] };
    });
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const options = { evalCase, appDir: fixture.appDir, baseUrl: service.baseUrl, capturesDir: dir, timeoutMs: 60_000 };
    // Without NODE_ENV=test, as in the other runs, so Eve keeps the fixture's scripted model.
    const env: Record<string, string | undefined> = { ...process.env, ...fixture.evalEnv, EVAL_OPTIONS: JSON.stringify(options), EVAL_DATABASE_URL: url.toString() };
    delete env.NODE_ENV;
    const code = `import { createPool } from "@agent-lab/lab/database";
      import { runDailyEval } from "./scripts/lib/daily-eval.ts";
      await runDailyEval(createPool(process.env.EVAL_DATABASE_URL), JSON.parse(process.env.EVAL_OPTIONS));`;
    const launcher = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: root, env: env as NodeJS.ProcessEnv, stdio: "ignore" });
    const before = new Set(await readdir(join(fixture.appDir, ".eve/evals")).catch(() => []));
    await firstCall.promise;
    launcher.kill("SIGKILL");

    // eve eval sees its stdin close, cancels the turn, and saves its artifacts.
    let artifactDir: string | undefined;
    for (let attempt = 0; attempt < 120 && !artifactDir; attempt++) {
      await sleep(250);
      for (const name of await readdir(join(fixture.appDir, ".eve/evals")).catch(() => [] as string[]))
        if (!before.has(name)) {
          const text = await readFile(join(fixture.appDir, ".eve/evals", name, "evals/daily/recovery.json"), "utf8").catch(() => "");
          if (text.includes("The launcher exited, so the evaluation is stopping.")) artifactDir = join(fixture.appDir, ".eve/evals", name);
        }
    }
    expect(artifactDir).toBeDefined();
    expect(await savedEventTypes(artifactDir!)).toContain("turn.cancelled");
    expect(fixture.calls).toHaveLength(1);

    // PostgreSQL released the lock with the launcher's connection. The grant
    // was never revoked; expiry, within one hour, is the fallback.
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await lockIsFree();
        break;
      } catch {
        await sleep(250);
      }
    }
    expect(await lockIsFree()).toBe(true);
    const { rows } = await pool.query<{ id: string; revoked: boolean; expires: boolean }>(
      "SELECT id, revoked_at IS NOT NULL AS revoked, expires_at <= now() + interval '1 hour' AS expires FROM lab_capture_access_grants ORDER BY created_at DESC LIMIT 1",
    );
    expect(rows[0]).toMatchObject({ revoked: false, expires: true });
    await pool.query("UPDATE lab_capture_access_grants SET revoked_at = now() WHERE id = $1", [rows[0].id]);
  }, 120_000);
});
