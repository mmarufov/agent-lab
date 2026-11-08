import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { DailyApplicationLog, DailyHttpObservation } from "@agent-lab/contracts/daily-capture";
import { createCaptureAccess, type CaptureGrant } from "@agent-lab/lab/capture-access";
import type { createPool } from "@agent-lab/lab/database";
import { EVIDENCE, dailyCapturesDir, type DailyCaptureRecords } from "@agent-lab/lab/daily-evidence";
import { readCaseRecording, type DailyRecoveryCase, type DailyRecoveryEvaluation, type turnUsage } from "@agent-lab/lab/daily-recovery";
import { acquireExecution } from "@agent-lab/lab/jobs";
import { getDailyHttpObservations } from "../../my-agent/agent/lib/daily-evidence";
import { investigatorEnv, type InvestigatorSettings } from "../../my-agent/client/investigate";
import { DAILY_RECOVERY_EVAL_ID, EVAL_ENV } from "../../my-agent/evals/daily/launch";
import { dailyRecoveryCase } from "../../my-agent/evals/daily/recovery-case";

// pnpm lab:eval:daily: a thin launcher around Eve's native evaluation runner.
// It holds the shared execution lock, verifies the case's pinned recording,
// grants access to exactly that recording, checks the local evidence service,
// and starts `eve eval daily/recovery`. Eve Eval owns the agent server, the
// session, the assertions, and the saved artifacts; this file starts no model
// loop of its own. Afterward it revokes the grant, releases the lock, and
// reads the artifacts Eve wrote so the result can be printed.

export const DAILY_EVAL_TIMEOUT_MS = 5 * 60_000;
/** After a stop request: the eval cancels its turn (up to 15 s), writes its artifacts, and closes Eve's server. */
export const EVAL_STOP_GRACE_MS = 30_000;
/** Startup and teardown allowed beyond the eval's own timeout before the launcher stops eve eval itself. */
const EVAL_OVERHEAD_MS = 2 * 60_000;
const OUTPUT_TAIL_BYTES = 16_000;

type Pool = ReturnType<typeof createPool>;

/** One eval assertion as Eve saved it. */
export interface SavedAssertion {
  name: string;
  passed: boolean;
  severity: "gate" | "soft";
  score: number;
  threshold?: number;
  message?: string;
  metadata?: Record<string, unknown>;
}

/** What this launch's artifacts under my-agent/.eve/evals/<time>/ contain, read back without a model call. */
export interface DailyEvalArtifacts {
  dir: string;
  verdict: "passed" | "failed" | "scored" | "skipped";
  error?: string;
  sessionId?: string;
  answer: unknown;
  assertions: SavedAssertion[];
  evaluation?: DailyRecoveryEvaluation;
  usage?: ReturnType<typeof turnUsage> & { durationMs: number };
  provenance?: { git?: { revision: string; dirty: boolean | "unavailable"; changedPaths?: number } } & Record<string, unknown>;
  cancel?: { reason: string };
}

export interface DailyEvalOutcome {
  /** eve eval's exit code: 0 passed, 1 failed, 2 configuration error. 1 when it was stopped or killed. */
  exitCode: number;
  /** Why the launcher asked eve eval to stop, if it did. */
  stopped?: string;
  /** eve eval did not exit within the grace period and was killed with SIGKILL. */
  forced: boolean;
  grant: { id: string; expiresAt: string; revoked: boolean };
  /** Undefined when eve eval wrote none, for example when its setup refused to run. */
  artifacts?: DailyEvalArtifacts;
  /** The cited records, described from the verified recording. */
  citedRecords: Record<string, string>;
  /** The end of eve eval's console output, with the access token redacted. */
  output: string;
}

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

async function directories(dir: string) {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** One t.log line of the eval: "agent-lab.<name> <json>". */
function logRecords(lines: unknown) {
  const records: Record<string, unknown> = {};
  for (const line of Array.isArray(lines) ? lines : []) {
    const match = typeof line === "string" ? /^agent-lab\.([a-z]+) ([^]*)$/.exec(line) : null;
    if (!match) continue;
    try {
      records[match[1]] = JSON.parse(match[2]);
    } catch {
      // Not one of this eval's records.
    }
  }
  return records;
}

/** This launch's artifact directory, found by the launch ID its eval logged. */
async function readArtifacts(root: string, before: string[], launchId: string): Promise<DailyEvalArtifacts | undefined> {
  const all = (await directories(root)).sort().reverse();
  const candidates = [...all.filter((name) => !before.includes(name)), ...all.slice(0, 5)];
  for (const name of new Set(candidates)) {
    const dir = join(root, name);
    let saved: {
      verdict: DailyEvalArtifacts["verdict"];
      error?: string;
      assertions?: SavedAssertion[];
      result?: { output?: unknown; sessionId?: string; logs?: unknown };
    };
    try {
      saved = JSON.parse(await readFile(join(dir, "evals", ...DAILY_RECOVERY_EVAL_ID.split("/")) + ".json", "utf8"));
    } catch {
      continue;
    }
    const records = logRecords(saved.result?.logs);
    if ((records.provenance as { launchId?: string } | undefined)?.launchId !== launchId) continue;
    return {
      dir,
      verdict: saved.verdict,
      error: saved.error,
      sessionId: saved.result?.sessionId,
      answer: saved.result?.output ?? null,
      assertions: saved.assertions ?? [],
      evaluation: records.evaluation as DailyEvalArtifacts["evaluation"],
      usage: records.usage as DailyEvalArtifacts["usage"],
      provenance: records.provenance as DailyEvalArtifacts["provenance"],
      cancel: records.cancel as DailyEvalArtifacts["cancel"],
    };
  }
  return undefined;
}

function describeRecord(record: DailyHttpObservation | DailyApplicationLog) {
  if (record.kind === "log") return `${record.service} log at ${record.timestamp ?? "an unrecorded time"}: ${record.message.slice(0, 160)}`;
  const result =
    record.outcome === "response" ? `HTTP ${record.response.status}` : record.outcome === "timeout" ? `no response within ${record.deadlineMs} ms` : `network error (${record.error.code ?? record.error.name})`;
  return `${record.method} ${record.path}${record.authenticated ? "" : " (unauthenticated)"} started ${record.startedAt}: ${result}`;
}

/**
 * Start `eve eval daily/recovery` in appDir and wait for it to exit. A stop
 * request sends SIGTERM, which the eval turns into a session cancellation;
 * after the grace period, or at once on force, its process group is killed.
 * Its stdin stays open as a lifeline: if this process dies, the eval sees the
 * end of input and stops itself.
 */
async function runEveEval(options: {
  appDir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stopGraceMs: number;
  signal: AbortSignal;
  force?: AbortSignal;
  redact: (text: string) => string;
  onOutput?: (text: string) => void;
}) {
  const require = createRequire(join(options.appDir, "package.json"));
  const executable = join(dirname(require.resolve("eve/package.json")), "bin", "eve.js");
  const args = ["eval", DAILY_RECOVERY_EVAL_ID, "--strict", "--max-concurrency", "1", "--timeout", String(options.timeoutMs), "--skip-report"];
  const child = spawn(process.execPath, [executable, ...args], {
    cwd: options.appDir,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdin.on("error", () => undefined); // The eval may exit first.
  let output = "";
  const record = (chunk: Buffer) => {
    const text = options.redact(chunk.toString());
    output = (output + text).slice(-OUTPUT_TAIL_BYTES);
    options.onOutput?.(text);
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  let closed = false;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error: error.message }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    closed = true;
  });
  const killGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  let forced = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const forceStop = () => {
    if (closed || forced) return;
    forced = true;
    killGroup("SIGKILL");
  };
  const requestStop = () => {
    if (closed) return;
    child.kill("SIGTERM");
    forceTimer = setTimeout(forceStop, options.stopGraceMs);
  };
  options.signal.addEventListener("abort", requestStop, { once: true });
  options.force?.addEventListener("abort", forceStop, { once: true });
  if (options.signal.aborted) requestStop();
  if (options.force?.aborted) forceStop();
  try {
    const exit = await exited;
    return { ...exit, forced, output };
  } finally {
    clearTimeout(forceTimer);
    options.signal.removeEventListener("abort", requestStop);
    options.force?.removeEventListener("abort", forceStop);
    child.stdin.destroy();
    // Anything eve eval left in its process group.
    killGroup("SIGKILL");
  }
}

/**
 * One native Eve Eval run of the Daily recovery case. Throws, before eve eval
 * starts, when the lock is busy, the recording is missing, incomplete, or
 * changed, or the evidence service does not serve it; no model work happens
 * then. Otherwise resolves with eve eval's result and its artifacts.
 */
export async function runDailyEval(
  pool: Pool,
  options: {
    /** The case to run; tests pass a labeled synthetic recording's case. */
    evalCase?: DailyRecoveryCase;
    /** The Eve app whose evals/ directory runs; tests pass a fixture copy. */
    appDir?: string;
    baseUrl?: string;
    capturesDir?: string;
    timeoutMs?: number;
    stopGraceMs?: number;
    /** Stop: cancel the session, allow bounded cleanup, then kill what remains. */
    signal?: AbortSignal;
    /** Stop at once with SIGKILL, for a second Ctrl+C. */
    force?: AbortSignal;
    /** Added to the eve eval process's environment before the evidence settings; tests set the model double here. */
    env?: Record<string, string | undefined>;
    onProgress?: (message: string) => void;
    onOutput?: (text: string) => void;
  } = {},
): Promise<DailyEvalOutcome> {
  const evalCase = options.evalCase ?? dailyRecoveryCase;
  const appDir = options.appDir ?? fileURLToPath(new URL("../../my-agent/", import.meta.url));
  const capturesDir = options.capturesDir ?? dailyCapturesDir();
  const baseUrl = options.baseUrl ?? process.env.LAB_BASE_URL ?? "http://127.0.0.1:3000";
  const timeoutMs = options.timeoutMs ?? DAILY_EVAL_TIMEOUT_MS;
  const progress = options.onProgress ?? (() => undefined);
  // One model operation at a time, shared with the CLI investigations and the web worker.
  const lease = await acquireExecution(pool);
  const supervision = AbortSignal.timeout(timeoutMs + EVAL_OVERHEAD_MS);
  const signal = AbortSignal.any([lease.signal, supervision, ...(options.signal ? [options.signal] : [])]);
  const stopReason = () =>
    options.signal?.aborted
      ? message(options.signal.reason)
      : lease.signal.aborted
        ? "The execution lock connection was lost."
        : supervision.aborted
          ? `eve eval did not finish within ${(timeoutMs + EVAL_OVERHEAD_MS) / 60_000} minutes.`
          : undefined;
  const access = createCaptureAccess(pool, capturesDir);
  let grant: CaptureGrant | undefined;
  let outcome: DailyEvalOutcome | undefined;
  let token = "";
  const redact = (text: string) => (token ? text.replaceAll(token, "[redacted]") : text);
  try {
    signal.throwIfAborted();
    // 1. The pinned recording, verified before anything is granted. Never another one.
    let recording: DailyCaptureRecords;
    try {
      recording = await readCaseRecording(capturesDir, evalCase);
    } catch (error) {
      throw new Error(`Case ${evalCase.id} needs its pinned recording. ${message(error)} No model work was started.`);
    }
    progress(
      `Recording ${evalCase.captureId} matches the case's pinned SHA-256 for manifest.json, evidence.jsonl, and controller.jsonl: ` +
        `${recording.observations.length} HTTP observations and ${recording.logs.length} log lines.`,
    );

    // 2. Access pinned to exactly those files.
    const granted = await access.grant(evalCase.captureId);
    ({ token, grant } = granted);
    if (!isDeepStrictEqual(grant.sha256, evalCase.captureSha256))
      throw new Error(`Capture ${evalCase.captureId} changed after it was verified. No model work was started.`);
    const evidenceSha256 = grant.sha256[EVIDENCE];
    progress(`Access grant ${grant.id} pins evidence.jsonl ${evidenceSha256} and expires ${grant.expiresAt}.`);

    // 3. The evidence service answers with this grant. Its page is not given to the model.
    try {
      await getDailyHttpObservations({ limit: 1 }, { baseUrl, token, captureId: evalCase.captureId, evidenceSha256, signal });
    } catch (error) {
      let detail = redact(message(error));
      if (/capture_missing|capture_changed/.test(detail))
        detail += " The lab service reads captures from its own working directory; run pnpm dev from this checkout.";
      throw new Error(`${detail} No model work was started.`);
    }
    signal.throwIfAborted();
    progress(`Evidence service at ${baseUrl} serves this capture.`);

    // 4. eve eval, with the evidence tools' settings from investigatorEnv. The
    // database and the reviewer's credentials are not passed on.
    const settings: InvestigatorSettings = { mode: "daily_capture", baseUrl, captureToken: token, captureId: evalCase.captureId, evidenceSha256 };
    const base: NodeJS.ProcessEnv = { ...process.env, ...options.env };
    for (const name of ["DATABASE_URL", "LAB_REVIEW_GATEWAY_API_KEY", "LAB_REVIEW_MODEL"]) delete base[name];
    const launchId = randomUUID();
    const env: NodeJS.ProcessEnv = {
      ...investigatorEnv(settings, base),
      [EVAL_ENV.capturesDir]: capturesDir,
      [EVAL_ENV.launchId]: launchId,
      [EVAL_ENV.lifeline]: "stdin",
    };
    const artifactsRoot = join(appDir, ".eve", "evals");
    const before = await directories(artifactsRoot);
    progress(
      `Running eve eval ${DAILY_RECOVERY_EVAL_ID}: strict assertions, concurrency 1, ` +
        `${timeoutMs % 60_000 ? `${timeoutMs / 1000}-second` : `${timeoutMs / 60_000}-minute`} timeout, reporting disabled...\n`,
    );
    const exit = await runEveEval({
      appDir,
      env,
      timeoutMs,
      stopGraceMs: options.stopGraceMs ?? EVAL_STOP_GRACE_MS,
      signal,
      force: options.force,
      redact,
      onOutput: options.onOutput,
    });
    const stopped = stopReason();
    const artifacts = await readArtifacts(artifactsRoot, before, launchId);
    const answer = artifacts?.answer as { evidenceIds?: unknown; availability?: { failureEvidenceIds?: unknown; recoveryEvidenceIds?: unknown } } | null;
    const cited = [answer?.evidenceIds, answer?.availability?.failureEvidenceIds, answer?.availability?.recoveryEvidenceIds]
      .flatMap((ids) => (Array.isArray(ids) ? ids : []))
      .filter((id): id is string => typeof id === "string");
    const recorded = new Map([...recording.observations, ...recording.logs].map((entry) => [entry.id, entry]));
    const citedRecords = Object.fromEntries(
      [...new Set(cited)].map((id) => [id, recorded.has(id) ? describeRecord(recorded.get(id)!) : "not a record of this recording"]),
    );
    outcome = {
      exitCode: exit.code === 0 && !stopped ? 0 : exit.code === 2 && !stopped ? 2 : 1,
      stopped,
      forced: exit.forced,
      grant: { id: grant.id, expiresAt: grant.expiresAt, revoked: false },
      artifacts,
      citedRecords,
      output: exit.error ? `${exit.output}\n${exit.error}` : exit.output,
    };
    return outcome;
  } catch (error) {
    const reason = stopReason();
    throw new Error(redact(reason && !message(error).includes(reason) ? `${reason} ${message(error)}` : message(error)));
  } finally {
    // Revoke the grant and release the lock, each even if the other fails.
    if (grant) {
      const { id, expiresAt } = grant;
      await access.revoke(id).then(
        () => {
          if (outcome) outcome.grant.revoked = true;
          progress(`Access grant ${id} revoked.`);
        },
        () => progress(`Could not revoke access grant ${id}; it expires ${expiresAt}.`),
      );
    }
    await lease.release();
  }
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** The printed result: the checks, the answer with its cited records, usage, and where the artifacts are (relative to root). */
export function describeDailyEval(outcome: DailyEvalOutcome, root?: string) {
  const lines: string[] = [];
  const saved = outcome.artifacts;
  if (outcome.stopped) lines.push(`Stopped: ${outcome.stopped}${outcome.forced ? " eve eval did not exit in time and was killed." : ""}`);
  if (!saved) {
    lines.push(
      outcome.exitCode === 0 ? "eve eval reported success but wrote no artifacts for this launch." : "eve eval wrote no artifacts for this launch.",
      `Result: FAILED (exit code ${outcome.exitCode}).`,
    );
    return lines;
  }
  const evaluation = saved.evaluation;
  lines.push(`\nResult: ${saved.verdict === "passed" ? "PASSED" : "FAILED"} (Eve verdict ${saved.verdict}, exit code ${outcome.exitCode})${saved.error ? `\nEve error: ${saved.error}` : ""}`);
  lines.push("\nChecks:");
  for (const assertion of saved.assertions) {
    const tag = assertion.severity === "soft" && assertion.threshold === undefined ? "TRACKED" : assertion.passed ? "PASS" : "FAIL";
    const score = assertion.severity === "soft" ? ` ${percent(assertion.score)}` : "";
    lines.push(`  ${tag}${score} ${assertion.name}${assertion.message ? `: ${assertion.message}` : ""}`);
  }
  if (evaluation) {
    lines.push("\nCoverage of the recording's availability facts (tracked, not a gate):");
    for (const fact of evaluation.coverage.facts) {
      const matched = fact.requirements
        .map((requirement) => `${fact.requirements.length > 1 ? `${requirement.id} ` : ""}${requirement.matchedIds.join(", ") || "none retrieved"}`)
        .join("; ");
      lines.push(`  ${fact.status.toUpperCase()} ${fact.label}${fact.requirements.length ? `: ${matched}` : ` (${fact.reason})`}`);
    }
    for (const item of evaluation.notAssessed) lines.push(`NOT ASSESSED ${item.label}: ${item.reason}`);
  }
  const answer = saved.answer as {
    diagnosis?: string;
    evidenceIds?: string[];
    uncertainty?: string;
    availability?: { state?: string; failureEvidenceIds?: string[]; recoveryEvidenceIds?: string[] };
  } | null;
  if (answer && typeof answer === "object") {
    lines.push("\nAnswer:");
    if (answer.availability) {
      lines.push(`  Availability: ${answer.availability.state}`);
      lines.push(`  Failure evidence: ${answer.availability.failureEvidenceIds?.join(", ") || "none"}`);
      lines.push(`  Recovery evidence: ${answer.availability.recoveryEvidenceIds?.join(", ") || "none"}`);
    }
    if (answer.diagnosis) lines.push(`  Diagnosis: ${answer.diagnosis}`);
    lines.push(`  Evidence IDs: ${answer.evidenceIds?.join(", ") || "none"}`);
    if (answer.uncertainty) lines.push(`  Uncertainty: ${answer.uncertainty}`);
    const cited = Object.entries(outcome.citedRecords);
    if (cited.length) {
      lines.push("  Cited records (from the verified recording):");
      for (const [id, description] of cited) lines.push(`    ${id}: ${description}`);
    }
  } else lines.push("\nAnswer: none was produced.");
  const usage = saved.usage;
  if (usage) {
    const tokens = usage.tokens === "unavailable" ? "tokens unavailable" : `${usage.tokens.input} input, ${usage.tokens.output} output tokens`;
    const cost = typeof usage.costUsd === "number" ? `$${usage.costUsd.toFixed(6)}` : "unavailable";
    const tools = Object.entries(usage.toolCalls.byTool).map(([name, count]) => `${name} ${count}`).join(", ");
    lines.push(
      "\nUsage:",
      `  ${(usage.durationMs / 1000).toFixed(1)} s; ${usage.modelSteps} model step(s) (${usage.observedModels.join(", ") || "no model observed"}); ` +
        `${usage.toolCalls.total} tool call(s)${tools ? ` (${tools})` : ""}`,
      `  ${tokens}; reported cost ${cost}`,
    );
  }
  const git = saved.provenance?.git;
  if (git) lines.push(`  Source: Git ${git.revision}${git.dirty === true ? `, with ${git.changedPaths} uncommitted change(s)` : git.dirty === false ? ", clean" : ""}`);
  const dir = root ? relative(root, saved.dir) || "." : saved.dir;
  lines.push(
    "\nSaved results (read without another model request):",
    `  ${dir}/`,
    "    summary.json, results.jsonl: verdict and every assertion with its reason",
    `    evals/${DAILY_RECOVERY_EVAL_ID}.json: answer, check details, task, instructions, provenance, usage (result.logs)`,
    `    evals/${DAILY_RECOVERY_EVAL_ID}.events.ndjson: the session's original events`,
    "  These are local evaluation files, not database-sealed Agent Lab runs; the workbench does not list them.",
  );
  return lines;
}
