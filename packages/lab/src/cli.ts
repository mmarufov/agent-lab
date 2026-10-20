import { createPool } from "./database";
import { createTrial } from "./fixtures";
import { migrate } from "./migrate";
import { createLab } from "./service";

const pool = createPool();
try {
  const [command, trialId] = process.argv.slice(2);
  const lab = createLab(pool);
  if (command === "migrate") {
    await migrate(pool);
    console.log("Database schema is ready.");
  } else if (command === "init") {
    console.log(JSON.stringify(await createTrial(pool), null, 2));
  } else if (command === "inspect" && trialId) {
    console.log(JSON.stringify({ state: await lab.getState(trialId), actions: await lab.listActions(trialId) }, null, 2));
  } else if (command === "promote" && trialId) {
    console.log(JSON.stringify(await lab.promote(trialId, "C"), null, 2));
  } else {
    throw new Error("Usage: pnpm lab init | inspect <trial-id> | promote <trial-id>");
  }
} finally {
  await pool.end();
}
