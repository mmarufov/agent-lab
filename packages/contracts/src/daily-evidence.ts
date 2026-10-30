import { z } from "zod";
import { dailyApplicationLogSchema, dailyCaptureIdSchema, dailyHttpObservationSchema } from "./daily-capture";

// The two Daily evidence tools: what the model may ask for, and what
// GET /api/tools/daily/get-logs and /get-http-observations return. Capture
// identity is never an input. The access grant behind the bearer token
// selects exactly one recorded capture.

/** The most a serialized page may take; fewer complete records are returned instead. */
export const DAILY_EVIDENCE_PAGE_BYTES = 64 * 1024;
export const DAILY_LOGS_LIMIT = { default: 50, max: 100 } as const;
export const DAILY_HTTP_LIMIT = { default: 20, max: 50 } as const;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** Opaque. Returned as nextCursor and passed back unchanged to read the next page. */
export const dailyEvidenceCursorSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/);

const cursor = dailyEvidenceCursorSchema
  .optional()
  .describe("nextCursor from the previous page of the same request. Omit it to start at the first record.");

export const getDailyLogsInputSchema = z.strictObject({
  service: z.enum(["daily-api", "daily-gateway"]).optional().describe("Only lines written by this container."),
  messageContains: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Only lines whose message contains this text, ignoring letter case."),
  cursor,
  limit: z
    .int()
    .min(1)
    .max(DAILY_LOGS_LIMIT.max)
    .optional()
    .describe(`Most lines to return in this page (default ${DAILY_LOGS_LIMIT.default}).`),
});

export const getDailyHttpObservationsInputSchema = z.strictObject({
  path: z
    .string()
    .max(200)
    .regex(/^\/[^\s?#]*$/)
    .optional()
    .describe("Only requests whose path is exactly this value."),
  cursor,
  limit: z
    .int()
    .min(1)
    .max(DAILY_HTTP_LIMIT.max)
    .optional()
    .describe(`Most observations to return in this page (default ${DAILY_HTTP_LIMIT.default}).`),
});

// Which recording every record in a page comes from: the capture and the
// SHA-256 of its evidence.jsonl.
const source = { captureId: dailyCaptureIdSchema, evidenceSha256: sha256 };
const paging = {
  // A record too large for any page is identified here instead of being
  // shortened or silently skipped.
  oversized: z.array(z.strictObject({ id: z.string().min(1), bytes: z.int().positive() })),
  nextCursor: dailyEvidenceCursorSchema.nullable(),
};

export const getDailyLogsOutputSchema = z.strictObject({
  ...source,
  logs: z.array(dailyApplicationLogSchema),
  ...paging,
});

export const getDailyHttpObservationsOutputSchema = z.strictObject({
  ...source,
  observations: z.array(dailyHttpObservationSchema),
  ...paging,
});

/** Every non-2xx response. The local-access guard's 403 has no code. */
export const dailyEvidenceErrorSchema = z.object({
  error: z.object({ code: z.string().optional(), message: z.string() }),
});

export type GetDailyLogsInput = z.infer<typeof getDailyLogsInputSchema>;
export type GetDailyLogsOutput = z.infer<typeof getDailyLogsOutputSchema>;
export type GetDailyHttpObservationsInput = z.infer<typeof getDailyHttpObservationsInputSchema>;
export type GetDailyHttpObservationsOutput = z.infer<typeof getDailyHttpObservationsOutputSchema>;
