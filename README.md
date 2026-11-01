# Agent Lab

Controlled deployment scenarios for testing whether a change to an AI agent improves its behavior.

**Current checkpoint:** a local web workbench for a live Eve investigator through AI Gateway. Start investigations, inspect their saved trace, follow citations to returned logs, and request a separate model review. PostgreSQL retains the evidence and available usage; Evidence checks, saved case outcome checks, and model judgments remain separate. Agent-version comparisons are next. The broader [project plan](PROJECT_BRIEF.md) describes future work.

Deployments A, B, and C and their logs are authored fixtures. No real deployments are created or rolled back, and the tests do not measure model quality.

## Run locally

Requirements: pnpm 12.9.1 and a running Docker engine. pnpm selects the project's Node 24 runtime.

```sh
pnpm install --frozen-lockfile
test -f .env.local || cp .env.example .env.local
pnpm db:up
pnpm dev:lab
```

Open **http://127.0.0.1:3000/runs**. `dev:lab` applies pending migrations and
starts Next.js plus one local worker. Configure Eve's model connection and the
reviewer credentials described below before starting model work. **New
investigation** selects one of four development cases and makes a fresh trial; **Review answer** makes a separate model
request. Both incur model usage. Reading saved runs makes no model calls.

While an operation runs, a compact activity panel shows recorded model requests
and tool results. It stays open after completion until you close it;
**View activity** reopens it. Only steps with details can expand. Click a citation
to inspect its exact returned log. Evidence checks, outcome checks, and the independent review
result sit beneath the answer on the left. Outcome failures stay visible; passing
checks expand to show expected versus observed values and decisive evidence. **Review answer** remains at the bottom
of the activity panel on the right. Live updates use a read-only SSE connection
that reads saved state once per second and sends changed snapshots. Reconnecting
or reopening a run never submits model work.

Use `pnpm dev` for the viewer and HTTP tools alone. If it is already running,
start `pnpm lab:worker` in another terminal to enable the actions. Do not run a
second `dev:lab` on the occupied port. Set `LAB_LOCAL_EXECUTION=0` when starting
Next.js to disable browser execution.

The worker uses PostgreSQL job records and a connection-held execution lock
shared with the CLIs. Duplicate submissions with the same request ID reuse the
saved operation. Only one operation is admitted at a time. Refreshing the page
does not stop it; use **Cancel** to request cancellation. On worker restart,
unfinished browser operations are marked interrupted without automatically
calling a model again. This workbench binds to loopback and is not a hosted,
authenticated multi-user service.

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

The simulated-deployment tools require `Authorization: Bearer <trial-token>`; a token only grants access to its own trial. The Daily evidence tools take a capture access token instead; see [Reading a capture through Eve's tools](#reading-a-capture-through-eves-tools).

| Interface | Purpose |
| --- | --- |
| `GET /api/tools/get-logs?deploymentId=B` | Retrieve the trial's saved logs. |
| `GET /api/tools/get-deployment-state` | Read the current deployment and revision. |
| `POST /api/tools/rollback-deployment` | Roll back to a healthy older deployment. |
| `GET /api/tools/daily/get-logs` | Recorded Daily log lines from the capture a grant selects. |
| `GET /api/tools/daily/get-http-observations` | Recorded HTTP requests to Daily and what was observed for each. |
| `pnpm lab init` | Create a trial and print its ID and token. Keep the token local. |
| `pnpm lab inspect <trial-id>` | Inspect state and committed actions. |
| `pnpm lab promote <trial-id>` | Simulate another actor promoting C. |
| `pnpm lab:daily-evidence <capture-id>` | Read one recorded capture back through the Daily evidence tools, then revoke its grant. |
| `pnpm lab:daily-investigate <capture-id>` | Investigate one recorded capture with Eve through AI Gateway, save the run, then revoke its grant. Makes real model calls. |
| `pnpm lab:coverage <run-id\|latest>` | Check which availability facts of a finished Daily run's full recording its retrieved records establish, and save the assessment. No model call. |
| `pnpm lab coverage <assessment-id\|latest> [--json]` | Reopen a saved coverage assessment from PostgreSQL alone. |

A guarded rollback sends `{"targetDeploymentId":"A","expectedRevision":7}`. If another actor has changed the revision, the service returns HTTP 409 without overwriting the new state. Omitting `expectedRevision` is intentionally supported as an unsafe experiment control. Changes and action records commit together in a database transaction.

## Agent package

`my-agent/agent/agent.ts` selects the model and reasoning effort, turns off Eve's optional built-in tools and delegation (`defaultTools: false`, `tool: false`), and sets session usage limits of 500,000 input tokens, 20,000 output tokens, and $0.10 of reported model cost. Eve checks those limits between model calls, so the call that crosses one finishes and can exceed it; the runners treat Eve's request to approve more usage as a failure and never approve it. `tools/get_logs.ts` wraps the HTTP client and reads `LAB_BASE_URL` and `LAB_TRIAL_TOKEN` from runtime configuration; see `my-agent/.env.example`. Credentials are not model-facing tool arguments.

`LAB_TOOL_MODE`, which only the process that starts Eve sets, chooses both the tools and the instructions when a session starts. Unset or `simulated` exposes `get_logs` with `prompts/simulated.md` (the former `agent/instructions.md`, byte for byte, so its SHA-256 matches earlier runs); `daily_capture` exposes the two Daily evidence tools with `prompts/daily-capture.md`. `agent/instructions/investigator.ts` selects the text through Eve's dynamic instructions, and `client/instructions.ts` reads the same file for the run record. Each runner gives Eve only its own mode's credentials. `pnpm lab:investigate` pins `simulated`.

With PostgreSQL and Next.js running and an eve model connection configured:

```sh
pnpm lab:investigate --case recovered-startup
# Legacy deployment-only form remains available:
pnpm lab:investigate B
pnpm lab run latest
# Use the printed run ID to reopen a specific investigation:
pnpm lab run <run-id> --json
```

The investigation command creates a fresh trial and run record, checks service access, starts its own eve process on `127.0.0.1:2000`, and asks the configured model to investigate. The model receives the deployment ID; the tool's credentials stay in the child process environment. It saves each event before displaying it, saves the structured `diagnosis`, `evidenceIds`, and `uncertainty`, then stops eve. It makes real model calls through the configured connection. Run `pnpm db:migrate` after updating the project to install pending migrations through 011 without resetting existing trials.

`pnpm lab run` reads the saved record without starting eve or making a model call. The JSON view includes the original instructions, their SHA-256 hash, the authored agent configuration, timestamps, and all recorded events. Source files are captured at startup; this is not a snapshot of the entire runtime. Duration includes service checks, eve startup, and event saving, but excludes process teardown. Failed and cancelled runs retain partial evidence. An abrupt kill or database outage can leave a run marked `running`; the command reports that uncertainty rather than inventing a final result.

Migration 010 makes saved events append-only and seals each run when it finishes. Triggers refuse to change an event's payload, ID, order, or recorded time, to delete one event, to truncate the events table on its own, or to add an event once the run has a final status. Deleting a whole run, or its trial, still removes its events through the existing cascades. An event insert takes the same row lock on its run that finishing takes, including direct SQL inserts and worker recovery, so a concurrent event either commits first and is part of the final record or is refused. Only a READ COMMITTED transaction, PostgreSQL's default and what every Lab writer uses, may finish a run, because an older REPEATABLE READ snapshot could miss a committed event.

The statement that gives a run its final status also saves a SHA-256 fingerprint of one versioned jsonb document: the run's ID and source identity (trial and deployment, or capture ID and pinned file hashes), its final status and answer, and every event's ID and complete payload in saved order. PostgreSQL builds the same document again to verify it, so JavaScript key order never matters. The fingerprint's version, event count, creation time, and origin are saved with it, and after that the run row never changes. Runs that had already finished were sealed by the migration and are labeled `legacy_snapshot`: that protects them from then on, but says nothing about their earlier history. Their evidence reports and reviews were not rewritten.

`lab run`, `lab evaluate`, and both investigation commands print `Integrity: verified`, `MISMATCH`, `MISSING`, or `not sealed yet`, and `--json` includes the recomputed fingerprint. A mismatch makes `lab evaluate` exit 1. New reviews and coverage assessments refuse a finished run whose record does not verify; saved reviews still reopen from their own snapshots. The fingerprint covers the fields above, not usage, model, session, error text, or the derived evidence report; the immutability trigger protects those. These controls cover ordinary application and database writes. An administrator who disables the triggers can still change rows, and verification then reports a mismatch.

To check the saved evidence with only PostgreSQL running:

```sh
pnpm lab evaluate latest
pnpm lab evaluate <run-id> --json
```

`evidence-v1` checks execution status, agreement between the saved answer and its structured event, tool-trace consistency, successful retrieval, and citation membership. It pairs requests/results by turn and call ID, validates returned logs, and only credits the requested deployment's successful results recorded before the answer. Invented or unreceived citations fail even if the ID exists in the fixture database. Conflicting log content is reported. The JSON report includes each received log and its request/result event IDs.

Case investigations require version-two answers: the original fields plus
`outcome.state`, `outcome.cause`, and `outcome.configurationKey`. The trusted registry
in `packages/lab/src/cases.ts` defines four development cases:

| Case | Required structured conclusion |
| --- | --- |
| `missing-config` | Failed startup, missing configuration, `DATABASE_URL` |
| `healthy-startup` | Healthy startup, no observed failure cause |
| `recovered-startup` | Recovery, earlier missing configuration, `DATABASE_URL` |
| `no-logs` | Unknown state/cause, no configuration claim |

The [first live baseline](docs/CASE_BASELINE.md) records all four runs, the separate review, and reported costs.

All target B and receive the same neutral task. The model must retrieve logs
through the authenticated HTTP tool; neither investigator nor reviewer receives
case names, expected answers, or the case snapshot. Log IDs are unique to each
trial. Legacy deployment-only commands retain version-one output.

`outcome-v1` compares structured claims and requires the decisive citations to
have been retrieved before the answer. Recovery needs both failure and later
success evidence. Empty evidence can pass only after successful empty retrieval.
Unfinished runs and unreliable traces cannot receive an outcome pass. These checks
assess structured claims; the independent reviewer assesses prose.

Migration 006 saves the case ID/version and an immutable fixture/expectation
snapshot. Completion saves the answer and outcome report in one transaction.
`lab evaluate` and the UI read that saved report, without recomputing it against
new fixtures. Old investigations display **Outcome not assessed**.

An empty successful response is distinguishable from a failed/missing retrieval. An empty citation list is explicitly unassessed. Passing these checks does **not** prove the diagnosis interprets the logs correctly: diagnosis assessment stays `not_evaluated`. Evidence reports are computed on demand; case outcome reports are read from the completed run. Neither read calls a model or modifies the saved run. Exit status is 1 for a failed evidence/outcome check or command, 2 for an unfinished run with no failed checks, and 0 otherwise; it is not a semantic correctness score.

To add a separate model review of a completed investigation:

```sh
pnpm db:migrate
pnpm lab:review latest                  # New model request; incurs usage
pnpm lab review latest                 # Read saved review; no model request
pnpm lab review <review-id> --json      # Exact input, settings, checks, output, usage
```

Only PostgreSQL and Gateway access are needed for reviewing a saved run. Put a Gateway key in ignored `.env.local` as `LAB_REVIEW_GATEWAY_API_KEY`. This setting is specific to the reviewer and does not replace Eve's configured connection. Standard `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` also work; Eve's local CLI login alone is not inherited by this standalone SDK call. See [Gateway authentication](https://vercel.com/docs/ai-gateway/authentication-and-byok).

The default reviewer is `openai/gpt-6.1-sol`; override it with `LAB_REVIEW_MODEL`. For a simulated run, the AI SDK sends fresh review instructions plus only the task, answer, deployment ID, and successful recorded logs (Daily runs are described in [Reviewing a Daily investigation](#reviewing-a-daily-investigation)). It receives no investigator conversation, investigator instructions, database access, or tools. `review-v1` asks it to quote claims, classify each as supported/unsupported/uncertain, cite logs, and identify missing evidence. TypeScript validates the response shape, exact answer quotations, and evidence references. These checks do not prove the review's reasoning is correct or complete.

Migration 004 adds a separate review-attempt table. Each attempt preserves its exact input, prompt/version/hash, model/settings, evidence-check snapshot, status, response metadata, reported usage, and valid review or error. The review never replaces the original answer or clears a failed check. Repeating `lab:review` creates another attempt; `lab review` only reads. The generating command exits 1 for execution failure or failed objective checks, not merely because a model returns an unfavorable opinion.

Requests allow at most 4,096 output tokens, have a 60-second model deadline, and disable SDK retries. Input over 64 KiB is rejected instead of silently truncating evidence. Ctrl+C records cancellation when PostgreSQL remains available; an abrupt kill/outage can leave an attempt marked `running`. Reported usage is retained after invalid model output, and unavailable cost remains unknown. The review is advisory; this is not a measured guarantee of diagnosis accuracy or resistance to prompt injection.

Run one investigation at a time and stop any separately running eve server first. The command has a two-minute deadline; Ctrl+C requests cancellation and stops its eve process. `pnpm --filter my-agent dev` opens eve's terminal interface for model connection setup. `pnpm build:agent` builds without model calls; `pnpm lab:logs B` still retrieves logs without a model. A completed investigation is not an independent evaluation of its answer.

## Daily sandbox

An isolated local copy of [Daily](https://github.com/mmarufov/Daily)'s backend at commit `02afcabf6ec0695c33f4be162bb7d6a5fbecaca1`, with its own PostgreSQL database and three fictional test articles. `pnpm daily:capture` breaks this real application in one controlled way (it stops only its database) and records what happened. It needs Docker and network access for the first build, and no model or provider credentials.

```sh
pnpm daily:up      # Prepare source, build, start, wait for readiness, seed, check
pnpm daily:check   # Check the running sandbox; no reseeding or restarting
pnpm daily:logs    # Follow timestamped logs; Ctrl+C stops following
pnpm daily:stop    # Stop the containers; the database volume and session stay
pnpm daily:reset   # Delete only the sandbox containers, networks, volume, and session
pnpm daily:capture # Record a real PostgreSQL outage and recovery (about 1.5 to 4 minutes)
pnpm daily:recover # Finish a capture that was killed, or clear an abandoned lock
```

`daily:up` fetches the pinned commit into ignored `.context/daily-source/`, extracts only committed `backend/` files, and builds Daily's own Dockerfile with `GIT_SHA` set to that commit. Local `.env` files and uncommitted edits in a Daily checkout cannot reach the image. Compose project `agent-lab-daily` (`scenarios/daily/compose.yaml`) runs three containers:

| Service | Role |
| --- | --- |
| `daily-db` | `pgvector/pgvector:0.8.0-pg16`, the image Daily's CI uses. Database `daily_lab`, named volume, no published port. |
| `daily-api` | Daily's backend started by `scenarios/daily/launcher.py`: one Uvicorn worker, its six background loops replaced by logged no-ops before startup. |
| `daily-gateway` | `scenarios/daily/gateway.py` forwards `127.0.0.1:8081` on the Mac to `daily-api:8080`. It runs no Daily code. |

`daily-api` and `daily-db` are attached only to an `internal: true` network, so Daily cannot reach the internet, AI providers, or the Mac. Docker does not publish ports from containers on an internal-only network, which is why the forwarder exists. Configuration is explicit in the Compose file; Agent Lab's `.env.local` is not read. Daily's optional S3 to S8 and enrichment stages are off. Its OpenAI key is an inert placeholder, because Daily constructs the client while importing.

`scenarios/daily/seed.py` runs inside `daily-api` with Daily's psycopg driver. In one transaction it upserts a fictional reader, completed preferences, one active source, and the three articles from `scenarios/daily/fixture.json` with their feed-cache rows, all with fixed IDs. The controller keeps the session token in `.context/daily-sandbox/session.json` (mode 0600) and sends Daily only its SHA-256 hash, the format Daily's sign-in handlers store. Rerunning setup refreshes rows instead of duplicating them, and resets cache timestamps because Daily ignores cache rows older than 60 minutes.

`daily:check` makes real HTTP requests that pass through Daily's handlers and PostgreSQL. `/healthz` must report the pinned build and no background-loop leadership, and `/readyz` must be ready. `/feed` must return 401 without a token and with an unknown token, and `status: "ready"` with the three fixture articles in order for the saved session. It also confirms that `daily-api` runs the launcher, is attached only to the internal network, and fails DNS and TCP egress probes. Each failure names its stage (build, startup, schema, authentication, feed, background, isolation) and the next step. Startup checks wait up to 120 seconds, and each request times out after 5 seconds.

Every command passes `--project-name agent-lab-daily` and the sandbox Compose file, so Agent Lab's own PostgreSQL is never touched. `daily:up` refuses to continue when `127.0.0.1:8081` is taken, or when a volume, network, or container with a sandbox name belongs to something else. It never picks another port or project, and `daily:reset` never deletes resources it did not create. `.context/daily-sandbox/environment.json` records the source revision and backend tree, image digests, and the resolved Python package versions, since Daily's requirements allow version ranges. Daily logs one non-fatal `pg_prewarm` error at startup because the optional S5 reader table is not installed in feed-only mode.

### Capturing a real outage

`pnpm daily:capture` uses the running sandbox as it is; it never builds, reseeds, or restarts it. It first runs `daily:check`, refuses a feed cache that would expire before the capture ends (run `daily:up` to refresh it), and verifies that all three containers carry this workspace's Compose labels and the image digests `daily:up` recorded. Then it opens a capture window and:

1. **Baseline.** Two rounds of `GET /healthz`, `GET /feed` (with the sandbox session), and `GET /readyz`, two seconds apart. If a round is not healthy, it saves that result and never touches PostgreSQL.
2. **Outage.** It writes a recovery marker, runs `docker stop --timeout 10` against the verified `daily-db` container ID, confirms the container stopped, and keeps sending the same rounds for 45 seconds. `daily-api` and `daily-gateway` keep running.
3. **Restore.** `docker start` on the same container (same volume and data), then it waits for Docker's `pg_isready` health check. Database availability is recorded separately from application recovery.
4. **Recovery.** Up to 120 seconds after `docker start` for two consecutive healthy rounds, with the expected three articles. Nothing is restarted, reseeded, or reconfigured to make this pass. Afterwards the API and gateway must still have the same container IDs and start times.
5. **Collection.** `docker logs --timestamps --since ... --until ...` for the capture window, from all three containers.

Every request has a 5-second deadline and its own connection. A timeout is recorded as a timeout, with no invented status. The terminal shows each phase and each request as it happens. Each run writes a new directory, `.context/daily-sandbox/captures/<capture-id>/`. Earlier captures are never reused or overwritten:

| File | Contents |
| --- | --- |
| `evidence.jsonl` | What an outside observer could see: one record per HTTP request (method, path, start and end time, elapsed time, and the status and body, a timeout, or the connection error), then one record per `daily-api` and `daily-gateway` log line with Docker's timestamp and stream. Eligible for later investigator tools. |
| `controller.jsonl` | What the script did and knew: phase boundaries, which evidence IDs each request round produced and whether they passed, every Docker action with its exit code, container snapshots, cleanup attempts, and the `daily-db` log lines. |
| `manifest.json` | Execution status, the observed outcome checks, cleanup result, provenance (Daily revision and tree, image digests, resolved Python packages, container IDs and start times, SHA-256 of the Compose file, launcher, gateway, seed program, and fixture), redaction counts, and the SHA-256 and record counts of both JSONL files. |

The evidence never says that PostgreSQL was stopped: phases, expected outcomes, and database logs live in the controller file. Daily's logs carry no request IDs, so log lines are not matched to requests; repeated lines and every stack-trace line stay separate records. Request headers and cookies are never stored, and the session token, its hash, the sandbox database password, Bearer tokens, and URL passwords are replaced with `[REDACTED]` before anything is written. The schemas are in `packages/contracts/src/daily-capture.ts`, and `verifyCapture()` in `packages/lab/src/daily-evidence.ts` rechecks a capture's hashes, records, and IDs, including a cancelled or interrupted one.

The command exits 0 only when every phase ran, all seven outcome checks passed (baseline, stop, outage observed, database available, application recovered, containers unchanged, evidence complete), and the database was restored. On Ctrl+C or SIGTERM it stops sampling, starts `daily-db` again if it had stopped it, collects logs, saves the partial record as `cancelled`, and exits 130 or 143. Restoration has its own 60-second limit and runs in its own process group, so another Ctrl+C cannot interrupt it.

One mutating command runs at a time. `daily:up`, `daily:stop`, `daily:reset`, `daily:capture`, and `daily:recover` share `.context/daily-sandbox/operation.lock`, and `daily:check` refuses to run during a capture because its requests would land in the evidence window. If a capture is killed outright or the Mac shuts down, the lock and the recovery marker stay behind and the other commands point to `pnpm daily:recover`. Recover checks that the recorded container still belongs to this workspace's `daily-db`, starts it, marks the capture `interrupted`, and runs `daily:check`. If it cannot start the container, it reports the exact container ID and error and keeps the marker; it never marks the sandbox recovered silently.

A capture records one controlled outage of a local sandbox. It is not a production incident, and it says nothing yet about how well an investigator diagnoses it.

### Reading a capture through Eve's tools

Two read-only tools give an Eve agent the recorded evidence of exactly one capture:

| Eve tool | Endpoint | Optional inputs | Page size |
| --- | --- | --- | --- |
| `get_daily_logs` | `GET /api/tools/daily/get-logs` | `service`, `messageContains` (ignores letter case), `cursor`, `limit` | 50 by default, at most 100 |
| `get_daily_http_observations` | `GET /api/tools/daily/get-http-observations` | `path` (exact match), `cursor`, `limit` | 20 by default, at most 50 |

```text
Eve tool -> my-agent/agent/lib/daily-evidence.ts (HTTP client, one 5-second deadline)
  -> Next.js route: local-host check -> packages/lab/src/daily-tools.ts
  -> capture-access.ts: token hash -> grant (capture ID, pinned SHA-256s, expiry, revocation)
  -> daily-evidence.ts: re-read and verify captures/<capture-id>/ -> one page of evidence.jsonl records
```

Access comes from a grant, not a trial. A trusted command, never the model, verifies the capture and inserts a row into `lab_capture_access_grants` (migration 007): the capture ID, the SHA-256 of `manifest.json`, `evidence.jsonl`, and `controller.jsonl`, the SHA-256 of a random bearer token, and an expiry one hour later. PostgreSQL holds only this access metadata; the evidence stays in its files. Every request checks the grant, re-reads the files, and refuses them when a hash differs from the pinned value (409 `capture_changed`), the capture is gone (404 `capture_missing`), or the files fail verification or are symbolic links (422 `capture_invalid`). Unknown, revoked, and expired tokens get 401. The capture ID comes from the grant; no request input selects a capture.

A capture is served only when it completed, its evidence was fully collected, and neither JSONL file has an invalid line. Its outage and recovery outcomes do not have to pass: an observed failure is still evidence. Captures are selected by ID inside `.context/daily-sandbox/captures/`, never by path.

Pages contain the original records in recorded order, with IDs, timestamps, messages, statuses, timeouts, and truncation markers unchanged. A serialized page never exceeds 64 KiB: with large records it holds fewer, and a record too large for any page is listed under `oversized` with its size instead of being shortened. Every page names its `captureId` and `evidenceSha256`, and the clients refuse a page from any other source. `nextCursor` is bound to the capture, the tool, and the filters, and the same request returns the same page. Responses carry `Cache-Control: no-store` and never include controller records, outcome checks, file paths, or credentials.

In `daily_capture` mode the tools read `LAB_BASE_URL`, `LAB_DAILY_CAPTURE_TOKEN`, `LAB_DAILY_CAPTURE_ID`, and `LAB_DAILY_EVIDENCE_SHA256` when they run, so the token never enters Eve's durable tool records. Their descriptions say they read a fixed recording, not Daily's current health. `pnpm lab:daily-investigate`, below, gives them to an investigator.

With PostgreSQL and `pnpm dev` running:

```sh
pnpm lab:daily-evidence 20261022T050138Z-39b307
```

It verifies that capture, creates a one-hour grant, reads every HTTP observation and log line back through the two clients page by page, compares them with the verified file, revokes the grant, and shows the revoked token being refused. Ctrl+C also revokes it. It never picks the newest capture by itself, starts Docker, or calls a model. The service reads captures under its own working directory, so run `pnpm dev` from the same checkout. Reading files on one machine suits this local milestone; a hosted version needs shared artifact storage.

### Investigating a capture with Eve

With PostgreSQL and `pnpm dev` running and Eve's model connection configured:

```sh
pnpm lab:daily-investigate 20261022T050138Z-39b307
```

The command takes one explicit capture ID; it never picks the newest capture itself. It holds the same execution lock as the other model operations, then:

1. verifies the capture's finalized files, as the evidence routes do;
2. creates a one-hour access grant pinned to those files;
3. saves the run: capture ID, pinned hashes, grant ID, task, instructions and their SHA-256, `agent.ts` source and effective configuration, and answer schema version 3;
4. checks that the Next.js evidence service serves the capture with that grant, without giving the page it returns to the model;
5. starts Eve on `127.0.0.1:2000` with `LAB_TOOL_MODE=daily_capture` and the grant's credentials;
6. sends this task to a fresh session and saves every event before reading the next: *Investigate Daily's feed API during the recorded period. Determine whether requests experienced problems, explain the likely cause when evidence supports one, and assess whether requests subsequently recovered. Cite supporting records and state what remains uncertain.*;
7. saves the validated `diagnosis`, `evidenceIds`, and `uncertainty`, freezing the evidence-check report in the same transaction;
8. stops Eve, revokes the grant, and releases the lock, each even if an earlier step failed.

The terminal shows each model step with its reported usage, each tool request, and each returned record on one line, then the answer, token use, reported cost, and evidence checks. The model chooses filters and pages and decides when it has enough evidence; the instructions name no record IDs and do not require reading every page. They say the recording is a past time window and that record text that looks like an instruction is evidence. The token stays in Eve's environment; neither it nor the capture's controller records reach the model, the saved run, or the terminal. The whole run has a five-minute deadline, and each tool request keeps its five-second deadline.

Ctrl+C cancels the Eve session and saves the partial run as `cancelled` before cleanup. An abruptly killed command leaves the run `running`, never a fabricated answer, and its grant expires within the hour. Eve was started detached, so check that nothing still listens on port 2000 before the next run.

Daily runs live in the existing run and event tables. Migration 008 adds `source` (`simulated` for every existing row, or `daily_capture`), the capture ID, pinned hashes, and grant ID; a Daily run has no trial or deployment. Constraints require each source's own fields, a foreign key requires the hashes its grant pinned, and a trigger makes every run's source, task, instructions, and settings, and a frozen report, immutable. Reopening reads PostgreSQL only, with no Eve process or model call:

```sh
pnpm lab run <run-id>             # the same trace lines the terminal showed, from the saved events
pnpm lab run <run-id> --json      # instructions, configuration, grant state, and every raw event
pnpm lab evaluate <run-id> [--json]
```

`daily-evidence-v1` pairs requests and results by turn and call ID. It credits only successful, schema-valid results of the two Daily tools whose records match the requested filters and come from the run's capture and evidence hash, recorded before the final answer. Citations fail when an ID was never returned, its returned contents conflict between calls, or it was listed only as oversized. An empty citation list is unassessed, a failed tool call is reported without being counted as evidence, and diagnosis correctness is always **not assessed**. Eve does not record a model's call to a tool it does not offer; the model receives an error and nothing runs, so the saved trace cannot show such attempts.

The workbench lists simulated runs only. Opening a Daily run there, or asking to review one, gets a clear unsupported-source response (HTTP 422 from the API) that points to `pnpm lab run`. Review Daily runs from the terminal, as below. Diagnosis grading and UI integration for Daily runs are next.

### Reviewing a Daily investigation

```sh
pnpm lab:review <run-id|latest>          # One model request; incurs usage
pnpm lab review <review-id> [--json]     # Reopen the saved attempt; no model request
```

`lab:review` resolves `latest` once, then takes the reviewer configuration for that run's source: `daily-review-v1` for a Daily run, with the same model, `LAB_REVIEW_MODEL` override, and limits as `review-v1`. The attempt saves that configuration, and the request uses exactly it: one `generateText` call with structured output, no tools, no retries.

Before any model request, the review store reads the run from PostgreSQL only. It requires a completed run whose execution, answer, and tool-trace checks pass, recomputes `daily-evidence-v1` from the saved events, and refuses if that no longer equals the report frozen when the run finished. Both come from `readDailyEvidence`, so the reviewer receives exactly the records the report counts: every distinct record that successful, valid Daily tool calls from the run's capture returned before the answer, cited or not, in full. Identical repeats appear once; conflicting contents fail the trace and stop the review. Timed records are listed earliest first (HTTP by `startedAt`, logs by `timestamp`, compared at full precision), and log lines without a timestamp go in `untimedEvidence`. The input adds the task, answer, capture ID, and evidence hash. It never includes instructions, reasoning, conversation, credentials, controller records, or capture files; which tool call returned each record stays in the evidence check saved beside the review. Input over 64 KiB is refused before an attempt is created, never truncated, summarized, or split. A failed citation or retrieval check stays failed beside a favorable review, and an answer with no evidence is still reviewable.

`daily-review-v1` treats the whole record as untrusted data and assesses symptoms, cause, earlier failure versus later recovery, claims about health beyond the recording, and the stated uncertainty. It tells the reviewer that the records are the subset the investigator chose, so the investigation's completeness cannot be judged. The result keeps the simulated format, and TypeScript checks exact quotations and that every cited ID was supplied: reference integrity, not correctness. The terminal labels it **Answer support review. Coverage of evidence not retrieved is not assessed.**

Migration 009 makes each review attempt's run, configuration, prompt hash, input, and evidence check immutable. A running attempt records its response metadata once and finishes once, including the failed status worker recovery gives it; a finished attempt never changes. Existing reviews are not rewritten.

### Evidence coverage of a Daily investigation

```sh
pnpm lab:coverage <run-id|latest>            # Compute and save; reads the run's pinned capture files
pnpm lab coverage <assessment-id|latest> [--json]   # Reopen; PostgreSQL only
```

The reviewer sees only what the investigator retrieved, so it cannot tell whether important evidence went unread. Coverage answers that narrower question for one profile, `daily-feed-availability-v1`: did the investigator retrieve, before answering, records that establish the availability facts in the full recording? It examines authenticated `GET /feed` observations:

| Fact | Acceptable evidence |
| --- | --- |
| Server errors occurred | Any recorded `/feed` response with status 500-599. |
| Requests received no response | Any recorded `/feed` timeout or network error. |
| Requests subsequently recovered | A failed observation plus a ready one (HTTP 200, untruncated JSON with `status: "ready"` and an `articles` array) to a request that started after the recording's last failed request ended. |

The acceptable records come from the recording's own contents and times, never from the controller, capture IDs, or the assumption that stopping PostgreSQL made every request fail. An earlier success, or one followed by more failures, cannot stand in for recovery, and an authentication failure or truncated body establishes none of the facts. A fact absent from the recording is **not assessed**, with the reason; a recording with none of them gives no pass. Recovery means a sampled success inside the recording, not continuous or current health.

`lab:coverage` resolves `latest` once and refuses simulated runs, unfinished runs, and runs whose record does not match their fingerprint. It reads the capture with the existing reader, which refuses files that differ from the hashes the run's grant pinned; no Docker operation or new grant is needed. It recomputes `daily-evidence-v1` from the saved events and requires the frozen report, then counts every distinct record that report counts, received before the answer, cited or not. Each must equal the recorded record in full, not only by ID. A missing or changed file, or retrieved contents that differ, is an error and nothing is saved. A failed or cancelled investigation, or an invalid trace, is saved as not assessed; a completed one with a valid trace and no records misses every fact present. `coverage-v1`, the small evaluator in `packages/lab/src/coverage.ts`, knows nothing about Daily: a fact is a list of requirements, each met by any one of several records.

Migration 011 stores each assessment once per run, profile version, and evaluator version: the fingerprint it verified, the capture hashes, the facts, every acceptable record in full, the retrieved matches with the tool call and events that carried them, the missing alternatives, the result, and the time. A trigger accepts it only for a finished Daily run that verifies now and names that run's fingerprint and files, and saved assessments never change. Repeating `lab:coverage` returns the saved assessment after checking that the recording still reproduces it; a difference means the rules changed without a new version and is refused. `lab coverage` reopens it without capture files, Eve, Next.js, or a model. Both exit 0 when covered, 1 when missed, and 2 when not assessed.

The terminal shows each fact as covered, missed, or not assessed, the retrieved IDs that met it or the acceptable IDs that were missing, and `Answer interpretation: not assessed by this coverage check`. It shows no percentage. Coverage does not read the answer: a wrong conclusion drawn from the right records still passes. Root-cause log coverage and semantic assessment of the answer are separate, later profiles or evaluators. Neither the investigator nor the reviewer receives the expected facts, the full recording, or an assessment.

## Verify

With PostgreSQL running:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm build:agent
```

With the Next.js service also running, run `pnpm test:api`. It exercises the endpoints over real HTTP, and reads all of capture `20261022T050138Z-39b307` through the Daily evidence tools when that capture exists on the machine. Run `pnpm test:ui` for browser checks; it uses installed Google Chrome and creates its own temporary database fixtures. These suites do not call models. Tests clean up only their own trials and temporary schemas. The client suite includes two real five-second timeout checks.

The Daily controller and capture tests in `pnpm test` fake Docker but use real Git, HTTP, sockets, files, and timing (short durations); they need neither Docker nor the sandbox. They cover outage and recovery, refusals that stop nothing, timeouts and connection errors, cancellation before and after the stop, failed restoration, recovery of a killed capture, log fidelity, redaction, and tampered artifacts. `pnpm daily:check` verifies the real sandbox.

The Daily evidence tests build synthetic captures in temporary directories and use real PostgreSQL for grants. They cover schema, hash, count, and duplicate-ID failures, unsafe selections and symbolic links, changed files, paging under every limit and filter, the 64 KiB limit and oversized records, cursor binding, token expiry and revocation, and responses free of controller data. One test also reads the real clean capture when it is present.

The investigator runtime tests compile and run a copy of the real `my-agent/agent` files with `eve dev`, replacing only the model with Eve's `mockModel`; each model call is answered by the test, which sees exactly what Eve presents. They show the tools and instructions in each mode, the model's paging through the real evidence handler, calls to unavailable tools such as `bash`, `get_logs`, `web_fetch`, and `agent` being refused, and the input-token limit stopping a session. The `lab:daily-investigate` tests use the same fixture for missing, incomplete, changed, and inaccessible recordings, failed tools, repeated and conflicting events, invalid answers, cancellation, the deadline, the usage limit, the frozen report, and reopening in a fresh process. No model provider is called. Vitest sets `NODE_ENV=test`, which makes Eve swap every authored model for its own mock, so the fixture clears it for its Eve process.

The integrity tests use real PostgreSQL, separate connections for concurrent inserts and finishes, and a test helper that disables triggers as an administrator could. They cover rejected changes to saved events and finished runs, identical and conflicting replay, cancellation, worker recovery, a REPEATABLE READ finisher, key-order stability, detection of changed values, migration upgrade and reapplication, legacy labeling, and cascade cleanup. The coverage tests use synthetic recordings in temporary directories: server errors, timeouts, network errors, failures after an apparent recovery, truncated responses, irrelevant authentication failures, retrieval with and without citation, unfinished and invalid investigations, missing, changed, and mismatched evidence, a false conclusion that still passes, concurrent repeats, and reopening after the recording is deleted.

The Daily review tests use real PostgreSQL and a test function in place of the model. They cover overlapping pages, repeated and uncited records, untimed lines, failed calls, records after the answer or from another capture, conflicting contents, a frozen report the events no longer produce, oversized input (zero requests, no attempt), invented citations and quotations, provider failure, timeout, cancellation, unsaveable final status, missing credentials, immutability, and reopening in a fresh process.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/app/api/tools/` | HTTP routes for logs, deployment state, rollback, and recorded Daily evidence (`daily/`). |
| `src/app/runs/`, `src/components/runs/` | Saved runs, trace, evidence inspector, review history, and execution controls. |
| `src/lib/server/`, `packages/lab/src/web.ts` | Server-only database access and explicit browser display data. |
| `packages/lab/src/activity.ts` | Stable activity items; pairs tool requests/results by turn and call ID. |
| `src/app/api/runs/[runId]/stream/`, `packages/lab/src/stream.ts` | Read-only SSE snapshots, disconnect cleanup, and terminal closure. |
| `src/components/runs/use-run-controller.ts` | One detail-page connection plus explicit review and cancellation actions. |
| `packages/lab/src/jobs.ts`, `scripts/lib/worker.ts` | Local job admission, idempotency, worker lifecycle, cancellation, and crash recovery. |
| `scripts/dev-lab.ts`, `scripts/lab-worker.ts` | Local process entry points; reuse the same investigation/review functions as the CLIs. |
| `src/lib/lab-http.ts` | Trial authentication and HTTP error mapping. |
| `packages/contracts/` | Shared Zod schemas and TypeScript types. |
| `packages/lab/` | SQL migrations, fixtures, database operations, controller CLI, and integration tests. |
| `packages/lab/src/cases.ts`, `outcome.ts` | Trusted case definitions, trial-bound snapshots, and pure structured outcome checks. |
| `packages/lab/src/evaluate.ts` | Pure saved-run evidence checker; reports received logs, missing/ambiguous citations, and assessment limits. |
| `packages/lab/src/reviews.ts` | Review input preparation for both run sources, frozen-report verification, persistence, and lifecycle; preserves objective checks separately. |
| `packages/lab/src/review-report.ts` | Terminal lines shared by `lab:review` and `lab review`. |
| `packages/lab/migrations/009_immutable_reviews.sql` | Immutable review snapshots and finished attempts. |
| `packages/lab/migrations/010_evidence_integrity.sql` | Append-only events, run row locking, the versioned fingerprint document, sealing at finish, and legacy snapshots. |
| `packages/lab/src/coverage.ts` | `coverage-v1`: facts, required combinations, and alternative records, independent of Daily. |
| `packages/lab/src/daily-coverage.ts`, `coverage-report.ts` | `daily-feed-availability-v1` facts, the comparison with the recording, the assessment store, and the terminal lines both coverage commands print. |
| `packages/lab/migrations/011_coverage_assessments.sql`, `scripts/lab-coverage.ts` | Immutable coverage assessments and `pnpm lab:coverage`. |
| `my-agent/client/review.ts` | Reviewer configuration per source (`review-v1`, `daily-review-v1`), one bounded Gateway request, structured output, and response usage capture. |
| `my-agent/` | Eve configuration, instructions, HTTP tool, local process/client integration, and tests. |
| `scripts/` | Logs and investigation CLIs, plus HTTP checks. |
| `scenarios/daily/` | Daily sandbox Compose file, feed-only launcher, TCP gateway, seed program, and fixture. |
| `scripts/daily-sandbox.ts`, `scripts/lib/daily-sandbox.ts` | `pnpm daily:*` controller: source preparation, lifecycle, conflict checks, seeding, environment record, HTTP checks, container ownership, and the operation lock. |
| `scripts/lib/daily-capture.ts`, `packages/contracts/src/daily-capture.ts` | `pnpm daily:capture` and `daily:recover`: outage phases, recording, redaction, and the versioned capture schemas. |
| `packages/lab/src/daily-evidence.ts` | Capture file reading and verification, shared by the capture controller and the evidence endpoints; selection by capture ID. |
| `packages/lab/src/capture-access.ts`, `migrations/007_capture_access.sql` | One-hour capture access grants pinned to file hashes, with revocation. |
| `packages/lab/src/daily-tools.ts`, `packages/contracts/src/daily-evidence.ts` | Daily evidence pages, cursors, page-size limit, error mapping, and the tool contracts. |
| `my-agent/agent/tools/daily_capture.ts`, `my-agent/agent/lib/{daily-evidence,tool-mode}.ts` | Daily evidence clients, Eve tool definitions, and `LAB_TOOL_MODE` selection. |
| `scripts/lab-daily-evidence.ts` | `pnpm lab:daily-evidence`: verify, grant, read back, compare, revoke. |
| `my-agent/agent/instructions/investigator.ts`, `my-agent/prompts/` | Instructions selected by `LAB_TOOL_MODE`; `client/instructions.ts` reads the same files for run records. |
| `scripts/lab-daily-investigate.ts`, `scripts/lib/daily-investigation.ts` | `pnpm lab:daily-investigate`: verify, grant, save, check the service, run Eve, save, revoke. |
| `my-agent/client/investigate.ts` | Eve process supervisor (per-mode environment), session event reader, tasks, and usage-limit handling. |
| `packages/lab/migrations/008_daily_capture_runs.sql`, `packages/lab/src/runs.ts` | Run sources, per-source constraints, immutable sources, and frozen Daily evidence reports. |
| `packages/lab/src/daily-evaluate.ts`, `packages/contracts/src/daily-review.ts` | `daily-evidence-v1` and the records a Daily run received, shared by its evidence report and its review; the Daily review input and exact time ordering. |
| `packages/lab/src/daily-evaluate.ts`, `daily-trace.ts` | `daily-evidence-v1` citation provenance checks, and the trace lines both the runner and `lab run` print. |
| `packages/contracts/src/daily-investigation.ts` | The Daily answer schema (version 3). |
| `scripts/lib/investigator-fixture.ts` | Test-only copy of the investigator with a scripted `mockModel`, and a test evidence service. |
| `scripts/lib/daily-test-harness.ts` | Fake Docker and a Daily-shaped HTTP server shared by the sandbox and capture tests. |

Local credentials, build output, research artifacts, and personal session notes are gitignored.
