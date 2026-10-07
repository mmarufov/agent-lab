# Agent Lab

A testing and improvement workbench for AI agents.

Agent Lab is designed to run an agent against realistic operational failures, capture what actually happened, let a coding agent propose changes, and independently evaluate whether those changes improve behavior. Its central question is: **Does this change make my agent better, and should I ship it?**

The intended first release combines controlled stateful experiments, bounded repair attempts, and an evidence report showing code changes, outcomes, regressions, latency, and cost. Vercel's AI SDK, Sandbox, Workflow, and AI Gateway are the proposed infrastructure, with Next.js providing the experiment interface.

[Project idea, scope, Vercel connection, and broader usefulness](PROJECT_BRIEF.md)

**Status:** project definition and starter scaffolding. The Agent Lab experiment engine and measured results are not implemented yet.
