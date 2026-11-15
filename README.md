# Agent Lab

A workbench for testing AI agents against controlled operational failures. The goal is to help developers decide whether a change to an agent (its instructions, tools, or model settings) actually improves its behavior.

> **Status:** early prototype under active development. It runs locally only, includes one real-application failure scenario, and does not yet compare agent versions. Expect breaking changes.

## What works today

- **Capture:** run a sandboxed copy of the [Daily](https://github.com/mmarufov/Daily) backend, stop its database, and record what the API returned and logged.
- **Investigate:** an [Eve](https://eve.dev) agent diagnoses the recording through two read-only tools scoped to it.
- **Check:** verify that every citation was actually retrieved, measure which key facts the agent found, and optionally ask a separate model to review the answer.
- **Inspect:** launch runs and inspect their evidence and checks in a local Next.js workbench backed by PostgreSQL.

## Getting started

Requires pnpm 12.9 and Docker. pnpm provides the project's Node 24 runtime.

```sh
pnpm install --frozen-lockfile
test -f .env.local || cp .env.example .env.local
pnpm db:up     # PostgreSQL in Docker
pnpm dev:lab   # migrations, Next.js, and a local worker
```

Open http://127.0.0.1:3000/runs. To record an outage, run `pnpm daily:up`, then `pnpm daily:capture`.

Investigations and reviews make real model calls through [AI Gateway](https://vercel.com/docs/ai-gateway). Set up Eve's connection with `pnpm --filter my-agent dev`, and add the reviewer key to `.env.local` (see `.env.example`). Viewing saved runs makes no model calls.

## Development

```sh
pnpm test        # requires PostgreSQL
pnpm typecheck
pnpm lint
```

No test calls a model provider.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/` | Next.js workbench and evidence endpoints |
| `my-agent/` | Eve investigator agent, tools, and evals |
| `packages/lab/` | Migrations, checks, job queue, and the `lab` CLI |
| `packages/contracts/` | Shared Zod schemas |
| `scenarios/daily/` | Daily sandbox configuration and seed data |
| `scripts/` | CLIs, worker, and sandbox controller |

The longer-term plan is in [PROJECT_BRIEF.md](PROJECT_BRIEF.md).
