import { coverageExitCode, describeCoverage } from "@agent-lab/lab/coverage-report";
import { createPool } from "@agent-lab/lab/database";
import { createCoverageStore } from "@agent-lab/lab/daily-coverage";

// pnpm lab:coverage <run-id|latest>: which availability facts of the full
// Daily recording a finished investigation retrieved evidence for. It reads
// PostgreSQL and the run's pinned capture files only: no Docker, Eve, Next.js,
// or model request. Exits 0 covered, 1 missed, 2 not assessed.

async function main() {
  const [runId, ...extra] = process.argv.slice(2);
  if (!runId || extra.length) throw new Error("Usage: pnpm lab:coverage <run-id|latest>");
  const pool = createPool();
  try {
    const { created, assessment } = await createCoverageStore(pool).assess(runId);
    console.log(created
      ? `Saved coverage assessment ${assessment.id}.`
      : `Coverage assessment ${assessment.id} already exists for this run, profile, and evaluator version, and the recording still reproduces it. Nothing new was saved.`);
    console.log(`Read later: pnpm lab coverage ${assessment.id}\n`);
    console.log(describeCoverage(assessment).join("\n"));
    process.exitCode = coverageExitCode(assessment.result);
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Coverage command failed.");
  process.exitCode = 1;
});
