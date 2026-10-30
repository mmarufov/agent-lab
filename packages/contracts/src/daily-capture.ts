import { z } from "zod";

// Files written by pnpm daily:capture in .context/daily-sandbox/captures/<id>/.
// evidence.jsonl holds only what an outside observer of Daily could see: HTTP
// observations and API/gateway logs. controller.jsonl holds what the capture
// script did and knew: phases, Docker actions, and database logs. Keep them
// apart; knowing that the script stopped PostgreSQL is an answer, not evidence.

const timestamp = z.iso.datetime({ offset: true });
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const containerId = z.string().regex(/^[0-9a-f]{64}$/);

export const dailyCaptureIdSchema = z.string().regex(/^\d{8}T\d{6}Z-[0-9a-f]{6}$/);
export const dailyServiceSchema = z.enum(["daily-db", "daily-api", "daily-gateway"]);
export const dailyCapturePhaseSchema = z.enum(["baseline", "outage", "restore", "recovery", "collection"]);

const httpBase = {
  kind: z.literal("http"),
  id: z.string().regex(/^http-\d{4,}$/),
  method: z.literal("GET"),
  path: z.string().startsWith("/"),
  // Whether the sandbox session token was sent. Request headers are never stored.
  authenticated: z.boolean(),
  startedAt: timestamp,
  endedAt: timestamp,
  elapsedMs: z.number().nonnegative(),
  deadlineMs: z.int().positive(),
};

export const dailyHttpObservationSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    ...httpBase,
    outcome: z.literal("response"),
    response: z.strictObject({
      status: z.int().min(100).max(599),
      // Allowlisted response headers only; cookies are never stored.
      headers: z.record(z.string(), z.string()),
      bodyFormat: z.enum(["json", "text"]),
      body: z.unknown(),
      bodyBytes: z.int().nonnegative(),
      bodyTruncated: z.boolean(),
    }),
  }),
  // Nothing arrived within deadlineMs, so there is no status to report.
  z.strictObject({ ...httpBase, outcome: z.literal("timeout") }),
  z.strictObject({
    ...httpBase,
    outcome: z.literal("network_error"),
    error: z.strictObject({ name: z.string(), code: z.string().nullable(), message: z.string() }),
  }),
]);

const logBase = {
  kind: z.literal("log"),
  stream: z.enum(["stdout", "stderr"]),
  // When Docker received the line (docker logs --timestamps); null only for a
  // line Docker printed without one.
  timestamp: timestamp.nullable(),
  // One line exactly as the container wrote it. Repeated lines and each line of
  // a stack trace stay separate records.
  message: z.string(),
};

export const dailyApplicationLogSchema = z.strictObject({
  ...logBase,
  id: z.string().regex(/^log-(api|gateway)-\d{4,}$/),
  service: z.enum(["daily-api", "daily-gateway"]),
});

export const dailyDatabaseLogSchema = z.strictObject({
  ...logBase,
  id: z.string().regex(/^log-db-\d{4,}$/),
  service: z.literal("daily-db"),
});

/** One line of evidence.jsonl. */
export const dailyCaptureEvidenceSchema = z.discriminatedUnion("kind", [
  dailyHttpObservationSchema,
  dailyApplicationLogSchema,
]);

export const dailyContainerSchema = z.strictObject({
  service: dailyServiceSchema,
  id: containerId,
  name: z.string(),
  image: z.strictObject({ reference: z.string(), id: z.string(), manifest: z.string().nullable() }),
  running: z.boolean(),
  status: z.string(),
  startedAt: timestamp,
  finishedAt: timestamp,
  exitCode: z.int(),
  health: z.string().nullable(),
  restartCount: z.int().nonnegative(),
  compose: z.strictObject({
    project: z.string(),
    service: z.string(),
    configFiles: z.string(),
    configHash: z.string(),
  }),
});

const controllerBase = { id: z.string().regex(/^ctl-\d{4,}$/), at: timestamp };

/** One line of controller.jsonl. */
export const dailyCaptureControllerSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...controllerBase,
    kind: z.literal("phase"),
    phase: dailyCapturePhaseSchema,
    status: z.enum(["started", "completed", "failed", "cancelled", "skipped"]),
    detail: z.string(),
  }),
  // Which evidence records one request round produced, and whether each met
  // the controller's success criterion.
  z.strictObject({
    ...controllerBase,
    kind: z.literal("round"),
    phase: z.enum(["baseline", "outage", "recovery"]),
    round: z.int().positive(),
    complete: z.boolean(),
    ok: z.boolean(),
    results: z.array(z.strictObject({ evidenceId: z.string(), ok: z.boolean(), summary: z.string() })),
  }),
  z.strictObject({
    ...controllerBase,
    kind: z.literal("action"),
    action: z.enum([
      "persist-recovery-marker",
      "stop-database",
      "start-database",
      "remove-recovery-marker",
      "collect-logs",
    ]),
    target: z.string().nullable(),
    command: z.array(z.string()).nullable(),
    startedAt: timestamp,
    endedAt: timestamp,
    ok: z.boolean(),
    exitCode: z.int().nullable(),
    detail: z.string(),
  }),
  z.strictObject({ ...controllerBase, kind: z.literal("container"), reason: z.string(), container: dailyContainerSchema }),
  z.strictObject({ ...controllerBase, kind: z.literal("note"), level: z.enum(["info", "warning", "error"]), message: z.string() }),
  dailyDatabaseLogSchema,
]);

const outcomeSchema = z.strictObject({
  status: z.enum(["passed", "failed", "not_evaluated"]),
  detail: z.string(),
  at: timestamp.nullable(),
  // Milliseconds since the action the outcome refers to, such as docker start.
  elapsedMs: z.number().nonnegative().nullable(),
});

const artifactSchema = z.strictObject({
  sha256,
  bytes: z.int().nonnegative(),
  records: z.int().nonnegative(),
  invalidLines: z.int().nonnegative(),
});

export const dailyCaptureManifestSchema = z.strictObject({
  version: z.literal(1),
  captureId: dailyCaptureIdSchema,
  // Execution only: completed means every phase ran. Observed results are in outcomes.
  status: z.enum(["running", "completed", "failed", "cancelled", "interrupted"]),
  createdAt: timestamp,
  finishedAt: timestamp.nullable(),
  settings: z.strictObject({
    requestTimeoutMs: z.int().positive(),
    roundPauseMs: z.int().nonnegative(),
    baselineRounds: z.int().positive(),
    outageMs: z.int().positive(),
    recoveryTimeoutMs: z.int().positive(),
    recoveryRounds: z.int().positive(),
    stopTimeoutSeconds: z.int().nonnegative(),
    cleanupTimeoutMs: z.int().positive(),
  }),
  window: z.strictObject({ start: timestamp, end: timestamp.nullable() }).nullable(),
  logRange: z.strictObject({ since: timestamp, until: timestamp }).nullable(),
  execution: z.strictObject({
    completed: z.boolean(),
    stoppedDuring: dailyCapturePhaseSchema.nullable(),
    cancellation: z.strictObject({ signal: z.string(), at: timestamp }).nullable(),
    error: z.string().nullable(),
  }),
  outcomes: z.strictObject({
    baselineHealthy: outcomeSchema,
    databaseStopped: outcomeSchema,
    outageObserved: outcomeSchema,
    databaseAvailable: outcomeSchema,
    applicationRecovered: outcomeSchema,
    containersUnchanged: outcomeSchema,
    evidenceComplete: outcomeSchema,
  }),
  cleanup: z.strictObject({
    required: z.boolean(),
    databaseRestored: z.boolean().nullable(),
    markerRetained: z.boolean(),
    detail: z.string(),
  }),
  recovery: z
    .strictObject({
      by: z.literal("pnpm daily:recover"),
      at: timestamp,
      databaseRestored: z.boolean(),
      detail: z.string(),
    })
    .nullable(),
  environment: z.strictObject({
    composeProject: z.string(),
    composeFile: z.string(),
    apiUrl: z.string(),
    daily: z.strictObject({
      repository: z.string(),
      revision: z.string().regex(/^[0-9a-f]{40}$/),
      tree: z.string(),
      files: z.int().nonnegative(),
    }),
    images: z.strictObject({
      api: z.strictObject({ name: z.string(), id: z.string(), platform: z.unknown() }),
      database: z.strictObject({ name: z.string(), id: z.string(), repoDigests: z.array(z.string()) }),
    }),
    python: z.strictObject({ version: z.string(), packages: z.record(z.string(), z.string()) }),
    containers: z.strictObject({
      "daily-db": dailyContainerSchema,
      "daily-api": dailyContainerSchema,
      "daily-gateway": dailyContainerSchema,
    }),
    // SHA-256 of sandbox definition files, keyed by repository-relative path.
    files: z.record(z.string(), sha256),
    environmentRecord: z.strictObject({ path: z.string(), sha256, recordedAt: timestamp }),
  }),
  // How many times each known credential was replaced with [REDACTED].
  redactions: z.record(z.string(), z.int().nonnegative()),
  artifacts: z
    .strictObject({ "evidence.jsonl": artifactSchema, "controller.jsonl": artifactSchema })
    .nullable(),
});

/** Written before PostgreSQL is stopped; removed once it runs again. */
export const dailyCaptureRecoveryMarkerSchema = z.strictObject({
  version: z.literal(1),
  captureId: dailyCaptureIdSchema,
  pid: z.int().positive(),
  createdAt: timestamp,
  database: z.strictObject({
    id: containerId,
    name: z.string(),
    composeProject: z.string(),
    composeFile: z.string(),
  }),
  restoreCommand: z.array(z.string()),
});

export type DailyService = z.infer<typeof dailyServiceSchema>;
export type DailyCapturePhase = z.infer<typeof dailyCapturePhaseSchema>;
export type DailyHttpObservation = z.infer<typeof dailyHttpObservationSchema>;
export type DailyApplicationLog = z.infer<typeof dailyApplicationLogSchema>;
export type DailyDatabaseLog = z.infer<typeof dailyDatabaseLogSchema>;
export type DailyCaptureEvidence = z.infer<typeof dailyCaptureEvidenceSchema>;
export type DailyContainer = z.infer<typeof dailyContainerSchema>;
export type DailyCaptureControllerRecord = z.infer<typeof dailyCaptureControllerSchema>;
export type DailyCaptureManifest = z.infer<typeof dailyCaptureManifestSchema>;
export type DailyCaptureOutcome = z.infer<typeof outcomeSchema>;
export type DailyCaptureRecoveryMarker = z.infer<typeof dailyCaptureRecoveryMarkerSchema>;
