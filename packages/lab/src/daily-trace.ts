import type { DailyApplicationLog, DailyHttpObservation } from "@agent-lab/contracts/daily-capture";

// Terminal lines for one event of a Daily investigation. The runner prints
// them as events arrive and pnpm lab run prints the same lines from the saved
// record, so a reopened run reads exactly like the live one. Display only: the
// evidence checker reads the events themselves.

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const clip = (text: string, length = 160) => (text.length > length ? `${text.slice(0, length - 3)}...` : text);
// JSON with object keys sorted at every level. PostgreSQL's jsonb does not keep
// key order, so sorting makes saved events print exactly like live ones.
const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]))
      : value;
const json = (value: unknown) => JSON.stringify(sorted(value));
const tokens = (usage: Record<string, unknown>) => {
  const cost = usage.costUsd;
  return (
    `${usage.inputTokens ?? "unknown"} input, ${usage.outputTokens ?? "unknown"} output tokens` +
    (typeof cost === "number" ? `, reported cost $${cost.toFixed(6)}` : "")
  );
};

function observation(record: DailyHttpObservation) {
  const outcome =
    record.outcome === "response"
      ? `${record.response.status} ${clip(typeof record.response.body === "string" ? record.response.body : json(record.response.body), 80)}`
      : record.outcome === "timeout"
        ? `no response within ${record.deadlineMs} ms`
        : `network error ${record.error.code ?? record.error.name}: ${clip(record.error.message, 60)}`;
  return `  ${record.id}  ${record.startedAt}  ${record.method} ${record.path}  ${outcome}  (${record.elapsedMs} ms)`;
}

const logLine = (record: DailyApplicationLog) =>
  `  ${record.id}  ${record.timestamp ?? "no timestamp"}  ${record.service} ${record.stream}  ${clip(record.message)}`;

function page(output: Record<string, unknown>) {
  const logs = Array.isArray(output.logs) ? (output.logs as DailyApplicationLog[]) : null;
  const observations = Array.isArray(output.observations) ? (output.observations as DailyHttpObservation[]) : null;
  const oversized = Array.isArray(output.oversized) ? (output.oversized as { id: string; bytes: number }[]) : [];
  const records = logs ?? observations ?? [];
  const summary =
    `${records.length} ${logs ? "log line(s)" : "HTTP observation(s)"}` +
    (oversized.length ? `, ${oversized.length} too large to return (${oversized.map((entry) => entry.id).join(", ")})` : "") +
    (output.nextCursor ? "; more pages" : "; last page");
  return [summary, ...(logs ? logs.map(logLine) : (observations ?? []).map(observation))];
}

/** Accepts a live Eve event or a saved one. */
export function describeDailyEvent(event: { type: string; data?: unknown }): string[] {
  const data = object(event.data);
  switch (event.type) {
    case "step.started":
      return [`Model step ${Number(data.stepIndex ?? 0) + 1}: ${data.modelId ?? "unknown model"}`];
    case "step.completed":
      return [`  step ended (${data.finishReason ?? "unknown"}): ${tokens(object(data.usage))}`];
    case "actions.requested":
      return (Array.isArray(data.actions) ? data.actions : [])
        .map(object)
        .filter((action) => action.kind === "tool-call")
        .map((action) => `Tool request ${action.toolName} ${json(action.input ?? {})}`);
    case "action.result": {
      const result = object(data.result);
      if (result.kind !== "tool-result") return [];
      if (data.status !== "completed" || result.isError === true) {
        const error = object(data.error);
        const detail = typeof error.message === "string" ? error.message : typeof result.output === "string" ? result.output : "no error message";
        return [`Tool result ${result.toolName} (${data.status}): ${clip(detail, 300)}`];
      }
      const [summary, ...records] = page(object(result.output));
      return [`Tool result ${result.toolName}: ${summary}`, ...records];
    }
    case "input.requested":
      return (Array.isArray(data.requests) ? data.requests : []).map((request) => `Eve asked for input: ${object(request).prompt}`);
    case "turn.failed":
    case "session.failed":
    case "step.failed":
      return [`${event.type}: ${data.message ?? "no message"}`];
    case "turn.cancelled":
      return ["Turn cancelled."];
    default:
      return [];
  }
}
