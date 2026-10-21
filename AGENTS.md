<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

Before planning a substantial feature, adding a dependency or service, or preparing
a milestone PR, read [docs/PROJECT_DIRECTION.md](docs/PROJECT_DIRECTION.md) and
apply its direction check. Revisit it when scope becomes unclear; routine edits
within an agreed step do not need a separate review.

After each completed implementation step, remind the user about a commit/PR
checkpoint. Commit, push, open a PR, or merge when the user authorizes that action.

Personal teaching notes may exist in the gitignored `docs/SESSION_CONTEXT.md`.
When that local file exists, apply this instruction:

At the start of every session and after every context compaction, read docs/SESSION_CONTEXT.md and follow the 'How I like explanations' section.
