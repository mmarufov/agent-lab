# Understand later

A learning checklist for topics Muhammad wants to revisit. This is not an
implementation roadmap or evidence that a topic has already been understood.

When Muhammad says to understand something later, add the specific topic here
with its relevant files and a small walkthrough. Extend an existing entry when
it covers the same topic. Mark an item understood only after confirmation.
Teach one step at a time using the actual code and saved results.

## Case evaluation: four scenarios and saved outcome checks

Added October 21, 2026. Status: briefly explained; detailed walkthrough deferred.

Goal: explain how selecting a case produces a real agent investigation and how
ordinary TypeScript checks its conclusion without giving the agent the answer.

- [ ] **Define a case.** Read `packages/lab/src/cases.ts`. Identify the prepared
  logs, expected state/cause, and decisive evidence IDs. Compare missing-config
  with recovered-startup. Explain why both target deployment B and why expected
  answers stay outside the model request.
- [ ] **Create an isolated trial.** Follow `createTrial` in
  `packages/lab/src/fixtures.ts` and `bindCase` in `cases.ts`. Trace the SQL
  inserts, fresh trial ID/token, and trial-prefixed log IDs. Distinguish the
  deployed application's simulated logs from logs produced by Agent Lab itself.
- [ ] **Follow the run from the UI or CLI.** Trace the selected `caseId` through
  the job/worker or `scripts/lab-investigate.ts` into `runInvestigation` in
  `scripts/lib/investigation.ts`. Follow Eve's model request, `get_logs`, the
  Next.js endpoint, PostgreSQL, and the tool result sent back to the model.
- [ ] **Understand structured output.** Read the version-two answer schema in
  `packages/contracts/src/index.ts` and its use in
  `my-agent/client/investigate.ts`. Explain `state`, `cause`, and
  `configurationKey`; distinguish valid JSON/schema shape from a true conclusion.
  Explain how older version-one answers remain readable.
- [ ] **Walk through the evaluator.** Read `evaluateOutcome` in
  `packages/lab/src/outcome.ts`. Compare expected and observed values, then check
  that decisive logs were retrieved and cited before the answer. Explain pass,
  fail, and not assessed. Separate evidence provenance, structured outcome
  correctness, and the AI review of prose.
- [ ] **Understand saving and immutability.** Follow `createRunStore().finish`
  in `packages/lab/src/runs.ts` and migration
  `packages/lab/migrations/006_case_outcomes.sql`. Explain the row lock,
  transaction, saved case snapshot, and database trigger that rejects changes
  to snapshots or existing assessments. Explain why changing tomorrow's fixture
  must not change yesterday's saved grade.
- [ ] **Follow the saved result into the page.** Inspect
  `packages/lab/src/web.ts` and `src/components/runs/outcome-checks.tsx`.
  Explain how the UI receives expected/observed values and evidence links through
  the existing saved-state/SSE flow, without submitting another model request.
- [ ] **Understand what verification proves.** Compare software tests in
  `packages/lab/test/outcome.test.ts` and `case-runs.test.ts` with the real model
  observations in `docs/CASE_BASELINE.md`. Four successful observations do not
  establish general reliability, reviewer accuracy, or an improvement over a
  different agent version.

### Walkthrough when we return

1. Open the saved recovery run from `docs/CASE_BASELINE.md`; no new model call
   is needed. Locate the earlier failure and later successful startup.
2. Predict the expected structured outcome and which logs must be cited.
3. Trace that run through the files above, naming which process performs each step.
4. Inspect the existing evaluator tests for ignored recovery and a wrong cause
   with valid citations. Explain why those answers fail.
5. Explain the complete path back in your own words, then mark only the topics
   that are understood. A fresh paid model run is unnecessary for this walkthrough.
