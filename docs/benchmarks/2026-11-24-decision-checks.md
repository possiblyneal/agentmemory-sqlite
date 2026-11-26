# Advisory checks for project decisions (#565)

Baseline `563b88f7`. Both arms use production startup Rule Injection over the same seven synthetic patch fixtures and a 400-token request budget. The baseline adds no automatic patch advisory; the treatment matches the visible Rule text to hand-written checks over before/after file contents. It never evaluates Memory text as code. Freeze the bar at at least one additional true warning and zero false warnings on correct changes. No model or repository holdout was used.

| Metric | Ordinary Injection | Plus advisory checks |
|---|---:|---:|
| Known violations flagged | 0 of 4 | 3 of 4 |
| Correct patches warned on | 0 of 3 | 0 of 3 |
| Rules with executable coverage | 0 of 3 | 2 of 3 |

Two checks were authored and one required an edit when its Rule changed. Refusing the stale check avoided an incorrect warning but left the amended violation unflagged until the mapping was maintained. The unsupported qualitative Rule had no check. No Operator time or effect on Agent decisions was measured; baseline zero is absence of an automatic warning, not a failure of an Agent to notice the Rule.

**Verdict: inconclusive for real patches.** The synthetic screen passed. Retry with independent patches and blind Agent review under both arms, plus time spent authoring and maintaining checks as real Rules change.

Reproduce with `npx tsx eval/runner/decision-checks.ts`; verify with `npx vitest run test/eval-decision-checks.test.ts`.
