# Agent Lab

Roadmap, originally written October 6, 2026. The repository now implements the local deployment simulation, saved-log retrieval, a live eve investigation CLI, PostgreSQL run records, a deterministic citation checker, and a separate persisted model review. Tests cover infrastructure, persistence, stream handling, evidence matching, and review boundaries. A UI, agent comparisons, and measured reviewer effectiveness remain planned. The broader product behavior and benchmark results described below are proposals, not measured outcomes. See the [README](README.md) for the runnable checkpoint.

## The idea

**Agent Lab is a testing and improvement workbench that helps developers decide whether an agent upgrade deserves to ship.**

It takes an actual agent implementation, a controlled task environment, and explicit definitions of success. It exposes the agent to realistic failures, records the resulting behavior, gives a coding agent evidence for a proposed repair, and independently tests the changed implementation. The output is a reviewable candidate with evidence for accepting or rejecting it.

The central question is: **Does this change actually make my agent better, and should I ship it?**

## The problem

An agent can sound confident while leaving the underlying system in the wrong state. A tool can succeed while its response disappears. An observation can become stale while the agent is reasoning. A duplicated event can initiate redundant work. A recovery strategy can fix one case while breaking another.

Persisting execution and retrying failed work do not, by themselves, establish that the agent's actions were correct. Developers need a way to reproduce failures, understand what happened, and distinguish a useful repair from an appealing explanation or a lucky run.

Agent Lab's intended impact is fewer broken agent releases and less manual work reproducing incidents and checking proposed fixes. Those benefits remain hypotheses until demonstrated.

## The product experience

An experiment starts with a specific agent revision and a known environment state. The controller introduces a defined fault at a known point in a tool operation. Independent checks compare the actual actions and resulting state with the task's requirements.

A separate repair agent receives permitted source files, the tool contract, the relevant event trace, and the failure evidence. It proposes a bounded change to code or instructions. Candidate implementations run from equivalent fresh fixtures, including cases that were not available during repair generation.

The comparison interface presents the source diff, state changes, failure explanation, task outcomes, regressions, latency, and cost. Rejected candidates remain visible with their reasons. A human decides whether to release the tested revision. An experiment that finds no acceptable repair is a valid outcome.

## The flagship demonstration

The initial demonstration concept is a deployment-operations agent acting on a small, controlled service with real HTTP endpoints and a database. Its deployments and incidents are simulated and clearly identified as such.

An agent investigates a failing deployment. While it is working, another actor makes a newer healthy deployment current. Acting on its earlier observation could replace that healthy deployment. Agent Lab would expose the mistake through the service's action history and state, then evaluate a proposed repair using the tool API's supported checks and revision preconditions.

The memorable result would be a concrete failure, a rejected inadequate repair, and an accepted change that also works on unseen cases with the same underlying model. A candidate that refuses every action would fail cases that require intervention. A confident success message would fail when the required state change did not occur.

The exact target agent and a meaningful baseline failure are still unvalidated. This scenario is a product concept, not a claim that Vercel's production agent has this bug. Repeated calls are only failures when their effects violate the actual tool contract.

## What the system contains

| Component | Responsibility |
| --- | --- |
| Agent under test | Executes the task using the candidate's code and permitted tools in isolation. |
| Repair agent | Proposes changes to allowed source files using development failure evidence. |
| Trusted controller and verifier | Owns fixtures, fault schedules, service state, action history, budgets, hidden cases, and verdicts outside both agents' writable environments. |
| Experiment store | Records code, environment, evaluator, and model versions alongside outcomes and usage. |
| Comparison interface | Makes the behavioral change and the evidence behind a release decision inspectable. |

Correctness comes from human-authored executable task contracts covering both action history and final state. An optional model judge could assess qualitative output, but could not override a failed state check. The agent is not assumed to reliably recognize or grade all its own mistakes.

The first fault classes are refusal before an operation commits, a lost response after a committed operation, stale observations caused by concurrent changes, and duplicate incoming events.

## The connection to Vercel

Vercel's public [agentic infrastructure strategy](https://vercel.com/blog/agentic-infrastructure) includes running agents and using agents to operate software. Agent Lab addresses the related release question: how a developer can establish that a proposed behavioral change improves an agent before depending on it.

Vercel already discusses [agent evaluations and production-like validation](https://vercel.com/i/ai-agent-evaluation-frameworks-production), and [eve already has evaluation capabilities](https://github.com/vercel/eve/blob/main/docs/evals/overview.mdx). Agent Lab's proposed contribution is a complete, inspectable experiment around operational state: controlled failure, authoritative evidence, source repair, and independent comparison. Its value depends on the implementation and measured usefulness, not an assertion that this category is new or missing inside Vercel.

| Proposed technology | Role in Agent Lab |
| --- | --- |
| TypeScript and AI SDK | The first supported agent interface and model/tool execution boundary. |
| Vercel Sandbox | Isolated execution of agent versions and repair candidates. |
| Vercel Workflow | Persistent orchestration of experiments, retries, and review pauses. |
| AI Gateway | Model access and usage accounting. |
| Next.js | Experiment reports, progress, and code/state comparisons. |
| Trusted database | Experiment records and controlled service state. |

The current agent package uses eve and registers the log-retrieval tool. Real model investigations of simulated deployments and their evidence are saved; citation checks can be run without another model call. A separate Gateway request produces an advisory claim review and records its input, configuration, usage, and outcome. Comparing agent versions and measuring assessment accuracy remain future work. The implementation does not depend on unmerged eve proposals.

Vercel's [intern retrospective](https://vercel.com/blog/inside-the-vercel-intern-experience) provides relevant engineering patterns: Kevin Thomas's measured model-routing experiments, Kavin Valli's sandbox and agent lifecycle work, and Mingchung Xia's consistency mechanisms. Agent Lab combines experiment design, execution infrastructure, and state correctness in a developer-facing product. The interview value would come from explaining those mechanisms and their observed tradeoffs in detail.

## Evidence of improvement

The proposed comparison includes the original agent, a straightforward retry strategy, a reasonable manually engineered repair, and the selected automatic repair. Primary comparisons keep the underlying model and settings fixed. Repeated fresh runs account for model variation.

A provisional benchmark consists of 50 scenarios split into 20 development, 10 validation, and 20 final held-out cases. Five repetitions of the final cases across four implementations would produce 400 trials. Final cases remain outside repair generation and selection.

The report would show completion, state/history violations, abstentions, consistency across repeated runs, latency, and total cost per correct completion. Failed attempts and repair/evaluation overhead count toward cost. This would be a custom operational reliability benchmark with disclosed simulation boundaries.

One research question is whether authoritative state differences and action traces help a repair agent produce more generalizable fixes than an error message alone, under the same budget. No improvement rate has been established.

## Usefulness beyond Vercel

The same release decision matters to companies building support agents, incident-response agents, data agents, and other software that changes external state. A developer could compare a prompt, tool implementation, orchestration change, or model configuration before releasing it.

The intended standalone product is an agent testing workbench with a reusable adapter and environment interface. The first version supports one agent interface and one task environment; each additional domain requires suitable tool semantics and explicit correctness contracts.

## First-release scope and open boundaries

The roughly twenty-day target is a complete, bounded experiment loop: one TypeScript agent interface, one stateful environment, four fault classes, at most three repair candidates per failure initially, independent checks, cost limits, and an inspectable results interface. Automatic failure minimization, broad framework support, arbitrary live-session recovery, multi-tenant billing, and autonomous production releases are possible later directions.

Interrupted trials can restart from clean fixtures while completed results retain stable identities. Sandbox filesystem snapshots do not restore arbitrary process memory or external database state. Repairs involving idempotency or atomic revision checks depend on actual tool support; an unknown external outcome may require escalation. Changing agent code does not undo an external action, and this project does not train model weights.

The earlier development and evaluation budget estimate was $150-$300 under modest model and runtime assumptions. It is a planning estimate, not measured spend. The main unresolved question is whether the workbench can produce useful repairs that generalize at a worthwhile total cost.
