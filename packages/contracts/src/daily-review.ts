import { z } from "zod";
import {
  dailyApplicationLogSchema,
  dailyCaptureEvidenceSchema,
  dailyCaptureIdSchema,
  type DailyCaptureEvidence,
} from "./daily-capture";
import { dailyInvestigationAnswerSchema } from "./daily-investigation";

// What the reviewer of one Daily investigation receives: the task, the saved
// answer, which recording it read, and every distinct record its successful
// tool calls returned before the answer, cited or not. Nothing else: no
// investigator instructions, reasoning, or conversation, no controller
// records, and no note of which tool call returned a record. The evidence
// check saved beside the review keeps that provenance.

/** When a record happened: an HTTP request's start, or when Docker received a log line (null if Docker printed no time). */
export const dailyRecordTime = (record: DailyCaptureEvidence) => (record.kind === "http" ? record.startedAt : record.timestamp);

function instant(timestamp: string) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(timestamp);
  if (!match) throw new Error(`Not an RFC 3339 timestamp with seconds and a zone: ${timestamp}`);
  return { seconds: Date.parse(`${match[1]}${match[3]}`), fraction: match[2] ?? "" };
}

/**
 * Orders two record timestamps exactly. Docker writes nanoseconds, more than a
 * JavaScript Date keeps, and trims trailing zeros, so text order is not time order.
 */
export function compareTimestamps(a: string, b: string) {
  const x = instant(a);
  const y = instant(b);
  if (x.seconds !== y.seconds) return x.seconds - y.seconds;
  const digits = Math.max(x.fraction.length, y.fraction.length);
  const [p, q] = [x.fraction.padEnd(digits, "0"), y.fraction.padEnd(digits, "0")];
  return p < q ? -1 : p > q ? 1 : 0;
}

const untimedLogSchema = dailyApplicationLogSchema.extend({ timestamp: z.null() });
export type UntimedDailyLog = z.infer<typeof untimedLogSchema>;

/** Timed records earliest first, then untimed log lines. Records with equal times, and untimed lines, keep their given order. */
export function orderDailyRecords(records: readonly DailyCaptureEvidence[]) {
  return {
    evidence: records
      .filter((record) => dailyRecordTime(record) !== null)
      .sort((a, b) => compareTimestamps(dailyRecordTime(a)!, dailyRecordTime(b)!)),
    untimedEvidence: records.filter((record): record is UntimedDailyLog => record.kind === "log" && record.timestamp === null),
  };
}

export const dailyReviewInputSchema = z
  .strictObject({
    task: z.string().min(1),
    captureId: dailyCaptureIdSchema,
    evidenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    answer: dailyInvestigationAnswerSchema,
    /** Complete records with a time, earliest first. */
    evidence: z.array(dailyCaptureEvidenceSchema),
    /** Complete log lines without a time. Where they fall in time is unknown. */
    untimedEvidence: z.array(untimedLogSchema),
  })
  .superRefine((input, context) => {
    const seen = new Set<string>();
    for (const [list, records] of [["evidence", input.evidence], ["untimedEvidence", input.untimedEvidence]] as const) {
      records.forEach((record, index) => {
        if (seen.has(record.id)) context.addIssue({ code: "custom", path: [list, index, "id"], message: "Each record appears once." });
        seen.add(record.id);
      });
    }
    input.evidence.forEach((record, index) => {
      const time = dailyRecordTime(record);
      if (time === null) context.addIssue({ code: "custom", path: ["evidence", index], message: "An untimed log line belongs in untimedEvidence." });
      const previous = index > 0 ? dailyRecordTime(input.evidence[index - 1]) : null;
      if (time !== null && previous !== null && compareTimestamps(previous, time) > 0)
        context.addIssue({ code: "custom", path: ["evidence", index], message: "Timed records are listed earliest first." });
    });
  });

export type DailyReviewInput = z.infer<typeof dailyReviewInputSchema>;
