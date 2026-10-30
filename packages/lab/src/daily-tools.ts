import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  DAILY_EVIDENCE_PAGE_BYTES,
  DAILY_HTTP_LIMIT,
  DAILY_LOGS_LIMIT,
  getDailyHttpObservationsInputSchema,
  getDailyHttpObservationsOutputSchema,
  getDailyLogsInputSchema,
  getDailyLogsOutputSchema,
  type GetDailyHttpObservationsInput,
  type GetDailyHttpObservationsOutput,
  type GetDailyLogsInput,
  type GetDailyLogsOutput,
} from "@agent-lab/contracts/daily-evidence";
import { CaptureAccessError, createCaptureAccess } from "./capture-access";
import { DailyCaptureError, EVIDENCE, readDailyCapture, type DailyCaptureRecords } from "./daily-evidence";

// The two Daily evidence tools behind GET /api/tools/daily/*. A page holds
// original evidence records in recorded order: never controller records,
// expected outcomes, file paths, or credentials. No Next.js imports, so tests
// call it with a plain Request.

export type DailyEvidenceTool = "get_daily_logs" | "get_daily_http_observations";

/** A cursor that is malformed or was issued for another capture, tool, or filters. */
export class DailyCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyCursorError";
  }
}

type Oversized = { id: string; bytes: number };

/** One page of the capture's log lines that match every filter, after the cursor. */
export function dailyLogsPage(capture: DailyCaptureRecords, input: GetDailyLogsInput): GetDailyLogsOutput {
  const needle = input.messageContains?.toLowerCase();
  const matches = capture.logs.filter(
    (log) => (!input.service || log.service === input.service) && (!needle || log.message.toLowerCase().includes(needle)),
  );
  const source = { captureId: capture.captureId, evidenceSha256: capture.sha256[EVIDENCE] };
  return paginate({
    binding: binding(capture, "get_daily_logs", [input.service ?? null, input.messageContains ?? null]),
    matches,
    cursor: input.cursor,
    limit: input.limit ?? DAILY_LOGS_LIMIT.default,
    body: (logs, oversized, nextCursor) => ({ ...source, logs, oversized, nextCursor }),
  });
}

/** One page of the capture's HTTP observations, optionally for one exact path, after the cursor. */
export function dailyHttpObservationsPage(
  capture: DailyCaptureRecords,
  input: GetDailyHttpObservationsInput,
): GetDailyHttpObservationsOutput {
  const matches = capture.observations.filter((observation) => !input.path || observation.path === input.path);
  const source = { captureId: capture.captureId, evidenceSha256: capture.sha256[EVIDENCE] };
  return paginate({
    binding: binding(capture, "get_daily_http_observations", [input.path ?? null]),
    matches,
    cursor: input.cursor,
    limit: input.limit ?? DAILY_HTTP_LIMIT.default,
    body: (observations, oversized, nextCursor) => ({ ...source, observations, oversized, nextCursor }),
  });
}

/**
 * Answer one tool request: the bearer token's grant selects the capture, its
 * files are verified against the grant's hashes, and the query selects a page.
 */
export async function dailyEvidenceResponse(
  request: Request,
  tool: DailyEvidenceTool,
  options: { pool: () => Pool; capturesDir: string },
): Promise<Response> {
  const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return failure(401, "unauthorized", "A capture access token is required.");
  try {
    const grant = await createCaptureAccess(options.pool(), options.capturesDir).resolve(token);
    const params = new URL(request.url).searchParams;
    const read = () => readDailyCapture(options.capturesDir, grant.captureId, grant.sha256);
    if (tool === "get_daily_logs") {
      const input = parseQuery(params, getDailyLogsInputSchema, ["service", "messageContains", "cursor", "limit"]);
      if (!input.success) return failure(400, "invalid_input", input.message);
      return page(getDailyLogsOutputSchema.parse(dailyLogsPage(await read(), input.data)));
    }
    const input = parseQuery(params, getDailyHttpObservationsInputSchema, ["path", "cursor", "limit"]);
    if (!input.success) return failure(400, "invalid_input", input.message);
    return page(getDailyHttpObservationsOutputSchema.parse(dailyHttpObservationsPage(await read(), input.data)));
  } catch (error) {
    if (error instanceof CaptureAccessError) return failure(401, "unauthorized", error.message);
    if (error instanceof DailyCursorError) return failure(400, "invalid_cursor", error.message);
    if (error instanceof DailyCaptureError) {
      const status = { missing: 404, changed: 409, invalid: 422, rejected: 422 }[error.code];
      return failure(status, `capture_${error.code}`, error.message);
    }
    console.error("Daily evidence request failed. Check PostgreSQL, migrations, and the captures directory.");
    return failure(500, "internal_error", "The lab service could not read the recorded evidence.");
  }
}

/**
 * Records in order, as many as fit both the limit and the page size. A record
 * that could not fit even an otherwise empty page is listed in oversized
 * instead of being shortened. The cursor names the last record considered,
 * so a repeated request returns the same page.
 */
function paginate<T extends { id: string }, Body>(options: {
  binding: string;
  matches: T[];
  cursor: string | undefined;
  limit: number;
  body: (records: T[], oversized: Oversized[], nextCursor: string | null) => Body;
}): Body {
  const { matches, limit } = options;
  let start = 0;
  if (options.cursor !== undefined) {
    const after = readCursor(options.cursor, options.binding);
    start = matches.findIndex((record) => record.id === after) + 1;
    if (start === 0) throw new DailyCursorError("This cursor does not point into these results. Repeat the request without a cursor.");
  }
  const records: T[] = [];
  const oversized: Oversized[] = [];
  // Serialized size of the page so far, with room reserved for the longest cursor.
  const empty = bytes(options.body([], [], "x".repeat(MAX_CURSOR_LENGTH)));
  let size = empty;
  let next = start;
  for (; next < matches.length && records.length < limit; next++) {
    const record = matches[next];
    const recordBytes = bytes(record);
    if (empty + recordBytes > DAILY_EVIDENCE_PAGE_BYTES) {
      const entry = { id: record.id, bytes: recordBytes };
      const cost = bytes(entry) + (oversized.length ? 1 : 0);
      if (size + cost > DAILY_EVIDENCE_PAGE_BYTES) break;
      oversized.push(entry);
      size += cost;
      continue;
    }
    const cost = recordBytes + (records.length ? 1 : 0);
    if (size + cost > DAILY_EVIDENCE_PAGE_BYTES) break;
    records.push(record);
    size += cost;
  }
  if (next === start && start < matches.length) throw new Error("A Daily evidence page made no progress.");
  const nextCursor = next < matches.length ? writeCursor(options.binding, matches[next - 1].id) : null;
  return options.body(records, oversized, nextCursor);
}

// The cursor schema's maximum length.
const MAX_CURSOR_LENGTH = 512;

/** Ties a cursor to one capture's evidence file, one tool, and one set of filters. */
function binding(capture: DailyCaptureRecords, tool: DailyEvidenceTool, filters: (string | null)[]) {
  return createHash("sha256")
    .update(JSON.stringify([1, tool, capture.captureId, capture.sha256[EVIDENCE], ...filters]))
    .digest("hex")
    .slice(0, 32);
}

function writeCursor(binding: string, after: string) {
  return Buffer.from(JSON.stringify({ v: 1, binding, after })).toString("base64url");
}

function readCursor(cursor: string, expected: string) {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    value = undefined;
  }
  if (!isCursor(value))
    throw new DailyCursorError("This cursor is not valid. Repeat the request without a cursor to start at the first record.");
  if (value.binding !== expected)
    throw new DailyCursorError("This cursor belongs to a different capture, tool, or filters. Repeat the request without a cursor.");
  return value.after;
}

function isCursor(value: unknown): value is { v: 1; binding: string; after: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { v, binding, after, ...rest } = value as Record<string, unknown>;
  return (
    v === 1 &&
    typeof binding === "string" &&
    /^[0-9a-f]{32}$/.test(binding) &&
    typeof after === "string" &&
    after.length > 0 &&
    after.length <= 100 &&
    Object.keys(rest).length === 0
  );
}

interface InputSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string; path: PropertyKey[] }[] } };
}

/** Allowed keys, each at most once; limit is a decimal integer. Everything else is the shared schema's job. */
function parseQuery<T>(params: URLSearchParams, schema: InputSchema<T>, keys: string[]) {
  const query: Record<string, string | number> = {};
  for (const [key, value] of params) {
    if (!keys.includes(key) || Object.hasOwn(query, key))
      return { success: false as const, message: `Unknown or repeated query parameter "${key}". Allowed once each: ${keys.join(", ")}.` };
    query[key] = key === "limit" && /^\d{1,4}$/.test(value) ? Number(value) : value;
  }
  const parsed = schema.safeParse(query);
  if (parsed.success) return parsed;
  const issue = parsed.error.issues[0];
  return { success: false as const, message: `${issue?.path.join(".") || "query"}: ${issue?.message ?? "is invalid"}` };
}

function page(body: GetDailyLogsOutput | GetDailyHttpObservationsOutput) {
  // paginate reserves space for the cursor, so this only guards against a bug.
  if (bytes(body) > DAILY_EVIDENCE_PAGE_BYTES) throw new Error("A Daily evidence page exceeded its size limit.");
  return json(body, 200);
}

function failure(status: number, code: string, message: string) {
  return json({ error: { code, message } }, status);
}

function json(value: unknown, status: number) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
