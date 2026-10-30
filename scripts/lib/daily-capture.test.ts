import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { capture, newCaptureId, parseDockerLogs, recover, verifyCapture } from "./daily-capture";
import { check, RECOVERY_MARKER, stop, tokenHash, up } from "./daily-sandbox";
import { exists, failure, harness, ROOT, runCleanups, SESSION_TOKEN, tempDir, type Harness } from "./daily-test-harness";

// Docker is faked; HTTP (a Daily-shaped server), timing, and files are real.
afterEach(runCleanups);

const DATABASE_PASSWORD = "daily_lab_sandbox_only";
const ARTIFACTS = ["evidence.jsonl", "controller.jsonl", "manifest.json"];

/** Commands that change a container. Only daily-db may ever be stopped or started. */
const mutations = (sandbox: Harness) =>
  sandbox.dockerCalls().filter(({ args }) => ["stop", "start", "restart", "kill", "rm"].includes(args[0]));
const captureDirs = (sandbox: Harness) => readdir(join(sandbox.config.stateDir, "captures")).catch(() => [] as string[]);
const markerExists = (sandbox: Harness) => exists(join(sandbox.config.stateDir, RECOVERY_MARKER));

function writeLock(sandbox: Harness, operation: string, pid: number) {
  mkdirSync(sandbox.config.stateDir, { recursive: true });
  writeFileSync(
    join(sandbox.config.stateDir, "operation.lock"),
    JSON.stringify({ version: 1, operation, pid, token: "a".repeat(32), startedAt: "2026-10-21T20:00:00.000Z" }),
  );
}

describe("pnpm daily:capture", () => {
  it("records a healthy baseline, an outage of daily-db only, and recovery without restarting Daily", async () => {
    const sandbox = await harness();
    await sandbox.running();
    const result = await capture(sandbox.config);

    expect(result.exitCode).toBe(0);
    expect(result.captureId).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{6}$/);
    const { manifest, evidence, controller } = await verifyCapture(result.dir);
    expect(manifest.status).toBe("completed");
    expect(Object.values(manifest.outcomes).map((outcome) => outcome.status)).toEqual(Array(7).fill("passed"));

    // One stop and one start, both aimed at the verified daily-db container ID,
    // each bounded and outside the terminal's Ctrl+C process group.
    const database = sandbox.containerId("daily-db");
    expect(mutations(sandbox).map(({ args }) => args)).toEqual([
      ["stop", "--timeout", "10", database],
      ["start", database],
    ]);
    for (const { options } of mutations(sandbox)) expect(options).toMatchObject({ detached: true, timeoutMs: expect.any(Number) });

    const http = evidence.filter((record) => record.kind === "http");
    const status = (record: (typeof http)[number]) => (record.outcome === "response" ? record.response.status : record.outcome);
    expect(http.slice(0, 6).map((record) => [record.path, status(record)])).toEqual([
      ["/healthz", 200],
      ["/feed", 200],
      ["/readyz", 200],
      ["/healthz", 200],
      ["/feed", 200],
      ["/readyz", 200],
    ]);
    // Phases live in controller.jsonl and point at evidence IDs.
    const rounds = controller.filter((record) => record.kind === "round");
    const outageIds = new Set(rounds.filter((round) => round.phase === "outage").flatMap((round) => round.results.map((entry) => entry.evidenceId)));
    const outage = http.filter((record) => outageIds.has(record.id));
    expect(outage.length).toBeGreaterThan(0);
    expect(new Set(outage.map((record) => `${record.path} ${status(record)}`))).toEqual(
      new Set(["/healthz 200", "/feed 500", "/readyz 503"]),
    );
    expect(rounds.filter((round) => round.phase === "recovery").at(-1)?.ok).toBe(true);

    // Daily's own logs from inside the window are evidence; preflight requests are not.
    const logs = evidence.filter((record) => record.kind === "log");
    expect(logs.filter((log) => log.message.startsWith("INFO:"))).toHaveLength(http.length);
    expect(logs.some((log) => log.service === "daily-api" && log.stream === "stderr" && log.message.includes("PoolTimeout"))).toBe(true);
    // Database logs and everything the controller did stay out of the evidence.
    expect(controller.some((record) => record.kind === "log" && record.message.includes("database system is shut down"))).toBe(true);
    expect(JSON.stringify(evidence)).not.toMatch(/daily-db|outage|baseline|recovery|docker|marker/);
    expect(JSON.stringify(evidence)).not.toContain("tracking=1");

    expect(Object.keys(manifest.environment.files)).toEqual([
      "scenarios/daily/compose.yaml",
      "scenarios/daily/launcher.py",
      "scenarios/daily/gateway.py",
      "scenarios/daily/seed.py",
      "scenarios/daily/fixture.json",
    ]);
    expect(manifest.environment.containers["daily-db"]).toMatchObject({ id: database, image: { reference: "pgvector/pgvector:0.8.0-pg16" } });
    expect(manifest.environment.python.packages).toEqual({ fastapi: "0.115.2" });
    expect(manifest.outcomes.databaseAvailable.elapsedMs).toEqual(expect.any(Number));
    expect(manifest.cleanup).toMatchObject({ required: true, databaseRestored: true, markerRetained: false });
    expect(JSON.stringify(manifest)).not.toContain(DATABASE_PASSWORD);
    expect(await markerExists(sandbox)).toBe(false);
    expect(await exists(join(sandbox.config.stateDir, "operation.lock"))).toBe(false);
  });

  it.each([
    {
      refusal: "a feed cache that would expire during the capture",
      stage: "feed",
      message: /expires in 2\.0 min/,
      setup: (sandbox: Harness) => {
        const seededAt = new Date(Date.now() - 58 * 60_000).toISOString();
        writeFileSync(
          join(sandbox.config.stateDir, "session.json"),
          JSON.stringify({ version: 1, token: SESSION_TOKEN, createdAt: seededAt, seededAt }),
        );
      },
    },
    {
      refusal: "containers created by another workspace",
      stage: "conflict",
      message: /not this workspace's/,
      setup: (sandbox: Harness) => (sandbox.world.containers["daily-db"].configFiles = "/elsewhere/scenarios/daily/compose.yaml"),
    },
    {
      refusal: "a container running another image",
      stage: "conflict",
      message: /daily-api runs image sha256:other/,
      setup: (sandbox: Harness) => (sandbox.world.containers["daily-api"].image = "sha256:other"),
    },
    {
      refusal: "a missing session",
      stage: "authentication",
      message: /No sandbox session/,
      setup: (sandbox: Harness) => rmSync(join(sandbox.config.stateDir, "session.json")),
    },
    {
      refusal: "another running sandbox operation",
      stage: "conflict",
      message: /daily:up is already running \(pid 424242/,
      setup: (sandbox: Harness) => {
        writeLock(sandbox, "up", 424_242);
        sandbox.world.processes[424_242] = "node --import tsx scripts/daily-sandbox.ts up";
      },
    },
    {
      refusal: "an earlier capture whose restoration is unconfirmed",
      stage: "conflict",
      message: /did not confirm its restoration/,
      setup: (sandbox: Harness) =>
        writeFileSync(join(sandbox.config.stateDir, RECOVERY_MARKER), JSON.stringify({ captureId: "earlier", database: { id: "abc" } })),
    },
  ])("refuses $refusal before recording or stopping anything", async ({ setup, stage, message }) => {
    const sandbox = await harness();
    await sandbox.running();
    setup(sandbox);
    const error = await failure(capture(sandbox.config));
    expect(error.stage).toBe(stage);
    expect(error.message).toMatch(message);
    expect(mutations(sandbox)).toEqual([]);
    expect(await captureDirs(sandbox)).toEqual([]);
  });

  it("saves a failed baseline as a diagnostic result and never stops PostgreSQL", async () => {
    const sandbox = await harness();
    await sandbox.running();
    let ready = 0;
    // The preflight check passes; the first baseline round does not.
    sandbox.daily.ready = () => (++ready > 1 ? [503, { status: "unready" }] : [200, { status: "ready" }]);
    const result = await capture(sandbox.config);

    expect(result.exitCode).toBe(1);
    const { manifest, evidence } = await verifyCapture(result.dir);
    expect(manifest).toMatchObject({
      status: "failed",
      execution: { stoppedDuring: "baseline", error: expect.stringMatching(/baseline was not healthy/) },
      cleanup: { required: false },
    });
    expect(manifest.outcomes.baselineHealthy).toMatchObject({ status: "failed", detail: expect.stringContaining("GET /readyz 503 unready") });
    expect(manifest.outcomes.databaseStopped.status).toBe("not_evaluated");
    expect(manifest.outcomes.evidenceComplete.status).toBe("passed");
    expect(evidence.filter((record) => record.kind === "http")).toHaveLength(3);
    expect(mutations(sandbox)).toEqual([]);
  });

  it("records 500, 503, connection errors, and timeouts as observed, then waits for a delayed recovery", async () => {
    const sandbox = await harness({ requestTimeoutMs: 200, capture: { outageMs: 900 } });
    await sandbox.running();
    sandbox.world.recoveryDelayMs = 400;
    const down = () => sandbox.world.containers["daily-db"].state !== "running";
    let health = 0,
      feed = 0;
    sandbox.daily.health = () =>
      down() && ++health % 2 === 0 ? "hang" : [200, { status: "ok", git_sha: sandbox.config.revision, leader_of: [] }];
    sandbox.daily.feed = (token) => (token && down() && ++feed % 2 === 0 ? "reset" : "default");
    const result = await capture(sandbox.config);

    expect(result.exitCode).toBe(0);
    const { manifest, evidence } = await verifyCapture(result.dir);
    const http = evidence.filter((record) => record.kind === "http");
    const timeout = http.find((record) => record.outcome === "timeout");
    expect(timeout).toMatchObject({ path: "/healthz", deadlineMs: 200 });
    expect(timeout).not.toHaveProperty("response");
    expect(timeout!.elapsedMs).toBeGreaterThanOrEqual(190);
    expect(http.find((record) => record.outcome === "network_error")).toMatchObject({
      path: "/feed",
      error: { message: expect.any(String) },
    });
    expect(http.some((record) => record.outcome === "response" && record.response.status === 500)).toBe(true);
    expect(http.some((record) => record.outcome === "response" && record.response.status === 503)).toBe(true);
    expect(manifest.outcomes.outageObserved.detail).toMatch(/timed out after 0\.2 s/);
    expect(manifest.outcomes.outageObserved.detail).toMatch(/connection error/);
    expect(manifest.outcomes.applicationRecovered.elapsedMs).toBeGreaterThanOrEqual(400);
  });

  it("reports a recovery that does not arrive in time, after still restoring the database", async () => {
    const sandbox = await harness({ capture: { recoveryTimeoutMs: 500 } });
    await sandbox.running();
    sandbox.world.recoveryDelayMs = 60_000;
    const result = await capture(sandbox.config);

    expect(result.exitCode).toBe(1);
    const { manifest } = await verifyCapture(result.dir);
    expect(manifest.status).toBe("completed");
    expect(manifest.outcomes.applicationRecovered).toMatchObject({
      status: "failed",
      detail: expect.stringMatching(/no 2 consecutive healthy rounds within 0\.5 s/),
    });
    expect(manifest.outcomes.databaseAvailable.status).toBe("passed");
    expect(manifest.cleanup).toMatchObject({ databaseRestored: true, markerRetained: false });
    // Nothing was restarted to make recovery pass.
    expect(mutations(sandbox).map(({ args }) => args[0])).toEqual(["stop", "start"]);
  });

  it("cancelled before PostgreSQL is stopped: stops nothing and keeps the partial evidence", async () => {
    const sandbox = await harness();
    await sandbox.running();
    const controller = new AbortController();
    let ready = 0;
    sandbox.daily.ready = () => {
      // Preflight, then two baseline rounds: Ctrl+C arrives during the last baseline request.
      if (++ready === 3) controller.abort("SIGINT");
      return [200, { status: "ready" }];
    };
    const result = await capture(sandbox.config, controller.signal);

    expect(result.exitCode).toBe(130);
    const { manifest, evidence, controller: records } = await verifyCapture(result.dir);
    expect(manifest).toMatchObject({
      status: "cancelled",
      execution: { stoppedDuring: "baseline", cancellation: { signal: "SIGINT" } },
      cleanup: { required: false },
    });
    expect(manifest.outcomes.evidenceComplete.status).toBe("passed");
    expect(evidence.filter((record) => record.kind === "http")).toHaveLength(5);
    expect(records.some((record) => record.kind === "note" && record.message.includes("abandoned by the cancellation"))).toBe(true);
    expect(mutations(sandbox)).toEqual([]);
    expect(await markerExists(sandbox)).toBe(false);
  });

  it("cancelled right after docker stop: starts daily-db again, then saves what it observed", async () => {
    const sandbox = await harness();
    await sandbox.running();
    const controller = new AbortController();
    sandbox.world.onStop = () => controller.abort("SIGTERM");
    const result = await capture(sandbox.config, controller.signal);

    expect(result.exitCode).toBe(143);
    const database = sandbox.containerId("daily-db");
    expect(mutations(sandbox).map(({ args }) => args)).toEqual([
      ["stop", "--timeout", "10", database],
      ["start", database],
    ]);
    const { manifest } = await verifyCapture(result.dir);
    expect(manifest).toMatchObject({
      status: "cancelled",
      execution: { stoppedDuring: "outage", cancellation: { signal: "SIGTERM" } },
      cleanup: { required: true, databaseRestored: true, markerRetained: false },
    });
    expect(manifest.outcomes.databaseStopped.status).toBe("passed");
    expect(manifest.outcomes.databaseAvailable.status).toBe("passed");
    expect(manifest.outcomes.applicationRecovered.status).toBe("not_evaluated");
    expect(sandbox.world.containers["daily-db"].state).toBe("running");
    expect(await markerExists(sandbox)).toBe(false);
  });

  it("still starts daily-db again when recording fails mid-outage", async () => {
    const sandbox = await harness();
    await sandbox.running();
    sandbox.world.onStop = () => {
      const [captureId] = readdirSync(join(sandbox.config.stateDir, "captures"));
      chmodSync(join(sandbox.config.stateDir, "captures", captureId, "evidence.jsonl"), 0o444);
    };
    const result = await capture(sandbox.config);

    expect(result.exitCode).toBe(1);
    expect(mutations(sandbox).map(({ args }) => args[0])).toEqual(["stop", "start"]);
    const { manifest } = await verifyCapture(result.dir);
    expect(manifest.status).toBe("failed");
    expect(manifest.execution.error).toMatch(/EACCES|permission denied/i);
    expect(manifest.cleanup).toMatchObject({ databaseRestored: true, markerRetained: false });
    expect(manifest.outcomes.evidenceComplete).toMatchObject({ status: "failed", detail: expect.stringContaining("recording failed") });
    expect(await markerExists(sandbox)).toBe(false);
  });

  it("keeps the recovery marker when restoration fails, and other commands wait for daily:recover", async () => {
    const sandbox = await harness({ capture: { cleanupTimeoutMs: 600 } });
    await sandbox.running();
    sandbox.world.startFailures = 99;
    const result = await capture(sandbox.config);
    const database = sandbox.containerId("daily-db");

    expect(result.exitCode).toBe(1);
    expect(result.manifest).toMatchObject({
      status: "failed",
      execution: { stoppedDuring: "restore" },
      cleanup: { required: true, databaseRestored: false, markerRetained: true },
    });
    expect(result.manifest.cleanup.detail).toContain(`docker start ${database}`);
    expect(sandbox.lines.join("\n")).toContain(`FAILED to start daily-db ${database}`);
    expect(await markerExists(sandbox)).toBe(true);
    for (const command of [up, stop, capture]) {
      const error = await failure(command(sandbox.config));
      expect(error.stage).toBe("conflict");
      expect(error.hint).toContain("pnpm daily:recover");
    }

    sandbox.world.startFailures = 0;
    await recover(sandbox.config);
    expect(sandbox.world.containers["daily-db"].state).toBe("running");
    expect(await markerExists(sandbox)).toBe(false);
    const { manifest } = await verifyCapture(result.dir);
    expect(manifest.status).toBe("failed");
    expect(manifest.recovery).toMatchObject({ by: "pnpm daily:recover", databaseRestored: true });
    expect(manifest.cleanup).toMatchObject({ databaseRestored: true, markerRetained: false });
  });

  it("keeps repeated lines and stack traces, tolerates a silent service, and redacts known credentials", async () => {
    const sandbox = await harness();
    await sandbox.running();
    sandbox.daily.health = () => [200, { status: "ok", git_sha: sandbox.config.revision, leader_of: [], echoed: `Bearer ${SESSION_TOKEN}` }];
    sandbox.world.onStop = async () => {
      for (let line = 0; line < 3; line++) {
        sandbox.log("daily-api", "stderr", "WARNING psycopg.pool: discarding closed connection");
        await delay(2);
      }
      // One write of a multi-line traceback: Docker gives every line the same time.
      sandbox.log(
        "daily-api",
        "stderr",
        "ERROR app.main: Error loading feed",
        "Traceback (most recent call last):",
        '  File "/app/app/feed.py", line 9, in load',
        "psycopg.OperationalError: the connection is lost",
      );
      sandbox.log(
        "daily-api",
        "stderr",
        `DEBUG token=${SESSION_TOKEN} hash=${tokenHash(SESSION_TOKEN)}`,
        "connecting to postgresql://daily_lab:daily_lab_sandbox_only@daily-db:5432/daily_lab",
      );
    };
    const result = await capture(sandbox.config);

    expect(result.exitCode).toBe(0);
    const { manifest, evidence } = await verifyCapture(result.dir);
    const logs = evidence.filter((record) => record.kind === "log");
    const repeated = logs.filter((log) => log.message === "WARNING psycopg.pool: discarding closed connection");
    expect(repeated).toHaveLength(3);
    expect(new Set(repeated.map((log) => log.id)).size).toBe(3);
    const start = logs.findIndex((log) => log.message === "ERROR app.main: Error loading feed");
    expect(logs.slice(start, start + 4).map((log) => [log.stream, log.message])).toEqual([
      ["stderr", "ERROR app.main: Error loading feed"],
      ["stderr", "Traceback (most recent call last):"],
      ["stderr", '  File "/app/app/feed.py", line 9, in load'],
      ["stderr", "psycopg.OperationalError: the connection is lost"],
    ]);
    expect(logs.filter((log) => log.service === "daily-gateway")).toEqual([]);
    expect(manifest.outcomes.evidenceComplete.status).toBe("passed");

    const written = (await Promise.all(ARTIFACTS.map((file) => readFile(join(result.dir, file), "utf8")))).join("\n");
    for (const secret of [SESSION_TOKEN, tokenHash(SESSION_TOKEN), DATABASE_PASSWORD]) expect(written).not.toContain(secret);
    expect(logs.map((log) => log.message)).toContain("connecting to postgresql://daily_lab:[REDACTED]@daily-db:5432/daily_lab");
    expect(manifest.redactions["sandbox session token"]).toBeGreaterThan(0);
    expect(manifest.redactions["sandbox session token hash"]).toBe(1);
    expect(manifest.redactions["database password"]).toBe(1);
  });

  it("marks evidence incomplete when a container's logs cannot be collected", async () => {
    const sandbox = await harness();
    await sandbox.running();
    sandbox.world.logFailures["daily-gateway"] = "Error response from daemon: configured logging driver does not support reading";
    const result = await capture(sandbox.config);

    expect(result.exitCode).toBe(1);
    const { manifest } = await verifyCapture(result.dir);
    expect(manifest.status).toBe("completed");
    expect(manifest.outcomes.evidenceComplete).toMatchObject({ status: "failed", detail: expect.stringContaining("daily-gateway logs") });
    expect(manifest.cleanup.databaseRestored).toBe(true);
  });

  it("detects artifacts that no longer match their manifest", async () => {
    const sandbox = await harness();
    await sandbox.running();
    const { dir } = await capture(sandbox.config);
    const evidence = join(dir, "evidence.jsonl");
    const original = await readFile(evidence, "utf8");

    await appendFile(evidence, `${original.split("\n")[0]}\n`);
    await expect(verifyCapture(dir)).rejects.toThrow(/SHA-256/);

    // An invalid record is caught even when someone also updates the hash.
    const tampered = original.replace('"outcome":"response"', '"outcome":"invented"');
    await writeFile(evidence, tampered);
    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.artifacts["evidence.jsonl"].sha256 = createHash("sha256").update(tampered).digest("hex");
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(verifyCapture(dir)).rejects.toThrow(/record counts/);
  });

  it("gives every capture its own directory and never overwrites an earlier one", async () => {
    const sandbox = await harness();
    await sandbox.running();
    const first = await capture(sandbox.config);
    const before = await Promise.all(ARTIFACTS.map((file) => readFile(join(first.dir, file), "utf8")));
    // Force the next capture to try the earlier ID first.
    let collided = false;
    sandbox.config.newCaptureId = () => (collided ? newCaptureId() : ((collided = true), first.captureId));
    const second = await capture(sandbox.config);

    expect(collided).toBe(true);
    expect(second.captureId).not.toBe(first.captureId);
    expect(await Promise.all(ARTIFACTS.map((file) => readFile(join(first.dir, file), "utf8")))).toEqual(before);
    expect((await captureDirs(sandbox)).sort()).toEqual([first.captureId, second.captureId].sort());
    await verifyCapture(first.dir);
  });

  it("never restarts Daily's API, reseeds, rebuilds, or touches Agent Lab's database", async () => {
    const sandbox = await harness();
    await sandbox.running();
    await capture(sandbox.config);

    for (const command of sandbox.subcommands()) expect(command).toMatch(/^ps --all --format json$|^exec -T daily-api python -c \nimport json, socket/);
    const plain = sandbox.dockerCalls().map(({ args }) => (args[0] === "container" ? args.slice(0, 2).join(" ") : args[0]));
    expect(new Set(plain)).toEqual(new Set(["info", "inspect", "network", "container inspect", "stop", "start", "logs"]));
    const everything = JSON.stringify(sandbox.calls.map((call) => call.args));
    expect(everything).not.toContain("agent-lab-kingstown");
    expect(everything).not.toContain(JSON.stringify(join(ROOT, "compose.yaml")));
    expect(sandbox.world.containers["daily-api"].startedAt).toBeUndefined();
  });
});

describe("pnpm daily:recover", () => {
  it("restores a capture whose process died mid-outage and marks it interrupted", async () => {
    const sandbox = await harness();
    await sandbox.running();
    const abandoned = await tempDir("daily-abandoned-");
    // What a killed process leaves on disk: the state the moment daily-db stopped.
    sandbox.world.onStop = () => cpSync(sandbox.config.stateDir, abandoned, { recursive: true });
    await capture(sandbox.config);
    const config = { ...sandbox.config, stateDir: abandoned };
    const lockPath = join(abandoned, "operation.lock");
    // The capture's process is gone (the fake ps knows no PID 999999).
    await writeFile(lockPath, JSON.stringify({ ...JSON.parse(await readFile(lockPath, "utf8")), pid: 999_999 }));
    sandbox.world.containers["daily-db"].state = "exited";

    const refused = await failure(up(config));
    expect(refused.message).toMatch(/previous pnpm daily:capture \(pid 999999.*ended without releasing the sandbox lock/);
    expect(refused.hint).toContain("pnpm daily:recover");

    sandbox.calls.length = 0;
    await recover(config);
    const database = sandbox.containerId("daily-db");
    expect(mutations(sandbox).map(({ args }) => args)).toEqual([["start", database]]);
    expect(sandbox.subcommands().some((command) => /^(build|up|restart)\b|seed\.py/.test(command))).toBe(false);
    expect(await exists(join(abandoned, RECOVERY_MARKER))).toBe(false);
    expect(await exists(lockPath)).toBe(false);
    const [captureId] = await readdir(join(abandoned, "captures"));
    const { manifest, controller } = await verifyCapture(join(abandoned, "captures", captureId));
    expect(manifest).toMatchObject({
      status: "interrupted",
      execution: { stoppedDuring: "outage" },
      cleanup: { required: true, databaseRestored: true, markerRetained: false },
      recovery: { by: "pnpm daily:recover", databaseRestored: true },
    });
    expect(manifest.outcomes.evidenceComplete.status).toBe("failed");
    expect(controller.some((record) => record.kind === "action" && record.action === "start-database" && record.target === database)).toBe(true);
    await check(config);
  });

  it("refuses to start a recorded container this workspace does not own, and keeps the marker", async () => {
    const sandbox = await harness();
    await sandbox.running();
    sandbox.world.startFailures = 99;
    await capture({ ...sandbox.config, capture: { ...sandbox.config.capture, cleanupTimeoutMs: 300 } });
    sandbox.world.startFailures = 0;
    sandbox.world.containers["daily-db"].configFiles = "/another/workspace/scenarios/daily/compose.yaml";
    sandbox.calls.length = 0;

    const error = await failure(recover(sandbox.config));
    expect(error.stage).toBe("recovery");
    expect(error.message).toMatch(/Refusing to start .*not this workspace's/);
    expect(mutations(sandbox)).toEqual([]);
    expect(await markerExists(sandbox)).toBe(true);
  });
});

describe("the sandbox operation lock", () => {
  it("refuses other operations while one runs, including read-only checks during a capture", async () => {
    const sandbox = await harness();
    await sandbox.running();
    writeLock(sandbox, "capture", 424_242);
    sandbox.world.processes[424_242] = "node --import tsx scripts/daily-sandbox.ts capture";
    for (const command of [up, stop, recover, capture]) {
      const error = await failure(command(sandbox.config));
      expect(error.message).toMatch(/daily:capture is already running \(pid 424242/);
    }
    expect((await failure(check(sandbox.config))).message).toMatch(/evidence window/);
    expect(mutations(sandbox)).toEqual([]);
  });

  it("treats a lock whose PID now runs another program as abandoned; recover clears it", async () => {
    const sandbox = await harness();
    await sandbox.running();
    writeLock(sandbox, "up", 424_242);
    // After a restart the recorded PID belongs to something else.
    sandbox.world.processes[424_242] = "/Applications/Safari.app/Contents/MacOS/Safari";
    expect((await failure(stop(sandbox.config))).message).toMatch(/previous pnpm daily:up \(pid 424242.*ended without releasing/);

    await recover(sandbox.config);
    expect(sandbox.lines.join("\n")).toContain("Rerun pnpm daily:up if it did not finish.");
    expect(mutations(sandbox)).toEqual([]);
    await stop(sandbox.config);
  });
});

describe("parseDockerLogs", () => {
  it("interleaves both streams by Docker's timestamps and keeps every line", () => {
    const stdout = "2026-10-22T04:00:00.100000000Z GET /feed 500\n2026-10-22T04:00:00.300000000Z GET /readyz 503\n";
    const stderr =
      "2026-10-22T04:00:00.200000000Z ERROR boom\n" +
      "2026-10-22T04:00:00.200000000Z Traceback (most recent call last):\n" +
      "2026-10-22T04:00:00.2Z \n" +
      "not a docker line\n";
    expect(parseDockerLogs(stdout, stderr)).toEqual([
      { stream: "stderr", timestamp: null, message: "not a docker line" },
      { stream: "stdout", timestamp: "2026-10-22T04:00:00.100000000Z", message: "GET /feed 500" },
      { stream: "stderr", timestamp: "2026-10-22T04:00:00.200000000Z", message: "ERROR boom" },
      { stream: "stderr", timestamp: "2026-10-22T04:00:00.200000000Z", message: "Traceback (most recent call last):" },
      { stream: "stderr", timestamp: "2026-10-22T04:00:00.2Z", message: "" },
      { stream: "stdout", timestamp: "2026-10-22T04:00:00.300000000Z", message: "GET /readyz 503" },
    ]);
  });
});
