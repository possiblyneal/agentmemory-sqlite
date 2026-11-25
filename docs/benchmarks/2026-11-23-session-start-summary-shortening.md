# Session-start Summary shortening (#532)

## Verdict

**Inconclusive for real usage; do not adopt the tested treatment.** The reported synthetic screen gained a needed decision but lost a needed file name, failing its zero-file-loss criterion. It does not estimate the effect on a representative cohort.

## Method and reported results

The research scorecard reports a paired deterministic screen of five synthetic in-memory checkpoints against baseline `12d2abbcad84f39fdedb99f256acac6c9738b78d`. The treatment omitted narrative and files from Summary blocks with decisions; both arms used a 180-token budget. Needs were scored in visible Injection text, not Summary references. The screen did not use a live store, model, private labels or holdout.

| Needed item | Total | Baseline | Treatment | Gained | Lost |
|---|---:|---:|---:|---:|---:|
| Decisions | 3 | 2 | 3 | 1 | 0 |
| File names | 2 | 1 | 0 | 0 | 1 |

The source scorecard reports that the matching real replay cohort, decision key and verdict cache were unavailable. It does not measure downstream task correctness, typical budgets, latency or real Operator needs. Retry with a matched checkpoint set, decision key and offline judgments, or a candidate preserving needed file names; prespecify a practical threshold and use the normal dev/holdout process.

## Provenance and limits

These are reported aggregates, not a new run. The source scorecard, synthetic runner and matching test assertions are recorded in local research commit `7daf45027c69a5e12f938c0b6704a14ac32f3c76`; the test asserts the same counts and the runner defines the paired synthetic cases and visible-text scoring. They were inspected but not executed for this preservation. Neither the runner nor private experiment records are included in this candidate.
