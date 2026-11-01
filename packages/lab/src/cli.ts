import { createPool } from "./database";
import { createTrial } from "./fixtures";
import { migrate } from "./migrate";
import { createLab } from "./service";
import { createRunStore, describeIntegrity, type DailyRun, type RunIntegrity, type SimulatedRun } from "./runs";
import { unassessedOutcome } from "./outcome";
import { evaluateRun } from "./evaluate";
import { evaluateDailyRun, type DailyEvidenceReport } from "./daily-evaluate";
import { describeDailyEvent } from "./daily-trace";
import { createReviewStore } from "./reviews";
import { describeReview } from "./review-report";
import { createCoverageStore } from "./daily-coverage";
import { coverageExitCode, describeCoverage } from "./coverage-report";

function printRun(run: SimulatedRun) {
  console.log(`Run: ${run.id}\nStatus: ${run.status}\nTrial: ${run.trialId}\nDeployment: ${run.deploymentId}\nSession: ${run.sessionId ?? "not created"}`);
  console.log(`Model (first step): ${run.modelId ?? "not observed"}\nInstructions SHA-256: ${run.instructionsHash}`);
  console.log(`Started: ${run.startedAt}\nFinished: ${run.finishedAt ?? "not recorded"}\nDuration: ${run.durationMs === null ? "not recorded" : `${Math.round(run.durationMs)} ms`}`);
  console.log(describeIntegrity(run.integrity));
  console.log(`Task: ${run.task}`);
  for (const event of run.events) {
    if (event.type === "actions.requested" || event.type === "action.result") console.log(`\n${event.type}: ${JSON.stringify(event.data, null, 2)}`);
  }
  console.log(`\nAnswer: ${run.answer ? JSON.stringify(run.answer, null, 2) : "not available"}`);
  console.log(`Usage: ${run.usage ? JSON.stringify(run.usage) : "not reported; any partial step usage remains in the events"}`);
  if (run.error) console.log(`Error: ${run.error}`);
  if (run.status === "running") console.log("No terminal status was saved. This run may still be active or may have been interrupted.");
  console.log("Execution status is not an independent evaluation of the answer. Use --json for the full source snapshot and event record.");
}

function printEvaluation(report: ReturnType<typeof evaluateRun>, integrity: RunIntegrity) {
  console.log(`Run: ${report.runId}\nDeployment: ${report.deploymentId}\nEvaluator: ${report.evaluatorVersion}`);
  console.log(describeIntegrity(integrity));
  for (const name of ["execution", "answer", "toolTrace", "retrieval", "citations"] as const) {
    const result = report.checks[name];
    console.log(`${result.status.toUpperCase()} ${name}: ${result.reason}`);
  }
  console.log(`Cited IDs: ${report.citedEvidenceIds.join(", ") || "none assessed"}`);
  console.log("NOT_EVALUATED diagnosis (TypeScript): Citation checks do not assess meaning. Model reviews are separate assessments.");
  console.log("Use --json for the received logs and their request/result event IDs.");
}

// The same lines pnpm lab:daily-investigate printed while the run happened.
function printDailyRun(run: DailyRun) {
  console.log(`Run: ${run.id}\nSource: recorded Daily capture ${run.captureId}\nStatus: ${run.status}\nSession: ${run.sessionId ?? "not created"}`);
  console.log(`Pinned files: evidence.jsonl ${run.captureSha256["evidence.jsonl"]}\n  controller.jsonl ${run.captureSha256["controller.jsonl"]}\n  manifest.json ${run.captureSha256["manifest.json"]}`);
  const grant = run.grantRevokedAt ? `revoked ${run.grantRevokedAt}` : `not revoked; expires ${run.grantExpiresAt}`;
  console.log(`Access grant: ${run.grantId} (${grant})\nModel (first step): ${run.modelId ?? "not observed"}`);
  console.log(`Instructions SHA-256: ${run.instructionsHash}\nAnswer schema: version ${run.resultSchemaVersion}`);
  console.log(`Started: ${run.startedAt}\nFinished: ${run.finishedAt ?? "not recorded"}\nDuration: ${run.durationMs === null ? "not recorded" : `${Math.round(run.durationMs)} ms`}`);
  console.log(describeIntegrity(run.integrity));
  console.log(`Task: ${run.task}\n`);
  for (const event of run.events) for (const line of describeDailyEvent(event)) console.log(line);
  console.log(`\nAnswer: ${run.answer ? JSON.stringify(run.answer, null, 2) : "not available"}`);
  console.log(`Usage: ${run.usage ? JSON.stringify(run.usage) : "not reported; any partial step usage remains in the events"}`);
  if (run.error) console.log(`Error: ${run.error}`);
  if (run.status === "running") console.log("No terminal status was saved. This run may still be active or may have been interrupted.");
  console.log("Execution status is not an independent evaluation of the answer. Use --json for the instructions, configuration, and full event record.");
}

function printDailyEvaluation(report: DailyEvidenceReport, frozen: boolean, integrity: RunIntegrity) {
  console.log(`Run: ${report.runId}\nCapture: ${report.captureId} (evidence.jsonl ${report.evidenceSha256})\nEvaluator: ${report.evaluatorVersion}`);
  console.log(frozen ? "Report saved when the run finished." : "Computed now: the run has no saved report because it never finished.");
  console.log(describeIntegrity(integrity));
  for (const name of ["execution", "answer", "toolTrace", "retrieval", "citations"] as const) {
    const result = report.checks[name];
    console.log(`${result.status.toUpperCase()} ${name}: ${result.reason}`);
  }
  console.log(`Cited IDs: ${report.citedEvidenceIds.join(", ") || "none assessed"}`);
  console.log(`NOT ASSESSED diagnosis: ${report.diagnosisAssessment.reason}`);
  console.log("Use --json for each received record and its request/result event IDs.");
}

// A finished run whose record no longer verifies fails evaluation, whatever its checks say.
const unsound = (integrity: RunIntegrity) => integrity.status === "mismatch" || integrity.status === "missing";

const pool = createPool();
try {
  const [command, trialId, format, ...extra] = process.argv.slice(2);
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
  } else if (command === "review" && trialId && extra.length === 0 && (format === undefined || format === "--json")) {
    // Reads the saved attempt only; reopening never sends another model request.
    const saved = await createReviewStore(pool).get(trialId);
    if (format === "--json") console.log(JSON.stringify(saved, null, 2));
    else console.log([`Review: ${saved.id}`, ...describeReview(saved)].join("\n"));
  } else if (command === "coverage" && trialId && extra.length === 0 && (format === undefined || format === "--json")) {
    // Reads the saved assessment only: no capture files, Eve, or model.
    const saved = await createCoverageStore(pool).get(trialId);
    if (format === "--json") console.log(JSON.stringify(saved, null, 2));
    else console.log(describeCoverage(saved).join("\n"));
    process.exitCode = coverageExitCode(saved.result);
  } else if ((command === "run" || command === "evaluate") && trialId && extra.length === 0 && (format === undefined || format === "--json")) {
    const run = await createRunStore(pool).getAny(trialId);
    if (run.source === "daily_capture") {
      if (command === "evaluate") {
        const report = run.evidenceReport ?? evaluateDailyRun({ ...run, evidenceSha256: run.captureSha256["evidence.jsonl"] });
        if (format === "--json") console.log(JSON.stringify({ ...report, frozen: run.evidenceReport !== null, integrity: run.integrity }, null, 2));
        else printDailyEvaluation(report, run.evidenceReport !== null, run.integrity);
        if (unsound(run.integrity) || Object.values(report.checks).some((result) => result.status === "fail")) process.exitCode = 1;
        else if (report.checks.execution.status === "not_evaluated") process.exitCode = 2;
      } else if (format === "--json") console.log(JSON.stringify(run, null, 2));
      else printDailyRun(run);
    } else if (command === "evaluate") {
      const report = { ...evaluateRun(run), outcome: run.outcomeReport ?? unassessedOutcome(), integrity: run.integrity };
      if (format === "--json") console.log(JSON.stringify(report, null, 2));
      else {
        printEvaluation(report, run.integrity);
        console.log(`Outcome ${report.outcome.status.toUpperCase()}: ${report.outcome.reasons.join(" ")}`);
        if (report.outcome.expected) console.log(`Expected: ${JSON.stringify(report.outcome.expected)}\nObserved: ${JSON.stringify(report.outcome.observed)}`);
      }
      if (unsound(run.integrity) || report.outcome.status === "fail" || Object.values(report.checks).some((result) => result.status === "fail")) process.exitCode = 1;
      else if (report.checks.execution.status === "not_evaluated") process.exitCode = 2;
    } else {
      if (format === "--json") console.log(JSON.stringify(run, null, 2));
      else printRun(run);
    }
  } else {
    throw new Error("Usage: pnpm lab init | inspect <trial-id> | promote <trial-id> | run <run-id|latest> [--json] | evaluate <run-id|latest> [--json] | review <review-id|latest> [--json] | coverage <assessment-id|latest> [--json]");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Lab command failed.");
  process.exitCode = 1;
} finally {
  await pool.end();
}
