# Agent Lab demo roadmap

Written October 20, 2026. Target: tomorrow evening, October 21 in the user's
local time. Updated October 21: steps 1, 2, and 3 are implemented locally;
comparison and recording remain proposed work.
Follow [PROJECT_DIRECTION.md](PROJECT_DIRECTION.md) for the project's purpose.

## The demo we want

A developer runs a deployment investigator, opens the evidence behind its answer,
gets executable checks and a separate AI review, then compares the original agent
with one proposed instruction change on the same cases.

Working assumption: the change improves **our investigator's instructions**.
The user wants to decide the editing approach when we reach the comparison step.
They are considering a second agent that changes investigator instructions or
other permitted implementation files, or directs the investigator to revise its
own behavior. No editing mechanism or expanded source permissions are selected.
Repairing the investigated application's source would be a different experiment:
reproduce an application bug, apply a code patch, rebuild/redeploy, and run tests.
The common next step below, checking saved investigation evidence, is useful to
either direction. Do not silently treat a proposal as an approved app-code pivot.

The main story is whether the proposed change deserves to be kept. A rejected
change or no measured improvement is a valid result. We must not promise an
improvement before measuring one or weaken the baseline to manufacture it.

## Current starting point

- Real Eve calls through AI Gateway; the configured investigator model is
  `openai/gpt-6-luna-fast` with reasoning `high`.
- Authenticated Next.js log retrieval backed by PostgreSQL.
- A/B/C deployment records and their logs are deliberately authored simulations.
- `pnpm lab:investigate B` records the task, source settings, ordered events,
  structured answer, status, timestamps, and reported usage.
- `pnpm lab run <id|latest>` reopens those records after Eve stops.
- The previous implementation turn verified 48 tests, typecheck, lint, both
  builds, and a live B investigation. These are dated foundation checks, not
  evidence of reviewer effectiveness or a successful agent improvement.
- `pnpm lab evaluate <id|latest>` now checks a saved run's evidence without another
  model call. Fresh verification: 74 tests, typecheck, lint, and citation checks on
  the previously saved B investigation. This does not assess diagnosis correctness.
- `pnpm lab:review <id|latest>` now makes a separate bounded model request and saves
  the review attempt. `pnpm lab review <review-id|latest>` reopens it. Fresh checks:
  94 tests, types, lint, both builds, one saved B review, and one clearly labeled
  deliberately wrong answer rejected in a separate live control. These two model
  observations do not establish reviewer accuracy or an agent improvement.
- The local workbench runs at `/runs`, with a single investigation/review page,
  live activity that stays open on completion, linked evidence, review history,
  real model actions, cancellation, and SSE refresh/reconnection.
  `pnpm dev:lab` starts Next.js and the local worker. Latest UI verification:
  111 unit/integration tests, 10 API tests, 12 browser tests, types, lint,
  both builds, and one fresh B investigation plus one review.
  Their combined reported model cost was $0.0060216. These remain simulation
  observations, not a benchmark of diagnosis quality.
- There is no agent-version comparison UI or app repair loop.

## Build order and visible results

| Step | Work and purpose | Done when |
| --- | --- | --- |
| 1. Evidence checker (implemented locally) | `packages/lab/src/evaluate.ts`, tests, and `pnpm lab evaluate <run-id|latest> [--json]`. | Made-up and unreceived citations fail in tests; the saved B record's three returned IDs pass; missing/failed retrieval is visible. |
| 2. Separate AI review (implemented locally) | A fresh Gateway request receives the task, answer, and received logs; `review-v1` returns claim judgments and missing evidence. | Review input/configuration/checks, errors, and usage are saved separately and reopenable. |
| 3. Small working UI (implemented locally) | Use the existing Next.js app to select a case and show the run timeline, returned log rows, answer, objective checks, and AI review. | A real run updates the screen and can be reopened after refresh; clicking a citation reveals its recorded evidence. |
| 4. One candidate and comparison | Propose one instruction revision from development evidence; show its diff, run the candidate separately, and compare with the current baseline. | Both versions retain their own source hashes, runs, checks, reviews, and costs; failures and regressions remain visible. |
| 5. Rehearse and record | Freeze working features, run the demonstration, and record a concise video. | The user can explain each actor and reproduce the shown result. |

Tonight's target: steps 1 and 2. Tomorrow morning: step 3. Tomorrow afternoon:
step 4 and verification. Reserve the final two hours for fixes, explanation,
rehearsal, and recording. Cut stretch work first if these blocks slip.

### Step 1: implemented evidence checker

`evaluateRun` is a pure function; the CLI loads the ordered saved events and prints
its `evidence-v1` report. It correlates turn/call IDs, rejects conflicting records,
and requires evidence before the last structured answer. The saved answer must
match that event. It does not query fixture logs to give credit for unseen records.
The original run stays unchanged. Evaluation persistence is deferred; the report
is calculated each time. Empty citations and diagnosis correctness remain explicitly
`not_evaluated`. There is no overall semantic grade.

Use `createRunStore(pool).get(runId)` to load the existing record. Keep the checker
as a pure function over that record so unit tests and a later Eve eval can reuse it.

Match `actions.requested` and `action.result` by `callId`. Count evidence only from
completed `get_logs` calls for the requested deployment; validate their log shape.
Then check that every claimed evidence ID was actually returned in those calls.
For a completed answer, empty retrieved logs plus an empty evidence list is a
valid provenance result, not automatic proof of a correct diagnosis. No successful
retrieval, a failed run, or an invalid trace must remain distinguishable.

Return named checks and reasons. Do not use one green badge to imply more than
was tested. Keep these separate:

1. Execution completed.
2. Citations refer to evidence actually retrieved.
3. The diagnosis matches the prepared case's expected outcome, if assessed.
4. A reviewer considers the claims supported by the evidence.

For example, an answer can cite the real `log-17` and still wrongly claim that it
proved a network outage. Step 1 detects missing/fabricated evidence; semantic
support needs its own assessment. For known cases, keep expected outcomes outside
the investigator's prompt/tool results. Version-two case answers now carry structured state, cause, and configuration
claims. `outcome-v1` compares those values and requires retrieved decisive
citations; it does not grade prose by substring matching. Migration 006 saves an
immutable case snapshot and atomically saves the completed answer and outcome
report. Legacy runs remain unassessed. Reopening reads the saved assessment.

The four development cases are `missing-config`, `healthy-startup`,
`recovered-startup`, and `no-logs`. They all target B and use the same task;
expected answers remain outside investigator and reviewer requests. The [first live baseline](CASE_BASELINE.md) records one run per case plus one separate review, including reported costs and limitations. The web
launch dialog and `pnpm lab:investigate --case <id>` run one selected case at a
time. A candidate generator, reserved cases, and version comparisons remain next.

### Step 2: reviewer boundary and reuse

Implemented: `my-agent/client/review.ts` uses the installed AI SDK's `generateText`
and `Output.object`, rather than an autonomous subagent. Default reviewer:
`openai/gpt-6.1-sol`; investigator remains unchanged. `reviewSchemaFor` validates
the model's quoted answer spans and cited log IDs. Migration 004 stores attempts;
`packages/lab/src/reviews.ts` prepares only selected input and preserves objective
check failures. The standalone credential is in the ignored reviewer-only
`LAB_REVIEW_GATEWAY_API_KEY` setting, with a $1 non-renewing Gateway quota. No
billing credits were purchased. Standard key/OIDC settings are also supported.
The request has no tools, no investigator history, a 64 KiB input cap, 4,096
output-token cap, 60-second deadline, and no SDK retries. Cancellation, failures,
invalid output, and missing cost remain explicit. Model review effectiveness and
prompt-injection resistance are not established by these plumbing tests.

The reviewer receives a separate context, not the investigator's conversation or
hidden reasoning. It gets the actual returned evidence, not just the model's own
summary. Treat any instructions inside log messages as data. It has no deployment
write tools and does not edit the agent while judging it.

Reuse installed Eve/client and Gateway support. The installed Eve docs already
provide `eve/evals`, assertions, and `t.judge` backed by `evaluate` from `eve/ai`.
Judge scores do not guarantee prose rationales. For the UI's claim explanations
or a proposed instruction revision, use a separate structured language-model
request if needed, rather than pretending a score contains an explanation.
Verify the exact supported call and authentication during implementation; native
evaluation-model IDs and ordinary language-model IDs are not interchangeable.

Record review failure as unavailable/failed, not a pass. A reviewer cannot override
a failed objective check. A separate model request is useful feedback, not an
independent source of ground truth. Record its model, prompt/schema version, and
usage separately from the investigator's.

### Step 3: UI and execution scope

Implemented October 21: a light-first Geist interface with dark mode, runs table,
URL-based filters, linked evidence, independent checks, and review attempts on
one page. Compact shadcn Trace/Collapsible steps show live activity in a resizable
desktop panel, or below the task on phones. Following the user's latest clarification,
the panel stays open after completion and closes only on request. Only steps with
inspectable details expand. Evidence checks and the independent review result
remain below the answer on the left; Review answer stays in the activity panel. View activity and
citations reopen a closed panel. Phones retain the evidence drawer. Legacy trace/review links select
the relevant section. Tokens, costs, and IDs live in expandable details.
Review judgments do not replace deterministic checks.

Migration 005 stores local execution jobs and worker heartbeats. Next.js admits
same-origin commands; a separate Node worker invokes the shared CLI investigation
and review functions. PostgreSQL locks serialize model execution, duplicate
request IDs reuse their operation, and interrupted browser jobs are reconciled
without automatic model replay. Before a run exists, the browser watches its
queued job. The detail page then uses one SSE connection: the server reads saved
state once per second and transmits changed display snapshots. Connections close
when hidden, unmounted, or settled; reconnects read the latest saved state.
The browser never receives runtime credentials or source settings.
`LAB_LOCAL_EXECUTION=0` disables model actions. Hosted access remains deferred.


Reuse the current TypeScript, Next.js, Eve, Gateway, PostgreSQL, pg, Zod, and Vitest
stack. Read installed Next.js/Eve guides before implementation. No new database,
vector store, deployment platform, or general workflow engine is needed here.

#### Design and structure researched October 21

The user wants a professional developer-tool interface with Vercel's visual feel
and a foundation we can extend. Start with the actual saved investigation and
review records. The UI must help someone follow an answer back to the returned
evidence; appearance alone does not establish investigation or reviewer quality.

Use Geist Sans for interface text and Geist Mono for IDs, code, and numeric
metadata. Define reusable semantic color, spacing, border, radius, and typography
tokens in `src/app/globals.css`, with light/dark values. Favor quiet neutral
surfaces, thin borders, compact readable tables, and restrained status colors.
Load fonts through Next.js/local font support. Add only the shadcn/ui primitives
needed for real controls; implement run/evidence/review components around our
existing contracts. Do not install a broad dashboard starter or an entire
upstream observability application.

The proposed screens and interactions:

- A compact runs table with case, execution status, model, date, duration, and
  reported cost. Separate missing values from actual zero values.
- A stable `/runs/[runId]` detail URL with an overview, trace, and review. Clicking
  an evidence citation reveals the matching recorded tool result, including its
  call ID. Keep TypeScript checks and the model review visibly distinct.
- A desktop evidence inspector beside the answer; stack content on narrow
  screens. Use keyboard-operable controls, visible focus, text labels for status,
  and deliberate loading, empty, failed, and cancelled states.
- URL-addressed selection/tabs where useful; refresh must reopen saved data.
  Add Run Investigation and Review actions after the saved-run view works.
  Label simulations, saved executions, and live activity accurately.

Proposed ownership, creating files only when the corresponding feature needs them:

| Location | Responsibility |
| --- | --- |
| `src/app/layout.tsx`, `src/app/globals.css` | Fonts, shared page shell, design tokens. |
| `src/app/runs/page.tsx` | Recent saved runs. |
| `src/app/runs/[runId]/page.tsx` | Load and display one saved investigation. |
| `src/components/ui/` | Small reusable controls. |
| `src/components/runs/` | Run table, trace, evidence inspector, review display. |
| `src/lib/server/` | Server-only data loaders and explicit browser-safe fields. |
| `packages/lab/`, `my-agent/client/` | Existing SQL, checks, review and execution logic. |

Server-side page code can call the existing stores directly; do not add an HTTP
hop solely for a Server Component to read our own database. Add browser-facing
endpoints when polling or actions require them. Keep credentials and raw runtime
configuration out of browser data. Add run listing and reviews-by-run reads to
the existing stores rather than importing a CLI entry point into the page.

References inspected:

- [Geist typography](https://vercel.com/geist/typography),
  [colors](https://vercel.com/geist/colors),
  [materials](https://vercel.com/geist/materials), and
  [Web Interface Guidelines](https://vercel.com/design/guidelines).
- Workflow's public [runs table](https://github.com/vercel/workflow/blob/6455bebd7dbc18e08fce5e3dede6df6ac4d7d7ff/packages/web/app/components/runs-table.tsx)
  and [run detail composition](https://github.com/vercel/workflow/blob/6455bebd7dbc18e08fce5e3dede6df6ac4d7d7ff/packages/web/app/components/run-detail-view.tsx).
  Its web app uses React Router/Vite; reuse the component boundaries while keeping
  our installed Next.js app. Its shared UI package has Workflow-specific coupling.
- [Geist fonts](https://github.com/vercel/geist-font) and
  [shadcn/ui theming](https://ui.shadcn.com/docs/theming) provide public building
  blocks. The Geist table example imports `@vercel/geistcn/components`; that
  package returned 404 from the public npm registry when checked. Do not assume
  it is an installable public equivalent to Vercel's internal UI.
- [AI Elements](https://github.com/vercel/ai-elements/tree/ca8be600bfd01b3131f9bf6134b51602a71f4374) announces a move to shadcn/ui and
  deprecation of that repository in November 2026. Check the current component
  source before adopting it; its tool components expect AI SDK message shapes,
  whereas our saved trace uses Eve events.

#### Local first, with a supported hosting path

The first complete UI runs at `http://127.0.0.1:3000`. Vercel hosting is the next
deployment target, not an already configured or verified capability. Local and
hosted execution should use the same display components and saved-run contracts.

Installed Eve 0.71.0 documents `withEve` from `eve/next`. Its `eveRoot` option can
point at `./my-agent`; Next.js and Eve can run together locally and deploy as one
Vercel project with separate services. See
`my-agent/node_modules/eve/docs/guides/frontend/nextjs.mdx` and the
[public deployment guide](https://github.com/vercel/eve/blob/main/docs/guides/deployment/vercel.mdx).
This integration has not been added or tested in our app. Hosted execution also
needs reachable PostgreSQL, authenticated run access, bounded model spending, and
trial credentials scoped to the correct session. Uploading the Next.js app alone
does not move our Mac's Docker database or CLI process supervisor to the cloud.

Extract the CLI's orchestration into reusable code before wiring a Run button.
Keep one active local investigation at a time with an explicit busy response.
Supervise the owned Eve process and keep credentials in the server process;
never mutate a shared Eve server's global trial token between browser requests.
The browser reads saved state through SSE; it does not depend on receiving the
one original Eve stream to display a completed run after refresh.

The first recording can use a local browser and local Node processes. This does
not establish that the current long-running supervisor works in a hosted
serverless request. Public hosting and concurrent multi-user access are separate
work, not prerequisites for a truthful recorded demo.

### Step 4: exactly what changes and how we compare

Preserve the present investigator as baseline. Decide with the user at this step
whether a model proposes a patch for the runner to apply, a separate editing agent
writes permitted candidate files, or the investigator proposes its own revision.
The simplest initial option remains a proposed instruction revision, but it is
not locked in. Any tool/code changes need an explicit scope and corresponding
tests; changing model weights is not part of this approach.

Display the rationale and diff. Save a separate candidate and run it in a fresh
session; do not replace the baseline or modify the checker/expected outcomes to
make a candidate pass. Keep tools fixed for an instructions-only comparison.
The evaluation process stays independent of whichever actor proposes the change.

Example hypothesis, only if an observed failure motivates it: instructions that
explicitly distinguish an earlier error from a later recovery might reduce stale
diagnoses. The current instructions already require all log levels and uncertainty;
repeating those requirements alone is not an established improvement.

Prepare cases before tuning:

- Missing configuration, healthy startup, and empty logs from the existing fixtures.
- A transient failure followed by recovery, with enough evidence to distinguish it.
- A retrieval failure that requires admitting the evidence is unavailable.

For the last case, deliberately allow the investigator to encounter a controlled
tool failure. The present preflight exits before any model session if HTTP fails;
that currently tests runner failure, not agent behavior on failed retrieval.

Reserve at least two additional variants from candidate generation and tuning.
Freeze candidate instructions before running these held-out cases. Run each
version three times per case with fresh trials/sessions, alternating version order
and keeping model, tools, inputs, and budgets the same. This is a small demo sample,
not a statistically established benchmark. Record failed/time-limited attempts too.

Show per-case checks, review outcomes, elapsed time, tool/model calls, and available
cost. Keep investigator, reviewer, and proposal costs separate and show their total
when known; unknown cost stays unknown. Retain the baseline if the candidate causes
regressions or there is no persuasive improvement. If time runs short, a manually
authored and clearly labeled candidate can demonstrate the comparison; do not
present it as an AI-generated patch.

## Real deployments and captured data

The choice affects what we can claim:

| Data source | What it establishes | What it does not establish |
| --- | --- | --- |
| Authored cases | Repeatable behavior under deliberately chosen conditions. | A real application experienced those incidents. |
| Saved logs from an actual app | The agent can investigate authentic captured output; both versions see identical evidence. | Current production state, or that a suggested repair works. |
| Live deployment access | The integration can retrieve current evidence from that deployment. | Correct diagnosis or successful repair without further checks. |

Preferred addition after steps 1-4 work: capture one real failure from an app we
own or an open-source app running in our own preview. Record the source revision,
deployment/time window, original record IDs, any redactions, and whether we
deliberately induced the fault. Preserve recovery/context logs as well as errors.
Replay a fixed copy through the same tool interface for comparison. Clearly label
the UI as a captured real case rather than a live incident.

Vercel's current [logs CLI documentation](https://vercel.com/docs/cli/logs) supports
deployment filters and JSON output. Confirm the installed CLI version and actual
project access when adding this path. No real project/log access or capture has
been verified for this roadmap, and no external deployment has been selected.
Time-box this addition to one hour; it must not displace the working loop or video.

An open-source app can provide externally authored software without needing access
to someone else's production account. If the user chooses application repair,
the acceptance criterion becomes a reproduction test failing before the patch
and passing afterward, plus regression tests and an isolated preview rerun.
Rerunning the investigator or obtaining a reviewer's approval alone cannot prove
that software was repaired. Re-scope that branch before implementing it.

## Recording and completion

Record a two-to-three-minute walkthrough: select a clearly labeled case; watch
retrieval; open cited logs; inspect objective checks and AI review; show the
candidate diff and the actual comparison; state the result and limitations.
Use saved real executions for comparison playback and identify them as saved.
Include one fresh run if the model connection is available; do not fake a live run.

Verify evaluator failure cases, persistence/reopen, UI behavior, and the normal
types/lint/build checks. Keep tested milestones reviewable; package a PR when the
user asks to save the next checkpoint. No publication is implied by this roadmap.

Deferred beyond this deadline: arbitrary third-party production repairs, broad
autonomous source editing, automatic model routing, QuickJS/code-mode benchmarks,
multi-user execution, and DeepSec. Revisit each when a measured question warrants it.
