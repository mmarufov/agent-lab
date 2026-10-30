import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { captureConfig, type CaptureConfig, type CaptureSettings } from "./daily-capture";
import {
  API_IMAGE,
  COMPOSE_PROJECT,
  composeFile,
  DATABASE_IMAGE,
  runCommand,
  SandboxError,
  SERVICES,
  tokenHash,
  type CommandOptions,
  type CommandResult,
  type Runner,
} from "./daily-sandbox";

// Shared by the Daily sandbox and capture tests. Docker is faked here;
// git, tar, HTTP, sockets, and the filesystem are real.
export const INTERNAL_NETWORK = `${COMPOSE_PROJECT}_daily-internal`;
export const ROOT = captureConfig().root;
export const SESSION_TOKEN = "sandbox-session-token-0123456789";
const STARTED_AT = "2026-10-21T03:58:37.249270008Z";
export const articles: { id: string; title: string }[] = JSON.parse(
  readFileSync(join(ROOT, "scenarios/daily/fixture.json"), "utf8"),
).articles.map(({ id, title }: { id: string; title: string }) => ({ id, title }));

export type Reply = [status: number, body: unknown] | "hang" | "reset";

export interface FakeContainer {
  state: string;
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
  restartCount?: number;
  /** daily-db's health check passes from this time (ms) on. */
  healthyAt?: number;
  project?: string;
  service?: string;
  configFiles?: string;
  image?: string;
}

export interface LogEntry {
  service: string;
  stream: "stdout" | "stderr";
  at: number;
  message: string;
}

export interface World {
  containers: Record<string, FakeContainer>;
  volume?: Record<string, unknown>;
  networks: Record<string, Record<string, unknown>>;
  strangers: string[];
  buildCode: number;
  apiLogs: string;
  apiCommand: string[];
  apiNetworks: string[];
  egressBlocked: boolean;
  seededHash?: string;
  /** What docker logs --timestamps returns, per container. */
  logs: LogEntry[];
  /** ps -o command= output for process IDs that are alive. */
  processes: Record<number, string>;
  startFailures: number;
  logFailures: Partial<Record<string, string>>;
  databaseHealthyAfterMs: number;
  /** After daily-db starts again, Daily keeps failing this long (pool backoff). */
  recoveryDelayMs: number;
  onStop?: () => void | Promise<void>;
  onStart?: () => void | Promise<void>;
}

export interface DailyBehavior {
  build?: string;
  leaders?: string[];
  health?: () => Reply;
  ready?: () => Reply;
  feed?: (token: string | undefined) => Reply | "default";
}

export interface Harness {
  config: CaptureConfig;
  world: World;
  daily: DailyBehavior;
  calls: { command: string; args: string[]; options?: CommandOptions }[];
  lines: string[];
  onUp?: () => void;
  /** docker compose subcommands, without the project and file arguments. */
  subcommands: () => string[];
  /** Plain docker commands (not compose), e.g. ["stop", "--timeout", "10", id]. */
  dockerCalls: () => { args: string[]; options?: CommandOptions }[];
  containerId: (service: string) => string;
  log: (service: string, stream: "stdout" | "stderr", ...messages: string[]) => void;
  running: () => Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];

export async function runCleanups() {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

type Overrides = Partial<Omit<CaptureConfig, "capture">> & { capture?: Partial<CaptureSettings> };

export async function harness(overrides: Overrides = {}) {
  const dir = await tempDir("daily-sandbox-");
  const port = await freePort();
  let stopDaily: (() => Promise<void>) | undefined;
  const containerId = (service: string) => createHash("sha256").update(`container:${service}`).digest("hex");
  const sandbox: Harness = {
    config: undefined as unknown as CaptureConfig,
    world: {
      containers: {},
      networks: {},
      strangers: [],
      buildCode: 0,
      apiLogs: "",
      apiCommand: ["python", "/lab/launcher.py"],
      apiNetworks: [INTERNAL_NETWORK],
      egressBlocked: true,
      logs: [],
      processes: {},
      startFailures: 0,
      logFailures: {},
      databaseHealthyAfterMs: 0,
      recoveryDelayMs: 0,
    },
    daily: {},
    calls: [],
    lines: [],
    subcommands: () =>
      sandbox.calls.filter((call) => call.args[0] === "compose").map((call) => call.args.slice(5).join(" ")),
    dockerCalls: () =>
      sandbox.calls
        .filter((call) => call.command === "docker" && call.args[0] !== "compose")
        .map(({ args, options }) => ({ args, options })),
    containerId,
    log: (service, stream, ...messages) => {
      const at = Date.now();
      for (const message of messages) sandbox.world.logs.push({ service, stream, at, message });
    },
    async running() {
      for (const service of SERVICES) sandbox.world.containers[service] = { state: "running" };
      sandbox.world.networks[INTERNAL_NETWORK] = {
        Internal: true,
        Labels: { "com.docker.compose.project": COMPOSE_PROJECT },
      };
      stopDaily ??= await serveDaily(sandbox);
      sandbox.world.seededHash = tokenHash(SESSION_TOKEN);
      mkdirSync(sandbox.config.stateDir, { recursive: true });
      const at = new Date().toISOString();
      writeFileSync(
        join(sandbox.config.stateDir, "session.json"),
        JSON.stringify({ version: 1, token: SESSION_TOKEN, createdAt: at, seededAt: at }),
      );
      writeFileSync(
        join(sandbox.config.stateDir, "environment.json"),
        `${JSON.stringify({
          version: 1,
          recordedAt: at,
          composeProject: COMPOSE_PROJECT,
          source: { repository: sandbox.config.repository, revision: sandbox.config.revision, path: "backend", tree: "f".repeat(40), files: 3 },
          apiImage: { name: API_IMAGE, id: "sha256:built-manifest", platform: { os: "linux", architecture: "arm64" } },
          databaseImage: { name: DATABASE_IMAGE, id: "sha256:database-index", repoDigests: ["pgvector/pgvector@sha256:registry"] },
          python: { version: "3.12.15", packages: { fastapi: "0.115.2" } },
        })}\n`,
      );
    },
  };
  const { capture, ...rest } = overrides;
  sandbox.config = captureConfig({
    port,
    sourceDir: join(dir, "source"),
    stateDir: join(dir, "state"),
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 1_000,
    pollIntervalMs: 20,
    run: fakeDocker(sandbox, async () => {
      sandbox.world.networks[INTERNAL_NETWORK] ??= {
        Internal: true,
        Labels: { "com.docker.compose.project": COMPOSE_PROJECT },
      };
      sandbox.onUp?.();
      stopDaily ??= await serveDaily(sandbox);
    }),
    log: (line) => sandbox.lines.push(line),
    ...rest,
    capture: {
      roundPauseMs: 10,
      outageMs: 250,
      recoveryTimeoutMs: 3_000,
      cleanupTimeoutMs: 3_000,
      settleMs: 50,
      logMarginMs: 10,
      databasePollMs: 10,
      ...capture,
    },
  });
  cleanups.push(async () => {
    await stopDaily?.();
    await rm(dir, { recursive: true, force: true });
  });
  return sandbox;
}

function fakeDocker(sandbox: Harness, started: () => Promise<void>): Runner {
  return async (command, args, options) => {
    sandbox.calls.push({ command, args: [...args], options });
    const { world } = sandbox;
    const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
    const absent = (stderr: string): CommandResult => ({ code: 1, stdout: "", stderr });
    if (command === "ps") {
      const alive = world.processes[Number(args.at(-1))];
      return alive ? ok(`${alive}\n`) : absent("");
    }
    // Capture git's progress output instead of printing it during tests.
    if (command !== "docker") return runCommand(command, args, { ...options, stream: false });
    const byId = (id: string | undefined) =>
      Object.keys(world.containers).find((service) => id && sandbox.containerId(service).startsWith(id));
    if (args[0] === "info") return ok("29.8.2\n");
    if (args[0] === "compose") {
      const [subcommand, ...rest] = args.slice(5);
      if (subcommand === "ps")
        return ok(
          Object.entries(world.containers)
            .map(([service, container]) =>
              JSON.stringify({
                ID: sandbox.containerId(service).slice(0, 12),
                Service: service,
                State: container.state,
                ExitCode: container.exitCode ?? 0,
                Publishers:
                  service === "daily-gateway"
                    ? [{ URL: "127.0.0.1", TargetPort: 8080, PublishedPort: sandbox.config.port, Protocol: "tcp" }]
                    : [],
              }),
            )
            .join("\n"),
        );
      if (subcommand === "build") return { code: world.buildCode, stdout: "", stderr: "" };
      if (subcommand === "up") {
        for (const service of SERVICES) world.containers[service] = { state: "running" };
        await started();
        return ok();
      }
      if (subcommand === "exec" && rest.includes("/lab/seed.py")) {
        world.seededHash = JSON.parse(options!.input!).tokenHash;
        const tables = { users: 1, sessions: 1, user_preferences: 1, user_sources: 1, articles: 3, user_feed_cache: 3 };
        return ok(
          JSON.stringify({
            tables: Object.fromEntries(
              Object.entries(tables).map(([name, rows]) => [name, { fixture: rows, existing: 0, total: rows }]),
            ),
            removedCacheRows: 0,
          }),
        );
      }
      if (subcommand === "exec") {
        const script = rest[rest.indexOf("-c") + 1];
        if (script.includes("socket"))
          return ok(
            JSON.stringify({
              dns: { blocked: world.egressBlocked, detail: "Temporary failure in name resolution" },
              tcp: { blocked: world.egressBlocked, detail: "Network is unreachable" },
            }),
          );
        return ok(JSON.stringify({ python: "3.12.15", packages: { fastapi: "0.115.2" } }));
      }
      if (subcommand === "logs") return ok(world.apiLogs);
      if (subcommand === "stop") {
        for (const container of Object.values(world.containers)) container.state = "exited";
        return ok();
      }
      if (subcommand === "down") {
        world.containers = {};
        world.volume = undefined;
        return ok();
      }
    }
    if (args[0] === "volume")
      return world.volume ? ok(JSON.stringify(world.volume)) : absent("Error response from daemon: no such volume");
    if (args[0] === "network") {
      const network = world.networks[args.at(-1)!];
      return network ? ok(JSON.stringify(network)) : absent(`Error response from daemon: network ${args.at(-1)} not found`);
    }
    if (args[0] === "ps") return ok(world.strangers.join("\n"));
    if (args[0] === "inspect" || (args[0] === "container" && args[1] === "inspect")) {
      const service = byId(args.at(-1));
      if (!service) return absent(`Error response from daemon: No such container: ${args.at(-1)}`);
      return ok(JSON.stringify(inspectContainer(sandbox, service)));
    }
    if (args[0] === "stop") {
      const service = byId(args.at(-1));
      if (!service) return absent(`Error response from daemon: No such container: ${args.at(-1)}`);
      Object.assign(world.containers[service], { state: "exited", exitCode: 0, finishedAt: new Date().toISOString() });
      if (service === "daily-db")
        sandbox.log("daily-db", "stderr", "LOG:  received fast shutdown request", "LOG:  database system is shut down");
      await world.onStop?.();
      return ok(`${args.at(-1)}\n`);
    }
    if (args[0] === "start") {
      const service = byId(args.at(-1));
      if (!service) return absent(`Error response from daemon: No such container: ${args.at(-1)}`);
      if (world.startFailures > 0) {
        world.startFailures -= 1;
        return absent(`Error response from daemon: failed to start container ${args.at(-1)}`);
      }
      Object.assign(world.containers[service], {
        state: "running",
        startedAt: new Date().toISOString(),
        healthyAt: Date.now() + world.databaseHealthyAfterMs,
      });
      if (service === "daily-db") sandbox.log("daily-db", "stderr", "LOG:  database system is ready to accept connections");
      await world.onStart?.();
      return ok(`${args.at(-1)}\n`);
    }
    if (args[0] === "logs") {
      const service = byId(args.at(-1));
      if (!service) return absent(`Error response from daemon: No such container: ${args.at(-1)}`);
      if (world.logFailures[service]) return absent(world.logFailures[service]!);
      const since = Date.parse(args[args.indexOf("--since") + 1]);
      const until = Date.parse(args[args.indexOf("--until") + 1]);
      const entries = world.logs.filter((entry) => entry.service === service && entry.at >= since && entry.at <= until);
      const print = (stream: string) =>
        entries
          .filter((entry) => entry.stream === stream)
          .map((entry) => `${new Date(entry.at).toISOString().replace("Z", "000000Z")} ${entry.message}\n`)
          .join("");
      return { code: 0, stdout: print("stdout"), stderr: print("stderr") };
    }
    if (args[0] === "image" && args.includes("{{json .RepoDigests}}")) return ok('["pgvector/pgvector@sha256:registry"]\n');
    if (args[0] === "image" && args.includes("--platform")) return ok("sha256:built-manifest\n");
    if (args[0] === "image")
      return ok(
        JSON.stringify({
          Id: "sha256:built-index",
          Os: "linux",
          Architecture: "arm64",
          Descriptor: { mediaType: "application/vnd.oci.image.index.v1+json" },
        }),
      );
    throw new Error(`Unexpected command: docker ${args.join(" ")}`);
  };
}

function inspectContainer(sandbox: Harness, service: string) {
  const container = sandbox.world.containers[service];
  const api = service !== "daily-db";
  const running = container.state === "running";
  return {
    Id: sandbox.containerId(service),
    Name: `/${COMPOSE_PROJECT}-${service}-1`,
    Image: api ? "sha256:built-index" : "sha256:database-index",
    ...(api
      ? { ImageManifestDescriptor: { digest: container.image ?? "sha256:built-manifest", platform: { os: "linux", architecture: "arm64" } } }
      : {}),
    RestartCount: container.restartCount ?? 0,
    State: {
      Status: container.state,
      Running: running,
      StartedAt: container.startedAt ?? STARTED_AT,
      FinishedAt: container.finishedAt ?? "0001-01-01T00:00:00Z",
      ExitCode: container.exitCode ?? 0,
      ...(api ? {} : { Health: { Status: running ? (Date.now() >= (container.healthyAt ?? 0) ? "healthy" : "starting") : "unhealthy" } }),
    },
    Config: {
      Image: api ? API_IMAGE : DATABASE_IMAGE,
      Cmd: service === "daily-api" ? sandbox.world.apiCommand : api ? ["python", "/lab/gateway.py"] : ["postgres"],
      // Real containers carry credentials here; a capture must never copy them.
      Env: [
        "DATABASE_URL=postgresql://daily_lab:daily_lab_sandbox_only@daily-db:5432/daily_lab",
        "OPENAI_API_KEY=agent-lab-sandbox-inert-placeholder",
      ],
      Labels: {
        "com.docker.compose.project": container.project ?? COMPOSE_PROJECT,
        "com.docker.compose.service": container.service ?? service,
        "com.docker.compose.project.config_files": container.configFiles ?? composeFile(sandbox.config),
        "com.docker.compose.config-hash": `config-hash-${service}`,
        "com.docker.compose.oneoff": "False",
      },
    },
    NetworkSettings: {
      Networks: Object.fromEntries((service === "daily-api" ? sandbox.world.apiNetworks : [INTERNAL_NETWORK]).map((name) => [name, {}])),
    },
  };
}

/**
 * A real HTTP server shaped like Daily's /healthz, /readyz, and /feed. While
 * daily-db is down (or still within recoveryDelayMs of starting), the
 * database-backed endpoints fail and log tracebacks the way Daily does.
 */
async function serveDaily(sandbox: Harness) {
  const sockets = new Set<Socket>();
  const closing = new WeakSet<Socket>();
  const databaseDown = () => {
    const database = sandbox.world.containers["daily-db"];
    if (!database || database.state !== "running") return true;
    return Boolean(database.startedAt) && Date.now() < Date.parse(database.startedAt!) + sandbox.world.recoveryDelayMs;
  };
  const traceback = (summary: string, handler: string) =>
    sandbox.log(
      "daily-api",
      "stderr",
      `ERROR app.main: ${summary}`,
      "Traceback (most recent call last):",
      `  File "/app/app/main.py", line 742, in ${handler}`,
      "    with pool.connection() as conn:",
      "psycopg_pool.PoolTimeout: couldn't get a connection after 30.00 sec",
    );
  const reply = (url: string | undefined, token: string | undefined): Reply => {
    const { daily, world } = sandbox;
    if (url === "/healthz")
      return (
        daily.health?.() ?? [
          200,
          { status: "ok", git_sha: daily.build ?? sandbox.config.revision, started_at: "2026-10-21T00:00:00+00:00", leader_of: daily.leaders ?? [] },
        ]
      );
    if (url === "/readyz") {
      if (daily.ready) return daily.ready();
      if (!databaseDown()) return [200, { status: "ready" }];
      traceback("Readiness check failed", "readyz");
      return [503, { status: "unready" }];
    }
    if (url !== "/feed") return [404, { detail: "Not Found" }];
    const custom = daily.feed?.(token);
    if (custom && custom !== "default") return custom;
    if (token === undefined) return [401, { detail: "Missing token" }];
    if (databaseDown()) {
      traceback("Unhandled error on GET /feed", "get_feed");
      return [500, { detail: "Internal server error" }];
    }
    if (tokenHash(token) !== world.seededHash) return [401, { detail: "Invalid or expired token" }];
    return [200, { status: "ready", articles: articles.map((article) => ({ ...article, relevant: true })), feed_request_id: "request" }];
  };
  const server = createHttpServer((request, response) => {
    // A request that reuses a connection the server is closing never reaches Daily.
    if (closing.has(request.socket)) return request.socket.destroy();
    const result = reply(request.url, request.headers.authorization?.replace(/^Bearer /, ""));
    const port = 50_000 + Math.floor(Math.random() * 10_000);
    if (result === "hang") return;
    if (result === "reset") return request.socket.destroy();
    sandbox.log("daily-api", "stdout", `INFO:     172.21.0.4:${port} - "GET ${request.url} HTTP/1.1" ${result[0]}`);
    // Like Uvicorn after an unhandled exception: send the 500, then close the
    // connection. Through the gateway the client learns of it a moment later.
    if (result[0] === 500) {
      closing.add(request.socket);
      response.once("finish", () => setTimeout(() => request.socket.destroy(), 20));
    }
    response
      .writeHead(result[0], { "content-type": "application/json", "cache-control": "private, no-store", "set-cookie": "tracking=1" })
      .end(JSON.stringify(result[1]));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(sandbox.config.port, "127.0.0.1", resolve));
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}

export function commit(dir: string, files: Record<string, string>) {
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Agent Lab test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false",
        "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", "-C", dir, ...args],
      { encoding: "utf8" },
    ).trim();
  git("init", "--quiet");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git("add", "--all");
  git("commit", "--quiet", "--message", "Daily fixture");
  return git("rev-parse", "HEAD");
}

export const seeded = (sandbox: Harness, token: string | undefined) =>
  token !== undefined && tokenHash(token) === sandbox.world.seededHash;

export async function failure(pending: Promise<unknown>) {
  const error = await pending.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(SandboxError);
  return error as SandboxError;
}

export async function freePort() {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export function onCleanup(cleanup: () => Promise<void>) {
  cleanups.push(cleanup);
}

export async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  );
}
