import { createPool } from "./database";
import { createTrial } from "./fixtures";
import { migrate } from "./migrate";
import { createLab } from "./service";
import { createRunStore } from "./runs";
import { unassessedOutcome } from "./outcome";
import { evaluateRun } from "./evaluate";
import { createReviewStore } from "./reviews";

function printRun(run: Awaited<ReturnType<ReturnType<typeof createRunStore>["get"]>>) {
  console.log(`Run: ${run.id}\nStatus: ${run.status}\nTrial: ${run.trialId}\nDeployment: ${run.deploymentId}\nSession: ${run.sessionId ?? "not created"}`);
  console.log(`Model (first step): ${run.modelId ?? "not observed"}\nInstructions SHA-256: ${run.instructionsHash}`);
  console.log(`Started: ${run.startedAt}\nFinished: ${run.finishedAt ?? "not recorded"}\nDuration: ${run.durationMs === null ? "not recorded" : `${Math.round(run.durationMs)} ms`}`);
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

function printEvaluation(report: ReturnType<typeof evaluateRun>) {
  console.log(`Run: ${report.runId}\nDeployment: ${report.deploymentId}\nEvaluator: ${report.evaluatorVersion}`);
  for (const name of ["execution", "answer", "toolTrace", "retrieval", "citations"] as const) {
    const result = report.checks[name];
    console.log(`${result.status.toUpperCase()} ${name}: ${result.reason}`);
  }
  console.log(`Cited IDs: ${report.citedEvidenceIds.join(", ") || "none assessed"}`);
  console.log("NOT_EVALUATED diagnosis (TypeScript): Citation checks do not assess meaning. Model reviews are separate assessments.");
  console.log("Use --json for the received logs and their request/result event IDs.");
}

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
    const saved = await createReviewStore(pool).get(trialId);
    if (format === "--json") console.log(JSON.stringify(saved, null, 2));
    else {
      console.log(`Review: ${saved.id}\nStatus: ${saved.status}\nReviewer: ${saved.configuration.modelId}`);
      printEvaluation(saved.evidenceCheck);
      if (saved.review) {
        for (const claim of saved.review.claims) {
          console.log(`\n${claim.verdict.toUpperCase()} [${claim.field}] ${claim.quote}\n${claim.explanation}\nEvidence: ${claim.evidenceIds.join(", ") || "none cited"}`);
        }
        console.log(`\nMissing evidence: ${saved.review.missingEvidence.join("; ") || "none identified"}\nSummary: ${saved.review.summary}`);
      }
      console.log(`\nReview usage: ${saved.observation ? JSON.stringify(saved.observation.usage) : "not reported"}`);
      if (saved.error) console.log(`Error: ${saved.error}`);
      if (saved.status === "running") console.log("This review may still be active or may have been interrupted; no final assessment is available.");
      console.log("The model review is advisory and does not override the evidence checks.");
    }
  } else if ((command === "run" || command === "evaluate") && trialId && extra.length === 0 && (format === undefined || format === "--json")) {
    const run = await createRunStore(pool).get(trialId);
    if (command === "evaluate") {
      const report = { ...evaluateRun(run), outcome: run.outcomeReport ?? unassessedOutcome() };
      if (format === "--json") console.log(JSON.stringify(report, null, 2));
      else {
        printEvaluation(report);
        console.log(`Outcome ${report.outcome.status.toUpperCase()}: ${report.outcome.reasons.join(" ")}`);
        if (report.outcome.expected) console.log(`Expected: ${JSON.stringify(report.outcome.expected)}\nObserved: ${JSON.stringify(report.outcome.observed)}`);
      }
      if (report.outcome.status === "fail" || Object.values(report.checks).some((result) => result.status === "fail")) process.exitCode = 1;
      else if (report.checks.execution.status === "not_evaluated") process.exitCode = 2;
    } else {
      if (format === "--json") console.log(JSON.stringify(run, null, 2));
      else printRun(run);
    }
  } else {
    throw new Error("Usage: pnpm lab init | inspect <trial-id> | promote <trial-id> | run <run-id|latest> [--json] | evaluate <run-id|latest> [--json] | review <review-id|latest> [--json]");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Lab command failed.");
  process.exitCode = 1;
} finally {
  await pool.end();
}
