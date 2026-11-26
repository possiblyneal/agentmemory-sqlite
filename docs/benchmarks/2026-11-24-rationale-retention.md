# Retaining rationale beyond the checkout (#567)

Baseline `33194776`. The three arms share the immutable synthetic checkout fixture in the runner and the same five questions. Checkout-only has no notes; full has all fixture notes; rationale-only keeps only reasons for decisions unavailable in the checkout. The scripted reader tries an exact Memory key before looking in the checkout. Before scoring, require equal correctness, fewer serialized Memory bytes, and no additional logical checkout reads or commands versus full. This uses neither the production ranker nor the repository holdout.

| Measure | Checkout only | Full notes | Rationale only |
|---|---:|---:|---:|
| Correct action or deferral | 3 of 5 | 5 of 5 | 5 of 5 |
| Logical checkout reads | 5 | 1 | 3 |
| Commands | 0 | 0 | 0 |
| Serialized note bytes | — | 298 | 228 |

Rationale-only tied full on every task and beat checkout alone on two decisions. Removing the two checkout-recoverable notes added two logical reads. The runner records elapsed synchronous lookup time, but it only reads in-memory strings, and neither Agent time nor physical IO was measured.

**Verdict: rejected on the frozen proxy criterion.** The smaller note set transferred work into checkout reads. Retry when an independent coding task cohort and blind action scoring can measure whether the Agent already has the relevant file in context, and can charge actual tool-call and Agent time.

Reproduce with `npx tsx eval/runner/rationale-retention.ts`; verify with `npx vitest run test/eval-rationale-retention.test.ts`.
