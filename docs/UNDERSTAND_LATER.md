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

## Next.js basics in this app

Added October 26, 2026. Status: not yet explained.

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
- [ ] **Separate current capability from the next integration.** The capture
  controller executes ordinary code without model calls. Its evidence is saved
  on disk. Connecting Eve to this evidence remains the next implementation
  milestone at this checkpoint; controller actions must not become an answer
  key supplied to the investigator.

### Walkthrough when we return

1. Read the saved clean capture above; no new outage or model call is necessary.
2. Follow `http-0008` (feed failure) and `http-0024` (feed recovery) through the
   recording code and explain which process produced each record.
3. Trace the stop/start actions and recovery marker, then inspect the
   cancellation/interruption tests in `scripts/lib/daily-capture.test.ts`.
4. Explain which records a future investigator can receive and which remain
   controller-only. Continue with the existing Next.js basics checklist when
   the user is ready.
