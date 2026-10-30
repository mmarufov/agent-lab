import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  API_IMAGE,
  COMPOSE_PROJECT,
  DAILY_REVISION,
  DATABASE_IMAGE,
  check,
  composeArgs,
  logs,
  reset,
  runCommand,
  SERVICES,
  stop,
  tokenHash,
  up,
} from "./daily-sandbox";
import {
  articles,
  commit,
  exists,
  failure,
  harness as createHarness,
  INTERNAL_NETWORK,
  onCleanup,
  ROOT,
  runCleanups,
  seeded,
  tempDir,
  type Harness,
} from "./daily-test-harness";

let source: { repository: string; revision: string };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "daily-repository-"));
  afterAll(() => rm(dir, { recursive: true, force: true }));
  source = {
    repository: pathToFileURL(dir).href,
    revision: commit(dir, {
      "backend/Dockerfile": "FROM scratch\n",
      "backend/.env.example": "OPENAI_API_KEY=\n",
      "backend/app/main.py": "app = 'committed'\n",
      "web/README.md": "Not part of the backend.\n",
    }),
  };
  // Local, uncommitted work in the Daily checkout must never reach the image.
  writeFileSync(join(dir, "backend/.env"), "OPENAI_API_KEY=real-looking-secret\n");
  writeFileSync(join(dir, "backend/app/main.py"), "app = 'uncommitted edit'\n");
});

afterEach(runCleanups);

/** The Step 1 tests build from a real local Git repository. */
const harness = (overrides: Parameters<typeof createHarness>[0] = {}) =>
  createHarness({ repository: source.repository, revision: source.revision, ...overrides });

describe("pnpm daily:up", () => {
  it("prepares committed source, then builds, starts, seeds, records, and checks one Compose project", async () => {
    const sandbox = await harness();
    await up(sandbox.config);

    const backend = join(sandbox.config.sourceDir, "backend");
    expect(await readFile(join(backend, "app/main.py"), "utf8")).toBe("app = 'committed'\n");
    expect(await exists(join(backend, ".env.example"))).toBe(true);
    expect(await exists(join(backend, ".env"))).toBe(false);
    expect(await exists(join(sandbox.config.sourceDir, "web"))).toBe(false);

    const prefix = composeArgs(sandbox.config, []);
    expect(prefix).toEqual([
      "compose",
      "--project-name",
      "agent-lab-daily",
      "--file",
      join(ROOT, "scenarios/daily/compose.yaml"),
    ]);
    const docker = sandbox.calls.filter((call) => call.command === "docker");
    for (const call of docker) {
      if (call.args[0] === "compose") expect(call.args.slice(0, prefix.length)).toEqual(prefix);
      else expect(["info", "ps", "inspect", "image", "volume", "network"]).toContain(call.args[0]);
      if (call.args[0] === "image" || call.args[0] === "volume" || call.args[0] === "network")
        expect(call.args[1]).toBe("inspect");
    }
    expect(sandbox.subcommands()).toEqual(
      expect.arrayContaining(["build daily-api", "up --detach --no-build --remove-orphans", "exec -T daily-api python /lab/seed.py"]),
    );
    expect(sandbox.subcommands().indexOf("build daily-api")).toBeLessThan(
      sandbox.subcommands().indexOf("up --detach --no-build --remove-orphans"),
    );

    const sessionPath = join(sandbox.config.stateDir, "session.json");
    const session = JSON.parse(await readFile(sessionPath, "utf8"));
    expect((await stat(sessionPath)).mode & 0o777).toBe(0o600);
    expect(session.token).toMatch(/^[\w-]{32}$/);
    expect(sandbox.world.seededHash).toBe(tokenHash(session.token));
    expect(JSON.stringify(sandbox.calls.map((call) => call.args))).not.toContain(session.token);

    const environment = JSON.parse(await readFile(join(sandbox.config.stateDir, "environment.json"), "utf8"));
    expect(environment).toMatchObject({
      composeProject: COMPOSE_PROJECT,
      source: { repository: source.repository, revision: source.revision, path: "backend", files: 3 },
      apiImage: { name: API_IMAGE, id: "sha256:built-manifest" },
      databaseImage: { name: DATABASE_IMAGE, repoDigests: ["pgvector/pgvector@sha256:registry"] },
      python: { version: "3.12.15", packages: { fastapi: "0.115.2" } },
    });
    expect(sandbox.lines.filter((line) => line.startsWith("PASS"))).toHaveLength(8);
    for (const article of articles) expect(sandbox.lines.join("\n")).toContain(article.id);

    // Repeating setup reuses the saved session instead of minting duplicates.
    await up(sandbox.config);
    expect(sandbox.world.seededHash).toBe(tokenHash(session.token));
  });

  it("refuses an occupied port instead of choosing another target", async () => {
    const sandbox = await harness();
    const occupied = createTcpServer();
    await new Promise<void>((resolve) => occupied.listen(sandbox.config.port, "127.0.0.1", resolve));
    onCleanup(() => new Promise((resolve) => occupied.close(() => resolve())));

    const error = await failure(up(sandbox.config));
    expect(error.stage).toBe("conflict");
    expect(error.message).toContain(`127.0.0.1:${sandbox.config.port} is already in use`);
    expect(error.hint).toContain("does not pick another target");
    expect(sandbox.calls.some((call) => call.command === "git")).toBe(false);
    expect(sandbox.subcommands().some((command) => /^(build|up)\b/.test(command))).toBe(false);
  });

  it("refuses resources this project did not create, and reset leaves them alone", async () => {
    const sandbox = await harness();
    sandbox.world.volume = { Name: `${COMPOSE_PROJECT}_daily-db-data`, Labels: null };
    sandbox.world.strangers = [`${COMPOSE_PROJECT}-daily-api-1\tsomeone-else`];

    const error = await failure(up(sandbox.config));
    expect(error.stage).toBe("conflict");
    expect(error.message).toContain("was not created by Compose project agent-lab-daily");
    expect(error.message).toContain("belongs to Compose project someone-else");
    expect((await failure(reset(sandbox.config))).stage).toBe("conflict");
    expect(sandbox.subcommands().some((command) => /^(build|up|down)\b/.test(command))).toBe(false);
  });

  it("refuses its own incompatible resources and points to daily:reset", async () => {
    const sandbox = await harness();
    sandbox.world.networks[INTERNAL_NETWORK] = {
      Internal: false,
      Labels: { "com.docker.compose.project": COMPOSE_PROJECT },
    };
    const error = await failure(up(sandbox.config));
    expect(error.stage).toBe("conflict");
    expect(error.message).toContain("internal=false; the sandbox requires internal=true");
    expect(error.hint).toContain("pnpm daily:reset");
  });

  it("reports a build failure as a build failure and starts nothing", async () => {
    const sandbox = await harness();
    sandbox.world.buildCode = 1;
    const error = await failure(up(sandbox.config));
    expect(error.stage).toBe("build");
    expect(sandbox.subcommands()).not.toContain("up --detach --no-build --remove-orphans");
  });

  it("refuses a Daily commit that contains environment files", async () => {
    const dir = await tempDir("daily-secrets-");
    const revision = commit(dir, { "backend/Dockerfile": "FROM scratch\n", "backend/.env": "OPENAI_API_KEY=secret\n" });
    const sandbox = await harness({ repository: pathToFileURL(dir).href, revision });
    const error = await failure(up(sandbox.config));
    expect(error.stage).toBe("source");
    expect(error.message).toContain("backend/.env");
    expect(sandbox.subcommands().some((command) => command.startsWith("build"))).toBe(false);
  });

  it("times out an API whose /readyz never reports ready as a schema failure", async () => {
    const sandbox = await harness({ startupTimeoutMs: 400 });
    sandbox.daily.ready = () => [503, { status: "unready" }];
    const started = performance.now();
    const error = await failure(up(sandbox.config));
    expect(error.stage).toBe("schema");
    expect(error.message).toMatch(/within 0\.4 s .*503/);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("bounds each request, so a hung API fails startup within its window", async () => {
    const sandbox = await harness({ startupTimeoutMs: 600, requestTimeoutMs: 150 });
    sandbox.daily.health = () => "hang";
    const started = performance.now();
    const error = await failure(up(sandbox.config));
    const elapsed = performance.now() - started;
    expect(error.stage).toBe("startup");
    expect(error.message).toContain("the request timed out");
    expect(elapsed).toBeGreaterThanOrEqual(550);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("stops waiting as soon as daily-api exits, and reports schema failures from its logs", async () => {
    const sandbox = await harness({ startupTimeoutMs: 60_000 });
    sandbox.onUp = () => {
      sandbox.world.containers["daily-api"] = { state: "exited", exitCode: 3 };
      sandbox.world.apiLogs = "daily-api-1  | ERROR app.main: Schema setup failed at startup";
    };
    const started = performance.now();
    const error = await failure(up(sandbox.config));
    expect(error.stage).toBe("schema");
    expect(error.message).toContain("daily-api exited with code 3 during startup");
    expect(error.message).toContain("Schema setup failed");
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("pnpm daily:check", () => {
  it("passes against Daily-shaped responses without seeding, building, or restarting", async () => {
    const sandbox = await harness();
    await sandbox.running();
    await check(sandbox.config);
    expect(sandbox.lines.filter((line) => line.startsWith("PASS"))).toHaveLength(8);
    expect(sandbox.subcommands().some((command) => /^(build|up|stop|down)\b|seed\.py/.test(command))).toBe(false);
  });

  it.each([
    {
      failure: "accepts requests without a token",
      setup: (sandbox: Harness) => (sandbox.daily.feed = (token) => (token ? "default" : [200, { status: "ready" }])),
      stage: "authentication",
      message: /without a token returned 200; expected 401/,
    },
    {
      failure: "rejects the saved session token",
      setup: (sandbox: Harness) => (sandbox.world.seededHash = tokenHash("another-token")),
      stage: "authentication",
      message: /rejected the saved sandbox session token/,
    },
    {
      failure: "no longer has a fresh feed cache",
      setup: (sandbox: Harness) =>
        (sandbox.daily.feed = (token) => (seeded(sandbox, token) ? [200, { status: "needs_build", articles: [] }] : "default")),
      stage: "feed",
      message: /"needs_build".*older than 60 minutes/,
    },
    {
      failure: "serves different articles",
      setup: (sandbox: Harness) =>
        (sandbox.daily.feed = (token) =>
          seeded(sandbox, token) ? [200, { status: "ready", articles: articles.slice(1) }] : "default"),
      stage: "feed",
      message: /does not match the fixture/,
    },
    {
      failure: "runs another build",
      setup: (sandbox: Harness) => (sandbox.daily.build = "0000000000000000000000000000000000000000"),
      stage: "build",
      message: /not the pinned/,
    },
    {
      failure: "reports background-loop leadership",
      setup: (sandbox: Harness) => (sandbox.daily.leaders = ["ingestion"]),
      stage: "background",
      message: /\["ingestion"\]/,
    },
    {
      failure: "runs Daily's own command instead of the launcher",
      setup: (sandbox: Harness) => (sandbox.world.apiCommand = ["uvicorn", "app.main:app", "--workers", "2"]),
      stage: "background",
      message: /not the Agent Lab launcher/,
    },
    {
      failure: "lets daily-api reach the internet",
      setup: (sandbox: Harness) => (sandbox.world.egressBlocked = false),
      stage: "isolation",
      message: /reached the outside network/,
    },
    {
      failure: "attaches daily-api to the edge network",
      setup: (sandbox: Harness) => sandbox.world.apiNetworks.push(`${COMPOSE_PROJECT}_daily-edge`),
      stage: "isolation",
      message: /attached only to the internal network/,
    },
  ])("fails as $stage when the sandbox $failure", async ({ setup, stage, message }) => {
    const sandbox = await harness();
    await sandbox.running();
    setup(sandbox);
    const error = await failure(check(sandbox.config));
    expect(error.stage).toBe(stage);
    expect(error.message).toMatch(message);
  });

  it("asks for daily:up when no session was seeded", async () => {
    const sandbox = await harness();
    await sandbox.running();
    await rm(join(sandbox.config.stateDir, "session.json"));
    const error = await failure(check(sandbox.config));
    expect(error.stage).toBe("authentication");
    expect(error.hint).toBe("Run pnpm daily:up to seed the fixture reader.");
  });

  it("reports a stopped sandbox before making HTTP requests", async () => {
    const sandbox = await harness();
    for (const service of SERVICES) sandbox.world.containers[service] = { state: "exited" };
    const error = await failure(check(sandbox.config));
    expect(error.stage).toBe("startup");
    expect(error.message).toMatch(/^The sandbox is not running/);
    expect(error.hint).toBe("Run pnpm daily:up to start it.");
  });
});

describe("stop, logs, and reset", () => {
  it("target only the sandbox project and remove only its own state", async () => {
    const sandbox = await harness();
    await sandbox.running();
    await stop(sandbox.config);
    expect(await logs(sandbox.config)).toBe(0);
    await reset(sandbox.config);

    const prefix = composeArgs(sandbox.config, []);
    const compose = sandbox.calls.filter((call) => call.args[0] === "compose");
    for (const call of compose) expect(call.args.slice(0, prefix.length)).toEqual(prefix);
    expect(sandbox.subcommands()).toEqual(
      expect.arrayContaining(["stop", "logs --follow --timestamps", "down --volumes --remove-orphans"]),
    );
    expect(sandbox.calls.find((call) => call.args.includes("--follow"))?.options?.stream).toBe(true);
    expect(sandbox.calls.some((call) => ["rm", "rmi", "system"].includes(call.args[0]))).toBe(false);
    expect(await exists(join(sandbox.config.stateDir, "session.json"))).toBe(false);
    expect(await exists(join(sandbox.config.stateDir, "environment.json"))).toBe(true);
  });
});

describe("sandbox definition", () => {
  it("pins the same revision, image, project, port, and isolation the controller expects", async () => {
    const compose = await readFile(join(ROOT, "scenarios/daily/compose.yaml"), "utf8");
    expect(compose).toContain(`name: ${COMPOSE_PROJECT}\n`);
    expect(compose).toContain(`GIT_SHA: ${DAILY_REVISION}\n`);
    expect(compose.split(`image: ${API_IMAGE}\n`)).toHaveLength(3);
    expect(compose).toContain(`image: ${DATABASE_IMAGE} `);
    expect(compose).toContain(`dev.agent-lab.daily.database-image: ${DATABASE_IMAGE}\n`);
    expect(compose).toContain('command: ["python", "/lab/launcher.py"]');
    // Only the gateway publishes a port; Daily's API and database stay internal.
    expect(compose.match(/^ {4}ports:/gm)).toHaveLength(1);
    expect(compose).toContain('- "127.0.0.1:8081:8080"');
    expect(compose).toMatch(/daily-internal:\n {4}internal: true/);
    expect(compose).not.toMatch(/env_file|\$\{/);
  });

  it("seeds three uniquely identified, clearly labeled articles in relevance order", async () => {
    const fixture = JSON.parse(await readFile(join(ROOT, "scenarios/daily/fixture.json"), "utf8"));
    const scores = fixture.articles.map((article: { relevanceScore: number }) => article.relevanceScore);
    expect(articles).toHaveLength(3);
    expect(new Set(articles.map((article) => article.id)).size).toBe(3);
    for (const article of articles) expect(article.title).toMatch(/^Agent Lab test article \d: fictional /);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(new Set(scores).size).toBe(3);
  });
});

describe("runCommand", () => {
  it("stops a command that exceeds its timeout", async () => {
    const started = performance.now();
    await expect(
      runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { timeoutMs: 200 }),
    ).rejects.toThrow(/timed out after 0\.2 s/);
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
