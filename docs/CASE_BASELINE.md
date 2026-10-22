# Case outcome baseline

Observed October 21, 2026 (America/Los_Angeles). Implemented and exercised locally; not committed or deployed.

One real investigation per development case, run individually with fresh trials and sessions. The first three used the CLI; `no-logs` used the web launch dialog and local worker. All targeted deployment B with the same neutral task. No investigation was retried. The reviewer ran once, separately, against the recovered-startup answer.

Investigator: `openai/gpt-6-luna-fast`, reasoning `high`. Instructions SHA-256: `c7d203bd2fa14cfc72f19389b136990295b938584f20bd961937c0b9477f771a`. All case versions: 1. Answer schema: 2. Outcome evaluator: `outcome-v1`.

| Case | Saved run | Execution | Outcome | Input / output tokens | Reported USD |
| --- | --- | --- | --- | --- | --- |
| `missing-config` | `11d246f0-4a51-47c8-96aa-9dd52e1e86fc` | completed | pass | 5510 / 188 | $0.00095225 |
| `healthy-startup` | `d7066b3f-ef31-44ba-a30a-a1d834696a01` | completed | pass | 5521 / 251 | $0.00040505 |
| `recovered-startup` | `d415c528-8d21-4d60-b433-5baadabbf12e` | completed | pass | 5623 / 351 | $0.00053055 |
| `no-logs` | `91d0f38e-77df-4672-aa29-60b9bb3f6164` | completed | pass | 5370 / 141 | $0.00025730 |

The missing-config answer identified `DATABASE_URL`; healthy-startup identified successful startup; recovered-startup identified the earlier blocker and subsequent recovery, citing both decisive records; no-logs returned unknown state/cause and no citations after a successful empty tool response.

Separate review: `366579e1-88df-4c1d-9353-d847609fdcb0` of run `d415c528-8d21-4d60-b433-5baadabbf12e`. Reviewer `openai/gpt-6.1-sol` completed and judged the diagnosis and uncertainty claims supported. It requested later monitoring to establish ongoing health. Reported usage: 933 input and 702 output tokens; $0.008886.

Total reported model cost: **$0.01103115**. Costs are the saved provider/runtime reports, include cache effects, and are not a pricing estimate. Local compute cost is not measured.

These four observations establish a starting record, not a reliable performance percentage, reviewer accuracy measurement, or improvement over another agent version. The fixtures are authored simulations, and outcome checks assess structured claims; prose quality remains the separate reviewer's judgment.

All original events, case/expectation snapshots, reports, answers, usage, and review input/output remain in PostgreSQL. Full exports and execution logs are also saved locally under `.context/case-baseline/` (gitignored). Read without model work:

```sh
pnpm lab run <run-id> --json
pnpm lab evaluate <run-id> --json
pnpm lab review 366579e1-88df-4c1d-9353-d847609fdcb0 --json
```

Verification covers four correct outcomes, wrong cause with valid citations, ignored recovery, empty logs declared healthy, unjustified unknown, absent/foreign/late evidence, malformed answers, cancellation, failed retrieval, request isolation, migration from 005 with saved legacy records, immutable assessments, case selection, visible failures, citation navigation, and refresh without model work.

A browser regression exposed an inaccessible unavailable-citation label, which was restored. A timing-sensitive scroll test now waits for citation focus, which occurs after its scheduled reveal, before measuring independent scrolling. A test run overlapping live model execution correctly encountered the execution lock; final checks run after model execution is idle.

Final verification on October 21, 2026: 137 unit/integration tests, 11 API tests plus HTTP rollback/token-scope smoke checks, 17 browser tests, all workspace types, ESLint, Next.js production build, Eve build, and `git diff --check` passed. Real saved-run inspection covered desktop light/dark, mobile, and the evidence drawer, with zero additional model submissions. All four baseline investigations and the one review completed; no failed live attempt was discarded.
