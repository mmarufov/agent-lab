import {
  getLogsInputSchema,
  getLogsOutputSchema,
  type DeploymentLog,
  type InvestigationEvent,
} from "@agent-lab/contracts";
import type { DailyApplicationLog, DailyHttpObservation } from "@agent-lab/contracts/daily-capture";
import { getDailyHttpObservationsInputSchema, getDailyLogsInputSchema } from "@agent-lab/contracts/daily-evidence";
import { DAILY_TOOLS, readDailyToolPage, type DailyTool } from "./daily-evaluate";

export type ActivityStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

/** One record a tool returned, exactly as returned, tagged with what kind of record it is. */
export type RecordView =
  | ({ type: "deployment_log" } & DeploymentLog)
  | ({ type: "daily_log" } & DailyApplicationLog)
  | ({ type: "http" } & DailyHttpObservation);

export interface ToolResultView {
  eventId: string;
  at: string;
  status: ActivityStatus;
  /** Keys into the run view's records, in the order returned; null when no valid page was accepted. */
  recordKeys: string[] | null;
  /** Records the tool listed as too large to return. */
  oversized: { id: string; bytes: number }[];
  /** The tool reported another page of the same request. */
  morePages: boolean;
  error: string | null;
}

export interface ActivityItem {
  id: string;
  operationId: string;
  actor: "investigator" | "checks" | "reviewer";
  kind:
    "prepare" | "model" | "tool" | "answer" | "checks" | "coverage" | "review" | "outcome";
  title: string;
  detail: string;
  status: ActivityStatus;
  at: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  eventIds: string[];
  reviewId?: string;
  /** A failure explanation that stays visible with the step. */
  error?: string;
  tool?: {
    name: string;
    turnId: string;
    callId: string;
    /** A known evidence tool's validated input; null for another tool or invalid input. */
    input: Record<string, string | number> | null;
    /** The request's filter choices in words, such as "path /feed · next page · up to 20". */
    request: string;
    results: ToolResultView[];
  };
}
export interface ActivityRun {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string | null;
  answer: unknown;
  events: readonly InvestigationEvent[];
  /** A Daily run's recording: a page from any other source is not this run's evidence. */
  capture?: { captureId: string; evidenceSha256: string };
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
export const elapsed = (start: string | null, end: string | null) => {
  if (!start || !end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
};

// JSON with object keys sorted at every level, so equal records compare equal
// even though PostgreSQL's jsonb reorders keys.
const stable = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(stable).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`
      : JSON.stringify(value);

/**
 * Every distinct record the trace's tool results returned, stored once. The
 * same record returned again keeps its key, so overlapping pages share it. An
 * ID that returns with different contents gets another key ("id#2"), so both
 * versions stay visible instead of one silently replacing the other.
 */
export function createRecordStore() {
  const records: Record<string, RecordView> = {};
  const versions = new Map<string, { key: string; fingerprint: string }[]>();
  return {
    records,
    keyOf(record: RecordView) {
      const fingerprint = stable(record);
      const known = versions.get(record.id) ?? [];
      const found = known.find((entry) => entry.fingerprint === fingerprint);
      if (found) return found.key;
      const key = known.length ? `${record.id}#${known.length + 1}` : record.id;
      known.push({ key, fingerprint });
      versions.set(record.id, known);
      records[key] = record;
      return key;
    },
  };
}
export type RecordStore = ReturnType<typeof createRecordStore>;

/** A Daily record tagged for the browser. */
export const dailyRecordView = (record: DailyApplicationLog | DailyHttpObservation): RecordView =>
  record.kind === "http" ? { type: "http", ...record } : { type: "daily_log", ...record };

function validInput(name: string, raw: unknown): Record<string, string | number> | null {
  const parsed = name === "get_logs"
    ? getLogsInputSchema.safeParse({ deploymentId: object(raw).deploymentId })
    : name === "get_daily_logs"
      ? getDailyLogsInputSchema.safeParse(raw)
      : name === "get_daily_http_observations"
        ? getDailyHttpObservationsInputSchema.safeParse(raw)
        : null;
  return parsed?.success ? (parsed.data as Record<string, string | number>) : null;
}

/** The filter choices of one request, in words. */
export function describeRequest(name: string, input: Record<string, string | number> | null) {
  if (!input) return "Invalid or unavailable input";
  if (name === "get_logs") return `Deployment ${input.deploymentId}`;
  const parts = name === "get_daily_logs"
    ? [input.service ? `${input.service} only` : "all services", input.messageContains ? `containing "${input.messageContains}"` : null]
    : [input.path ? `path ${input.path}` : "all paths"];
  parts.push(input.cursor ? "next page" : "first page");
  if (input.limit) parts.push(`up to ${input.limit}`);
  return parts.filter(Boolean).join(" · ");
}

/** How many records one page returned, and whether more remain. */
export function describeResult(name: string, count: number, oversized: number, morePages: boolean) {
  if (name === "get_logs") return `${count} logs returned`;
  const noun = name === "get_daily_logs"
    ? count === 1 ? "log line" : "log lines"
    : count === 1 ? "HTTP observation" : "HTTP observations";
  return [`${count} ${noun}`, oversized ? `${oversized} too large to return` : null, morePages ? "more pages available" : "last page"]
    .filter(Boolean)
    .join(" · ");
}

// The Daily tools' own error messages name the tool first and carry no
// credentials. Anything else that reached the trace is not shown.
function toolError(name: string, data: Record<string, unknown>, result: Record<string, unknown>) {
  const message = text(object(data.error).message) || text(result.output);
  return DAILY_TOOLS.includes(name) && message.startsWith(`${name} `)
    ? `The tool call failed: ${message.slice(0, 500)}`
    : "The tool call failed. No evidence was accepted from this result.";
}

// Display-only projection. Preserve original events in the store, but allowlist
// what reaches the browser: known tool input/output, IDs and lifecycle metadata.
export function projectActivity(run: ActivityRun, store: RecordStore = createRecordStore()): ActivityItem[] {
  const items: ActivityItem[] = [];
  const calls = new Map<string, ActivityItem>();
  const fingerprints = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const item = (
    id: string,
    kind: ActivityItem["kind"],
    at: string | null,
    title: string,
    detail: string,
    status: ActivityStatus,
  ): ActivityItem => ({
    id,
    kind,
    operationId: run.id,
    actor: "investigator",
    at,
    title,
    detail,
    status,
    finishedAt: null,
    durationMs: null,
    eventIds: [],
  });
  const prepare = item(
    `${run.id}:prepare`,
    "prepare",
    run.startedAt,
    "Preparing investigation",
    run.capture
      ? "Verifying the recording, granting read access to it, and connecting Eve to its tools."
      : "Creating the trial and connecting Eve to its tools.",
    "running",
  );
  items.push(prepare);
  let model: ActivityItem | undefined;
  const finishModel = (at: string) => {
    if (!model) return;
    model.status = "completed";
    model.finishedAt = at;
    model.durationMs = elapsed(model.at, at);
    model = undefined;
  };
  for (const event of run.events) {
    if (seen.has(event.meta.id)) continue;
    seen.add(event.meta.id);
    const data = object(event.data);
    const at = event.meta.at;
    if (
      [
        "step.started",
        "actions.requested",
        "action.result",
        "result.completed",
      ].includes(event.type) &&
      prepare.status === "running"
    ) {
      prepare.status = "completed";
      prepare.finishedAt = at;
      prepare.durationMs = elapsed(prepare.at, at);
    }
    if (event.type === "step.started") {
      finishModel(at);
      model = item(
        event.meta.id,
        "model",
        at,
        "Requesting a model response",
        text(data.modelId) || "Investigator model",
        "running",
      );
      model.eventIds.push(event.meta.id);
      items.push(model);
    } else if (event.type === "actions.requested") {
      finishModel(at);
      for (const raw of Array.isArray(data.actions) ? data.actions : []) {
        const action = object(raw);
        if (action.kind !== "tool-call") continue;
        const turnId = text(data.turnId),
          callId = text(action.callId);
        const key = JSON.stringify([
          turnId || event.meta.id,
          callId || event.meta.id,
        ]);
        const name = text(action.toolName) || "Unknown tool";
        const input = validInput(name, action.input);
        const previous = calls.get(key);
        if (previous) {
          if (!previous.eventIds.includes(event.meta.id))
            previous.eventIds.push(event.meta.id);
          if (
            previous.tool?.name !== name ||
            JSON.stringify(previous.tool.input) !== JSON.stringify(input)
          ) {
            previous.status = "failed";
            previous.detail =
              "Conflicting requests recorded for the same call.";
          }
          continue;
        }
        const request = describeRequest(name, input);
        const entry = item(
          `tool:${key}`,
          "tool",
          at,
          name,
          `Requested · ${request}`,
          "running",
        );
        entry.eventIds = [event.meta.id];
        entry.tool = { name, turnId, callId, input, request, results: [] };
        calls.set(key, entry);
        items.push(entry);
      }
    } else if (event.type === "action.result") {
      const result = object(data.result);
      if (result.kind !== "tool-result") continue;
      const turnId = text(data.turnId),
        callId = text(result.callId);
      const key = JSON.stringify([
        turnId || event.meta.id,
        callId || event.meta.id,
      ]);
      let entry = calls.get(key);
      const matched = Boolean(entry);
      if (!entry) {
        entry = item(
          `unmatched:${event.meta.id}`,
          "tool",
          at,
          text(result.toolName) || "Tool result",
          "Result has no matching request in this turn.",
          "interrupted",
        );
        entry.tool = {
          name: text(result.toolName),
          turnId,
          callId,
          input: null,
          request: "No request recorded",
          results: [],
        };
        items.push(entry);
      }
      entry.eventIds.push(event.meta.id);
      const signature = JSON.stringify(data);
      const known = fingerprints.get(key) ?? new Set<string>();
      if (known.has(signature)) continue;
      known.add(signature);
      fingerprints.set(key, known);
      const name = entry.tool!.name;
      const failed = data.status !== "completed" || result.isError === true;
      // A page counts only when it matches the request and, for Daily, this run's recording.
      let page: { records: RecordView[]; oversized: { id: string; bytes: number }[]; morePages: boolean } | null = null;
      if (!failed && result.toolName === name && entry.tool!.input) {
        if (name === "get_logs") {
          const output = getLogsOutputSchema.safeParse(result.output);
          if (output.success && output.data.logs.every((log) => log.deploymentId === entry!.tool!.input?.deploymentId))
            page = { records: output.data.logs.map((log) => ({ type: "deployment_log", ...log })), oversized: [], morePages: false };
        } else if (DAILY_TOOLS.includes(name) && run.capture) {
          const read = readDailyToolPage(name as DailyTool, entry.tool!.input, result.output, run.capture);
          if (!("problem" in read)) page = { records: read.records.map(dailyRecordView), oversized: read.oversized, morePages: read.nextCursor !== null };
        }
      }
      const status = !matched
        ? "interrupted"
        : failed || !page || known.size > 1 || entry.status === "failed"
          ? "failed"
          : "completed";
      entry.tool!.results.push({
        eventId: event.meta.id,
        at,
        status,
        recordKeys: status === "completed" && page ? page.records.map((record) => store.keyOf(record)) : null,
        oversized: status === "completed" && page ? page.oversized : [],
        morePages: status === "completed" && page ? page.morePages : false,
        error:
          status === "completed"
            ? null
            : !matched
              ? "No matching tool request was recorded."
              : failed
                ? toolError(name, data, result)
                : "The returned data does not match this tool request, or conflicts with an earlier result.",
      });
      entry.status = status;
      entry.finishedAt = at;
      entry.durationMs = elapsed(entry.at, at);
      entry.detail =
        status === "completed" && page
          ? describeResult(name, page.records.length, page.oversized.length, page.morePages)
          : status === "interrupted"
            ? "Result has no matching request in this turn."
            : failed
              ? "Tool call failed"
              : "Tool returned invalid data";
    } else if (event.type === "result.completed") {
      finishModel(at);
    } else if (
      ["session.failed", "turn.failed", "turn.cancelled"].includes(event.type)
    ) {
      const status = event.type.endsWith("cancelled") ? "cancelled" : "failed";
      const failure = item(
        event.meta.id,
        "outcome",
        at,
        status === "cancelled"
          ? "Investigation cancelled"
          : "Investigation interrupted",
        "Saved events and evidence remain available.",
        status,
      );
      failure.eventIds = [event.meta.id];
      items.push(failure);
    }
  }
  if (run.status !== "running") {
    for (const entry of items) {
      if (entry.status !== "running") continue;
      entry.status = run.status === "cancelled" ? "cancelled" : "interrupted";
      entry.detail =
        "The operation ended without a recorded completion for this step.";
    }
    if (run.status === "completed" && run.answer) {
      items.push(
        item(
          `${run.id}:answer`,
          "answer",
          run.finishedAt,
          "Answer saved",
          "Structured diagnosis and evidence references validated.",
          "completed",
        ),
      );
    } else if (!items.some((i) => i.kind === "outcome")) {
      items.push(
        item(
          `${run.id}:outcome`,
          "outcome",
          run.finishedAt,
          run.status === "cancelled"
            ? "Investigation cancelled"
            : "Investigation interrupted",
          "No completed answer. Recorded progress is retained.",
          run.status === "cancelled" ? "cancelled" : "failed",
        ),
      );
    }
  }
  return items;
}
