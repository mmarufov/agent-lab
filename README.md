# Agent Lab

Controlled deployment scenarios for testing whether a change to an AI agent improves its behavior.

**Current checkpoint:** a local PostgreSQL simulation, authenticated Next.js endpoints, and a live eve investigator through AI Gateway. Each investigation saves its task, source settings, streamed events, structured answer, and available usage in PostgreSQL. A TypeScript checker verifies citations, and a separate Gateway model reviews claims against received evidence. Both assessments remain separate. The comparison UI and agent-version experiments are next. The broader [project plan](PROJECT_BRIEF.md) describes future work.

Deployments A, B, and C and their logs are authored fixtures. No real deployments are created or rolled back, and the tests do not measure model quality.

## Run locally

Requirements: pnpm 12.9.1 and a running Docker engine. pnpm selects the project's Node 24 runtime.

```sh
pnpm install --frozen-lockfile
test -f .env.local || cp .env.example .env.local
pnpm db:up
pnpm db:migrate
pnpm dev
```

In another terminal, from the repository root:

```sh
pnpm lab:logs B
```

```text
Trial: <new trial UUID>
Deployment: B
log-15: Starting application.
log-16: Optional telemetry is disabled.
log-17: Startup failed: DATABASE_URL is missing.
```

The CLI creates a fresh trial, then retrieves its logs through the real HTTP service:

```text
CLI -> getLogs -> Next.js on localhost:3000 -> PostgreSQL on localhost:55432
```

Try A for healthy logs or C for an empty list. Successful trials remain in PostgreSQL for inspection; failed demos clean up their own trial. `pnpm db:stop` stops the database without deleting its volume. The Compose project uses a fixed local port; change both its host port and `DATABASE_URL` to run another copy concurrently.

## Interfaces

All HTTP tools require `Authorization: Bearer <trial-token>`. A token only grants access to its own trial.

| Interface | Purpose |
| --- | --- |
| `GET /api/tools/get-logs?deploymentId=B` | Retrieve the trial's saved logs. |
| `GET /api/tools/get-deployment-state` | Read the current deployment and revision. |
| `POST /api/tools/rollback-deployment` | Roll back to a healthy older deployment. |
| `pnpm lab init` | Create a trial and print its ID and token. Keep the token local. |
| `pnpm lab inspect <trial-id>` | Inspect state and committed actions. |
| `pnpm lab promote <trial-id>` | Simulate another actor promoting C. |

A guarded rollback sends `{"targetDeploymentId":"A","expectedRevision":7}`. If another actor has changed the revision, the service returns HTTP 409 without overwriting the new state. Omitting `expectedRevision` is intentionally supported as an unsafe experiment control. Changes and action records commit together in a database transaction.

## Agent package

`my-agent/agent/agent.ts` selects the model. `instructions.md` tells it to retrieve evidence and cite log IDs. `tools/get_logs.ts` wraps the HTTP client and reads `LAB_BASE_URL` and `LAB_TRIAL_TOKEN` from runtime configuration; see `my-agent/.env.example`. Credentials are not model-facing tool arguments.

With PostgreSQL and Next.js running and an eve model connection configured:

```sh
pnpm lab:investigate B
pnpm lab run latest
# Use the printed run ID to reopen a specific investigation:
pnpm lab run <run-id> --json
```

The investigation command creates a fresh trial and run record, checks service access, starts its own eve process on `127.0.0.1:2000`, and asks the configured model to investigate. The model receives the deployment ID; the tool's credentials stay in the child process environment. It saves each event before displaying it, saves the structured `diagnosis`, `evidenceIds`, and `uncertainty`, then stops eve. It makes real model calls through the configured connection. Run `pnpm db:migrate` after updating the project to install migration 003 without resetting existing trials.

`pnpm lab run` reads the saved record without starting eve or making a model call. The JSON view includes the original instructions, their SHA-256 hash, the authored agent configuration, timestamps, and all recorded events. Source files are captured at startup; this is not a snapshot of the entire runtime. Duration includes service checks, eve startup, and event saving, but excludes process teardown. Failed and cancelled runs retain partial evidence. An abrupt kill or database outage can leave a run marked `running`; the command reports that uncertainty rather than inventing a final result.

To check the saved evidence with only PostgreSQL running:

```sh
pnpm lab evaluate latest
pnpm lab evaluate <run-id> --json
```

`evidence-v1` checks execution status, agreement between the saved answer and its structured event, tool-trace consistency, successful retrieval, and citation membership. It pairs requests/results by turn and call ID, validates returned logs, and only credits the requested deployment's successful results recorded before the answer. Invented or unreceived citations fail even if the ID exists in the fixture database. Conflicting log content is reported. The JSON report includes each received log and its request/result event IDs.

An empty successful response is distinguishable from a failed/missing retrieval. An empty citation list is explicitly unassessed. Passing these checks does **not** prove the diagnosis interprets the logs correctly: diagnosis assessment stays `not_evaluated`. Reports are computed on demand without modifying the saved run, creating evaluation rows, or calling a model. Exit status is 1 for a failed check/command, 2 for an unfinished run with no failed checks, and 0 otherwise; it is not a semantic correctness score.

To add a separate model review of a completed investigation:

```sh
pnpm db:migrate
pnpm lab:review latest                  # New model request; incurs usage
pnpm lab review latest                 # Read saved review; no model request
pnpm lab review <review-id> --json      # Exact input, settings, checks, output, usage
```

Only PostgreSQL and Gateway access are needed for reviewing a saved run. Put a Gateway key in ignored `.env.local` as `LAB_REVIEW_GATEWAY_API_KEY`. This setting is specific to the reviewer and does not replace Eve's configured connection. Standard `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` also work; Eve's local CLI login alone is not inherited by this standalone SDK call. See [Gateway authentication](https://vercel.com/docs/ai-gateway/authentication-and-byok).

The default reviewer is `openai/gpt-6.1-sol`; override it with `LAB_REVIEW_MODEL`. The AI SDK sends fresh review instructions plus only the task, answer, deployment ID, and successful recorded logs. It receives no investigator conversation, investigator instructions, database access, or tools. `review-v1` asks it to quote claims, classify each as supported/unsupported/uncertain, cite logs, and identify missing evidence. TypeScript validates the response shape, exact answer quotations, and evidence references. These checks do not prove the review's reasoning is correct or complete.

Migration 004 adds a separate review-attempt table. Each attempt preserves its exact input, prompt/version/hash, model/settings, evidence-check snapshot, status, response metadata, reported usage, and valid review or error. The review never replaces the original answer or clears a failed check. Repeating `lab:review` creates another attempt; `lab review` only reads. The generating command exits 1 for execution failure or failed objective checks, not merely because a model returns an unfavorable opinion.

Requests allow at most 4,096 output tokens, have a 60-second model deadline, and disable SDK retries. Input over 64 KiB is rejected instead of silently truncating evidence. Ctrl+C records cancellation when PostgreSQL remains available; an abrupt kill/outage can leave an attempt marked `running`. Reported usage is retained after invalid model output, and unavailable cost remains unknown. The review is advisory; this is not a measured guarantee of diagnosis accuracy or resistance to prompt injection.

Run one investigation at a time and stop any separately running eve server first. The command has a two-minute deadline; Ctrl+C requests cancellation and stops its eve process. `pnpm --filter my-agent dev` opens eve's terminal interface for model connection setup. `pnpm build:agent` builds without model calls; `pnpm lab:logs B` still retrieves logs without a model. A completed investigation is not an independent evaluation of its answer.

## Verify

With PostgreSQL running:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm build:agent
```

With the Next.js service also running, run `pnpm test:api`. It exercises the endpoints over real HTTP. Tests clean up only their own trials and temporary schemas. The client suite includes two real five-second timeout checks.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/app/api/tools/` | HTTP routes for logs, deployment state, and rollback. |
| `src/lib/lab-http.ts` | Trial authentication and HTTP error mapping. |
| `packages/contracts/` | Shared Zod schemas and TypeScript types. |
| `packages/lab/` | SQL migrations, fixtures, database operations, controller CLI, and integration tests. |
| `packages/lab/src/evaluate.ts` | Pure saved-run evidence checker; reports received logs, missing/ambiguous citations, and assessment limits. |
| `packages/lab/src/reviews.ts` | Review input preparation, persistence, and lifecycle; preserves objective checks separately. |
| `my-agent/client/review.ts` | Bounded standalone Gateway request, review instructions, structured output, and response usage capture. |
| `my-agent/` | Eve configuration, instructions, HTTP tool, local process/client integration, and tests. |
| `scripts/` | Logs and investigation CLIs, plus HTTP checks. |

Local credentials, build output, research artifacts, and personal session notes are gitignored.
