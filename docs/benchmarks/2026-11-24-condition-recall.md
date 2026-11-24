# Recall failed approaches by condition (#568)

Baseline `3d739d2d`. Both arms use the same two scoped synthetic Semantic Fact hits from production Recall for the same symptom. The baseline warns about the top hit; the treatment warns about the highest hit whose supplied failure condition matches the current incident. Each arm has one warning slot. A scripted reader starts with its proposed fix and switches to the other fix only when warned about the proposed one. Require fewer repeats when the condition still applies, no additional avoidance of valid fixes after a change, and no new error in the missing-condition control. No Agent or repository holdout was used.

| Measure | Top hit | Condition match |
|---|---:|---:|
| Repeated dead ends where condition known to persist | 1 of 2 | 0 of 2 |
| Valid fix avoided after condition changed | 1 of 1 | 0 of 1 |
| Repeated dead end when condition was unavailable | 0 of 1 | 1 of 1 |
| Correct proxy actions | 2 of 4 | 3 of 4 |

Two paired gains, one loss and one tie. The loss occurred because the applicable condition was unavailable, so the prototype gave no warning. Conditions and candidate actions were fixture labels, not extracted from traces.

**Verdict: rejected.** The known-condition gain did not survive the missing-condition guard. Retry with independently diagnosed historical incidents and a fallback that reports uncertainty without hiding the relevant warning or blocking a now-valid fix.

Reproduce with `npx tsx eval/runner/condition-recall.ts`; verify with `npx vitest run test/eval-condition-recall.test.ts`.
