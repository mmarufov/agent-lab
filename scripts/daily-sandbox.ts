import { capture, captureConfig, recover } from "./lib/daily-capture";
import {
  check,
  formatError,
  logs,
  releaseOperationLockSync,
  reset,
  SandboxError,
  stop,
  up,
} from "./lib/daily-sandbox";

const COMMANDS = ["up", "check", "logs", "stop", "reset", "capture", "recover"];

// pnpm daily:<command>; see scenarios/daily/compose.yaml for the sandbox itself.
async function main() {
  const args = process.argv.slice(2);
  const config = captureConfig();
  if (args.length !== 1) throw new Error(`Usage: ${COMMANDS.map((command) => `pnpm daily:${command}`).join(" | ")}`);
  switch (args[0]) {
    case "up":
      exitOnSignal();
      return up(config);
    case "check":
      return check(config);
    case "stop":
      exitOnSignal();
      return stop(config);
    case "reset":
      exitOnSignal();
      return reset(config);
    case "recover":
      exitOnSignal();
      return recover(config);
    case "capture": {
      // The first Ctrl+C or SIGTERM stops sampling. The capture then starts
      // daily-db again if it stopped it, collects logs, and saves its record.
      const controller = new AbortController();
      const interrupt = (signal: NodeJS.Signals) => {
        if (controller.signal.aborted)
          console.log(`${signal} again: still restoring and saving; cleanup has its own time limit.`);
        else {
          console.log(`\n${signal}: stopping the capture; cleanup runs before exit.`);
          controller.abort(signal);
        }
      };
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", interrupt);
      const result = await capture(config, controller.signal);
      process.exitCode = result.exitCode;
      return;
    }
    case "logs": {
      // Ctrl+C also reaches docker compose, which stops following; then exit cleanly.
      let interrupted = false;
      const interrupt = () => (interrupted = true);
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", interrupt);
      const code = await logs(config);
      if (code !== 0 && !interrupted)
        throw new SandboxError("docker", `docker compose logs exited with code ${code}.`);
      return;
    }
    default:
      throw new Error(`Unknown command ${JSON.stringify(args[0])}. Use ${COMMANDS.join(", ")}.`);
  }
}

/** An interrupted command still releases the sandbox lock before exiting. */
function exitOnSignal() {
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      releaseOperationLockSync();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
}

void main().catch((error: unknown) => {
  console.error(formatError(error));
  process.exitCode = 1;
});
