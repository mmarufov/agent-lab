import type { DailyRecoveryCase } from "@agent-lab/lab/daily-recovery";

// Evaluator-only metadata for evals/daily/recovery.eval.ts. pnpm lab:eval:daily
// and the eval's setup both verify the recording against these hashes before
// any model work; a missing, incomplete, or changed file stops the run, and no
// other recording is ever substituted. Nothing here is sent to the model.

export const dailyRecoveryCase = {
  id: "daily/recovery",
  recording: "Daily sandbox capture recorded by pnpm daily:capture",
  captureId: "20261022T050138Z-39b307",
  captureSha256: {
    "manifest.json": "2ddb43df4673d3f6c682622479e41602fac253bd4db9eac3d19e99c14164b87d",
    "evidence.jsonl": "b3021362880097f1c7acdfd7091f5cf59f0311408e68ff230bda697ebe2020e1",
    "controller.jsonl": "39ff555904dd4a0fcd65dde3dda47ffc3c91f725ac9c53722e4129ba31fa53cf",
  },
  // What the full recording's authenticated GET /feed observations establish
  // under daily-feed-availability-v1; setup recomputes it and refuses a mismatch.
  expected: { availability: "recovered" },
} as const satisfies DailyRecoveryCase;
