# Agent Lab

Controlled deployment scenarios for testing whether a change to an AI agent improves its behavior.

**Current checkpoint:** a local PostgreSQL simulation, authenticated Next.js endpoints, a log-retrieval CLI, and the same HTTP client registered as eve's `get_logs` tool. Scripted tests cover log isolation, migrations, and concurrent rollback behavior. Live model investigation, independent review, and the comparison UI are next. The broader [project plan](PROJECT_BRIEF.md) describes future work.

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

`pnpm build:agent` builds without credentials or model calls. `pnpm --filter my-agent dev` opens eve's terminal interface and requires a model connection for conversations. The logs CLI does not start eve or contact a model. Automated trial-to-session setup is not implemented yet.

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
| `my-agent/` | Eve configuration, instructions, HTTP tool, and client tests. |
| `scripts/` | Logs demonstration and HTTP checks. |

Local credentials, build output, research artifacts, and personal session notes are gitignored.
