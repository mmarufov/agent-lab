import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { createPool } from "@agent-lab/lab/database";
import { migrate } from "@agent-lab/lab/migrate";

async function main() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", () =>
      reject(
        new Error(
          "Port 3000 is in use. Stop your existing pnpm dev first, or run pnpm lab:worker beside it.",
        ),
      ),
    );
    probe.listen(3000, "127.0.0.1", () =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const pool = createPool();
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
  const require = createRequire(import.meta.url);
  const children: ChildProcess[] = [];
  let stopping = false;
  let resolveExit: () => void;
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill("SIGTERM");
    resolveExit();
  };
  function start(args: string[]) {
    const child = spawn(process.execPath, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        LAB_LOCAL_EXECUTION: process.env.LAB_LOCAL_EXECUTION ?? "1",
        LAB_BASE_URL: "http://127.0.0.1:3000",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    });
    children.push(child);
    child.once("error", stop);
    child.once("exit", (code) => {
      if (!stopping && code) process.exitCode = code;
      stop();
    });
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    start([
      require.resolve("next/dist/bin/next"),
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3000",
    ]);
    for (let attempt = 0; attempt < 120 && !stopping; attempt++) {
      try {
        const result = await fetch("http://127.0.0.1:3000/api/runner", {
          signal: AbortSignal.timeout(1_000),
        });
        await result.body?.cancel();
        if (result.ok) break;
      } catch {
        /* Next is starting. */
      }
      if (attempt === 119)
        throw new Error(
          "The workbench did not become ready. Check PostgreSQL and the Next.js output.",
        );
      await delay(250);
    }
    if (!stopping && process.env.LAB_LOCAL_EXECUTION !== "0")
      start(["--import", "tsx", "scripts/lab-worker.ts"]);
    await exit;
  } finally {
    stop();
    await Promise.all(
      children.map((child) =>
        child.exitCode !== null || child.signalCode
          ? Promise.resolve()
          : new Promise<void>((resolve) =>
              child.once("close", () => resolve()),
            ),
      ),
    );
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
void main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Could not start the local workbench.",
  );
  process.exitCode = 1;
});
