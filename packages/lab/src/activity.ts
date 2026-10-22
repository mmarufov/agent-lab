import {
  getLogsInputSchema,
  getLogsOutputSchema,
  type DeploymentLog,
  type InvestigationEvent,
} from "@agent-lab/contracts";

export type ActivityStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export interface ActivityItem {
  id: string;
  operationId: string;
  actor: "investigator" | "checks" | "reviewer";
  kind:
    "prepare" | "model" | "tool" | "answer" | "checks" | "review" | "outcome";
  title: string;
  detail: string;
  status: ActivityStatus;
  at: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  eventIds: string[];
  reviewId?: string;
  tool?: {
    name: string;
    turnId: string;
    callId: string;
    input: { deploymentId: string } | null;
    results: {
      eventId: string;
      at: string;
      status: ActivityStatus;
      logs: DeploymentLog[] | null;
      error: string | null;
    }[];
  };
}
export interface ActivityRun {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string | null;
  answer: unknown;
  events: readonly InvestigationEvent[];
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

// Display-only projection. Preserve original events in the store, but allowlist
// what reaches the browser: known tool input/output, IDs and lifecycle metadata.
export function projectActivity(run: ActivityRun): ActivityItem[] {
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
    "Creating the trial and connecting Eve to its tools.",
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
        const input = getLogsInputSchema.safeParse({
          deploymentId: object(action.input).deploymentId,
        });
        const name = text(action.toolName) || "Unknown tool";
        const previous = calls.get(key);
        if (previous) {
          if (!previous.eventIds.includes(event.meta.id))
            previous.eventIds.push(event.meta.id);
          if (
            previous.tool?.name !== name ||
            JSON.stringify(previous.tool.input) !==
              JSON.stringify(input.success ? input.data : null)
          ) {
            previous.status = "failed";
            previous.detail =
              "Conflicting requests recorded for the same call.";
          }
          continue;
        }
        const entry = item(
          `tool:${key}`,
          "tool",
          at,
          name,
          input.success
            ? `Requested · Deployment ${input.data.deploymentId}`
            : "Requested · Invalid or unavailable input",
          "running",
        );
        entry.eventIds = [event.meta.id];
        entry.tool = {
          name,
          turnId,
          callId,
          input: name === "get_logs" && input.success ? input.data : null,
          results: [],
        };
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
      const output = getLogsOutputSchema.safeParse(result.output);
      const failed = data.status !== "completed" || result.isError === true;
      const valid =
        entry.tool!.name === "get_logs" &&
        result.toolName === "get_logs" &&
        output.success &&
        output.data.logs.every(
          (log) => log.deploymentId === entry!.tool!.input?.deploymentId,
        );
      const status = !matched
        ? "interrupted"
        : failed || !valid || known.size > 1 || entry.status === "failed"
          ? "failed"
          : "completed";
      entry.tool!.results.push({
        eventId: event.meta.id,
        at,
        status,
        logs:
          status === "completed" && output.success ? output.data.logs : null,
        error:
          status === "completed"
            ? null
            : !matched
              ? "No matching tool request was recorded."
              : failed
                ? "Tool execution failed. No validated evidence was accepted from this result."
                : "The returned data does not match this tool request, or conflicts with an earlier result.",
      });
      entry.status = status;
      entry.finishedAt = at;
      entry.durationMs = elapsed(entry.at, at);
      entry.detail =
        status === "completed" && output.success
          ? `${output.data.logs.length} logs returned`
          : status === "interrupted"
            ? "Result has no matching request in this turn."
            : "Tool failed or returned invalid data";
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
