# Agent Lab demo roadmap

Written October 20, 2026. Target: tomorrow evening, October 21 in the user's
local time. Steps 1 and 2 are implemented locally; the remaining steps are proposed work.
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
- There is no comparison UI or app repair loop.

## Build order and visible results

| Step | Work and purpose | Done when |
| --- | --- | --- |
| 1. Evidence checker (implemented locally) | `packages/lab/src/evaluate.ts`, tests, and `pnpm lab evaluate <run-id|latest> [--json]`. | Made-up and unreceived citations fail in tests; the saved B record's three returned IDs pass; missing/failed retrieval is visible. |
| 2. Separate AI review (implemented locally) | A fresh Gateway request receives the task, answer, and received logs; `review-v1` returns claim judgments and missing evidence. | Review input/configuration/checks, errors, and usage are saved separately and reopenable. |
| 3. Small working UI | Use the existing Next.js app to select a case and show the run timeline, returned log rows, answer, objective checks, and AI review. | A real run updates the screen and can be reopened after refresh; clicking a citation reveals its recorded evidence. |
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
the investigator's prompt/tool results. A later structured outcome field may make
case checks more precise; do not use loose substring matching as proof of truth.

Start with a CLI report. Add a numbered migration for persisted evaluations when
the report contract is clear. Store evaluator version and run ID; do not overwrite
the original events or answer while evaluating them.

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

Reuse the current TypeScript, Next.js, Eve, Gateway, PostgreSQL, pg, Zod, and Vitest
stack. Read installed Next.js/Eve guides before implementation. No new database,
vector store, deployment platform, or general workflow engine is needed here.

Extract the CLI's orchestration into reusable code before wiring a Run button.
Keep one active local investigation at a time with an explicit busy response.
Supervise the owned Eve process and keep credentials in the server process;
never mutate a shared Eve server's global trial token between browser requests.
The browser can poll saved run state/events; it must not depend on receiving the
one original stream to display a completed run after refresh.

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
