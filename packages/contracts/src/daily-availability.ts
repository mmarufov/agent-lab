import { z } from "zod";
import { dailyInvestigationAnswerSchema } from "./daily-investigation";

// The answer the Daily recovery evaluation (my-agent/evals/daily/) asks for:
// the three version-three fields, unchanged, plus a structured availability
// conclusion that deterministic checks can grade. Evaluation only. Saved CLI
// and web runs keep the version-three answer (daily-investigation.ts).
// The model sees these descriptions, so they define the fields and never
// state an expected result.

/** Recorded in the evaluation's artifacts with each answer. */
export const DAILY_AVAILABILITY_ANSWER_VERSION = "daily-availability-answer-v1";

const ids = (description: string) => z.array(z.string().min(1)).describe(description);

export const dailyAvailabilityAnswerSchema = dailyInvestigationAnswerSchema.extend({
  availability: z
    .strictObject({
      state: z
        .enum(["healthy", "failing", "recovered", "unknown"])
        .describe(
          "Availability of Daily's feed API during the recorded period, not Daily's current health. " +
            "healthy: requests did not fail during the recorded period. " +
            "failing: requests failed, and the recording does not show later requests succeeding. " +
            "recovered: requests failed, and later requests in the recording succeeded. " +
            "unknown: the records returned during this investigation do not establish which.",
        ),
      failureEvidenceIds: ids(
        "IDs of returned records that show feed requests failing during the recorded period. " +
          "Use an empty list when none were returned. Every ID here must also be in evidenceIds.",
      ),
      recoveryEvidenceIds: ids(
        "IDs of returned records that show feed requests succeeding after the recorded failures. " +
          "Use an empty list when none were returned. Every ID here must also be in evidenceIds.",
      ),
    })
    .describe("Whether Daily's feed API failed and later recovered during the recorded period. It describes the recording, not Daily's current health."),
});

export type DailyAvailabilityAnswer = z.infer<typeof dailyAvailabilityAnswerSchema>;
export type DailyAvailabilityState = DailyAvailabilityAnswer["availability"]["state"];
