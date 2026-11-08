# Understand later

A learning checklist for topics Muhammad wants to revisit. This is not an
implementation roadmap or evidence that a topic has already been understood.

When Muhammad says to understand something later, add the specific topic here
with its relevant files and a small walkthrough. Extend an existing entry when
it covers the same topic. Mark an item understood only after confirmation.
Teach one step at a time using the actual code and saved results.

## Resume order after the November 8 handoff

The latest implementation checkpoint is the native Eve Eval Daily baseline
(November 7), following the Daily website integration. The website's runner
still exists; Eve Eval has not replaced every execution path. Current work is
interview tutoring, not another implementation. No new tests or model runs were
performed to save this checkpoint.

Recent drills covered jobs/worker separation, browser disconnects, worker
crashes, truthful observations, provenance versus coverage versus conclusions,
and checking the reviewer. The user correctly identified duplicate-work risks
and that a disconnected browser need not stop the investigator. Important
corrections still need practice: our worker does not resume every unfinished
operation like a durable workflow; retrieving recovery evidence does not mean
the model interpreted it correctly; stronger models are not automatically
reliable judges. Do not mark these topics mastered just because discussed.

When Muhammad asks to resume, use this order unless he chooses a specific topic:

1. Resume the prompt-injection question: if malicious logs persuade the model
   to request recording B, why can the server still restrict it to A? The user
   initially suggested the instructions file. Explain server-enforced grants,
   then ask whether a wrong answer about A is still possible.
2. Trace one website run and distinguish it from the native Eve Eval command.
3. Practice one component failure at a time, including ambiguous paid work.
4. Separate integrity, provenance, coverage, outcome checks, and model review;
   practice how to check the reviewer itself.
5. Inspect native Eval artifacts and what machinery we reuse versus supply.
6. Revisit the bounded direct-tools versus generated-code experiment. It is
   the agreed next research direction, not completed code or authorization to
   spend. Rehearse a short demo with honest limitations and authorship.

Teach through one concrete example and one question at a time. The user wants
to reason naturally about why/how/tradeoffs, not memorize polished responses.

The newest checkpoint in the local docs/SESSION_CONTEXT.md holds research
sources, implementation boundaries, and remaining decisions. This checklist
is deferred learning, not authorization to build or spend on model requests.
Older saved run IDs may have been deleted in the authorized November 1 cleanup;
use surviving saved records or historical output rather than assuming they reopen.

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

1. Read the recovery result in `docs/CASE_BASELINE.md`, or open a surviving
   saved recovery run. The original IDs may have been cleared; no new model
   call is required to locate the earlier failure and later successful startup.
2. Predict the expected structured outcome and which logs must be cited.
3. Trace that run through the files above, naming which process performs each step.
4. Inspect the existing evaluator tests for ignored recovery and a wrong cause
   with valid citations. Explain why those answers fail.
5. Explain the complete path back in your own words, then mark only the topics
   that are understood. A fresh paid model run is unnecessary for this walkthrough.

## Next.js basics in this app

Added October 26, 2026. Updated November 6: overview discussed; the detailed
current-code walkthrough below is not confirmed understood.

Goal: understand the five Next.js ideas this workbench depends on, using this
repository's files: routing, server versus browser code, request/response
handling, development versus production builds, and caching. The installed
version is Next.js 16.3.8, so read its bundled guides under
`node_modules/next/dist/docs/01-app/` rather than older tutorials.

- [ ] **Routing: folders become URLs.** Map `src/app/page.tsx` to `/`,
  `src/app/runs/page.tsx` to `/runs`, and `src/app/runs/[runId]/page.tsx` to
  `/runs/<id>`, where `[runId]` arrives through `params`. Explain what
  `src/app/layout.tsx` wraps, and when `src/app/runs/loading.tsx`, `error.tsx`,
  and `not-found.tsx` appear (for example, `notFound()` at
  `src/app/runs/[runId]/page.tsx:14`). Guide:
  `01-getting-started/03-layouts-and-pages.md`.
- [ ] **Server versus browser code.** Pages and layouts without `"use client"`
  are Server Components and run only in the Next.js server process.
  `src/app/runs/[runId]/page.tsx` reads PostgreSQL through `webStore()` in
  `src/lib/server/data.ts`, whose `import "server-only"` stops browser code from
  importing it. `"use client"` marks the doorway into browser code: a file such
  as `src/components/runs/run-detail.tsx`, and everything it imports, also runs
  in the browser after Next.js renders its first HTML on the server. Trace the
  hand-off at `src/app/runs/[runId]/page.tsx:22-28`, where server data becomes
  the `initial` prop. Explain why database credentials never reach the browser.
  Guide: `01-getting-started/05-server-and-client-components.md`.
- [ ] **Request and response handling.** Read the Route Handler
  `src/app/api/runs/[runId]/route.ts`: the exported `GET`, the host and
  same-origin checks in `guard` (`src/lib/server/http.ts:12`), ID validation,
  the store read, and the error path. Then follow the streaming route
  `src/app/api/runs/[runId]/stream/route.ts:21-37` (Server-Sent Events) into
  the browser's `new EventSource(...)` at
  `src/components/runs/use-run-controller.ts:32`, and the browser helper
  `request()` in `src/components/runs/request.ts`. Guide:
  `01-getting-started/15-route-handlers.md`.
- [ ] **Development versus production builds.** Compare `pnpm dev`
  (`next dev`: compiles each route when it is first visited, reloads on save,
  and shows development error overlays) with `pnpm build` then `pnpm start`
  (`next build` compiles everything ahead of time into `.next/`, and
  `next start` serves that output). Read the route table printed by
  `next build` and predict which routes are static and which are dynamic.
  Guides: `01-getting-started/17-deploying.md` and
  `02-guides/production-checklist.md`.
- [ ] **Caching.** This app uses the previous caching model because
  `next.config.ts` does not enable `cacheComponents`, so read
  `02-guides/caching-without-cache-components.md`, not
  `01-getting-started/08-caching.md`. Find each decision not to cache:
  `export const dynamic = "force-dynamic"` in both run pages and the stream
  route, `Cache-Control: no-store` in `src/lib/server/http.ts`,
  `src/lib/lab-http.ts`, and the stream route, and `cache: "no-store"` in the
  browser's `request()`. Explain why a live workbench must not show a stale
  run, and whether a finished run could ever be cached when reviews can still
  be added later.

### Walkthrough when we return

1. Start the workbench with `pnpm db:up` and `pnpm dev:lab`, then open
   `http://127.0.0.1:3000/runs` and one run. Predict each URL's file first.
2. In the browser's Network tab, separate the page's HTML from the
   `/api/runs/<id>/stream` request, and name which process produced each one.
3. Call `GET /api/runs/<id>` with `curl`, then repeat it with a different
   `Host` header and explain the 403 returned by `guard`.
4. Stop the development server, run `pnpm build`, read the route table, then
   compare `pnpm start` with development mode.
5. Explain each `force-dynamic` and `no-store` choice in your own words, then
   mark only the topics that are understood.

## Daily incident capture and recovery

Added October 28, 2026. Status: user confirmed the capture overview makes sense;
the detailed code walkthrough is deferred until the next session. Detailed
topics below are not yet confirmed understood.

Goal: trace how our Node.js controller creates and records a real database outage,
restores the sandbox, and keeps observable evidence separate from its own actions.

- [ ] **Trace capture execution.** Follow `scripts/daily-sandbox.ts` into
  `capture`, `execute`, `baseline`, `outage`, and `observeRecovery` in
  `scripts/lib/daily-capture.ts`. Explain the two healthy baseline rounds,
  Docker stop/start commands, 45-second sampling period, five-second request
  deadlines, and two consecutive healthy recovery rounds.
- [ ] **Trace recording.** Follow `observe`, `Recorder`, and `collectLogs`.
  Inspect one HTTP failure and a later successful response in
  `.context/daily-sandbox/captures/20261022T050138Z-39b307/evidence.jsonl`.
  Match their IDs to the phase records in `controller.jsonl`. Explain JSONL,
  timestamps, redaction, the manifest, and why file integrity does not prove
  that an investigation's conclusion is correct. Read the schemas in
  `packages/contracts/src/daily-capture.ts`.
- [ ] **Understand interrupted-capture recovery.** Follow `persistMarker`,
  `restoreDatabase`, and `recover` in `scripts/lib/daily-capture.ts`, the signal
  handlers in `scripts/daily-sandbox.ts`, and the operation lock in
  `scripts/lib/daily-sandbox.ts`. Explain why the marker is written before
  stopping PostgreSQL, how Ctrl+C differs from SIGKILL, and how
  `pnpm daily:recover` restores the recorded container and preserves an
  interrupted status instead of pretending the capture completed.
- [ ] **Separate capture from investigation.** The capture controller executes
  ordinary code without model calls and saves evidence on disk. Eve integration
  has since been implemented: the investigator receives selected pages from
  that recording. Controller actions must not become an answer key supplied
  to it. Capture creation and later investigation are separate operations.

### Walkthrough when we return

1. Read the saved clean capture above; no new outage or model call is necessary.
2. Follow `http-0008` (feed failure) and `http-0024` (feed recovery) through the
   recording code and explain which process produced each record.
3. Trace the stop/start actions and recovery marker, then inspect the
   cancellation/interruption tests in `scripts/lib/daily-capture.test.ts`.
4. Explain which records the investigator can receive and which remain
   controller-only. Continue with the existing Next.js basics checklist when
   the user is ready.

## Daily evidence access and the real Eve investigator

Added November 6, 2026. Status: overview discussed; detailed understanding not
confirmed. Implemented, not a future integration.

- [ ] Trace my-agent/agent/tools/daily_capture.ts through its plain client in
  my-agent/agent/lib/daily-evidence.ts, Next.js, and the verified reader/grant
  lookup in packages/lab/src/daily-evidence.ts and capture-access.ts.
  Explain why the model chooses filters/pages but the token chooses the capture.
- [ ] **Prompt injection and permissions.** Read the same tool/client/grant path
  plus `my-agent/prompts/daily-capture.md` and `my-agent/agent/agent.ts`.
  Walk through a malicious log requesting recording B while the runner issued
  a grant for A. Instructions label records as data; server authorization is
  the actual access boundary. Only the two read-only Daily tools are exposed.
  Explain why restricted access still does not guarantee a truthful diagnosis
  about A. Behavioral injection tests are a possible next check, not a claimed
  completed security evaluation. This is the immediate resume topic.
- [ ] Follow scripts/lib/daily-investigation.ts and
  my-agent/client/investigate.ts: settings, Eve process startup, session,
  recorded events, final answer, usage, cancellation, and access-grant cleanup.
- [ ] Read packages/lab/src/daily-evaluate.ts. Pair a requested tool with its
  completed result using turn/call IDs. Explain why an ID never returned to the
  investigator fails even if a reviewer finds its answer plausible.
- [ ] Distinguish the real controlled incident from a recording of that incident:
  today's read-only investigation does not stop, restart, or fix Daily.

Walkthrough: choose one saved Daily tool request/result, follow its capture
permission and one returned record, then locate that record in the final answer.
Use existing files/output; no new outage or paid run is necessary.

## Daily review, saved-record integrity, and evidence coverage

Added November 6, 2026. Status: explained in overview and some technical detail;
the user explicitly wants to revisit this layer before/alongside the new UI.

- [ ] **Review.** Trace reviewSavedRun and prepareDaily in
  packages/lab/src/reviews.ts, readDailyEvidence in daily-evaluate.ts, and
  my-agent/client/review.ts. Explain one separate model request, exact saved
  input/configuration, no tools/history/controller answer key, and why opening
  a saved review does not call the model again. Migration 009 stores immutable
  attempts; a failed/cancelled attempt is not a positive review.
- [ ] **Check the reviewer.** Explain the earlier negative control: a deliberately
  false claim that every /feed request succeeded, paired with real failure
  records. One rejection checks that example, not an overall accuracy rate.
  Next explain expert-labeled correct, incorrect, and uncertain examples,
  false approvals versus false rejections, held-out cases, and periodic audits.
  A stronger model is another candidate to measure. Human calibration need not
  mean a human approves every production answer. This broader calibration study
  is proposed, not completed.
  Relevant tests: packages/lab/test/daily-reviews.test.ts and
  daily-review-input.test.ts.
- [ ] **Integrity.** Read packages/lab/migrations/010_evidence_integrity.sql,
  packages/lab/src/runs.ts, and packages/lab/test/integrity.test.ts. Explain
  append-only events, finished-row freezing, and a fingerprint in plain language.
  Follow just two orderings: event insertion first versus run finishing first.
  READ COMMITTED is required by this implementation; do not teach isolation
  levels before the concrete lost-event problem. A matching hash is not truth
  and cannot defeat an administrator rewriting both data and hash.
- [ ] **Coverage.** Read dailyFeedAvailabilityFacts in
  packages/lab/src/daily-coverage.ts and evaluateCoverage in coverage.ts.
  Follow the full recording -> requirements -> retrieved record IDs -> covered/
  missed/not_assessed. This is deterministic TypeScript, not a second AI.
  Migration 011 preserves versioned assessments.
- [ ] **Chronology and limits.** Compare http-0005 (healthy before failures)
  with http-0024/http-0027 (later successful samples). Explain why early success
  cannot prove later recovery, and why one later success cannot prove ongoing
  health. Coverage does not establish that the agent interpreted it correctly.
- [ ] **Combine, without conflating.** Explain integrity, provenance, coverage,
  model support review, and task-outcome correctness separately. Use an answer
  that cites genuine evidence but draws the wrong conclusion.

Walkthrough: use one saved capture and available run; inspect one failing and
one recovering HTTP record, its provenance, coverage requirement, and supported/
unsupported claim. Inspect an existing test before adding or running anything.
Do not restore deleted history solely to teach it.

## Daily investigations in the website

Added November 6, 2026. Status: implementation complete locally, uncommitted;
thorough user walkthrough deferred. See the November 1-2 session checkpoint.

- [ ] **Choose a recording.** Follow src/components/runs/launch-form.tsx ->
  src/app/api/captures/route.ts -> listDailyCaptures in
  packages/lab/src/daily-evidence.ts. Explain why only verified, allowlisted
  metadata reaches the browser, not file paths, tokens, or controller contents.
- [ ] **Click Run.** Trace POST /api/jobs, packages/lab/src/jobs.ts,
  scripts/lib/worker.ts, createExecutor in scripts/lib/executor.ts, and
  runDailyInvestigation. Name which process queues work and which executes Eve.
  The website reuses the investigator, not a new browser-hosted agent.
- [ ] **Finish and check coverage.** Read migration 012_coverage_jobs.sql and
  jobs.finish. Explain why finishing the investigation job and queuing its
  coverage job happen in the same transaction, and how duplicates are avoided.
  A missed fact completes the check; it is different from the check crashing.
- [ ] **Watch progress.** Follow packages/lab/src/web.ts and activity.ts into
  src/app/api/runs/[runId]/stream/route.ts and
  src/components/runs/use-run-controller.ts. Explain saved-state SSE snapshots,
  initial queued-job polling, refresh/reconnect, and why reopening doesn't launch
  a new investigation. It does not stream private model reasoning.
- [ ] **Read the screen.** Inspect run-detail.tsx, activity-panel.tsx,
  evidence-panel.tsx, coverage-section.tsx, and review-view.tsx under
  src/components/runs/. Distinguish retrieved evidence from missed records
  present only in the full recording. Preserve the two independent scroll areas,
  separate stages, meaningful expanders, and user-controlled activity panel.
- [ ] **Review admission and failure.** Follow reviewBlocker/reviewInputProblem
  and REVIEW_MAX_INPUT_BYTES. The latest live run retrieved enough evidence for
  coverage, but its 103,261-byte review input exceeded our 65,536-byte cap, so no
  review model ran. Explain the cost/completeness tradeoff before changing it.
- [ ] **Cancellation and interruption.** Trace jobs.recover and existing tests.
  Closing the browser disconnects display updates; only Cancel requests work
  cancellation. A stopped local worker must not trigger automatic paid replay.
  A request handler queues the job; the separate worker executes it. Next.js
  could execute long work, but separating it lets the handler return early.
  Explain a paid model call completing just before the worker dies without
  saving the answer: the row alone cannot establish the external outcome.
  Recovery preserves completed results and marks unfinished paid work failed;
  a user can start a fresh attempt. Coverage has its own no-model recovery path.
  Distinguish browser disconnect from stopping Next.js (tool HTTP service) or
  PostgreSQL (saved state). Local execution is not what provides separation.
- [ ] **What validation establishes.** Use packages/lab/test/daily-workbench.test.ts,
  scripts/lib/executor.test.ts, scripts/workbench.api.test.ts, and
  tests/e2e/daily.spec.mts. Separate software checks from the one live model
  observation; not every possible diagnosis or reviewer behavior was tested.

Walkthrough: reopen the latest surviving Daily run, trace one activity item and
one coverage row back to their stored data, then inspect the review refusal.
Explain the normal path first; expand transactions/SSE only when asked.

## Native Eve Eval Daily baseline

Added November 8, 2026, describing the November 7 implementation checkpoint.
Status: implemented locally; detailed user walkthrough not confirmed. Prior
test/live results are recorded in SESSION_CONTEXT.md, not rerun for this save.

- [ ] Follow `pnpm lab:eval:daily` through `scripts/lab-eval-daily.ts` and
  `scripts/lib/daily-eval.ts`: capture verification, lock, scoped grant, evidence
  service check, and native Eve Eval invocation. Our launcher still supplies
  environment-specific setup and cleanup.
- [ ] Read `my-agent/evals/evals.config.ts` and
  `my-agent/evals/daily/recovery.eval.ts`. Eve supplies session execution and
  evaluation reporting; our case specifies the task, output schema, and checks.
  It does not infer Daily's expected recovery for us.
- [ ] Read `packages/contracts/src/daily-availability.ts` and
  `packages/lab/src/daily-recovery.ts`. Trace one structured state and its
  failure/recovery citations into assertions. Distinguish that outcome check
  from coverage, arbitrary prose correctness, and root-cause correctness.
- [ ] Inspect `my-agent/.eve/evals/2026-11-07T09-51-23/` if still present and
  `.context/eval-baseline/live-eval.txt`. Explain summary/results/events files
  versus the website runner's PostgreSQL records. Native Eval results are not
  automatically new runs in the website. Do not call this migration a measured
  speed/cost improvement without a comparison.
- [ ] Explain why the custom completed-turn assertion matters even when
  `t.succeeded()` passes, and why cancellation must let the event stream settle.
  In this installed version, aborting the stream can lose collected events;
  native artifacts are written at evaluation end. Limits do not undo an
  already-issued model request. Recheck source before making version-wide claims.

Walkthrough: reopen existing artifacts without a model call. Identify the
original task, one paired tool request/result, final structured answer, one
assertion, and the files containing them. Compare that with one saved web run.

## Eve runtime, generated programs, and the possible research contribution

Added November 6, 2026. Status: latest explanation delivered; follow-up pending.
This section describes concepts/research, not a new implemented agent mode.

- [ ] Trace my-agent/package.json -> eve dev -> agent/agent.ts,
  agent/instructions/investigator.ts, and agent/tools/daily_capture.ts. Explain
  LLM versus agent, framework versus runtime, tool schema versus execute function.
- [ ] Follow source text in JSON arguments -> parsing -> restricted execution ->
  explicitly exposed host function -> actual HTTP client -> tool result -> model.
  Explain why code generation cannot invent an API, credentials, or permission.
- [ ] Explain single-use versus reusable programs, dependent versus parallel
  calls, and why generation/retries/extra output can outweigh saved round trips.
  The direct baseline can already parallelize independent calls.
- [ ] Explain Run SDK and QuickJS as execution machinery; bundled capability is
  not proof our investigator exposes it. Its default development extensions and
  source-editing capabilities are disabled for our investigator.
- [ ] Read the installed Eve tools/overview.mdx section on toModelOutput.
  Contrast full action.result with what is actually sent to the model. Our
  current tools do not project outputs. Explain the proposed false-coverage
  fixture before claiming an existing defect or adding code-mode execution.
- [ ] Revisit the research sources in SESSION_CONTEXT: mixed task-dependent
  findings, proposal versus shipped implementation, unreproduced upstream
  numbers, repeated trials, withheld cases, fair baselines, and null results.

Walkthrough: draw two flows for one tool response, full output to the recorder
and reduced output to the model. Predict whether the current coverage checker
would over-credit a deliberately hidden recovery record. Treat the answer as a
hypothesis to verify with an integration test, not a confirmed current bug.

## Vercel support-agent talk

Added November 4, 2026. Status: full video deferred by the user; the two supplied
code slides are being explained separately. Understanding is not yet confirmed.

Source: Kathryn Middleton's Ship NYC talk,
https://www.youtube.com/watch?v=gYAqupu6iNI.

- [ ] Watch the full talk and distinguish reported results from independently
  verified behavior; identify the denominator and limits of the resolution metric.
- [ ] Trace one example ticket through enrichment, research, tool execution,
  response, and any approval or escalation. Separate documentation retrieval from
  access to actual account/project data.
- [ ] Revisit the server `streamText` and browser `useChat` slides at about 7:23
  and 8:14. Trace typing -> request -> model/tool interaction -> streamed reply.
  Explain omitted route/stream plumbing and older input-state APIs using
  `my-agent/node_modules/ai/docs/03-ai-sdk-core/15-tools-and-tool-calling.mdx`,
  `my-agent/node_modules/ai/docs/04-ai-sdk-ui/02-chatbot.mdx`, and
  `my-agent/node_modules/ai/docs/08-migration-guides/26-migration-guide-5-0.mdx`.

Walkthrough: after watching, choose one ticket from the talk, draw its data flow,
name what executes on the server versus in the browser, and identify one failure
or permission boundary to test. Mark items understood only after confirmation.
