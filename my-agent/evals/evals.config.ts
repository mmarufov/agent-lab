import { defineEvalConfig } from "eve/evals";
import { prepareDailyRecovery } from "./daily/recovery-setup";

// Eve Eval's configuration for this app. Run evals with pnpm lab:eval:daily
// from the repository root: it holds the shared execution lock, grants access
// to the pinned recording, and starts `eve eval` with strict assertions,
// concurrency one, a five-minute timeout, and reporting disabled. No reporter
// is configured here, so results stay in .eve/evals/.

export default defineEvalConfig({
  maxConcurrency: 1,
  timeoutMs: 5 * 60_000,
  // Runs once, before Eve starts the agent server; a throw stops the run before model work.
  setup: () => prepareDailyRecovery(),
  teardown: (context) => context?.dispose(),
});
