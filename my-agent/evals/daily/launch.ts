// Settings pnpm lab:eval:daily (scripts/lib/daily-eval.ts) gives the eve eval
// process besides the evidence tools' own (my-agent/client/investigate.ts,
// investigatorEnv). The model never sees any of them.

export const DAILY_RECOVERY_EVAL_ID = "daily/recovery";

export const EVAL_ENV = {
  /** Where the eval's setup reads the pinned recording to verify it and grade against it. */
  capturesDir: "LAB_EVAL_CAPTURES_DIR",
  /** A fresh ID per launch, logged by the eval, so the launcher finds this run's artifacts. */
  launchId: "LAB_EVAL_LAUNCH_ID",
  /** "stdin": the launcher holds stdin open; end of input means it exited, so the eval stops. */
  lifeline: "LAB_EVAL_LIFELINE",
} as const;
