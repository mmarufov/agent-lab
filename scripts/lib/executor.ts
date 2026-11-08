import type { createPool } from "@agent-lab/lab/database";
import { CoverageError, createCoverageStore } from "@agent-lab/lab/daily-coverage";
import { DailyCaptureError } from "@agent-lab/lab/daily-evidence";
import type { ExecutionJob, FollowUp } from "@agent-lab/lab/jobs";
import { ReviewAdmissionError } from "@agent-lab/lab/reviews";
import { IntegrityError } from "@agent-lab/lab/runs";
import { runDailyInvestigation } from "./daily-investigation";
import { runInvestigation } from "./investigation";
import { runReview } from "./review";

/** How a job ended: the job's status, a message the browser may show, and what to queue next. */
export interface Executed {
  status: "running" | "completed" | "failed" | "cancelled";
  error?: string;
  next?: FollowUp;
}

/**
 * Runs one claimed job for the local worker. A refusal this code can explain
 * without credentials or paths becomes the job's error; any other failure
 * keeps the worker's generic message. Tests pass a captures directory, an
 * evidence service, and a fixture Eve.
 */
export function createExecutor(
  pool: ReturnType<typeof createPool>,
  options: Pick<NonNullable<Parameters<typeof runDailyInvestigation>[2]>, "capturesDir" | "baseUrl" | "startEve"> = {},
) {
  return async (job: ExecutionJob, signal: AbortSignal): Promise<Executed> => {
    const command = job.command;
    if (command.kind === "investigate" && "captureId" in command) {
      try {
        const run = await runDailyInvestigation(pool, command.captureId, { ...options, signal, jobId: job.id });
        // Coverage of a completed answer is queued in the commit that finishes this job.
        return { status: run.status, next: run.status === "completed" ? { kind: "coverage", runId: run.id } : undefined };
      } catch (error) {
        if (error instanceof DailyCaptureError)
          return {
            status: "failed",
            error: `The recording could not be verified when the investigation started. ${error.message} No investigation was saved and no model request was made.`,
          };
        throw error;
      }
    }
    if (command.kind === "investigate") {
      const run = await runInvestigation(pool, "caseId" in command ? { caseId: command.caseId } : command.deploymentId, { signal, jobId: job.id });
      return { status: run.status };
    }
    if (command.kind === "coverage") {
      try {
        // The same assessment pnpm lab:coverage saves. No model request.
        await createCoverageStore(pool).assess(command.runId, { capturesDir: options.capturesDir });
        return { status: "completed" };
      } catch (error) {
        if (error instanceof CoverageError || error instanceof IntegrityError)
          return { status: "failed", error: `Coverage could not be checked. ${error.message}` };
        throw error;
      }
    }
    try {
      const review = await runReview(pool, command.runId, { signal, jobId: job.id });
      return { status: review.status };
    } catch (error) {
      if (error instanceof ReviewAdmissionError || error instanceof IntegrityError)
        return { status: "failed", error: `Review could not start. ${error.message}` };
      throw error;
    }
  };
}
