import { z } from "zod";

// What an investigation of one recorded Daily capture returns. The fields match
// the simulated version-one answer; the descriptions, which the model sees,
// name the two kinds of Daily record. Shape validation is not an evaluation of
// whether these claims are true.

/** Saved as result_schema_version. 1 and 2 are the simulated answer versions. */
export const DAILY_ANSWER_SCHEMA_VERSION = 3;

export const dailyInvestigationAnswerSchema = z.strictObject({
  diagnosis: z.string().min(1).describe("What the recorded evidence supports, or that the cause is undetermined."),
  evidenceIds: z
    .array(z.string().min(1))
    .describe(
      "IDs of the HTTP observations and log lines, returned by the tools during this investigation, that support the diagnosis. Use an empty list when none were retrieved.",
    ),
  uncertainty: z.string().min(1).describe("What the recorded evidence does not establish."),
});

export type DailyInvestigationAnswer = z.infer<typeof dailyInvestigationAnswerSchema>;
