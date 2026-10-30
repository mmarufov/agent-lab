import { defineDynamic, defineTool } from "eve/tools";
import {
  getDailyHttpObservationsInputSchema,
  getDailyHttpObservationsOutputSchema,
  getDailyLogsInputSchema,
  getDailyLogsOutputSchema,
} from "@agent-lab/contracts/daily-evidence";
import { dailyEvidenceConfig, getDailyHttpObservations, getDailyLogs } from "../lib/daily-evidence";
import { labToolMode } from "../lib/tool-mode";

// Read-only tools over one recorded Daily capture, exposed only when the
// trusted runner sets LAB_TOOL_MODE=daily_capture. The model chooses filters
// and pages; the grant behind the runtime token chooses the capture. Settings
// are read inside execute, so the token never enters a durable tool descriptor.
export default defineDynamic({
  events: {
    "session.started": () =>
      labToolMode() === "daily_capture"
        ? {
            get_daily_logs: defineTool({
              description:
                "Read log lines that Daily's API and gateway containers wrote during one recorded capture. " +
                "This is a fixed recording of a past time window, not Daily's current health; nothing here contacts Daily. " +
                "Lines keep their original IDs, Docker timestamps, streams, and text, in recorded order. " +
                "Optionally filter by service or by text the message contains, ignoring case. " +
                "Results are paged: to continue, call again with the same filters and cursor set to nextCursor; nextCursor is null on the last page. " +
                "A line too large to return is listed in oversized with its size.",
              inputSchema: getDailyLogsInputSchema,
              outputSchema: getDailyLogsOutputSchema,
              async execute(input, ctx) {
                return getDailyLogs(input, dailyEvidenceConfig(process.env, ctx.abortSignal));
              },
            }),
            get_daily_http_observations: defineTool({
              description:
                "Read the HTTP requests sent to Daily's API during one recorded capture and what was observed for each: " +
                "a response with its status, selected headers, and body; a timeout, meaning no response arrived within deadlineMs; or a network error. " +
                "This is a fixed recording of a past time window, not Daily's current health; nothing here contacts Daily. " +
                "Observations keep their original IDs, timestamps, durations, and order. " +
                "Optionally filter by exact request path. " +
                "Results are paged: to continue, call again with the same filter and cursor set to nextCursor; nextCursor is null on the last page. " +
                "An observation too large to return is listed in oversized with its size.",
              inputSchema: getDailyHttpObservationsInputSchema,
              outputSchema: getDailyHttpObservationsOutputSchema,
              async execute(input, ctx) {
                return getDailyHttpObservations(input, dailyEvidenceConfig(process.env, ctx.abortSignal));
              },
            }),
          }
        : null,
  },
});
