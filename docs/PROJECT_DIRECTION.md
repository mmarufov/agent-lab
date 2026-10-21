# Agent Lab direction

Agent Lab helps a developer decide whether a specific change to an agent's
instructions, tools, or model settings improves its behavior. Use controlled
deployment scenarios, recorded tool evidence, and independent checks to explain
the result. The developer should understand and be able to reproduce the work.

This file sets current priorities. [PROJECT_BRIEF.md](../PROJECT_BRIEF.md) contains
broader possibilities; it is not a requirement to implement all of them. Check
the current source and results before treating any planned capability as built.

## Direction check

Before a substantial feature, new dependency/service, or milestone PR, answer:

1. **Problem:** What concrete difficulty does this solve, and for whom?
2. **Evidence:** What observable result would show success or failure? For an
   agent comparison, name the baseline, the one intended change, and the cases.
3. **Judgment:** What existing Eve or other installed capability can we reuse?
   Explain the simplest useful approach and its main tradeoff.
4. **Scope:** Does this advance the next complete demo within the available time
   and cost? Necessary infrastructure can support a milestone without being a
   standalone showcase feature. Defer additions without a clear purpose.
5. **Understanding:** Can the developer explain the callers, runtime, data flow,
   implementation choice, and verification? Teach one concrete step at a time.

Summarize the problem, change, evidence, and tradeoff briefly in chat before
meaningful implementation. Afterward, report the actual result and limitations.
Use this to choose build now, defer, or drop; it is not an extra approval gate for
already-authorized work. Small edits within an agreed step need no new review.

Credible technical discussion comes from decisions, reproducible findings,
tradeoffs, and understanding. Do not predict an individual's interview reaction
or add tools solely for their name. Keep implemented, tested, measured, and
deployed claims distinct. An unsuccessful experiment can still be useful.

## First demo and next comparison

The immediate schedule and acceptance checks are in
[DEMO_ROADMAP.md](DEMO_ROADMAP.md). That roadmap distinguishes improving the
investigator from repairing the investigated application; confirm which change
is being evaluated before expanding the implementation.

Build the loop in small working steps:

1. Run a real Eve investigator through AI Gateway against a fresh simulated trial.
2. Record requested tools, returned evidence, final answer, and available usage.
3. Check evidence IDs and task outcomes with executable checks; use a separate
   model review for qualitative support and uncertainty. A reviewer's verdict
   does not replace the known case and actual tool records.
4. Show the investigation and checks in a small UI that makes failures visible.
5. Compare the baseline with one purposeful change on equivalent fresh cases.
   Keep the model fixed when comparing instructions or tools, disclose repeated
   runs and sample size, and report regressions as well as improvements.

Include cases beyond the obvious missing-configuration error, such as healthy
deployments, empty logs, and failed retrieval. Keep the cause in the fixture
evidence, not in the agent's instructions. Do not weaken a baseline to manufacture
an improvement. Add routing, generated code, or automated repairs when a measured
question justifies them.

## Later: focused security review with DeepSec

DeepSec is a candidate development-time security review tool, not part of the
investigator's runtime. It is deferred for the first local investigation step.
Revisit it when the live agent and UI introduce session access, browser
authentication, or additional tools, and when planning a hosted demo.

There is already meaningful code to inspect: trial-token authentication,
cross-trial record access, and the HTTP tool boundary. Keep checking those during
normal development. Later review targets include run/session ownership,
credential exposure, and any added code-execution capabilities. Malicious log
content also needs behavioral evaluation; source scanning alone cannot establish
resistance to prompt injection.

When scheduling DeepSec, select the source scope, model route, and a small time
and cost budget. Read its current documentation first: normal initialization can
proceed directly into AI review. Keep generated findings and credentials out of
the application source. Reproduce findings, identify false positives or intended
simulation behavior, fix confirmed issues, and add regression tests. A clean scan
is evidence about that review's coverage, not proof that the app is secure.

Useful evidence to discuss: the affected boundary, reproducible behavior, the fix,
and the test that prevents recurrence. Record no finding as confirmed without
checking it, and never invent a vulnerability for a demonstration.

Sources checked October 20, 2026:
- [DeepSec getting started](https://deepsec.sh/docs/getting-started)
- [Vercel's introduction to DeepSec](https://vercel.com/blog/introducing-deepsec-find-and-fix-vulnerabilities-in-your-code-base)
