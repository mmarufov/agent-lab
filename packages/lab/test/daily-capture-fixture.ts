import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DailyApplicationLog,
  DailyCaptureControllerRecord,
  DailyCaptureEvidence,
  DailyCaptureManifest,
  DailyContainer,
  DailyHttpObservation,
} from "@agent-lab/contracts/daily-capture";

// Synthetic captures in the exact format pnpm daily:capture writes. Strings
// that exist only in controller.jsonl and manifest.json start with
// CONTROLLER_ONLY so a test can prove they never reach a tool response.

export const CLEAN_CAPTURE_ID = "20261022T050138Z-39b307";
export const CONTROLLER_ONLY = "CONTROLLER_ONLY";

const at = (second: number) => new Date(Date.UTC(2026, 9, 22, 5, 1, 0) + second * 1_000).toISOString();
const pad = (n: number) => String(n).padStart(4, "0");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const directories: string[] = [];

/** A fresh captures directory, removed by removeCaptureDirs. */
export async function capturesDir() {
  const dir = await mkdtemp(join(tmpdir(), "daily-captures-"));
  directories.push(dir);
  return dir;
}

export async function removeCaptureDirs() {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

const request = (n: number, path: string) => ({
  kind: "http" as const,
  id: `http-${pad(n)}`,
  method: "GET" as const,
  path,
  authenticated: path === "/feed",
  startedAt: at(n),
  endedAt: at(n + 0.25),
  elapsedMs: 4.5,
  deadlineMs: 5_000,
});

export function http(n: number, path: string, outcome: "timeout" | number, body: unknown = { status: "ok" }): DailyHttpObservation {
  if (outcome === "timeout") return { ...request(n, path), elapsedMs: 5001.2, outcome: "timeout" };
  const text = JSON.stringify(body);
  return {
    ...request(n, path),
    outcome: "response",
    response: { status: outcome, headers: { "content-type": "application/json" }, bodyFormat: "json", body, bodyBytes: text.length, bodyTruncated: false },
  };
}

export function log(n: number, message: string, service: "daily-api" | "daily-gateway" = "daily-api"): DailyApplicationLog {
  return {
    kind: "log",
    id: `log-${service === "daily-api" ? "api" : "gateway"}-${pad(n)}`,
    service,
    stream: message.startsWith("INFO") ? "stdout" : "stderr",
    timestamp: `${at(n).slice(0, -1)}123456Z`,
    message,
  };
}

/** A small incident: healthy, failing (including a 200 and a timeout), then healthy again, with its logs. */
export function incidentEvidence(): DailyCaptureEvidence[] {
  const truncated: DailyHttpObservation = {
    ...request(9, "/feed"),
    outcome: "response",
    response: { status: 200, headers: { "content-type": "text/plain" }, bodyFormat: "text", body: "x".repeat(16), bodyBytes: 300_000, bodyTruncated: true },
  };
  const networkError: DailyHttpObservation = {
    ...request(8, "/readyz"),
    elapsedMs: 3.1,
    outcome: "network_error",
    error: { name: "SocketError", code: "UND_ERR_SOCKET", message: "other side closed" },
  };
  return [
    http(1, "/healthz", 200),
    http(2, "/feed", 200, { status: "ready", articles: [{ id: "a1", title: "Fixture" }] }),
    http(3, "/readyz", 200, { status: "ready" }),
    http(4, "/healthz", 200),
    http(5, "/feed", 500, { detail: "Internal server error" }),
    http(6, "/readyz", 503, { status: "unready" }),
    http(7, "/healthz", "timeout"),
    networkError,
    truncated,
    http(10, "/feed", 200, { status: "ready", articles: [{ id: "a1", title: "Fixture" }] }),
    log(1, 'INFO:     172.21.0.4:1 - "GET /healthz HTTP/1.1" 200 OK'),
    log(2, "ERROR app.main: Unhandled error on GET /feed"),
    log(3, "psycopg.errors.AdminShutdown: terminating connection due to administrator command"),
    log(4, "psycopg.errors.AdminShutdown: terminating connection due to administrator command"),
    log(5, "psycopg_pool.PoolTimeout: couldn't get a connection after 30.00 sec"),
    log(1, "gateway forwarded a connection", "daily-gateway"),
    { ...log(6, 'INFO:     172.21.0.4:2 - "GET /feed HTTP/1.1" 200 OK'), timestamp: null },
  ];
}

export function controllerRecords(): DailyCaptureControllerRecord[] {
  return [
    { kind: "phase", id: "ctl-0001", at: at(0), phase: "outage", status: "started", detail: `${CONTROLLER_ONLY} stop daily-db` },
    {
      kind: "action",
      id: "ctl-0002",
      at: at(1),
      action: "stop-database",
      target: "f".repeat(64),
      command: ["docker", "stop", "f".repeat(64)],
      startedAt: at(1),
      endedAt: at(2),
      ok: true,
      exitCode: 0,
      detail: `${CONTROLLER_ONLY} exit code 0`,
    },
    {
      kind: "round",
      id: "ctl-0003",
      at: at(3),
      phase: "outage",
      round: 1,
      complete: true,
      ok: false,
      results: [{ evidenceId: "http-0005", ok: false, summary: `${CONTROLLER_ONLY} 500 Internal server error` }],
    },
    { kind: "log", id: "log-db-0001", service: "daily-db", stream: "stderr", timestamp: at(1), message: `${CONTROLLER_ONLY} database system is shut down` },
  ];
}

function container(service: DailyContainer["service"], digit: string): DailyContainer {
  return {
    service,
    id: digit.repeat(64),
    name: `agent-lab-daily-${service}-1`,
    image: { reference: `${service}:fixture`, id: `sha256:${digit.repeat(64)}`, manifest: null },
    running: true,
    status: "running",
    startedAt: at(-60),
    finishedAt: "0001-01-01T00:00:00Z",
    exitCode: 0,
    health: service === "daily-db" ? "healthy" : null,
    restartCount: 0,
    compose: { project: "agent-lab-daily", service, configFiles: "/fixture/compose.yaml", configHash: digit.repeat(64) },
  };
}

const outcome = (detail: string) => ({ status: "passed" as const, detail: `${CONTROLLER_ONLY} ${detail}`, at: null, elapsedMs: null });

function manifest(captureId: string): DailyCaptureManifest {
  return {
    version: 1,
    captureId,
    status: "completed",
    createdAt: at(0),
    finishedAt: at(120),
    settings: {
      requestTimeoutMs: 5_000,
      roundPauseMs: 2_000,
      baselineRounds: 2,
      outageMs: 45_000,
      recoveryTimeoutMs: 120_000,
      recoveryRounds: 2,
      stopTimeoutSeconds: 10,
      cleanupTimeoutMs: 60_000,
    },
    window: { start: at(1), end: at(119) },
    logRange: { since: at(0.5), until: at(119.5) },
    execution: { completed: true, stoppedDuring: null, cancellation: null, error: null },
    outcomes: {
      baselineHealthy: outcome("baseline healthy"),
      databaseStopped: outcome("database stopped"),
      outageObserved: outcome("outage observed"),
      databaseAvailable: outcome("database available"),
      applicationRecovered: outcome("application recovered"),
      containersUnchanged: outcome("containers unchanged"),
      evidenceComplete: outcome("evidence complete"),
    },
    cleanup: { required: true, databaseRestored: true, markerRetained: false, detail: `${CONTROLLER_ONLY} restored` },
    recovery: null,
    environment: {
      composeProject: "agent-lab-daily",
      composeFile: "scenarios/daily/compose.yaml",
      apiUrl: "http://127.0.0.1:8081",
      daily: { repository: "https://github.com/mmarufov/Daily", revision: "0".repeat(40), tree: "1".repeat(40), files: 1 },
      images: {
        api: { name: "daily-api:fixture", id: `sha256:${"2".repeat(64)}`, platform: null },
        database: { name: "pgvector/pgvector:fixture", id: `sha256:${"3".repeat(64)}`, repoDigests: [] },
      },
      python: { version: "3.12.0", packages: {} },
      containers: { "daily-db": container("daily-db", "a"), "daily-api": container("daily-api", "b"), "daily-gateway": container("daily-gateway", "c") },
      files: { "scenarios/daily/compose.yaml": "4".repeat(64) },
      environmentRecord: { path: ".context/daily-sandbox/environment.json", sha256: "5".repeat(64), recordedAt: at(-120) },
    },
    redactions: { "sandbox session token": 0 },
    artifacts: null,
  };
}

export interface CaptureOptions {
  captureId?: string;
  evidence?: DailyCaptureEvidence[];
  controller?: DailyCaptureControllerRecord[];
  /** Exact file text, for invalid lines. Counts in the manifest still come from records and invalidLines. */
  evidenceText?: string;
  invalidLines?: number;
  manifest?: (manifest: DailyCaptureManifest) => DailyCaptureManifest;
}

const jsonl = (records: unknown[]) => records.map((record) => `${JSON.stringify(record)}\n`).join("");

/** Writes captures/<id>/ with a manifest whose artifact hashes and counts match the files. */
export async function writeCapture(root: string, options: CaptureOptions = {}) {
  const captureId = options.captureId ?? CLEAN_CAPTURE_ID;
  const evidence = options.evidence ?? incidentEvidence();
  const controller = options.controller ?? controllerRecords();
  const evidenceText = options.evidenceText ?? jsonl(evidence);
  const controllerText = jsonl(controller);
  const dir = join(root, captureId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "evidence.jsonl"), evidenceText);
  await writeFile(join(dir, "controller.jsonl"), controllerText);
  const artifact = (text: string, records: number, invalidLines = 0) => ({
    sha256: sha256(text),
    bytes: Buffer.byteLength(text),
    records,
    invalidLines,
  });
  const base = manifest(captureId);
  const finished = (options.manifest ?? ((value) => value))({
    ...base,
    artifacts: {
      "evidence.jsonl": artifact(evidenceText, evidence.length, options.invalidLines),
      "controller.jsonl": artifact(controllerText, controller.length),
    },
  });
  await writeFile(join(dir, "manifest.json"), `${JSON.stringify(finished, null, 2)}\n`);
  return dir;
}

/** SHA-256 of a file's text as written, independent of the code under test. */
export const fileHash = sha256;
