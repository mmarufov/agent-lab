import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { z } from "zod";
import { DAILY_AVAILABILITY_ANSWER_VERSION, dailyAvailabilityAnswerSchema } from "@agent-lab/contracts/daily-availability";
import { DAILY_FEED_AVAILABILITY_PROFILE } from "@agent-lab/lab/daily-coverage";
import { EVIDENCE } from "@agent-lab/lab/daily-evidence";
import { DAILY_RECOVERY_EVALUATOR_VERSION, readCaseRecording, recordedAvailability } from "@agent-lab/lab/daily-recovery";
import investigator from "../../agent/agent";
import { evidenceTools } from "../../agent/lib/tool-mode";
import { dailyCaptureTask } from "../../client/investigate";
import { EVAL_ENV } from "./launch";
import { dailyRecoveryCase } from "./recovery-case";

// What evals.config.ts's setup prepares, in the eve eval process, before Eve
// starts the agent server: the launch settings pnpm lab:eval:daily supplied,
// the pinned recording verified again, its expected availability recomputed,
// and the provenance saved with the result. Any problem throws here, so it
// stops the run before model work. Nothing here is sent to the model.

const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** One t.log line: a stable name and a JSON payload, kept in the eval's artifact. */
export const logRecord = (name: string, payload: unknown) => `agent-lab.${name} ${JSON.stringify(payload)}`;

async function files(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : Promise.resolve(entry.isFile() ? [join(dir, entry.name)] : []))),
  );
  return nested.flat().sort();
}

/** SHA-256 of the investigator, task, evaluation, and evaluator sources this process loaded. */
async function sourceHashes(appRoot: string) {
  const require = createRequire(join(appRoot, "package.json"));
  const packages = [
    ["@agent-lab/lab/src", dirname(require.resolve("@agent-lab/lab/daily-recovery"))],
    ["@agent-lab/contracts/src", dirname(require.resolve("@agent-lab/contracts/daily-availability"))],
  ] as const;
  const appFiles = [
    ...(await files(join(appRoot, "agent"))),
    ...(await files(join(appRoot, "prompts"))),
    ...(await files(join(appRoot, "evals"))),
    join(appRoot, "client", "investigate.ts"),
    join(appRoot, "client", "instructions.ts"),
    join(appRoot, "package.json"),
  ].filter((file) => existsSync(file));
  const entries: [string, string][] = [];
  for (const file of appFiles) entries.push([relative(appRoot, file), hash(await readFile(file))]);
  for (const [label, dir] of packages)
    for (const file of await files(dir)) entries.push([`${label}/${relative(dir, file)}`, hash(await readFile(file))]);
  return Object.fromEntries(entries);
}

/** The Git revision and whether the working tree differs from it, or "unavailable" outside a repository. */
function gitState(appRoot: string) {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", appRoot, ...args], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
  try {
    const revision = git("rev-parse", "HEAD").trim();
    const changed = git("status", "--porcelain=v1", "--untracked-files=normal").split("\n").filter(Boolean);
    return { revision, dirty: changed.length > 0, changedPaths: changed.length, changes: changed.slice(0, 200) };
  } catch {
    return { revision: "unavailable", dirty: "unavailable" as const };
  }
}

function describeModel(model: unknown) {
  if (typeof model === "string") return model;
  const { provider, modelId } = (model ?? {}) as { provider?: unknown; modelId?: unknown };
  return { provider: String(provider ?? "unknown"), modelId: String(modelId ?? "unknown") };
}

/** Launch settings, refused unless they grant exactly the case's pinned recording. */
function launchSettings(env: NodeJS.ProcessEnv) {
  const missing = [
    "LAB_TOOL_MODE",
    "LAB_BASE_URL",
    "LAB_DAILY_CAPTURE_TOKEN",
    "LAB_DAILY_CAPTURE_ID",
    "LAB_DAILY_EVIDENCE_SHA256",
    EVAL_ENV.capturesDir,
    EVAL_ENV.launchId,
  ].filter((name) => !env[name]);
  if (missing.length || env.LAB_TOOL_MODE !== "daily_capture")
    throw new Error(
      "Run this evaluation with pnpm lab:eval:daily from the repository root: it verifies the recording, " +
        `grants access to it, and starts eve eval with the settings this setup needs (missing: ${missing.join(", ") || "LAB_TOOL_MODE=daily_capture"}).`,
    );
  const captureId = env.LAB_DAILY_CAPTURE_ID!;
  const evidenceSha256 = env.LAB_DAILY_EVIDENCE_SHA256!;
  if (captureId !== dailyRecoveryCase.captureId || evidenceSha256 !== dailyRecoveryCase.captureSha256[EVIDENCE])
    throw new Error(
      `The access supplied is for capture ${captureId} (evidence ${evidenceSha256.slice(0, 12)}), not case ${dailyRecoveryCase.id}'s ` +
        `pinned recording ${dailyRecoveryCase.captureId} (evidence ${dailyRecoveryCase.captureSha256[EVIDENCE].slice(0, 12)}). No other recording is substituted.`,
    );
  return { capturesDir: env[EVAL_ENV.capturesDir]!, launchId: env[EVAL_ENV.launchId]!, lifeline: env[EVAL_ENV.lifeline] === "stdin" };
}

const ignoreClosedOutput = () => undefined;

/**
 * A stop request for the running evaluation: SIGINT or SIGTERM from the
 * launcher, or the launcher's exit when it holds this process's stdin open.
 * The eval cancels its session turn when this aborts. A second signal exits
 * at once.
 */
function stopSignal(lifeline: boolean) {
  const controller = new AbortController();
  const stop = (reason: string) => {
    if (!controller.signal.aborted) controller.abort(new Error(reason));
  };
  let signals = 0;
  const onSignal = (signal: NodeJS.Signals) => {
    signals += 1;
    if (signals > 1) process.exit(signal === "SIGINT" ? 130 : 143);
    stop(`The evaluation received ${signal} and is stopping.`);
  };
  const onLauncherGone = () => stop("The launcher exited, so the evaluation is stopping.");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  if (lifeline) {
    process.stdin.on("end", onLauncherGone);
    process.stdin.on("error", onLauncherGone);
    process.stdin.resume();
    // The launcher reads stdout and stderr. Once it is gone, a write fails
    // with EPIPE, which would otherwise crash this process before Eve saves
    // the cancelled turn's artifacts. Nobody can read that output, so drop it.
    // Kept until exit: Eve still prints after teardown.
    process.stdout.on("error", ignoreClosedOutput);
    process.stderr.on("error", ignoreClosedOutput);
  }
  return {
    signal: controller.signal,
    dispose() {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (lifeline) {
        process.stdin.off("end", onLauncherGone);
        process.stdin.off("error", onLauncherGone);
        process.stdin.destroy();
      }
    },
  };
}

export async function prepareDailyRecovery(env: NodeJS.ProcessEnv = process.env, appRoot = process.cwd()) {
  if (!existsSync(join(appRoot, "agent", "agent.ts")) || !existsSync(join(appRoot, "evals", "evals.config.ts")))
    throw new Error("Run eve eval from the agent app directory; pnpm lab:eval:daily does.");
  const launch = launchSettings(env);

  // The pinned recording, verified again in this process: a missing,
  // incomplete, or changed file throws a DailyCaptureError naming the file.
  const recording = await readCaseRecording(launch.capturesDir, dailyRecoveryCase);
  const recorded = recordedAvailability(recording.observations);
  if (recorded.state !== dailyRecoveryCase.expected.availability)
    throw new Error(
      `Case ${dailyRecoveryCase.id} expects ${dailyRecoveryCase.expected.availability}, but its recording establishes ${recorded.state}.`,
    );

  const instructions = await readFile(join(appRoot, "prompts", "daily-capture.md"), "utf8");
  const answerSchema = z.toJSONSchema(dailyAvailabilityAnswerSchema);
  const require = createRequire(join(appRoot, "package.json"));
  const eve = JSON.parse(await readFile(require.resolve("eve/package.json"), "utf8")) as { version: string };
  const { model, reasoning, limits, defaultTools, tool } = investigator as unknown as Record<string, unknown>;
  // What the model is given, recorded exactly: the user message, the system
  // instructions file, the tools, and the answer schema.
  const request = {
    task: dailyCaptureTask,
    instructions,
    instructionsSha256: hash(instructions),
    tools: evidenceTools.daily_capture,
    answerSchemaVersion: DAILY_AVAILABILITY_ANSWER_VERSION,
    answerSchema,
    answerSchemaSha256: hash(JSON.stringify(answerSchema)),
    modelSettings: { model: describeModel(model), reasoning: reasoning ?? null, limits: limits ?? null, defaultTools, tool },
  };
  const provenance = {
    launchId: launch.launchId,
    evaluatorVersion: DAILY_RECOVERY_EVALUATOR_VERSION,
    profileVersion: DAILY_FEED_AVAILABILITY_PROFILE,
    answerSchemaVersion: DAILY_AVAILABILITY_ANSWER_VERSION,
    eveVersion: eve.version,
    git: gitState(appRoot),
    sourceSha256: await sourceHashes(appRoot),
  };

  // Installed last, so a setup failure leaves no handlers behind.
  const stop = stopSignal(launch.lifeline);
  return { evalCase: dailyRecoveryCase, recording, request, provenance, stop: stop.signal, dispose: stop.dispose };
}
