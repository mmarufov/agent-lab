import { getLogsInputSchema } from "@agent-lab/contracts";
import { createPool } from "@agent-lab/lab/database";
import { createTrial, deleteTrials } from "@agent-lab/lab/fixtures";
import { getLogs } from "../my-agent/agent/lib/get-logs";

async function main() {
  const args = process.argv.slice(2);
  const input = getLogsInputSchema.safeParse({ deploymentId: args[0] });
  if (args.length !== 1 || !input.success) {
    throw new Error("Usage: pnpm lab:logs <deployment-id> (for example: pnpm lab:logs B)");
  }

  const pool = createPool();
  let trialId: string | undefined;
  try {
    // Only this trusted demo creates the trial. getLogs itself uses HTTP only.
    const trial = await createTrial(pool);
    trialId = trial.trialId;
    const logs = await getLogs(input.data, {
      baseUrl: process.env.LAB_BASE_URL ?? "http://127.0.0.1:3000",
      trialToken: trial.token,
    });
    console.log(`Trial: ${trial.trialId}`);
    console.log(`Deployment: ${input.data.deploymentId}`);
    if (logs.length === 0) console.log("No saved logs for this deployment.");
    for (const log of logs) console.log(`${log.id}: ${log.message}`);
    // Successful demo trials remain in Postgres so you can inspect the records.
  } catch (error) {
    if (trialId) {
      await deleteTrials(pool, [trialId]).catch(() => {
        console.error(`Could not clean up failed demo trial ${trialId}.`);
      });
    }
    throw error;
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "The logs demo failed.");
  process.exitCode = 1;
});
