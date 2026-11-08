import { defineEval } from "eve/evals";
import type { Assertion, AssertionEvaluation, AssertionSeverity } from "eve/evals/expect";
import { dailyAvailabilityAnswerSchema } from "@agent-lab/contracts/daily-availability";
import type { CoverageResult } from "@agent-lab/lab/coverage";
import { dailyTurnStatus, evaluateDailyRecovery, turnUsage, type DailyRecoveryEvaluation } from "@agent-lab/lab/daily-recovery";
import { dailyCaptureTask } from "../../client/investigate";
import type config from "../evals.config";
import { dailyRecoveryCase } from "./recovery-case";
import { logRecord } from "./recovery-setup";

// One fresh session sends the unchanged Daily task with the evaluation-only
// availability answer schema. The model chooses its own filters, pages, and
// parallel calls through the same two evidence tools; the case's expectation
// never enters its request. Afterward, deterministic checks grade the
// original events and answer against the full pinned recording:
//   turn completed: a structured answer, no failure, cancellation, or input request
//   evidence checks: citations are records received in full before the answer
//   availability outcome: "recovered", citing a qualifying failure and later recovery
//   coverage (tracked, never a gate): which availability facts were retrieved
// Root cause and the free-text explanation are not assessed.

/** After a stop request, how long the cancelled turn may take to reach its boundary before its stream is abandoned. */
const CANCEL_SETTLE_MS = 15_000;

type Graded = { status: string; reason: string };

/** Passes when a check's status is "pass"; reports its reason and details either way. */
function graded<T extends Graded>(name: string, details: (value: T) => Record<string, unknown>, severity: AssertionSeverity = "gate", threshold?: number): Assertion {
  const evaluate = (value: unknown): AssertionEvaluation => {
    const check = value as T;
    return {
      score: check.status === "pass" ? 1 : 0,
      message: check.status === "pass" ? check.reason : `${check.status}: ${check.reason}`,
      metadata: { status: check.status, ...details(check) },
    };
  };
  return {
    name,
    severity,
    threshold,
    evaluate,
    score: (value) => evaluate(value).score,
    gate: (next) => graded(name, details, "gate", next),
    soft: (next) => graded(name, details, "soft", next),
    atLeast: (next) => graded(name, details, "soft", next),
  };
}

/** The share of the recording's availability facts the received records establish. Soft and tracked only. */
function coverage(severity: AssertionSeverity = "soft", threshold?: number): Assertion {
  const evaluate = (value: unknown): AssertionEvaluation => {
    const result = value as CoverageResult;
    const applicable = result.facts.filter((fact) => fact.status !== "not_assessed");
    return {
      score: applicable.length ? applicable.filter((fact) => fact.status === "covered").length / applicable.length : 0,
      message: `${result.result}: ${result.reason}`,
      metadata: {
        result: result.result,
        facts: result.facts.map((fact) => ({ id: fact.id, status: fact.status, matchedIds: fact.requirements.flatMap((entry) => entry.matchedIds) })),
      },
    };
  };
  return {
    name: "coverage (tracked)",
    severity,
    threshold,
    evaluate,
    score: (value) => evaluate(value).score,
    gate: (next) => coverage("gate", next),
    soft: (next) => coverage("soft", next),
    atLeast: (next) => coverage("soft", next),
  };
}

export default defineEval<typeof config>({
  description:
    "Daily's feed API failed and then recovered in recording 20261022T050138Z-39b307. Does the investigator's structured " +
    "availability conclusion match, citing records it actually received?",
  tags: ["daily", "recorded-evidence"],
  // Evaluator-only: the pinned recording and its expected availability.
  metadata: { case: dailyRecoveryCase },
  async test(t) {
    const { evalCase, recording, request, provenance, stop } = t.context;
    t.log(logRecord("case", evalCase));
    t.log(logRecord("request", request));
    t.log(logRecord("provenance", provenance));

    const interrupt = AbortSignal.any([stop, t.signal]);
    if (interrupt.aborted) {
      t.check({ status: "fail", reason: "The evaluation was stopped before the investigation started." }, graded("turn completed", () => ({})));
      return;
    }

    const session = await t.session();
    // The stream is abandoned only if a cancelled turn never settles; until
    // then a stop request cancels the turn and its events are still recorded.
    const stream = new AbortController();
    let settled = false;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = async () => {
      const reason = interrupt.reason instanceof Error ? interrupt.reason.message : String(interrupt.reason);
      t.log(logRecord("cancel", { reason }));
      settleTimer = setTimeout(
        () => stream.abort(new Error(`The cancelled turn did not settle within ${CANCEL_SETTLE_MS / 1000} seconds.`)),
        CANCEL_SETTLE_MS,
      );
      // Retry while the turn has not started yet; stop once it is accepted or settled.
      while (!settled) {
        const result = await session.cancel().catch(() => undefined);
        if (result?.status === "accepted") return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    };
    const onInterrupt = () => void cancel();
    interrupt.addEventListener("abort", onInterrupt, { once: true });
    // A stop that arrived while the session was being created fired no event.
    if (interrupt.aborted) onInterrupt();

    const started = Date.now();
    let turn: Awaited<ReturnType<typeof session.send>> | undefined;
    let failure: unknown;
    try {
      turn = await session.send(dailyCaptureTask, { outputSchema: dailyAvailabilityAnswerSchema, signal: stream.signal });
    } catch (error) {
      failure = error;
    } finally {
      settled = true;
      clearTimeout(settleTimer);
    }
    const durationMs = Date.now() - started;

    // The original events, unmodified, as Eve recorded them for this session.
    const events = session.events;
    const status = dailyTurnStatus(events);
    t.succeeded();
    if (turn) turn.outputMatches(dailyAvailabilityAnswerSchema);
    t.check(
      {
        status: !failure && status.status === "completed" ? "pass" : "fail",
        reason: failure ? `The turn could not be read: ${failure instanceof Error ? failure.message : String(failure)}` : status.reason,
      },
      graded("turn completed", () => ({ turnStatus: status.status })),
    );

    const evaluation = evaluateDailyRecovery({ sessionId: session.sessionId, case: evalCase, recording, events, answer: turn?.data });
    t.check(
      evaluation.evidence,
      graded("evidence checks", (evidence: DailyRecoveryEvaluation["evidence"]) => ({
        citedIds: evidence.report.citedEvidenceIds,
        recordProblems: evidence.recordProblems,
        roleCitations: evidence.roleCitations,
      })),
    );
    t.check(
      evaluation.outcome,
      graded("availability outcome", (outcome: DailyRecoveryEvaluation["outcome"]) => ({
        expected: outcome.expected,
        answered: outcome.answered,
        lastFailureEndedAt: outcome.lastFailureEndedAt,
        failureCitations: outcome.failureCitations,
        recoveryCitations: outcome.recoveryCitations,
      })),
    );
    t.check(evaluation.coverage, coverage());
    t.log(logRecord("evaluation", evaluation));
    t.log(logRecord("usage", { durationMs, ...turnUsage(events) }));
    if (failure) throw failure;
  },
});
