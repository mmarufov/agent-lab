import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  dailyCaptureIdSchema,
  dailyCaptureManifestSchema,
  dailyCaptureRecoveryMarkerSchema,
  type DailyCaptureControllerRecord,
  type DailyCaptureManifest,
  type DailyCaptureOutcome,
  type DailyCapturePhase,
  type DailyCaptureRecoveryMarker,
  type DailyContainer,
  type DailyHttpObservation,
} from "@agent-lab/contracts/daily-capture";
import { CONTROLLER, EVIDENCE, MANIFEST, summarizeArtifacts, verifyCapture } from "@agent-lab/lab/daily-evidence";
import {
  acquireOperationLock,
  apiUrl,
  check,
  COMPOSE_PROJECT,
  composeFile,
  containerSnapshot,
  display,
  errorMessage,
  FEED_CACHE_MINUTES,
  field,
  fixtureArticles,
  isRecord,
  lastLines,
  ownershipProblems,
  preview,
  readSession,
  RECOVERY_MARKER,
  releaseOperationLock,
  request,
  requireDocker,
  sandboxConfig,
  SandboxError,
  seconds,
  SERVICES,
  serviceStates,
  statePath,
  tokenHash,
  waitForReady,
  withOperationLock,
  writeState,
  type CommandResult,
  type SandboxConfig,
  type Service,
} from "./daily-sandbox";

// Verification lives in the lab package so Next.js can read captures without
// importing this Docker controller.
export { verifyCapture };

export interface CaptureSettings {
  /** Healthy request rounds required before PostgreSQL is stopped. */
  baselineRounds: number;
  roundPauseMs: number;
  /** How long rounds continue while PostgreSQL is stopped. */
  outageMs: number;
  /** Measured from docker start: the window for consecutive healthy rounds. */
  recoveryTimeoutMs: number;
  recoveryRounds: number;
  /** docker stop --timeout: PostgreSQL's time to shut down cleanly. */
  stopTimeoutSeconds: number;
  /** Restoration's own budget, independent of a cancelled capture. */
  cleanupTimeoutMs: number;
  /** Quiet gap after the preflight check, so its requests stay out of the capture window. */
  settleMs: number;
  /** Widens the docker logs range for clock differences between the Mac and Docker's VM. */
  logMarginMs: number;
  databasePollMs: number;
}

const DEFAULT_SETTINGS: CaptureSettings = {
  baselineRounds: 2,
  roundPauseMs: 2_000,
  outageMs: 45_000,
  recoveryTimeoutMs: 120_000,
  recoveryRounds: 2,
  stopTimeoutSeconds: 10,
  cleanupTimeoutMs: 60_000,
  settleMs: 1_000,
  logMarginMs: 500,
  databasePollMs: 500,
};

export interface CaptureConfig extends SandboxConfig {
  capture: CaptureSettings;
  newCaptureId: () => string;
}

export function captureConfig(
  overrides: Partial<Omit<CaptureConfig, "capture">> & { capture?: Partial<CaptureSettings> } = {},
): CaptureConfig {
  const { capture, newCaptureId: newId, ...sandbox } = overrides;
  return { ...sandboxConfig(sandbox), capture: { ...DEFAULT_SETTINGS, ...capture }, newCaptureId: newId ?? newCaptureId };
}

/** UTC time plus random hex, for example 20261022T042210Z-a1b2c3. */
export function newCaptureId(now = new Date()) {
  return `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${randomBytes(3).toString("hex")}`;
}

// One round: liveness, the reader's feed (needs the database), then readiness.
const PROBES = [
  { path: "/healthz", authenticated: false },
  { path: "/feed", authenticated: true },
  { path: "/readyz", authenticated: false },
] as const;
type Probe = (typeof PROBES)[number];

const CAPTURES_DIR = "captures";
const SANDBOX_FILES = [
  "scenarios/daily/compose.yaml",
  "scenarios/daily/launcher.py",
  "scenarios/daily/gateway.py",
  "scenarios/daily/seed.py",
  "scenarios/daily/fixture.json",
];
const RESPONSE_HEADERS = ["content-type", "cache-control", "retry-after"];
const MAX_BODY_BYTES = 256 * 1024;
const REDACTED = "[REDACTED]";

type Distribute<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ControllerInput = Distribute<Exclude<DailyCaptureControllerRecord, { kind: "log" }>, "id" | "at">;
// What differs between HTTP observations: the outcome and its response or error.
type HttpOutcome = Distribute<
  DailyHttpObservation,
  "kind" | "id" | "method" | "path" | "authenticated" | "startedAt" | "endedAt" | "elapsedMs" | "deadlineMs"
>;
type OutcomeName = keyof DailyCaptureManifest["outcomes"];
type Environment = DailyCaptureManifest["environment"];
interface LogLine {
  stream: "stdout" | "stderr";
  timestamp: string | null;
  message: string;
}

export interface CaptureResult {
  captureId: string;
  dir: string;
  manifest: DailyCaptureManifest;
  exitCode: number;
}

/**
 * Record a real PostgreSQL outage in the running sandbox: healthy baseline,
 * stop daily-db only, keep requesting, start the same container, observe
 * recovery, then save evidence and logs. Preflight problems throw before
 * anything is recorded or stopped. Once recording starts, every result,
 * including a failure or cancellation, is saved and returned.
 */
export async function capture(config: CaptureConfig, signal?: AbortSignal): Promise<CaptureResult> {
  await requireDocker(config);
  return withOperationLock(config, "capture", async () => {
    const preflight = await prepare(config);
    if (signal?.aborted)
      throw new SandboxError("capture", "Cancelled before the capture started. Nothing was recorded and PostgreSQL was not touched.");
    return execute(await begin(config, preflight, signal));
  });
}

interface RoundResult {
  phase: "baseline" | "outage" | "recovery";
  round: number;
  results: { evidenceId: string; path: string; ok: boolean; summary: string }[];
  complete: boolean;
  ok: boolean;
  endedAt: string;
  endedMono: number;
}

interface RunState {
  captureId: string;
  dir: string;
  createdAt: string;
  phase: DailyCapturePhase | null;
  /** The phase that was cut short; later cleanup phases do not overwrite it. */
  stoppedDuring?: DailyCapturePhase;
  windowStart?: string;
  windowEnd?: string;
  logRange?: { since: string; until: string };
  cancellation?: { signal: string; at: string };
  error?: string;
  rounds: RoundResult[];
  outageStarted: boolean;
  outageCompleted: boolean;
  markerWritten: boolean;
  stopIssued: boolean;
  restoreStarted?: { at: string; mono: number };
  databaseRunning: boolean;
  outcomes: Partial<Record<OutcomeName, DailyCaptureOutcome>>;
  cleanup: DailyCaptureManifest["cleanup"];
  collectionErrors: string[];
  logCounts: Partial<Record<Service, number>>;
}

interface Context {
  config: CaptureConfig;
  settings: CaptureSettings;
  signal?: AbortSignal;
  token: string;
  expected: { id: string; title: string }[];
  containers: Record<Service, DailyContainer>;
  environment: Environment;
  recorder: Recorder;
  run: RunState;
}

type Preflight = Awaited<ReturnType<typeof prepare>>;

async function prepare(config: CaptureConfig) {
  config.log("Preflight: checking the running sandbox. A capture never builds, reseeds, or restarts it.");
  await check(config);
  const session = await readSession(config);
  if (!session)
    throw new SandboxError("authentication", "No sandbox session is saved.", "Run pnpm daily:up to seed the fixture reader.");
  // A feed cache that expires mid-capture would fail recovery for the wrong reason.
  const required = maximumDurationMs(config) + 60_000;
  const seededAt = session.seededAt ? Date.parse(session.seededAt) : Number.NaN;
  const freshFor = seededAt + FEED_CACHE_MINUTES * 60_000 - Date.now();
  if (!(freshFor >= required))
    throw new SandboxError(
      "feed",
      Number.isNaN(seededAt)
        ? "The saved session does not record when the fixture was seeded, so the feed cache's age is unknown."
        : `The fixture's feed cache expires in ${minutes(freshFor)}, and a capture can take ${minutes(required)}. ` +
            `Daily ignores cache rows older than ${FEED_CACHE_MINUTES} minutes, so recovery would fail for that reason instead of the outage.`,
      "Run pnpm daily:up to refresh the fixture, then rerun pnpm daily:capture.",
    );
  const record = await environmentRecord(config);
  const containers = await verifiedContainers(config, record);
  const files: Record<string, string> = {};
  for (const file of SANDBOX_FILES) files[file] = sha256(await readFile(join(config.root, file)));
  const environment: Environment = {
    composeProject: COMPOSE_PROJECT,
    composeFile: display(config, composeFile(config)),
    apiUrl: apiUrl(config),
    daily: record.daily,
    images: record.images,
    python: record.python,
    containers,
    files,
    environmentRecord: record.file,
  };
  config.log(
    `Verified containers: ${SERVICES.map((service) => `${service} ${short(containers[service].id)} (started ${containers[service].startedAt})`).join(", ")}`,
  );
  return {
    token: session.token,
    containers,
    environment,
    expected: await fixtureArticles(config),
    redactor: new Redactor(await knownCredentials(config, session.token)),
  };
}

/** The longest a capture can take with these settings. */
function maximumDurationMs(config: CaptureConfig) {
  const settings = config.capture;
  const round = PROBES.length * config.requestTimeoutMs;
  return (
    settings.settleMs +
    settings.baselineRounds * round +
    (settings.baselineRounds - 1) * settings.roundPauseMs +
    (settings.stopTimeoutSeconds + 20) * 1_000 +
    settings.outageMs +
    config.requestTimeoutMs +
    settings.recoveryTimeoutMs +
    config.requestTimeoutMs +
    30_000
  );
}

/** pnpm daily:up's record of the source, images, and packages the containers run. */
async function environmentRecord(config: CaptureConfig) {
  const path = statePath(config, "environment.json");
  const hint = "Run pnpm daily:up to record the environment again.";
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new SandboxError("capture", `${display(config, path)} is missing.`, hint);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  const source = field(value, "source"),
    api = field(value, "apiImage"),
    database = field(value, "databaseImage"),
    python = field(value, "python");
  const environment = dailyCaptureManifestSchema.shape.environment.shape;
  const parsed = {
    daily: environment.daily.safeParse({
      repository: field(source, "repository"),
      revision: field(source, "revision"),
      tree: field(source, "tree"),
      files: field(source, "files"),
    }),
    images: environment.images.safeParse({
      api: { name: field(api, "name"), id: field(api, "id"), platform: field(api, "platform") ?? null },
      database: { name: field(database, "name"), id: field(database, "id"), repoDigests: field(database, "repoDigests") },
    }),
    python: environment.python.safeParse({ version: field(python, "version"), packages: field(python, "packages") }),
    file: environment.environmentRecord.safeParse({
      path: display(config, path),
      sha256: sha256(text),
      recordedAt: field(value, "recordedAt"),
    }),
  };
  if (!parsed.daily.success || !parsed.images.success || !parsed.python.success || !parsed.file.success)
    throw new SandboxError("capture", `${display(config, path)} does not describe a complete sandbox.`, hint);
  if (parsed.daily.data.revision !== config.revision)
    throw new SandboxError(
      "capture",
      `${display(config, path)} records Daily ${parsed.daily.data.revision}, not the pinned ${config.revision}.`,
      hint,
    );
  return { daily: parsed.daily.data, images: parsed.images.data, python: parsed.python.data, file: parsed.file.data };
}

/** The three running containers, each verified as this workspace's sandbox service. */
async function verifiedContainers(config: CaptureConfig, record: Awaited<ReturnType<typeof environmentRecord>>) {
  const states = await serviceStates(config);
  const containers: Partial<Record<Service, DailyContainer>> = {};
  const problems: string[] = [];
  for (const service of SERVICES) {
    const state = states.get(service);
    const container = state && (await containerSnapshot(config, service, state.id));
    if (!container) {
      problems.push(`${service} has no container.`);
      continue;
    }
    containers[service] = container;
    problems.push(...ownershipProblems(config, container));
    if (!container.running) problems.push(`${service} is ${container.status}.`);
    const expected = service === "daily-db" ? record.images.database.id : record.images.api.id;
    if (imageOf(container) !== expected)
      problems.push(`${service} runs image ${imageOf(container)}, not ${expected} as recorded by pnpm daily:up.`);
  }
  if (problems.length)
    throw new SandboxError(
      "conflict",
      problems.join("\n"),
      "Nothing was stopped. A capture only targets this workspace's verified sandbox; run pnpm daily:up from this workspace.",
    );
  return containers as Record<Service, DailyContainer>;
}

async function begin(config: CaptureConfig, preflight: Preflight, signal?: AbortSignal): Promise<Context> {
  const root = join(config.stateDir, CAPTURES_DIR);
  await mkdir(root, { recursive: true, mode: 0o700 });
  let captureId: string, dir: string;
  for (let attempt = 1; ; attempt++) {
    captureId = dailyCaptureIdSchema.parse(config.newCaptureId());
    dir = join(root, captureId);
    try {
      // Without recursive, mkdir fails on an existing directory: earlier captures are never reused.
      await mkdir(dir, { mode: 0o700 });
      break;
    } catch (error) {
      if (field(error, "code") !== "EEXIST" || attempt === 5) throw error;
    }
  }
  for (const file of [EVIDENCE, CONTROLLER]) await writeFile(join(dir, file), "", { flag: "wx", mode: 0o600 });
  const ctx: Context = {
    config,
    settings: config.capture,
    signal,
    token: preflight.token,
    expected: preflight.expected,
    containers: preflight.containers,
    environment: preflight.environment,
    recorder: new Recorder(dir, preflight.redactor),
    run: {
      captureId,
      dir,
      createdAt: new Date().toISOString(),
      phase: null,
      rounds: [],
      outageStarted: false,
      outageCompleted: false,
      markerWritten: false,
      stopIssued: false,
      databaseRunning: false,
      outcomes: {},
      cleanup: { required: false, databaseRestored: null, markerRetained: false, detail: "PostgreSQL was not stopped." },
      collectionErrors: [],
      logCounts: {},
    },
  };
  // Written first, so pnpm daily:recover can find a capture whose process dies.
  await writeManifest(ctx, "running", null);
  config.log(`\nCapture ${captureId} -> ${display(config, dir)}`);
  for (const service of SERVICES)
    await ctx.recorder.control({ kind: "container", reason: "verified before the capture", container: ctx.containers[service] });
  return ctx;
}

async function execute(ctx: Context): Promise<CaptureResult> {
  try {
    await sample(ctx);
  } catch (error) {
    await interrupted(ctx, error);
  }
  // Restoration never depends on how sampling ended.
  if (ctx.run.markerWritten) await restoreDatabase(ctx);
  if (ctx.run.databaseRunning) {
    const database = watchDatabase(ctx);
    if (!ctx.run.cancellation && !ctx.run.error)
      await observeRecovery(ctx).catch((error: unknown) => interrupted(ctx, error));
    await database;
  }
  await compareContainers(ctx);
  await collectLogs(ctx);
  return finish(ctx);
}

async function sample(ctx: Context) {
  await pause(ctx, ctx.settings.settleMs);
  ctx.run.windowStart = new Date().toISOString();
  ctx.config.log(`Capture window opened at ${ctx.run.windowStart}.`);
  if (!(await baseline(ctx))) return;
  throwIfCancelled(ctx);
  await outage(ctx);
}

async function baseline(ctx: Context) {
  const { settings } = ctx;
  await phase(ctx, "baseline", "started", `${settings.baselineRounds} rounds of GET /healthz, /feed, /readyz`);
  for (let round = 1; round <= settings.baselineRounds; round++) {
    if (round > 1) await pause(ctx, settings.roundPauseMs);
    const result = await requestRound(ctx, "baseline", round);
    if (!result.ok) {
      ctx.run.stoppedDuring = "baseline";
      await phase(ctx, "baseline", "failed", `round ${round}: ${failures(result)}; PostgreSQL will not be stopped`);
      ctx.config.log("The baseline was not healthy, so PostgreSQL will not be stopped.");
      return false;
    }
  }
  await phase(ctx, "baseline", "completed", `${settings.baselineRounds} healthy rounds`);
  return true;
}

async function outage(ctx: Context) {
  const { settings, run } = ctx;
  const database = ctx.containers["daily-db"];
  await phase(ctx, "outage", "started", `stop daily-db ${short(database.id)}, then repeat the rounds for ${seconds(settings.outageMs)}`);
  await persistMarker(ctx);
  throwIfCancelled(ctx);
  await stopDatabase(ctx);
  run.outageStarted = true;
  // No request starts after the deadline; the one in flight finishes within its own deadline.
  const deadline = performance.now() + settings.outageMs;
  for (let round = 1; performance.now() < deadline; round++) {
    await requestRound(ctx, "outage", round, deadline);
    const remaining = deadline - performance.now();
    if (remaining > 0) await pause(ctx, Math.min(settings.roundPauseMs, remaining));
  }
  run.outageCompleted = true;
  await phase(ctx, "outage", "completed", describeOutage(ctx));
}

async function persistMarker(ctx: Context) {
  const { config, run } = ctx;
  const database = ctx.containers["daily-db"];
  const startedAt = new Date().toISOString();
  const marker: DailyCaptureRecoveryMarker = {
    version: 1,
    captureId: run.captureId,
    pid: process.pid,
    createdAt: startedAt,
    database: {
      id: database.id,
      name: database.name,
      composeProject: database.compose.project,
      composeFile: database.compose.configFiles,
    },
    restoreCommand: ["docker", "start", database.id],
  };
  await writeState(config, RECOVERY_MARKER, dailyCaptureRecoveryMarkerSchema.parse(marker), 0o600);
  run.markerWritten = true;
  await ctx.recorder.control({
    kind: "action",
    action: "persist-recovery-marker",
    target: database.id,
    command: null,
    startedAt,
    endedAt: new Date().toISOString(),
    ok: true,
    exitCode: null,
    detail: `${display(config, statePath(config, RECOVERY_MARKER))} records docker start ${database.id} for pnpm daily:recover.`,
  });
}

async function stopDatabase(ctx: Context) {
  const { config, settings, run } = ctx;
  const database = ctx.containers["daily-db"];
  const args = ["stop", "--timeout", String(settings.stopTimeoutSeconds), database.id];
  config.log(`Stopping only daily-db ${short(database.id)}: docker ${args.join(" ")}`);
  // Set first: even a failed or interrupted stop gets a restoration attempt.
  run.stopIssued = true;
  const result = await docker(config, args, (settings.stopTimeoutSeconds + 20) * 1_000);
  await ctx.recorder.control(actionRecord("stop-database", database.id, args, result));
  const after = await containerSnapshot(config, "daily-db", database.id);
  if (after) await ctx.recorder.control({ kind: "container", reason: "after docker stop", container: after });
  if (!after || after.running)
    throw new SandboxError(
      "capture",
      `daily-db ${short(database.id)} ${after ? "is still running" : "disappeared"} after docker stop (${result.detail}).`,
    );
  run.outcomes.databaseStopped = outcome(
    "passed",
    `daily-db ${short(database.id)} stopped with exit code ${after.exitCode}; daily-api and daily-gateway were not touched`,
    result.endedAt,
    result.elapsedMs,
  );
  config.log(
    `daily-db stopped after ${seconds(result.elapsedMs)} (exit code ${after.exitCode}). Requests continue for ${seconds(settings.outageMs)}.`,
  );
}

async function restoreDatabase(ctx: Context) {
  const { config, settings, run } = ctx;
  const database = ctx.containers["daily-db"];
  const marker = display(config, statePath(config, RECOVERY_MARKER));
  if (!run.stopIssued) {
    // Cancelled between persisting the marker and docker stop.
    await removeMarker(ctx);
    run.cleanup = { required: false, databaseRestored: null, markerRetained: false, detail: "PostgreSQL was never stopped." };
    return;
  }
  await safely(() => phase(ctx, "restore", "started", `docker start ${database.id}`));
  config.log(`Starting the same daily-db container again: docker start ${database.id}`);
  run.restoreStarted = { at: new Date().toISOString(), mono: performance.now() };
  const result = await startDatabase(config, database.id, run.restoreStarted.mono + settings.cleanupTimeoutMs, (fields) =>
    safely(() => ctx.recorder.control(fields)),
  );
  if (!result.running) {
    run.error ??= `daily-db ${short(database.id)} could not be started again`;
    run.stoppedDuring ??= "restore";
    run.outcomes.databaseAvailable = outcome("failed", `daily-db was not started again: ${result.detail}`);
    run.cleanup = {
      required: true,
      databaseRestored: false,
      markerRetained: true,
      detail: `docker start ${database.id} did not leave daily-db running (${result.detail}). ${marker} remains; run pnpm daily:recover.`,
    };
    config.log(`FAILED to start daily-db ${database.id}: ${result.detail}\n${marker} remains. Fix the Docker problem, then run pnpm daily:recover.`);
    await safely(() => phase(ctx, "restore", "failed", result.detail));
    return;
  }
  run.databaseRunning = true;
  const removed = await removeMarker(ctx);
  run.cleanup = {
    required: true,
    databaseRestored: true,
    markerRetained: !removed,
    detail:
      `docker start ${short(database.id)} succeeded${result.attempts > 1 ? ` on attempt ${result.attempts}` : ""}; same container, volume, and data.` +
      (removed ? "" : ` Removing ${marker} failed; pnpm daily:recover will clear it.`),
  };
  config.log(`daily-db ${short(database.id)} is running again.`);
  await safely(() => phase(ctx, "restore", "completed", run.cleanup.detail));
}

async function removeMarker(ctx: Context) {
  const startedAt = new Date().toISOString();
  let failure: string | undefined;
  try {
    await rm(statePath(ctx.config, RECOVERY_MARKER), { force: true });
  } catch (error) {
    failure = errorMessage(error);
  }
  await safely(() =>
    ctx.recorder.control({
      kind: "action",
      action: "remove-recovery-marker",
      target: ctx.containers["daily-db"].id,
      command: null,
      startedAt,
      endedAt: new Date().toISOString(),
      ok: !failure,
      exitCode: null,
      detail: failure ?? `removed ${display(ctx.config, statePath(ctx.config, RECOVERY_MARKER))}`,
    }),
  );
  return !failure;
}

/** docker start the recorded container until it runs, within its own deadline. */
async function startDatabase(
  config: SandboxConfig,
  id: string,
  deadline: number,
  record: (fields: ControllerInput) => Promise<unknown>,
) {
  let detail = "the cleanup deadline passed before docker start ran";
  let attempts = 0;
  while (attempts < 3 && performance.now() < deadline) {
    attempts += 1;
    const args = ["start", id];
    const result = await docker(config, args, Math.max(1_000, Math.min(30_000, deadline - performance.now())));
    await record(actionRecord("start-database", id, args, result));
    let after: DailyContainer | undefined;
    try {
      after = await containerSnapshot(config, "daily-db", id);
      detail = after ? `${result.detail}; daily-db is ${after.status}` : `${result.detail}; container ${id} does not exist`;
    } catch (error) {
      detail = `${result.detail}; ${errorMessage(error)}`;
    }
    if (after) await record({ kind: "container", reason: `after docker start (attempt ${attempts})`, container: after });
    if (after?.running) return { running: true, attempts, detail };
    await delay(Math.max(0, Math.min(1_000, deadline - performance.now())));
  }
  return { running: false, attempts, detail };
}

async function watchDatabase(ctx: Context) {
  const started = ctx.run.restoreStarted!;
  const result = await waitForDatabase(
    ctx.config,
    ctx.containers["daily-db"].id,
    started,
    started.mono + ctx.settings.cleanupTimeoutMs,
    ctx.settings.databasePollMs,
    (fields) => safely(() => ctx.recorder.control(fields)),
  );
  ctx.run.outcomes.databaseAvailable = result;
  ctx.config.log(`${result.status === "passed" ? "Database available" : "Database NOT available"}: ${result.detail}.`);
}

/** Poll the container until Docker's pg_isready health check passes. */
async function waitForDatabase(
  config: SandboxConfig,
  id: string,
  started: { mono: number },
  deadline: number,
  pollMs: number,
  record: (fields: ControllerInput) => Promise<unknown>,
): Promise<DailyCaptureOutcome> {
  let last = "";
  for (;;) {
    let container: DailyContainer | undefined;
    let problem: string | undefined;
    try {
      container = await containerSnapshot(config, "daily-db", id);
    } catch (error) {
      problem = errorMessage(error);
    }
    const state = container ? `${container.status}, health ${container.health ?? "none"}` : (problem ?? "missing");
    if (container && state !== last)
      await record({ kind: "container", reason: "database availability after docker start", container });
    last = state;
    const elapsed = performance.now() - started.mono;
    if (container?.running && (container.health === "healthy" || container.health === null))
      return outcome(
        "passed",
        `daily-db ${short(id)} running${container.health ? " and healthy (pg_isready)" : ""} ${seconds(elapsed)} after docker start`,
        new Date().toISOString(),
        Math.round(elapsed),
      );
    if (container && !container.running)
      return outcome("failed", `daily-db ${short(id)} is ${container.status} (exit code ${container.exitCode}) after docker start`);
    if (!container && !problem) return outcome("failed", `container ${id} no longer exists`);
    if (performance.now() >= deadline)
      return outcome("failed", `daily-db ${short(id)} was not healthy within ${seconds(elapsed)} of docker start (last: ${state})`);
    await delay(pollMs);
  }
}

async function observeRecovery(ctx: Context) {
  const { settings, run } = ctx;
  const started = run.restoreStarted!;
  const deadline = started.mono + settings.recoveryTimeoutMs;
  await phase(
    ctx,
    "recovery",
    "started",
    `up to ${seconds(settings.recoveryTimeoutMs)} after docker start for ${settings.recoveryRounds} consecutive healthy rounds`,
  );
  let streak: RoundResult[] = [];
  let last: RoundResult | undefined;
  for (let round = 1; performance.now() < deadline; round++) {
    last = await requestRound(ctx, "recovery", round, deadline);
    streak = last.ok ? [...streak, last] : [];
    if (streak.length >= settings.recoveryRounds) {
      const elapsed = streak[0].endedMono - started.mono;
      run.outcomes.applicationRecovered = outcome(
        "passed",
        `the first of ${streak.length} consecutive healthy rounds (round ${streak[0].round}) ended ${seconds(elapsed)} after docker start; Daily was not restarted or reseeded`,
        streak[0].endedAt,
        Math.round(elapsed),
      );
      await phase(ctx, "recovery", "completed", run.outcomes.applicationRecovered.detail);
      ctx.config.log(`Application recovered: ${run.outcomes.applicationRecovered.detail}.`);
      return;
    }
    const remaining = deadline - performance.now();
    if (remaining > 0) await pause(ctx, Math.min(settings.roundPauseMs, remaining));
  }
  run.outcomes.applicationRecovered = outcome(
    "failed",
    `no ${settings.recoveryRounds} consecutive healthy rounds within ${seconds(settings.recoveryTimeoutMs)} of docker start` +
      (last ? `; last round: ${failures(last)}` : ""),
  );
  await phase(ctx, "recovery", "failed", run.outcomes.applicationRecovered.detail);
  ctx.config.log(`Application did NOT recover: ${run.outcomes.applicationRecovered.detail}.`);
}

/** Daily's API and gateway must survive the outage without a restart. */
async function compareContainers(ctx: Context) {
  const changes: string[] = [];
  for (const service of ["daily-api", "daily-gateway"] as const) {
    const before = ctx.containers[service];
    let after: DailyContainer | undefined;
    try {
      after = await containerSnapshot(ctx.config, service, before.id);
    } catch (error) {
      changes.push(`${service}: ${errorMessage(error)}`);
      continue;
    }
    if (after) await safely(() => ctx.recorder.control({ kind: "container", reason: "after the capture", container: after }));
    if (!after) changes.push(`${service} ${short(before.id)} no longer exists`);
    else if (!after.running) changes.push(`${service} is ${after.status}`);
    else if (after.startedAt !== before.startedAt || after.restartCount !== before.restartCount)
      changes.push(`${service} restarted (started ${before.startedAt}, now ${after.startedAt}; restarts ${before.restartCount} -> ${after.restartCount})`);
  }
  ctx.run.outcomes.containersUnchanged = changes.length
    ? outcome("failed", changes.join("; "))
    : outcome(
        "passed",
        `daily-api ${short(ctx.containers["daily-api"].id)} and daily-gateway ${short(ctx.containers["daily-gateway"].id)} kept their IDs, start times, and restart counts`,
      );
}

/** API and gateway logs become evidence; database logs stay with the controller. */
async function collectLogs(ctx: Context) {
  const { config, settings, run } = ctx;
  if (!run.windowStart) {
    run.outcomes.evidenceComplete = outcome("not_evaluated", "cancelled before the capture window opened; nothing was recorded");
    return;
  }
  run.windowEnd = new Date().toISOString();
  // Give Docker the window's last lines before asking for them.
  await delay(settings.logMarginMs);
  const since = shift(run.windowStart, -settings.logMarginMs);
  const until = shift(run.windowEnd, settings.logMarginMs);
  run.logRange = { since, until };
  await safely(() => phase(ctx, "collection", "started", `docker logs --since ${since} --until ${until}`));
  for (const service of SERVICES) {
    const id = ctx.containers[service].id;
    const args = ["logs", "--timestamps", "--since", since, "--until", until, id];
    const result = await docker(config, args, 60_000);
    let ok = result.ok,
      detail = result.detail;
    if (result.ok) {
      const lines = parseDockerLogs(result.stdout, result.stderr);
      try {
        await ctx.recorder.logs(service, lines);
        run.logCounts[service] = lines.length;
        const stderr = lines.filter((line) => line.stream === "stderr").length;
        detail = `${lines.length} lines (${lines.length - stderr} stdout, ${stderr} stderr) recorded in ${service === "daily-db" ? CONTROLLER : EVIDENCE}`;
      } catch (error) {
        ok = false;
        detail = `recording failed: ${errorMessage(error)}`;
      }
    }
    if (!ok) run.collectionErrors.push(`${service} logs: ${detail}`);
    await safely(() => ctx.recorder.control({ ...actionRecord("collect-logs", id, args, result), ok, detail }));
  }
  const counts = SERVICES.map((service) => `${service} ${run.logCounts[service] ?? "?"}`).join(", ");
  config.log(`Collected log lines from ${since} to ${until}: ${counts}.`);
  await safely(() =>
    phase(ctx, "collection", run.collectionErrors.length ? "failed" : "completed", run.collectionErrors.join("; ") || counts),
  );
}

async function finish(ctx: Context): Promise<CaptureResult> {
  const { run } = ctx;
  const summary = await summarizeArtifacts(run.dir);
  if (!run.outcomes.evidenceComplete) {
    const problems = [
      ...run.collectionErrors,
      ...ctx.recorder.failures.map((failure) => `recording failed: ${failure}`),
      ...summary.problems,
    ];
    const http = summary.evidence.filter((record) => record.kind === "http").length;
    run.outcomes.evidenceComplete = problems.length
      ? outcome("failed", problems.join("; "))
      : outcome(
          "passed",
          `${http} HTTP observations, ${run.logCounts["daily-api"]} daily-api and ${run.logCounts["daily-gateway"]} daily-gateway log lines in ${EVIDENCE}; ` +
            `${run.logCounts["daily-db"]} daily-db log lines in ${CONTROLLER}`,
        );
  }
  const status = run.cancellation ? "cancelled" : run.error || baselineFailure(ctx) ? "failed" : "completed";
  const manifest = await writeManifest(ctx, status, summary.artifacts);
  await verifyCapture(run.dir);
  printSummary(ctx, manifest);
  const passed = Object.values(manifest.outcomes).every((result) => result.status === "passed");
  const exitCode =
    status === "cancelled"
      ? run.cancellation?.signal === "SIGTERM"
        ? 143
        : 130
      : status === "completed" && passed && !manifest.cleanup.markerRetained
        ? 0
        : 1;
  return { captureId: run.captureId, dir: run.dir, manifest, exitCode };
}

async function writeManifest(ctx: Context, status: DailyCaptureManifest["status"], artifacts: DailyCaptureManifest["artifacts"]) {
  const { config, settings, run } = ctx;
  const manifest = dailyCaptureManifestSchema.parse({
    version: 1,
    captureId: run.captureId,
    status,
    createdAt: run.createdAt,
    finishedAt: status === "running" ? null : new Date().toISOString(),
    settings: {
      requestTimeoutMs: config.requestTimeoutMs,
      roundPauseMs: settings.roundPauseMs,
      baselineRounds: settings.baselineRounds,
      outageMs: settings.outageMs,
      recoveryTimeoutMs: settings.recoveryTimeoutMs,
      recoveryRounds: settings.recoveryRounds,
      stopTimeoutSeconds: settings.stopTimeoutSeconds,
      cleanupTimeoutMs: settings.cleanupTimeoutMs,
    },
    window: run.windowStart ? { start: run.windowStart, end: run.windowEnd ?? null } : null,
    logRange: run.logRange ?? null,
    execution: {
      completed: status === "completed",
      stoppedDuring: status === "running" || status === "completed" ? null : (run.stoppedDuring ?? run.phase),
      cancellation: run.cancellation ?? null,
      error: run.error ?? (baselineFailure(ctx) ? "The baseline was not healthy, so PostgreSQL was not interrupted." : null),
    },
    outcomes: outcomes(ctx),
    cleanup: run.cleanup,
    recovery: null,
    environment: ctx.environment,
    redactions: { ...ctx.recorder.redactor.counts },
    artifacts,
  } satisfies DailyCaptureManifest);
  await writeManifestFile(run.dir, manifest);
  return manifest;
}

async function writeManifestFile(dir: string, manifest: DailyCaptureManifest) {
  const path = join(dir, MANIFEST);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/** Observed outcomes, derived from what the run recorded. */
function outcomes(ctx: Context): DailyCaptureManifest["outcomes"] {
  const { run, settings } = ctx;
  const unreached = outcome(
    "not_evaluated",
    run.cancellation ? `cancelled (${run.cancellation.signal}) before this was established` : run.error ? `not reached: ${run.error}` : "not reached",
  );
  const healthy = run.rounds.filter((round) => round.phase === "baseline" && round.ok).length;
  const failedBaseline = baselineFailure(ctx);
  const outageResults = run.rounds.filter((round) => round.phase === "outage").flatMap((round) => round.results);
  const failed = outageResults.filter((result) => !result.ok).length;
  return {
    baselineHealthy: failedBaseline
      ? outcome("failed", failedBaseline)
      : healthy >= settings.baselineRounds
        ? outcome("passed", `${healthy} healthy rounds: /healthz ok, /feed ready with the ${ctx.expected.length} fixture articles, /readyz ready`)
        : unreached,
    databaseStopped: run.outcomes.databaseStopped ?? unreached,
    outageObserved: !run.outageStarted
      ? unreached
      : failed
        ? outcome("passed", `${failed} of ${outageResults.length} requests failed while daily-db was stopped: ${describeOutage(ctx)}`)
        : run.outageCompleted
          ? outcome("failed", `all ${outageResults.length} requests succeeded while daily-db was stopped`)
          : unreached,
    databaseAvailable: run.outcomes.databaseAvailable ?? unreached,
    applicationRecovered: run.outcomes.applicationRecovered ?? unreached,
    containersUnchanged: run.outcomes.containersUnchanged ?? unreached,
    evidenceComplete: run.outcomes.evidenceComplete ?? unreached,
  };
}

function baselineFailure(ctx: Context) {
  const round = ctx.run.rounds.find((entry) => entry.phase === "baseline" && entry.complete && !entry.ok);
  return round && `baseline round ${round.round}: ${failures(round)}`;
}

/** Each path's results while PostgreSQL was stopped, counted by what was observed. */
function describeOutage(ctx: Context) {
  return PROBES.map(({ path }) => {
    const counts = new Map<string, number>();
    for (const round of ctx.run.rounds.filter((entry) => entry.phase === "outage"))
      for (const result of round.results.filter((entry) => entry.path === path))
        counts.set(result.summary, (counts.get(result.summary) ?? 0) + 1);
    const observed = [...counts].map(([summary, count]) => `${count}x ${summary}`).join(", ");
    return `GET ${path}: ${observed || "no requests"}`;
  }).join("; ");
}

function printSummary(ctx: Context, manifest: DailyCaptureManifest) {
  const { config } = ctx;
  const labels: Record<OutcomeName, string> = {
    baselineHealthy: "baseline",
    databaseStopped: "stop",
    outageObserved: "outage",
    databaseAvailable: "database",
    applicationRecovered: "recovery",
    containersUnchanged: "containers",
    evidenceComplete: "evidence",
  };
  const { execution } = manifest;
  config.log(
    `\nCapture ${manifest.captureId} ${manifest.status}` +
      (execution.cancellation ? ` by ${execution.cancellation.signal}` : "") +
      (execution.error ? `: ${execution.error}` : "."),
  );
  for (const [name, result] of Object.entries(manifest.outcomes) as [OutcomeName, DailyCaptureOutcome][])
    config.log(
      `${result.status === "passed" ? "PASS" : result.status === "failed" ? "FAIL" : "SKIP"}  ${labels[name].padEnd(11)} ${result.detail}`,
    );
  config.log(`Cleanup: ${manifest.cleanup.detail}`);
  const artifacts = manifest.artifacts!;
  config.log(
    `Saved ${display(config, ctx.run.dir)}/\n` +
      `  ${EVIDENCE.padEnd(17)} ${artifacts[EVIDENCE].records} records, sha256 ${artifacts[EVIDENCE].sha256}\n` +
      `  ${CONTROLLER.padEnd(17)} ${artifacts[CONTROLLER].records} records, sha256 ${artifacts[CONTROLLER].sha256}\n` +
      `  ${MANIFEST}`,
  );
}

async function requestRound(ctx: Context, phase: RoundResult["phase"], round: number, deadline?: number) {
  const result: RoundResult = { phase, round, results: [], complete: false, ok: false, endedAt: "", endedMono: 0 };
  ctx.run.rounds.push(result);
  try {
    for (const probe of PROBES) {
      if (deadline !== undefined && performance.now() >= deadline) break;
      const record = await observe(ctx, probe);
      const assessment = assess(probe, record, ctx.expected);
      ctx.config.log(
        `  ${record.id}  GET ${probe.path.padEnd(8)} ${assessment.ok ? "ok  " : "FAIL"}  ${assessment.summary} (${Math.round(record.elapsedMs)} ms)`,
      );
      result.results.push({ evidenceId: record.id, path: probe.path, ...assessment });
    }
    result.complete = result.results.length === PROBES.length;
    result.ok = result.complete && result.results.every((entry) => entry.ok);
  } finally {
    // Also for an interrupted round, so every evidence record maps to its phase.
    result.endedAt = new Date().toISOString();
    result.endedMono = performance.now();
    if (result.results.length)
      await safely(() =>
        ctx.recorder.control({
          kind: "round",
          phase,
          round,
          complete: result.complete,
          ok: result.ok,
          results: result.results.map(({ evidenceId, ok, summary }) => ({ evidenceId, ok, summary })),
        }),
      );
  }
  return result;
}

async function observe(ctx: Context, probe: Probe) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let fields: HttpOutcome;
  try {
    const response = await request(ctx.config, probe.path, {
      token: probe.authenticated ? ctx.token : undefined,
      signal: ctx.signal,
    });
    fields = { outcome: "response", response: describeResponse(response) };
  } catch (error) {
    if (ctx.signal?.aborted) {
      await safely(() =>
        ctx.recorder.control({
          kind: "note",
          level: "info",
          message: `GET ${probe.path} started at ${startedAt} was abandoned by the cancellation; it observed nothing and is not evidence.`,
        }),
      );
      throw new CancelledError();
    }
    fields = field(error, "name") === "TimeoutError" ? { outcome: "timeout" } : { outcome: "network_error", error: networkError(error) };
  }
  return ctx.recorder.http({
    method: "GET",
    path: probe.path,
    authenticated: probe.authenticated,
    startedAt,
    endedAt: new Date().toISOString(),
    elapsedMs: Math.round((performance.now() - started) * 10) / 10,
    deadlineMs: ctx.config.requestTimeoutMs,
    ...fields,
  });
}

function describeResponse(response: Awaited<ReturnType<typeof request>>) {
  const headers: Record<string, string> = {};
  for (const name of RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const bytes = Buffer.byteLength(response.text);
  if (bytes > MAX_BODY_BYTES)
    return {
      status: response.status,
      headers,
      bodyFormat: "text" as const,
      body: response.text.slice(0, MAX_BODY_BYTES),
      bodyBytes: bytes,
      bodyTruncated: true,
    };
  let body: unknown = response.text;
  let bodyFormat: "json" | "text" = "text";
  try {
    body = JSON.parse(response.text);
    bodyFormat = "json";
  } catch {
    // Keep a non-JSON body as text.
  }
  return { status: response.status, headers, bodyFormat, body, bodyBytes: bytes, bodyTruncated: false };
}

function networkError(error: unknown) {
  // fetch rejects with "fetch failed" and keeps the socket error as its cause.
  const cause = field(error, "cause");
  const source = isRecord(cause) ? cause : error;
  const code = field(source, "code");
  return {
    name: String(field(source, "name") ?? "Error"),
    code: typeof code === "string" ? code : null,
    message: String(field(source, "message") ?? source),
  };
}

/** The controller's success criterion for one observation; never stored as evidence. */
function assess(probe: Probe, record: DailyHttpObservation, expected: { id: string; title: string }[]) {
  if (record.outcome === "timeout") return { ok: false, summary: `timed out after ${seconds(record.deadlineMs)}` };
  if (record.outcome === "network_error")
    return { ok: false, summary: `connection error ${record.error.code ?? record.error.name}: ${record.error.message}` };
  const { status, body } = record.response;
  const state = field(body, "status"),
    detail = field(body, "detail");
  const label = typeof state === "string" ? state : typeof detail === "string" ? detail : preview(body);
  if (probe.path !== "/feed") {
    const ok = status === 200 && state === (probe.path === "/healthz" ? "ok" : "ready");
    return { ok, summary: `${status} ${label}` };
  }
  if (status !== 200 || state !== "ready") return { ok: false, summary: `${status} ${label}` };
  const articles = field(body, "articles");
  const observed = Array.isArray(articles) ? articles.map((article) => [field(article, "id"), field(article, "title")]) : [];
  const ok = JSON.stringify(observed) === JSON.stringify(expected.map((article) => [article.id, article.title]));
  return { ok, summary: ok ? `200 ready, the ${expected.length} fixture articles` : "200 ready, but not the fixture articles" };
}

const failures = (round: RoundResult) =>
  round.results
    .filter((result) => !result.ok)
    .map((result) => `GET ${result.path} ${result.summary}`)
    .concat(round.complete ? [] : ["round incomplete"])
    .join(", ") || "none";

async function phase(ctx: Context, name: DailyCapturePhase, status: "started" | "completed" | "failed" | "cancelled" | "skipped", detail: string) {
  if (status === "started") {
    ctx.run.phase = name;
    ctx.config.log(`\nPhase ${name}: ${detail}`);
  }
  await ctx.recorder.control({ kind: "phase", phase: name, status, detail });
}

async function interrupted(ctx: Context, error: unknown) {
  const { run } = ctx;
  run.stoppedDuring ??= run.phase ?? undefined;
  if (ctx.signal?.aborted) {
    const reason = ctx.signal.reason;
    run.cancellation ??= { signal: typeof reason === "string" ? reason : "abort", at: new Date().toISOString() };
    ctx.config.log(
      `\nCancelled (${run.cancellation.signal}) during ${run.phase ?? "the settle pause"}; ` +
        `${run.stopIssued ? "restoring daily-db before exiting" : "PostgreSQL was not stopped"}.`,
    );
  } else {
    run.error ??= errorMessage(error);
    ctx.config.log(`\nCapture error during ${run.phase ?? "the settle pause"}: ${run.error}`);
  }
  if (run.phase)
    await safely(() => phase(ctx, run.phase!, run.cancellation ? "cancelled" : "failed", run.cancellation ? `${run.cancellation.signal} received` : run.error!));
}

class CancelledError extends Error {
  constructor() {
    super("The capture was cancelled.");
    this.name = "CancelledError";
  }
}

function throwIfCancelled(ctx: Context) {
  if (ctx.signal?.aborted) throw new CancelledError();
}

/** A pause that ends early when the capture is cancelled. */
const pause = (ctx: Context, ms: number) => delay(Math.max(0, ms), undefined, { signal: ctx.signal });

/** Cleanup continues when recording fails; Recorder.failures keeps the failure for the manifest. */
async function safely(action: () => Promise<unknown>) {
  try {
    await action();
  } catch {
    // Kept in Recorder.failures.
  }
}

interface DockerResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  detail: string;
}

/** A bounded Docker command in its own process group; never throws. */
async function docker(config: SandboxConfig, args: string[], timeoutMs: number): Promise<DockerResult> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let result: CommandResult | undefined;
  let failure: string | undefined;
  try {
    result = await config.run("docker", args, { timeoutMs, detached: true });
  } catch (error) {
    failure = errorMessage(error);
  }
  const ok = result?.code === 0;
  return {
    ok,
    code: result?.code ?? null,
    stdout: result?.stdout ?? "",
    stderr: result?.stderr ?? "",
    startedAt,
    endedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - started),
    detail:
      failure ??
      (ok ? "exit code 0" : `exit code ${result!.code}${result!.stderr.trim() ? `: ${lastLines(result!.stderr, 1)}` : ""}`),
  };
}

const actionRecord = (
  action: "stop-database" | "start-database" | "collect-logs",
  target: string,
  args: string[],
  result: DockerResult,
): Extract<ControllerInput, { kind: "action" }> => ({
  kind: "action",
  action,
  target,
  command: ["docker", ...args],
  startedAt: result.startedAt,
  endedAt: result.endedAt,
  ok: result.ok,
  exitCode: result.code,
  detail: result.detail,
});

// docker logs --timestamps prefixes every line with an RFC 3339 time and a space.
const LOG_LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?([\s\S]*)$/;

/** Parse both streams, then interleave them by Docker's receive time. */
export function parseDockerLogs(stdout: string, stderr: string): LogLine[] {
  const lines: (LogLine & { order: number })[] = [];
  for (const [stream, text] of [
    ["stdout", stdout],
    ["stderr", stderr],
  ] as const) {
    const rows = text.split("\n");
    if (rows.at(-1) === "") rows.pop();
    rows.forEach((row, order) => {
      const match = LOG_LINE.exec(row);
      lines.push({ stream, timestamp: match?.[1] ?? null, message: match ? match[2] : row, order });
    });
  }
  const key = (timestamp: string | null) =>
    timestamp ? timestamp.replace(/(?:\.(\d+))?Z$/, (_, fraction = "") => `.${fraction.padEnd(9, "0")}Z`) : "";
  return lines
    .sort(
      (a, b) =>
        key(a.timestamp).localeCompare(key(b.timestamp)) ||
        (a.stream === b.stream ? a.order - b.order : a.stream === "stdout" ? -1 : 1),
    )
    .map(({ stream, timestamp, message }) => ({ stream, timestamp, message }));
}

class JsonlFile {
  private pending: Promise<void> = Promise.resolve();
  constructor(readonly path: string) {}
  /** Appends in call order; a failed write rejects only its own caller. */
  append(records: unknown[]) {
    const text = records.map((record) => `${JSON.stringify(record)}\n`).join("");
    const write = this.pending.then(() => appendFile(this.path, text));
    this.pending = write.catch(() => {});
    return write;
  }
}

/** Assigns stable record IDs, redacts, and appends to the capture's two JSONL files. */
class Recorder {
  readonly failures: string[] = [];
  private evidence: JsonlFile;
  private controller: JsonlFile;
  private next = { http: 0, ctl: 0, "daily-api": 0, "daily-gateway": 0, "daily-db": 0 };

  constructor(
    dir: string,
    readonly redactor: Redactor,
  ) {
    this.evidence = new JsonlFile(join(dir, EVIDENCE));
    this.controller = new JsonlFile(join(dir, CONTROLLER));
  }

  /** Continue an existing capture's numbering (pnpm daily:recover). */
  static async resume(dir: string, redactor: Redactor) {
    const recorder = new Recorder(dir, redactor);
    const counters: [RegExp, keyof Recorder["next"]][] = [
      [/^http-(\d+)$/, "http"],
      [/^ctl-(\d+)$/, "ctl"],
      [/^log-api-(\d+)$/, "daily-api"],
      [/^log-gateway-(\d+)$/, "daily-gateway"],
      [/^log-db-(\d+)$/, "daily-db"],
    ];
    for (const file of [EVIDENCE, CONTROLLER])
      for (const line of (await readFile(join(dir, file), "utf8")).split("\n")) {
        let id: unknown;
        try {
          id = field(JSON.parse(line), "id");
        } catch {
          continue;
        }
        for (const [pattern, counter] of counters) {
          const number = Number(pattern.exec(String(id))?.[1]);
          if (number > recorder.next[counter]) recorder.next[counter] = number;
        }
      }
    return recorder;
  }

  async http(fields: Distribute<DailyHttpObservation, "kind" | "id">) {
    const record = { kind: "http", id: `http-${pad(++this.next.http)}`, ...this.redactor.value(fields) } as DailyHttpObservation;
    await this.write(this.evidence, [record]);
    return record;
  }

  async control(fields: ControllerInput) {
    const record = { id: `ctl-${pad(++this.next.ctl)}`, at: new Date().toISOString(), ...this.redactor.value(fields) };
    await this.write(this.controller, [record]);
    return record as DailyCaptureControllerRecord;
  }

  async logs(service: Service, lines: LogLine[]) {
    const prefix = { "daily-api": "log-api", "daily-gateway": "log-gateway", "daily-db": "log-db" }[service];
    const records = lines.map((line) => ({
      kind: "log",
      id: `${prefix}-${pad(++this.next[service])}`,
      service,
      ...this.redactor.value(line),
    }));
    if (records.length) await this.write(service === "daily-db" ? this.controller : this.evidence, records);
  }

  private async write(file: JsonlFile, records: unknown[]) {
    try {
      await file.append(records);
    } catch (error) {
      this.failures.push(`${file.path}: ${errorMessage(error)}`);
      throw error;
    }
  }
}

const pad = (value: number) => String(value).padStart(4, "0");

interface Credential {
  label: string;
  value: string;
}

/** The sandbox's own secrets: never written to a capture artifact. */
async function knownCredentials(config: SandboxConfig, token: string | undefined): Promise<Credential[]> {
  const credentials: Credential[] = [];
  if (token)
    credentials.push(
      { label: "sandbox session token", value: token },
      { label: "sandbox session token hash", value: tokenHash(token) },
    );
  const compose = await readFile(composeFile(config), "utf8");
  for (const [label, key] of [
    ["database password", "POSTGRES_PASSWORD"],
    ["placeholder OpenAI key", "OPENAI_API_KEY"],
  ]) {
    const value = new RegExp(`^\\s*${key}:\\s*"?([^"\\s#]+)`, "m").exec(compose)?.[1];
    if (value) credentials.push({ label, value });
  }
  return credentials;
}

class Redactor {
  readonly counts: Record<string, number> = {};

  constructor(private credentials: Credential[]) {
    for (const { label } of credentials) this.counts[label] = 0;
    this.counts["bearer token"] = 0;
    this.counts["URL password"] = 0;
  }

  text(input: string) {
    let output = input;
    for (const { label, value } of this.credentials) {
      const parts = output.split(value);
      this.counts[label] += parts.length - 1;
      output = parts.join(REDACTED);
    }
    output = output.replace(/\b(Bearer\s+)[\w.~+/=-]{16,}/gi, (_, prefix: string) => {
      this.counts["bearer token"] += 1;
      return `${prefix}${REDACTED}`;
    });
    return output.replace(/\b([a-z][\w+.-]*:\/\/[^\s:/@]+:)(?!\[REDACTED\]@)[^\s@/]+@/gi, (_, prefix: string) => {
      this.counts["URL password"] += 1;
      return `${prefix}${REDACTED}@`;
    });
  }

  value<T>(input: T): T {
    if (typeof input === "string") return this.text(input) as T;
    if (Array.isArray(input)) return input.map((item) => this.value(item)) as T;
    if (isRecord(input)) return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, this.value(item)])) as T;
    return input;
  }
}

interface Restoration {
  detail: string;
}

/**
 * Finish what an interrupted capture could not: start the database it
 * stopped (after verifying the recorded container is this workspace's
 * daily-db), mark its record interrupted, and check that Daily serves again.
 * Never rebuilds, reseeds, or restarts Daily's API.
 */
export async function recover(config: CaptureConfig) {
  await requireDocker(config);
  const { abandoned } = await acquireOperationLock(config, "recover");
  try {
    if (abandoned)
      config.log(
        `Took over the lock left by pnpm daily:${abandoned.operation} (pid ${abandoned.pid}, started ${abandoned.startedAt}); that process is no longer running.`,
      );
    const marker = await readRecoveryMarker(config);
    const unfinished = await unfinishedCaptures(config);
    if (!marker && !unfinished.length) {
      config.log(
        abandoned
          ? `No capture left PostgreSQL stopped. Rerun pnpm daily:${abandoned.operation} if it did not finish.`
          : "Nothing to recover: no capture left PostgreSQL stopped or its record unfinished, and no operation left the sandbox lock.",
      );
      return;
    }
    const session = await readSession(config).catch(() => undefined);
    const credentials = await knownCredentials(config, session?.token);
    const restoration = marker ? await restoreFromMarker(config, marker, credentials) : undefined;
    for (const captureId of unfinished)
      await markInterrupted(config, captureId, captureId === marker?.captureId ? restoration : undefined, credentials);
    if (marker && restoration && !unfinished.includes(marker.captureId))
      await noteLateRestoration(config, marker.captureId, restoration, credentials);
    config.log("Checking that Daily serves again. Nothing is rebuilt, reseeded, or restarted.");
    const elapsed = await waitForReady(config);
    config.log(`Daily answered /healthz and /readyz after ${seconds(elapsed)}.`);
    await check(config);
    config.log("\nRecovered. The sandbox is usable again.");
  } finally {
    await releaseOperationLock();
  }
}

async function readRecoveryMarker(config: CaptureConfig) {
  const path = statePath(config, RECOVERY_MARKER);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (field(error, "code") === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  const parsed = dailyCaptureRecoveryMarkerSchema.safeParse(value);
  if (!parsed.success)
    throw new SandboxError(
      "recovery",
      `${display(config, path)} is not a valid recovery marker, so it does not say which container to start.`,
      "Nothing was started. Inspect the file; if daily-db is running, delete it and rerun pnpm daily:recover.",
    );
  return parsed.data;
}

async function restoreFromMarker(config: CaptureConfig, marker: DailyCaptureRecoveryMarker, credentials: Credential[]) {
  const id = marker.database.id;
  const markerPath = display(config, statePath(config, RECOVERY_MARKER));
  const dir = join(config.stateDir, CAPTURES_DIR, marker.captureId);
  const recorder = await Recorder.resume(dir, new Redactor(credentials)).catch(() => undefined);
  const record = (fields: ControllerInput) => safely(async () => recorder?.control(fields));
  config.log(`Capture ${marker.captureId} stopped daily-db container ${id} and did not confirm its restoration.`);
  const container = await containerSnapshot(config, "daily-db", id);
  if (!container)
    throw new SandboxError(
      "recovery",
      `The recorded daily-db container ${id} no longer exists, so it cannot be started.`,
      `Nothing was started. If it was removed on purpose, delete ${markerPath}, then run pnpm daily:up.`,
    );
  const problems = ownershipProblems(config, container);
  if (problems.length)
    throw new SandboxError(
      "recovery",
      `Refusing to start ${id}: ${problems.join(" ")}`,
      `Nothing was started. ${markerPath} names a container this workspace does not own.`,
    );
  const started = { at: new Date().toISOString(), mono: performance.now() };
  const deadline = started.mono + config.capture.cleanupTimeoutMs;
  let detail = `daily-db ${short(id)} was already running`;
  if (!container.running) {
    config.log(`Starting it: docker start ${id}`);
    const result = await startDatabase(config, id, deadline, record);
    if (!result.running)
      throw new SandboxError(
        "recovery",
        `docker start ${id} did not leave daily-db running: ${result.detail}.`,
        `${markerPath} remains. Fix the Docker problem, then rerun pnpm daily:recover.`,
      );
    detail = `docker start ${short(id)} succeeded`;
  }
  const available = await waitForDatabase(config, id, started, deadline, config.capture.databasePollMs, record);
  config.log(`${available.status === "passed" ? "" : "WARNING: "}${available.detail}.`);
  await rm(statePath(config, RECOVERY_MARKER), { force: true });
  await record({
    kind: "action",
    action: "remove-recovery-marker",
    target: id,
    command: null,
    startedAt: started.at,
    endedAt: new Date().toISOString(),
    ok: true,
    exitCode: null,
    detail: `pnpm daily:recover removed ${markerPath}`,
  });
  return { detail: `${detail}; ${available.detail}` };
}

/** Captures whose process ended before writing a final manifest. */
async function unfinishedCaptures(config: CaptureConfig) {
  const root = join(config.stateDir, CAPTURES_DIR);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if (field(error, "code") === "ENOENT") return [];
    throw error;
  }
  const unfinished: string[] = [];
  for (const entry of entries.sort()) {
    if (!dailyCaptureIdSchema.safeParse(entry).success) continue;
    const manifest = await readFile(join(root, entry, MANIFEST), "utf8")
      .then((text): unknown => JSON.parse(text))
      .catch(() => undefined);
    if (field(manifest, "status") === "running") unfinished.push(entry);
  }
  return unfinished;
}

async function markInterrupted(
  config: CaptureConfig,
  captureId: string,
  restoration: Restoration | undefined,
  credentials: Credential[],
) {
  const dir = join(config.stateDir, CAPTURES_DIR, captureId);
  const manifest = dailyCaptureManifestSchema.parse(JSON.parse(await readFile(join(dir, MANIFEST), "utf8")));
  const recorder = await Recorder.resume(dir, new Redactor(credentials));
  await safely(() =>
    recorder.control({
      kind: "note",
      level: "warning",
      message: "pnpm daily:recover marked this capture interrupted: its process ended without finalizing, and container logs were not collected.",
    }),
  );
  const summary = await summarizeArtifacts(dir);
  const phases = summary.controller.filter((record) => record.kind === "phase");
  const stopped = summary.controller.some((record) => record.kind === "action" && record.action === "stop-database");
  const restartedByCapture = summary.controller.some((record) => record.kind === "action" && record.action === "start-database" && record.ok);
  const unreached = (result: DailyCaptureOutcome) =>
    result.status === "not_evaluated" ? { ...result, detail: "the capture process ended before this was established" } : result;
  const redacted = (await Promise.all([EVIDENCE, CONTROLLER].map((file) => readFile(join(dir, file), "utf8"))))
    .join("")
    .split(REDACTED).length - 1;
  const updated = dailyCaptureManifestSchema.parse({
    ...manifest,
    status: "interrupted",
    execution: {
      completed: false,
      stoppedDuring: phases.at(-1)?.phase ?? null,
      cancellation: null,
      error: "The capture process ended without finalizing (killed or shut down).",
    },
    outcomes: {
      ...(Object.fromEntries(
        Object.entries(manifest.outcomes).map(([name, result]) => [name, unreached(result)]),
      ) as DailyCaptureManifest["outcomes"]),
      evidenceComplete: outcome("failed", "the capture process ended before collecting container logs"),
    },
    cleanup: restoration
      ? { required: true, databaseRestored: true, markerRetained: false, detail: `pnpm daily:recover: ${restoration.detail}` }
      : {
          required: stopped,
          databaseRestored: stopped ? restartedByCapture : null,
          markerRetained: false,
          detail: stopped
            ? "No recovery marker remained: the capture had already started daily-db again."
            : "The capture ended before stopping PostgreSQL.",
        },
    recovery: {
      by: "pnpm daily:recover",
      at: new Date().toISOString(),
      databaseRestored: Boolean(restoration),
      detail: restoration?.detail ?? "no database restoration was needed",
    },
    // Per-credential counts died with the process; count the markers it left.
    redactions: { "[REDACTED] markers left by the interrupted process": redacted },
    artifacts: summary.artifacts,
  } satisfies DailyCaptureManifest);
  await writeManifestFile(dir, updated);
  config.log(`Marked capture ${captureId} interrupted (it stopped during ${updated.execution.stoppedDuring ?? "startup"}).`);
}

/** A capture that finished but could not restart daily-db; recover did it later. */
async function noteLateRestoration(config: CaptureConfig, captureId: string, restoration: Restoration, credentials: Credential[]) {
  const dir = join(config.stateDir, CAPTURES_DIR, captureId);
  let manifest: DailyCaptureManifest;
  try {
    manifest = dailyCaptureManifestSchema.parse(JSON.parse(await readFile(join(dir, MANIFEST), "utf8")));
  } catch {
    return;
  }
  const recorder = await Recorder.resume(dir, new Redactor(credentials));
  await safely(() => recorder.control({ kind: "note", level: "info", message: `pnpm daily:recover started daily-db: ${restoration.detail}` }));
  const at = new Date().toISOString();
  await writeManifestFile(
    dir,
    dailyCaptureManifestSchema.parse({
      ...manifest,
      cleanup: { ...manifest.cleanup, databaseRestored: true, markerRetained: false, detail: `${manifest.cleanup.detail} Later: pnpm daily:recover ${restoration.detail}.` },
      recovery: { by: "pnpm daily:recover", at, databaseRestored: true, detail: restoration.detail },
      artifacts: (await summarizeArtifacts(dir)).artifacts,
    } satisfies DailyCaptureManifest),
  );
  config.log(`Recorded the late restoration in capture ${captureId}.`);
}

const outcome = (
  status: DailyCaptureOutcome["status"],
  detail: string,
  at: string | null = null,
  elapsedMs: number | null = null,
): DailyCaptureOutcome => ({ status, detail, at, elapsedMs });

const imageOf = (container: DailyContainer) => container.image.manifest ?? container.image.id;
const short = (id: string) => id.slice(0, 12);
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const shift = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
const minutes = (ms: number) => `${(Math.max(0, ms) / 60_000).toFixed(1)} min`;
