import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { DailyContainer } from "@agent-lab/contracts/daily-capture";

// The Daily commit the sandbox serves. scenarios/daily/compose.yaml repeats it
// as the image tag and GIT_SHA build argument; a test keeps them in step.
export const DAILY_REVISION = "02afcabf6ec0695c33f4be162bb7d6a5fbecaca1";
const DAILY_REPOSITORY = "https://github.com/mmarufov/Daily.git";
export const COMPOSE_PROJECT = "agent-lab-daily";
export const API_IMAGE = `agent-lab-daily-backend:${DAILY_REVISION}`;
export const DATABASE_IMAGE = "pgvector/pgvector:0.8.0-pg16";
export const SERVICES = ["daily-db", "daily-api", "daily-gateway"] as const;
export type Service = (typeof SERVICES)[number];
const VOLUME = `${COMPOSE_PROJECT}_daily-db-data`;
const INTERNAL_NETWORK = `${COMPOSE_PROJECT}_daily-internal`;
const EDGE_NETWORK = `${COMPOSE_PROJECT}_daily-edge`;
const PROJECT_LABEL = "com.docker.compose.project";
const DATABASE_IMAGE_LABEL = "dev.agent-lab.daily.database-image";
const LAUNCHER_COMMAND = ["python", "/lab/launcher.py"];
// Daily's feed cache TTL (FEED_CACHE_TTL_MINUTES in feed_service.py).
export const FEED_CACHE_MINUTES = 60;
// Only one mutating command (up, stop, reset, capture, recover) runs at a time.
const LOCK_FILE = "operation.lock";
// A capture writes this before stopping PostgreSQL and removes it once the
// database runs again. While it exists, only pnpm daily:recover may proceed.
export const RECOVERY_MARKER = "capture-recovery.json";

const PACKAGES_SCRIPT = `
import importlib.metadata as metadata, json, platform
packages = {d.metadata["Name"]: d.version for d in metadata.distributions() if d.metadata["Name"]}
print(json.dumps({"python": platform.python_version(), "packages": packages}, sort_keys=True))
`;
const EGRESS_PROBE_SCRIPT = `
import json, socket
def attempt(action):
    try:
        action()
    except OSError as error:
        return {"blocked": True, "detail": str(error)}
    return {"blocked": False, "detail": "connected"}
print(json.dumps({
    "dns": attempt(lambda: socket.getaddrinfo("example.com", 443)),
    "tcp": attempt(lambda: socket.create_connection(("1.1.1.1", 443), timeout=3).close()),
}))
`;

export type Stage =
  | "source"
  | "conflict"
  | "docker"
  | "build"
  | "startup"
  | "schema"
  | "seed"
  | "authentication"
  | "feed"
  | "background"
  | "isolation"
  | "capture"
  | "recovery";

const STAGE_LABELS: Record<Stage, string> = {
  source: "source preparation failed",
  conflict: "conflict",
  docker: "Docker command failed",
  build: "build failed",
  startup: "startup failed",
  schema: "schema check failed",
  seed: "seed failed",
  authentication: "authentication check failed",
  feed: "feed check failed",
  background: "background-job check failed",
  isolation: "isolation check failed",
  capture: "capture failed",
  recovery: "recovery failed",
};

export class SandboxError extends Error {
  constructor(
    public stage: Stage,
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

export function formatError(error: unknown) {
  if (!(error instanceof SandboxError))
    return `Daily sandbox command failed: ${errorMessage(error)}`;
  return [`Daily sandbox ${STAGE_LABELS[error.stage]}: ${error.message}`]
    .concat(error.hint ?? [])
    .join("\n");
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  /** Written to stdin; otherwise stdin is closed. */
  input?: string;
  /** Show output in the terminal instead of capturing it. */
  stream?: boolean;
  timeoutMs?: number;
  /** Run in its own process group, so Ctrl+C in the terminal does not reach it. */
  detached?: boolean;
}

export type Runner = (
  command: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

export const runCommand: Runner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const output = options.stream ? "inherit" : "pipe";
    const child = spawn(command, args, {
      stdio: [options.input === undefined ? "ignore" : "pipe", output, output],
      detached: options.detached,
    });
    let stdout = "",
      stderr = "",
      timedOut = false;
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
          }, options.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut)
        reject(new Error(`${describeCommand(command, args)} timed out after ${seconds(options.timeoutMs!)}`));
      else resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input);
  });

export interface SandboxConfig {
  root: string;
  repository: string;
  revision: string;
  host: string;
  port: number;
  sourceDir: string;
  stateDir: string;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  pollIntervalMs: number;
  run: Runner;
  log: (line: string) => void;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function sandboxConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    root: repositoryRoot,
    repository: DAILY_REPOSITORY,
    revision: DAILY_REVISION,
    host: "127.0.0.1",
    port: 8081,
    sourceDir: join(repositoryRoot, ".context/daily-source"),
    stateDir: join(repositoryRoot, ".context/daily-sandbox"),
    startupTimeoutMs: 120_000,
    requestTimeoutMs: 5_000,
    pollIntervalMs: 1_000,
    run: runCommand,
    log: (line) => console.log(line),
    ...overrides,
  };
}

/** The Compose file Docker records on every container this workspace creates. */
export const composeFile = (config: SandboxConfig) => join(config.root, "scenarios/daily/compose.yaml");

export function composeArgs(config: SandboxConfig, args: readonly string[]) {
  return ["compose", "--project-name", COMPOSE_PROJECT, "--file", composeFile(config), ...args];
}

export const apiUrl = (config: SandboxConfig) => `http://${config.host}:${config.port}`;

/** Prepare the pinned source, build, start, wait, seed, record, then check. */
export async function up(config: SandboxConfig) {
  await requireDocker(config);
  await withOperationLock(config, "up", () => upLocked(config));
}

async function upLocked(config: SandboxConfig) {
  await refuseConflicts(config);
  const source = await prepareSource(config);
  config.log(
    `Prepared Daily ${config.revision} backend (${source.files} committed files, tree ${source.tree}) in ${display(config, join(config.sourceDir, "backend"))}`,
  );
  config.log(`Building ${API_IMAGE} with Daily's Dockerfile`);
  await composeStep(config, ["build", "daily-api"], "build", "Fix the build error above, then rerun pnpm daily:up.");
  const imageId = await imageIdentity(config, API_IMAGE);
  config.log(`Built ${API_IMAGE} (${imageId})`);
  config.log(`Starting ${COMPOSE_PROJECT}: ${SERVICES.join(", ")}`);
  await composeStep(
    config,
    ["up", "--detach", "--no-build", "--remove-orphans"],
    "startup",
    "Check pnpm daily:logs, fix the cause, then rerun pnpm daily:up.",
  );
  const elapsed = await waitForReady(config);
  config.log(`Daily answered /healthz and /readyz ${seconds(elapsed)} after its containers started`);
  const session = await ensureSession(config);
  const report = await seed(config, session);
  await writeState(config, "session.json", { ...session, seededAt: new Date().toISOString() }, 0o600);
  const tables = Object.entries(report.tables);
  const fixtureRows = tables.reduce((total, [, table]) => total + table.fixture, 0);
  const existing = tables.reduce((total, [, table]) => total + table.existing, 0);
  config.log(
    `Seeded the fixture in one transaction: ${fixtureRows - existing} rows inserted, ${existing} refreshed` +
      (report.removedCacheRows ? `, ${report.removedCacheRows} extra feed-cache rows removed.` : "."),
  );
  config.log(`Table totals: ${tables.map(([name, table]) => `${name} ${table.total}`).join(", ")}`);
  const environment = await recordEnvironment(config, source, imageId);
  config.log(`Recorded the environment in ${display(config, environment)}`);
  await check(config);
  config.log(
    `\nDaily sandbox ready at ${apiUrl(config)}. Next: pnpm daily:check, pnpm daily:logs, pnpm daily:stop, or pnpm daily:reset.`,
  );
}

/** Check the running sandbox over real HTTP without reseeding or restarting it. */
export async function check(config: SandboxConfig) {
  const pass = (label: string, detail: string) => config.log(`PASS  ${label.padEnd(11)} ${detail}`);
  await refuseDuringCapture(config);
  config.log(`Checking ${COMPOSE_PROJECT} at ${apiUrl(config)} (Daily ${config.revision})`);
  await requireDocker(config);
  const services = await requireRunning(config, "check");
  pass("containers", `${SERVICES.join(", ")} running`);
  const session = await readSession(config);
  if (!session)
    throw new SandboxError(
      "authentication",
      `No sandbox session is saved in ${display(config, statePath(config, "session.json"))}.`,
      "Run pnpm daily:up to seed the fixture reader.",
    );

  const health = await get(config, "/healthz", "startup");
  if (health.status !== 200 || field(health.body, "status") !== "ok")
    throw new SandboxError("startup", `GET /healthz returned ${health.status} ${preview(health.body)}.`, "Check pnpm daily:logs, then rerun pnpm daily:up.");
  const build = field(health.body, "git_sha");
  if (build !== config.revision)
    throw new SandboxError(
      "build",
      `Daily reports build ${JSON.stringify(build)}, not the pinned ${config.revision}.`,
      "Rerun pnpm daily:up to rebuild and restart the API.",
    );
  pass("health", `GET /healthz -> 200 ok, build ${build}`);

  const ready = await get(config, "/readyz", "schema");
  if (ready.status !== 200 || field(ready.body, "status") !== "ready")
    throw new SandboxError(
      "schema",
      `GET /readyz returned ${ready.status} ${preview(ready.body)}; Daily's schema is not ready.`,
      "Check pnpm daily:logs for schema errors, then rerun pnpm daily:up.",
    );
  pass("readiness", "GET /readyz -> 200 ready (database schema initialized)");

  const anonymous = await get(config, "/feed", "authentication");
  if (anonymous.status !== 401)
    throw new SandboxError("authentication", `GET /feed without a token returned ${anonymous.status}; expected 401.`);
  pass("auth", "GET /feed without a token -> 401");
  const unknown = await get(config, "/feed", "authentication", newToken());
  if (unknown.status !== 401)
    throw new SandboxError("authentication", `GET /feed with an unknown token returned ${unknown.status}; expected 401.`);
  pass("auth", "GET /feed with an unknown token -> 401");

  const feed = await get(config, "/feed", "feed", session.token);
  if (feed.status === 401)
    throw new SandboxError(
      "authentication",
      "Daily rejected the saved sandbox session token with 401.",
      "Run pnpm daily:up to reseed the session.",
    );
  if (feed.status !== 200)
    throw new SandboxError("feed", `GET /feed returned ${feed.status} ${preview(feed.body)}.`, "Check pnpm daily:logs, then rerun pnpm daily:up.");
  const status = field(feed.body, "status");
  if (status !== "ready") {
    const age = session.seededAt ? Math.floor((Date.now() - Date.parse(session.seededAt)) / 60_000) : undefined;
    const reason =
      status === "needs_build"
        ? "it found no fresh cached feed. Daily ignores feed-cache rows older than " +
          `${FEED_CACHE_MINUTES} minutes, and the whole cache when the reader's preferences are newer than it.` +
          (age === undefined
            ? ""
            : age >= FEED_CACHE_MINUTES
              ? ` The fixture was seeded ${age} minutes ago.`
              : ` The fixture was seeded ${age} minutes ago, so its cache rows or preferences changed since then.`)
        : status === "needs_discovery"
          ? "it found no active source for the fixture reader."
          : `body ${preview(feed.body)}.`;
    throw new SandboxError(
      "feed",
      `Daily returned feed status ${JSON.stringify(status)} instead of "ready": ${reason}`,
      "Run pnpm daily:up to refresh the fixture and its timestamps.",
    );
  }
  const expected = await fixtureArticles(config);
  const articles = field(feed.body, "articles");
  const observed = Array.isArray(articles)
    ? articles.map((article) => ({ id: String(field(article, "id")), title: String(field(article, "title")) }))
    : undefined;
  if (!observed || JSON.stringify(observed) !== JSON.stringify(expected))
    throw new SandboxError(
      "feed",
      `Daily's feed does not match the fixture.\nExpected:\n${listArticles(expected)}\nObserved:\n${observed ? listArticles(observed) : indent(preview(feed.body))}`,
      "Run pnpm daily:up to restore the fixture.",
    );
  pass("feed", `GET /feed with the sandbox session -> 200 ready, ${observed.length} articles`);
  config.log(listArticles(observed, " ".repeat(18)));

  const leaders = field(health.body, "leader_of");
  if (!Array.isArray(leaders) || leaders.length)
    throw new SandboxError(
      "background",
      `Daily reports background-loop leadership ${JSON.stringify(leaders)}; the loops should be disabled.`,
      "Rerun pnpm daily:up so daily-api starts through scenarios/daily/launcher.py.",
    );
  const api = await inspectContainer(config, services.get("daily-api")!.id);
  const command = field(field(api, "Config"), "Cmd");
  if (JSON.stringify(command) !== JSON.stringify(LAUNCHER_COMMAND))
    throw new SandboxError(
      "background",
      `daily-api runs ${JSON.stringify(command)}, not the Agent Lab launcher.`,
      "Rerun pnpm daily:up.",
    );
  pass("background", "daily-api runs /lab/launcher.py; Daily reports no loop leadership");

  const networks = Object.keys(asRecord(field(field(api, "NetworkSettings"), "Networks")));
  const internal = await inspectResource(config, "network", INTERNAL_NETWORK);
  if (networks.join() !== INTERNAL_NETWORK || field(internal, "Internal") !== true)
    throw new SandboxError(
      "isolation",
      `daily-api is attached to ${networks.join(", ") || "no networks"}; it must be attached only to the internal network ${INTERNAL_NETWORK}.`,
      "Run pnpm daily:reset, then pnpm daily:up.",
    );
  const probe = await requireOk(
    () => config.run("docker", composeArgs(config, ["exec", "-T", "daily-api", "python", "-c", EGRESS_PROBE_SCRIPT]), { timeoutMs: 30_000 }),
    "isolation",
    "The egress probe in daily-api",
  );
  const egress = parseJson(lastLine(probe.stdout), "isolation");
  const dns = field(egress, "dns"),
    tcp = field(egress, "tcp");
  if (field(dns, "blocked") !== true || field(tcp, "blocked") !== true)
    throw new SandboxError(
      "isolation",
      `daily-api reached the outside network (DNS: ${String(field(dns, "detail"))}; TCP 1.1.1.1:443: ${String(field(tcp, "detail"))}).`,
      "Run pnpm daily:reset, then pnpm daily:up.",
    );
  pass(
    "isolation",
    `daily-api is only on ${INTERNAL_NETWORK}; DNS failed (${String(field(dns, "detail"))}), TCP 1.1.1.1:443 failed (${String(field(tcp, "detail"))})`,
  );
}

/** Follow timestamped logs from all sandbox services until Ctrl+C. */
export async function logs(config: SandboxConfig) {
  await requireDocker(config);
  if (!(await serviceStates(config)).size)
    throw new SandboxError("docker", "The sandbox has no containers.", "Run pnpm daily:up first.");
  return (await config.run("docker", composeArgs(config, ["logs", "--follow", "--timestamps"]), { stream: true })).code;
}

/** Stop the sandbox containers; the database volume and session remain. */
export async function stop(config: SandboxConfig) {
  await requireDocker(config);
  await withOperationLock(config, "stop", async () => {
    await composeStep(config, ["stop"], "docker");
    config.log(
      `Stopped ${COMPOSE_PROJECT}. Its database volume and saved session remain; pnpm daily:up starts it again.`,
    );
  });
}

/** Remove only the sandbox's containers, networks, volume, and session state. */
export async function reset(config: SandboxConfig) {
  await requireDocker(config);
  await withOperationLock(config, "reset", async () => {
    const { foreign } = await resourceProblems(config);
    if (foreign.length)
      throw new SandboxError(
        "conflict",
        foreign.join("\n"),
        "Nothing was removed. Remove or rename that resource yourself if it is not needed.",
      );
    await composeStep(config, ["down", "--volumes", "--remove-orphans"], "docker");
    await rm(statePath(config, "session.json"), { force: true });
    config.log(
      `Removed ${COMPOSE_PROJECT}'s containers, networks, and database volume, and deleted the saved session. ` +
        "Built images and the prepared source remain. Run pnpm daily:up to rebuild.",
    );
  });
}

export type Operation = "up" | "stop" | "reset" | "capture" | "recover";

interface OperationLock {
  version: 1;
  operation: Operation;
  pid: number;
  token: string;
  startedAt: string;
}

// The lock this process holds, so signal handlers can release it synchronously.
let heldLock: { path: string; token: string } | undefined;

/**
 * Take the sandbox operation lock. A lock whose process is still running is
 * always refused. Only pnpm daily:recover may take over an abandoned one,
 * because a capture killed mid-outage may have left PostgreSQL stopped.
 */
export async function acquireOperationLock(config: SandboxConfig, operation: Operation) {
  const path = statePath(config, LOCK_FILE);
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const lock: OperationLock = {
    version: 1,
    operation,
    pid: process.pid,
    token: randomBytes(16).toString("hex"),
    startedAt: new Date().toISOString(),
  };
  let abandoned: OperationLock | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      heldLock = { path, token: lock.token };
      return { abandoned };
    } catch (error) {
      if (field(error, "code") !== "EEXIST") throw error;
    }
    const holder = await readLock(path);
    if (holder === "missing") continue;
    if (holder !== "invalid" && (await operationAlive(config, holder.pid)))
      throw new SandboxError(
        "conflict",
        `pnpm daily:${holder.operation} is already running (pid ${holder.pid}, started ${holder.startedAt}).`,
        "Wait for it to finish; only one sandbox operation runs at a time.",
      );
    if (operation !== "recover")
      throw new SandboxError(
        "conflict",
        holder === "invalid"
          ? `${display(config, path)} is not a valid sandbox lock.`
          : `A previous pnpm daily:${holder.operation} (pid ${holder.pid}, started ${holder.startedAt}) ended without releasing the sandbox lock.`,
        "Run pnpm daily:recover. It restores anything an interrupted capture left stopped, then clears the lock.",
      );
    if (holder !== "invalid") abandoned = holder;
    await rm(path, { force: true });
  }
  throw new SandboxError("conflict", `Could not take the sandbox lock ${display(config, path)}.`, "Rerun the command.");
}

/** Release the lock this process holds, if it is still ours. */
export async function releaseOperationLock() {
  const lock = heldLock;
  heldLock = undefined;
  if (!lock) return;
  const current = await readLock(lock.path);
  if (typeof current === "object" && current.token === lock.token) await rm(lock.path, { force: true });
}

/** For signal handlers that exit immediately: the same release, synchronously. */
export function releaseOperationLockSync() {
  const lock = heldLock;
  heldLock = undefined;
  if (!lock) return;
  try {
    if (field(JSON.parse(readFileSync(lock.path, "utf8")), "token") === lock.token) unlinkSync(lock.path);
  } catch {
    // Nothing to release.
  }
}

export async function withOperationLock<T>(config: SandboxConfig, operation: Operation, task: () => Promise<T>) {
  await acquireOperationLock(config, operation);
  try {
    await refuseUnrecoveredCapture(config);
    return await task();
  } finally {
    await releaseOperationLock();
  }
}

/** Refuse while a capture's database restoration is unconfirmed. */
export async function refuseUnrecoveredCapture(config: SandboxConfig) {
  const path = statePath(config, RECOVERY_MARKER);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (field(error, "code") === "ENOENT") return;
    throw error;
  }
  let marker: unknown;
  try {
    marker = JSON.parse(text);
  } catch {
    marker = undefined;
  }
  throw new SandboxError(
    "conflict",
    `Capture ${String(field(marker, "captureId") ?? "(unreadable)")} stopped daily-db container ` +
      `${String(field(field(marker, "database"), "id") ?? "(unknown)")} and did not confirm its restoration (${display(config, path)}).`,
    "Run pnpm daily:recover. It starts that container again, checks Daily, and marks the capture.",
  );
}

/** Read-only commands would add requests and log lines to a running capture. */
async function refuseDuringCapture(config: SandboxConfig) {
  const holder = await readLock(statePath(config, LOCK_FILE));
  if (typeof holder !== "object" || holder.operation !== "capture" || holder.pid === process.pid) return;
  if (await operationAlive(config, holder.pid))
    throw new SandboxError(
      "conflict",
      `pnpm daily:capture is running (pid ${holder.pid}); these requests would land in its evidence window.`,
      "Wait for the capture to finish, then rerun.",
    );
}

async function readLock(path: string): Promise<OperationLock | "missing" | "invalid"> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    return field(error, "code") === "ENOENT" ? "missing" : "invalid";
  }
  const [operation, pid, token, startedAt] = ["operation", "pid", "token", "startedAt"].map((key) => field(value, key));
  if (
    field(value, "version") !== 1 ||
    !["up", "stop", "reset", "capture", "recover"].includes(String(operation)) ||
    !Number.isInteger(pid) ||
    typeof token !== "string" ||
    typeof startedAt !== "string"
  )
    return "invalid";
  return { version: 1, operation: operation as Operation, pid: pid as number, token, startedAt };
}

async function operationAlive(config: SandboxConfig, pid: number) {
  if (pid === process.pid) return true;
  try {
    // ps exits 1 when the process is gone. After a restart a recorded PID often
    // belongs to an unrelated program, so the command line must match too.
    const result = await config.run("ps", ["-o", "command=", "-p", String(pid)], { timeoutMs: 10_000 });
    return result.code === 0 && result.stdout.includes("daily-sandbox");
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return field(error, "code") === "EPERM";
    }
  }
}

export async function requireDocker(config: SandboxConfig) {
  let result: CommandResult;
  try {
    result = await config.run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 20_000 });
  } catch (error) {
    throw new SandboxError("docker", `Docker is unavailable (${errorMessage(error)}).`, "Install or start Docker Desktop, then rerun the command.");
  }
  if (result.code !== 0)
    throw new SandboxError(
      "docker",
      `Docker is not running: ${lastLines(result.stderr, 1) || `docker info exited with code ${result.code}`}`,
      "Start Docker Desktop, then rerun the command.",
    );
}

async function refuseConflicts(config: SandboxConfig) {
  const { foreign, incompatible } = await resourceProblems(config);
  const problems = [...foreign, ...incompatible];
  const hints = [
    `The sandbox only uses Compose project ${COMPOSE_PROJECT} at ${config.host}:${config.port}; it does not pick another target.`,
  ];
  const gateway = (await serviceStates(config)).get("daily-gateway");
  const ownsPort =
    gateway?.state === "running" &&
    gateway.publishers.some((publisher) => publisher.url === config.host && publisher.publishedPort === config.port);
  if (!ownsPort && (await portInUse(config.host, config.port))) {
    problems.push(`${config.host}:${config.port} is already in use by another process.`);
    hints.push(`Find it with lsof -nP -iTCP:${config.port} -sTCP:LISTEN, stop it, then rerun pnpm daily:up.`);
  }
  if (foreign.length)
    hints.push("Remove or rename the conflicting resource yourself if it is not needed; the sandbox never deletes resources it did not create.");
  else if (incompatible.length)
    hints.push("pnpm daily:reset recreates the sandbox's own resources; it deletes the sandbox database.");
  if (problems.length) throw new SandboxError("conflict", problems.join("\n"), hints.join("\n"));
}

async function resourceProblems(config: SandboxConfig) {
  const foreign: string[] = [],
    incompatible: string[] = [];
  const volume = await inspectResource(config, "volume", VOLUME);
  if (volume) {
    const labels = asRecord(field(volume, "Labels"));
    if (labels[PROJECT_LABEL] !== COMPOSE_PROJECT)
      foreign.push(`Volume ${VOLUME} exists but was not created by Compose project ${COMPOSE_PROJECT}.`);
    else if (labels[DATABASE_IMAGE_LABEL] !== DATABASE_IMAGE)
      incompatible.push(
        `Volume ${VOLUME} holds data for ${String(labels[DATABASE_IMAGE_LABEL] ?? "an unrecorded database image")}, not ${DATABASE_IMAGE}.`,
      );
  }
  for (const [name, internal] of [
    [INTERNAL_NETWORK, true],
    [EDGE_NETWORK, false],
  ] as const) {
    const network = await inspectResource(config, "network", name);
    if (!network) continue;
    if (asRecord(field(network, "Labels"))[PROJECT_LABEL] !== COMPOSE_PROJECT)
      foreign.push(`Network ${name} exists but was not created by Compose project ${COMPOSE_PROJECT}.`);
    else if (field(network, "Internal") !== internal)
      incompatible.push(`Network ${name} has internal=${String(field(network, "Internal"))}; the sandbox requires internal=${internal}.`);
  }
  const containers = await query(config, ["ps", "--all", "--format", `{{.Names}}\t{{.Label "${PROJECT_LABEL}"}}`]);
  const names = new Set(SERVICES.map((service) => `${COMPOSE_PROJECT}-${service}-1`));
  for (const line of containers.stdout.split("\n")) {
    const [name, project] = line.split("\t");
    if (names.has(name) && project !== COMPOSE_PROJECT)
      foreign.push(`Container ${name} exists but belongs to ${project ? `Compose project ${project}` : "no Compose project"}.`);
  }
  return { foreign, incompatible };
}

async function portInUse(host: string, port: number) {
  const bindable = await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host, port }, () => server.close(() => resolve(true)));
  });
  if (!bindable) return true;
  // A wildcard listener can coexist with a loopback bind on macOS; connecting finds it.
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(1_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

async function prepareSource(config: SandboxConfig) {
  if (!/^[0-9a-f]{40}$/.test(config.revision))
    throw new SandboxError("source", `The pinned Daily revision must be a full commit SHA, not ${config.revision}.`);
  const repository = join(config.sourceDir, "repository.git");
  const git = (args: string[], options?: CommandOptions) => config.run("git", ["-C", repository, ...args], options);
  await mkdir(config.sourceDir, { recursive: true });
  if (!(await exists(join(repository, "HEAD"))))
    await requireOk(() => config.run("git", ["init", "--bare", "--quiet", repository]), "source", "git init");
  let present: CommandResult;
  try {
    present = await git(["cat-file", "-t", config.revision]);
  } catch (error) {
    throw new SandboxError("source", `Git is unavailable (${errorMessage(error)}).`, "Install Git, then rerun pnpm daily:up.");
  }
  // Commits are content-addressed: an object with this ID is exactly the pinned commit.
  if (present.code !== 0 || present.stdout.trim() !== "commit") {
    config.log(`Fetching Daily ${config.revision} from ${config.repository}`);
    await requireOk(
      () => git(["fetch", "--depth=1", "--no-tags", config.repository, config.revision], { stream: true, timeoutMs: 300_000 }),
      "source",
      `git fetch of ${config.revision} from ${config.repository}`,
    );
  }
  const tree = (await requireOk(() => git(["rev-parse", "--verify", `${config.revision}:backend`]), "source", "Finding Daily's backend directory")).stdout.trim();
  const files = (
    await requireOk(() => git(["ls-tree", "-r", "--name-only", config.revision, "--", "backend"]), "source", "Listing Daily's backend")
  ).stdout
    .split("\n")
    .filter(Boolean);
  const environmentFiles = files.filter((file) => /(^|\/)\.env(\.[^/]*)?$/.test(file) && !file.endsWith("/.env.example"));
  if (environmentFiles.length)
    throw new SandboxError(
      "source",
      `Daily ${config.revision} commits environment files (${environmentFiles.join(", ")}); refusing to build from them.`,
    );
  // Extract fresh committed files every time, so local edits never reach the image.
  const staging = join(config.sourceDir, `.extract-${process.pid}`);
  const target = join(config.sourceDir, "backend");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging);
  try {
    const archive = join(staging, "backend.tar");
    await requireOk(() => git(["archive", "--format=tar", `--output=${archive}`, config.revision, "backend"]), "source", "git archive");
    await requireOk(() => config.run("tar", ["-xf", archive, "-C", staging]), "source", "Extracting Daily's backend");
    await rm(target, { recursive: true, force: true });
    await rename(join(staging, "backend"), target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const source = { repository: config.repository, revision: config.revision, path: "backend", tree, files: files.length };
  await writeFile(join(config.sourceDir, "source.json"), `${JSON.stringify({ ...source, extractedAt: new Date().toISOString() }, null, 2)}\n`);
  return source;
}

export async function waitForReady(config: SandboxConfig) {
  const started = performance.now(),
    deadline = started + config.startupTimeoutMs;
  let healthy = false,
    last = "no response yet";
  // Each request gets five seconds, or what is left of the window if that is less.
  const attempt = async (path: string) => {
    const timeoutMs = Math.max(1, Math.floor(Math.min(config.requestTimeoutMs, deadline - performance.now())));
    try {
      return await request(config, path, { timeoutMs });
    } catch (error) {
      // A request cut short by the end of the window says nothing new about Daily.
      if (timeoutMs < config.requestTimeoutMs && field(error, "name") === "TimeoutError") return undefined;
      throw error;
    }
  };
  for (;;) {
    await requireRunning(config, "startup");
    try {
      const health = await attempt("/healthz");
      if (health?.status === 200 && field(health.body, "status") === "ok") {
        healthy = true;
        const ready = await attempt("/readyz");
        if (ready?.status === 200 && field(ready.body, "status") === "ready") return performance.now() - started;
        if (ready) last = `GET /readyz returned ${ready.status} ${preview(ready.body)}`;
      } else if (health) last = `GET /healthz returned ${health.status} ${preview(health.body)}`;
    } catch (error) {
      last = `last request failed: ${describeRequestError(error)}`;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      const window = seconds(config.startupTimeoutMs);
      if (healthy)
        throw new SandboxError(
          "schema",
          `Daily answered /healthz but /readyz was not ready within ${window} (${last}).${await logTail(config, ["daily-api"])}`,
          "Daily's schema initialization did not finish. Fix the cause, then rerun pnpm daily:up.",
        );
      throw new SandboxError(
        "startup",
        `Daily did not answer /healthz at ${apiUrl(config)} within ${window} (${last}).${await logTail(config, ["daily-api", "daily-gateway"])}`,
        "Check pnpm daily:logs, then rerun pnpm daily:up.",
      );
    }
    await delay(Math.min(config.pollIntervalMs, remaining));
  }
}

async function requireRunning(config: SandboxConfig, during: "startup" | "check") {
  const services = await serviceStates(config);
  const stopped = SERVICES.filter((name) => services.get(name)?.state !== "running");
  if (!stopped.length) return services;
  const describe = (name: string) => {
    const service = services.get(name);
    if (!service) return `${name} has no container`;
    return service.state === "exited" ? `${name} exited with code ${service.exitCode}` : `${name} is ${service.state}`;
  };
  if (during === "check" && stopped.length === SERVICES.length)
    throw new SandboxError("startup", `The sandbox is not running (${stopped.map(describe).join("; ")}).`, "Run pnpm daily:up to start it.");
  const logs = services.has(stopped[0]) ? await logTail(config, [stopped[0]]) : "";
  throw new SandboxError(
    stopped[0] === "daily-api" && logs.includes("Schema setup failed") ? "schema" : "startup",
    `${describe(stopped[0])}${during === "startup" ? " during startup" : ""}.${logs}`,
    "Fix the cause shown in the logs, then rerun pnpm daily:up.",
  );
}

interface ServiceState {
  id: string;
  state: string;
  exitCode: number;
  publishers: { url: string; publishedPort: number }[];
}

export async function serviceStates(config: SandboxConfig) {
  const result = await query(config, composeArgs(config, ["ps", "--all", "--format", "json"]));
  const services = new Map<string, ServiceState>();
  const text = result.stdout.trim();
  // Compose prints one JSON object per line; older releases print one array.
  const entries: unknown[] = !text
    ? []
    : text.startsWith("[")
      ? asArray(parseJson(text))
      : text.split("\n").map((line) => parseJson(line));
  for (const entry of entries) {
    const service = field(entry, "Service");
    if (typeof service !== "string") continue;
    services.set(service, {
      id: String(field(entry, "ID")),
      state: String(field(entry, "State")),
      exitCode: Number(field(entry, "ExitCode") ?? 0),
      publishers: asArray(field(entry, "Publishers")).map((publisher) => ({
        url: String(field(publisher, "URL")),
        publishedPort: Number(field(publisher, "PublishedPort")),
      })),
    });
  }
  return services;
}

async function seed(config: SandboxConfig, session: Session) {
  const result = await requireOk(
    () =>
      config.run("docker", composeArgs(config, ["exec", "-T", "daily-api", "python", "/lab/seed.py"]), {
        // The token stays on the Mac; Daily's database receives only its hash.
        input: JSON.stringify({ tokenHash: tokenHash(session.token) }),
        timeoutMs: 60_000,
      }),
    "seed",
    "scenarios/daily/seed.py",
  );
  const report = parseJson(lastLine(result.stdout), "seed");
  const tables = asRecord(field(report, "tables"));
  const parsed: Record<string, { fixture: number; existing: number; total: number }> = {};
  for (const [name, table] of Object.entries(tables)) {
    const [fixture, existing, total] = ["fixture", "existing", "total"].map((key) => field(table, key));
    if (![fixture, existing, total].every(Number.isInteger))
      throw new SandboxError("seed", `seed.py printed an invalid report: ${preview(report)}`);
    parsed[name] = { fixture: fixture as number, existing: existing as number, total: total as number };
  }
  if (!Object.keys(parsed).length) throw new SandboxError("seed", `seed.py printed an invalid report: ${preview(report)}`);
  return { tables: parsed, removedCacheRows: Number(field(report, "removedCacheRows") ?? 0) };
}

async function recordEnvironment(config: SandboxConfig, source: Awaited<ReturnType<typeof prepareSource>>, imageId: string) {
  const services = await serviceStates(config);
  const api = await inspectContainer(config, services.get("daily-api")!.id);
  if (containerImage(api) !== imageId)
    throw new SandboxError(
      "startup",
      `daily-api runs image ${containerImage(api)}, not the image just built (${imageId}).`,
      "Rerun pnpm daily:up.",
    );
  const database = await inspectContainer(config, services.get("daily-db")!.id);
  const repoDigests = parseJson(
    (await query(config, ["image", "inspect", "--format", "{{json .RepoDigests}}", DATABASE_IMAGE])).stdout,
  );
  const python = parseJson(
    lastLine(
      (
        await requireOk(
          () => config.run("docker", composeArgs(config, ["exec", "-T", "daily-api", "python", "-c", PACKAGES_SCRIPT]), { timeoutMs: 30_000 }),
          "startup",
          "Listing Daily's Python packages",
        )
      ).stdout,
    ),
    "startup",
  );
  return writeState(config, "environment.json", {
    version: 1,
    recordedAt: new Date().toISOString(),
    composeProject: COMPOSE_PROJECT,
    apiUrl: apiUrl(config),
    source,
    apiImage: { name: API_IMAGE, id: imageId, platform: field(field(api, "ImageManifestDescriptor"), "platform") },
    databaseImage: { name: DATABASE_IMAGE, id: containerImage(database), repoDigests },
    python: { version: field(python, "python"), packages: field(python, "packages") },
    runtime: { uvicornWorkers: 1, backgroundJobs: "disabled", apiNetwork: INTERNAL_NETWORK },
  });
}

export interface Session {
  version: 1;
  token: string;
  createdAt: string;
  seededAt?: string;
}

/** A 32-character URL-safe token, the shape Daily's sign-in handlers issue. */
function newToken() {
  return randomBytes(24).toString("base64url");
}

/** Daily stores sessions.token_hash as the SHA-256 hex digest of the token. */
export function tokenHash(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function readSession(config: SandboxConfig): Promise<Session | undefined> {
  const path = statePath(config, "session.json");
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
  const token = field(value, "token"),
    createdAt = field(value, "createdAt"),
    seededAt = field(value, "seededAt");
  if (field(value, "version") !== 1 || typeof token !== "string" || !/^[\w-]{32}$/.test(token) || typeof createdAt !== "string")
    throw new SandboxError(
      "authentication",
      `${display(config, path)} is not a valid sandbox session file.`,
      "Run pnpm daily:reset, then pnpm daily:up.",
    );
  return { version: 1, token, createdAt, ...(typeof seededAt === "string" ? { seededAt } : {}) };
}

async function ensureSession(config: SandboxConfig) {
  const saved = await readSession(config);
  if (saved) return saved;
  const session: Session = { version: 1, token: newToken(), createdAt: new Date().toISOString() };
  await writeState(config, "session.json", session, 0o600);
  return session;
}

export const statePath = (config: SandboxConfig, name: string) => join(config.stateDir, name);

export async function writeState(config: SandboxConfig, name: string, value: unknown, mode = 0o644) {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const path = statePath(config, name),
    temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, path);
  return path;
}

export async function fixtureArticles(config: SandboxConfig) {
  const fixture: unknown = JSON.parse(await readFile(join(config.root, "scenarios/daily/fixture.json"), "utf8"));
  return asArray(field(fixture, "articles")).map((article) => ({
    id: String(field(article, "id")),
    title: String(field(article, "title")),
  }));
}

export async function request(
  config: SandboxConfig,
  path: string,
  options: { token?: string; timeoutMs?: number; signal?: AbortSignal } = {},
) {
  // The deadline covers the headers and the body; signal cancels earlier.
  const deadline = AbortSignal.timeout(options.timeoutMs ?? config.requestTimeoutMs);
  const response = await fetch(new URL(path, apiUrl(config)), {
    // A new connection per request, so each result belongs to its own request.
    // After an unhandled error Uvicorn closes the connection, and a reused
    // socket would fail the next request before it ever reached Daily.
    headers: { connection: "close", ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }) },
    cache: "no-store",
    redirect: "error",
    signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep non-JSON bodies as text for error messages.
  }
  return { status: response.status, body, text, headers: response.headers };
}

async function get(config: SandboxConfig, path: string, stage: Stage, token?: string) {
  try {
    return await request(config, path, { token });
  } catch (error) {
    throw new SandboxError(
      stage,
      `GET ${path} failed: ${describeRequestError(error)}.`,
      "Check pnpm daily:logs, then rerun pnpm daily:up.",
    );
  }
}

function describeRequestError(error: unknown) {
  if (field(error, "name") === "TimeoutError") return "the request timed out";
  const cause = field(error, "cause");
  return typeof field(cause, "message") === "string" ? String(field(cause, "message")) : errorMessage(error);
}

async function composeStep(config: SandboxConfig, args: string[], stage: Stage, hint?: string) {
  let result: CommandResult;
  try {
    result = await config.run("docker", composeArgs(config, args), { stream: true });
  } catch (error) {
    throw new SandboxError(stage, `docker compose ${args[0]} failed: ${errorMessage(error)}.`, hint);
  }
  if (result.code !== 0) {
    const logs = stage === "startup" ? await logTail(config, ["daily-db", "daily-api"]) : "";
    throw new SandboxError(stage, `docker compose ${args[0]} exited with code ${result.code}; its output is above.${logs}`, hint);
  }
}

async function requireOk(command: () => Promise<CommandResult>, stage: Stage, action: string) {
  let result: CommandResult;
  try {
    result = await command();
  } catch (error) {
    throw new SandboxError(stage, `${action} failed: ${errorMessage(error)}.`);
  }
  if (result.code !== 0) {
    const detail = lastLines(result.stderr, 5);
    throw new SandboxError(stage, `${action} exited with code ${result.code}${detail ? `:\n${indent(detail)}` : "."}`);
  }
  return result;
}

const query = (config: SandboxConfig, args: string[], stage: Stage = "docker") =>
  requireOk(() => config.run("docker", args, { timeoutMs: 30_000 }), stage, describeCommand("docker", args));

/** "docker compose ps" rather than the full argument list with its file path. */
function describeCommand(command: string, args: readonly string[]) {
  return [command, ...(command === "docker" && args[0] === "compose" ? ["compose", args[5]] : args.slice(0, 2))].join(" ");
}

async function inspectResource(config: SandboxConfig, kind: "volume" | "network", name: string) {
  let result: CommandResult;
  try {
    result = await config.run("docker", [kind, "inspect", "--format", "{{json .}}", name], { timeoutMs: 30_000 });
  } catch (error) {
    throw new SandboxError("docker", `docker ${kind} inspect ${name} failed: ${errorMessage(error)}.`);
  }
  if (result.code === 0) return asRecord(parseJson(result.stdout));
  if (/no such|not found/i.test(result.stderr)) return undefined;
  throw new SandboxError("docker", `docker ${kind} inspect ${name} failed: ${lastLines(result.stderr, 1)}`);
}

async function inspectContainer(config: SandboxConfig, id: string) {
  return asRecord(parseJson((await query(config, ["inspect", "--format", "{{json .}}", id])).stdout));
}

/** A container's identity and state, or undefined when Docker has no such container. */
export async function containerSnapshot(config: SandboxConfig, service: Service, id: string): Promise<DailyContainer | undefined> {
  const args = ["container", "inspect", "--format", "{{json .}}", id];
  let result: CommandResult;
  try {
    result = await config.run("docker", args, { timeoutMs: 30_000, detached: true });
  } catch (error) {
    throw new SandboxError("docker", `docker container inspect ${id} failed: ${errorMessage(error)}.`);
  }
  if (result.code !== 0) {
    if (/no such container/i.test(result.stderr)) return undefined;
    throw new SandboxError("docker", `docker container inspect ${id} failed: ${lastLines(result.stderr, 1) || `exit code ${result.code}`}`);
  }
  const container = parseJson(result.stdout);
  const state = field(container, "State");
  const labels = asRecord(field(field(container, "Config"), "Labels"));
  const health = field(field(state, "Health"), "Status");
  const manifest = field(field(container, "ImageManifestDescriptor"), "digest");
  return {
    service,
    id: String(field(container, "Id")),
    name: String(field(container, "Name")),
    image: {
      reference: String(field(field(container, "Config"), "Image")),
      id: String(field(container, "Image")),
      manifest: typeof manifest === "string" ? manifest : null,
    },
    running: field(state, "Running") === true,
    status: String(field(state, "Status")),
    startedAt: String(field(state, "StartedAt")),
    finishedAt: String(field(state, "FinishedAt")),
    exitCode: Number(field(state, "ExitCode") ?? 0),
    health: typeof health === "string" ? health : null,
    restartCount: Number(field(container, "RestartCount") ?? 0),
    compose: {
      project: String(labels[PROJECT_LABEL] ?? ""),
      service: String(labels["com.docker.compose.service"] ?? ""),
      configFiles: String(labels["com.docker.compose.project.config_files"] ?? ""),
      configHash: String(labels["com.docker.compose.config-hash"] ?? ""),
    },
  };
}

/** Why a container is not this workspace's sandbox service; empty when it is. */
export function ownershipProblems(config: SandboxConfig, container: DailyContainer) {
  const { service } = container;
  const label = `${service} container ${container.id.slice(0, 12)}`;
  const expectedName = `/${COMPOSE_PROJECT}-${service}-1`;
  const problems: string[] = [];
  if (container.compose.project !== COMPOSE_PROJECT)
    problems.push(
      `${label} belongs to ${container.compose.project ? `Compose project ${container.compose.project}` : "no Compose project"}, not ${COMPOSE_PROJECT}.`,
    );
  if (container.compose.service !== service)
    problems.push(`${label} is Compose service ${container.compose.service || "(none)"}, not ${service}.`);
  // Other workspaces of this repository use the same project name; the file tells them apart.
  if (container.compose.configFiles !== composeFile(config))
    problems.push(
      `${label} was created from ${container.compose.configFiles || "an unrecorded Compose file"}, not this workspace's ${composeFile(config)}.`,
    );
  if (container.name !== expectedName) problems.push(`${label} is named ${container.name}, not ${expectedName}.`);
  return problems;
}

// An image digest that survives cached rebuilds. With Docker's containerd image
// store, .Id names an image index whose build attestation changes on every
// build, so use the platform manifest; the classic store's .Id is already stable.
async function imageIdentity(config: SandboxConfig, reference: string) {
  const image = asRecord(parseJson((await query(config, ["image", "inspect", "--format", "{{json .}}", reference], "build")).stdout));
  if (!String(field(field(image, "Descriptor"), "mediaType")).includes("index")) return String(field(image, "Id"));
  const platform = [field(image, "Os"), field(image, "Architecture"), field(image, "Variant")].filter(Boolean).join("/");
  return (await query(config, ["image", "inspect", "--platform", platform, "--format", "{{.Id}}", reference], "build")).stdout.trim();
}

const containerImage = (container: unknown) =>
  String(field(field(container, "ImageManifestDescriptor"), "digest") ?? field(container, "Image"));

async function logTail(config: SandboxConfig, services: string[]) {
  try {
    const result = await config.run("docker", composeArgs(config, ["logs", "--no-color", "--tail", "20", ...services]), {
      timeoutMs: 20_000,
    });
    const text = `${result.stdout}${result.stderr}`.trim();
    return text ? `\nLast log lines:\n${indent(text)}` : "";
  } catch {
    return "";
  }
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function parseJson(text: string, stage: Stage = "docker"): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SandboxError(stage, `Expected JSON output but received: ${preview(text)}`);
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const field = (value: unknown, key: string) => (isRecord(value) ? value[key] : undefined);
export const asRecord = (value: unknown) => (isRecord(value) ? value : {});
const asArray = (value: unknown) => (Array.isArray(value) ? (value as unknown[]) : []);
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const lastLines = (text: string, count: number) => text.trim().split("\n").slice(-count).join("\n").trim();
const lastLine = (text: string) => lastLines(text, 1);
const indent = (text: string, prefix = "  ") => text.split("\n").map((line) => `${prefix}${line}`).join("\n");
export const seconds = (ms: number) => `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
export const display = (config: SandboxConfig, path: string) => relative(config.root, path) || ".";
const listArticles = (articles: { id: string; title: string }[], prefix = "  ") =>
  articles.map((article, index) => `${prefix}${index + 1}. ${article.id}  ${article.title}`).join("\n") || `${prefix}(none)`;

export function preview(value: unknown) {
  const text = typeof value === "string" ? value : String(JSON.stringify(value));
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}
