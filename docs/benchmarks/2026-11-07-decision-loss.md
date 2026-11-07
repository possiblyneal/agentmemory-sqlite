# 2026-11-07 — Where key decisions are lost between the Session and the Injection

**Commit:** main `4fb24627` (arms), `03a66e74` (fold-drift)
**Bench:** greedy `eval:replay --llm-summary --decision-key` over the frozen corpus (21 project
directories, 41 Sessions, `--cap 40 --min-turns 2`, dev split); `eval:fold-drift --batch 20`
**N:** 451 key items (decision, turn), 262 reachable
**LLM:** local broker, `general-eval-b` profile, greedy decoding; same model judges
**Embeddings:** on-device

## Headline

Most decisions the Agent was not shown never made it into any Session Summary. Of the 63
distinct key decisions missing from main's Summaries, 47 (75%) are in neither a fresh
one-pass Summary nor a fresh folded one. Folding is a minor cause (8 of 63), and carrying
decisions forward (#335, #336) made delivery worse. The next lever is capture, not fold or
render order.

## Arms: carrying decisions forward

| | main | #335 alone | #335 + #336 |
|---|---|---|---|
| decisionRecall either | **57 / 451** | 34 / 451 | 42 / 451 |
| sessionStart | 41 | 23 | 30 |
| promptSubmit | 17 | 11 | 12 |
| used share of injected items | 12.3% | 9.4% | 8.3% |
| injected chars per used item | 7,391 | 11,014 | 12,124 |
| prompt-context p99 | 559 ms | 2,310 ms | 3,562 ms |
| folds / full re-summaries | 231 / 198 | — | 309 / 120 |

- main vs #335, paired by (decision, turn): both 28, main only 29, #335 only 6; exact McNemar
  p = 2×10⁻⁵. main vs #335 + #336: main only 25, other only 13; p = 0.07.
- #336's session-start orderings all scored below main's 41: newest 24, oldest 29, model 30,
  match 18.
- Carried Summaries averaged ~68 decisions, and the first 10 rendered were the oldest.
- The p99 numbers were measured beside the live daemon's compression drain; #335 does not touch
  Injection, so treat them as contention.

## Attribution of main's misses

Per key item, the origin Session's Summary as it stood in the checkpoint it was probed from,
judged in full and then as its first 10 decisions (the render cap):

| Where | Items | Delivered |
|---|---|---|
| origin Session outside the replay corpus (unreachable) | 189 | 0 |
| not in the Summary | 140 | 9 |
| in the Summary, beyond the first 10 | 53 | 6 |
| in the first 10 | 69 | 42 |

Even a decision in the first 10 is delivered only 61% of the time (42 of 69).

## Capture versus fold

`eval:fold-drift` re-summarized the 18 origin Sessions of the not-in-Summary items, once in one
pass and once folded in batches of 20 Observations:

| Session | Obs | One-pass decisions | Folded decisions | Folds | Fallbacks | Dropped by folds | Dropped by fallbacks |
|---|---|---|---|---|---|---|---|
| `1fd1860c` | 406 | 7 | 44 | 12 | 8 | 75 | 83 |
| `2527e970` | 118 | 17 | 5 | 4 | 1 | 10 | 2 |
| `2cb8020e` | 162 | 15 | 16 | 7 | 1 | 27 | 7 |
| `2fe6f95c` | 460 | 28 | 4 | 15 | 7 | 111 | 196 |
| `6b43c728` | 155 | 8 | 16 | 4 | 3 | 24 | 13 |
| `6ebbbf8d` | 133 | 13 | 3 | 6 | 0 | 34 | 0 |
| `77ba5c04` | 306 | 2 | 5 | 12 | 3 | 82 | 19 |
| `79655cb7` | 390 | 9 | 3 | 15 | 4 | 119 | 58 |
| `877f2f5e` | 116 | 8 | 12 | 3 | 2 | 11 | 6 |
| `879ca29e` | 164 | 23 | 16 | 6 | 2 | 36 | 80 |
| `9223573e` | 299 | 42 | 22 | 7 | 7 | 50 | 72 |
| `a9d0e774` | 112 | 23 | 21 | 1 | 4 | 3 | 36 |
| `b2d29541` | 227 | 7 | 3 | 10 | 1 | 46 | 3 |
| `bfad4fcc` | 220 | 37 | 6 | 8 | 2 | 32 | 17 |
| `e7506630` | 74 | 14 | 14 | 3 | 0 | 5 | 0 |
| `e77455c2` | 655 | 3 | 2 | 23 | 9 | 101 | 82 |
| `f2b3c475` | 231 | 28 | 6 | 6 | 5 | 38 | 99 |
| `f3e72519` | 447 | 13 | 9 | 14 | 8 | 65 | 73 |
| **total** | 4,675 | 297 | 207 | 136 | 54 | 869 | 846 |

Dropped counts use word-set Jaccard ≥ 0.5 between a list and its next version. fold-drift's
`missing` column equals the one-pass count on every Session, because independently written lists
never match lexically; it is not reported (#349).

The 140 not-in-Summary items are 63 distinct decisions. Judged against the fresh Summaries:

| In one-pass | In folded | Decisions | Reading |
|---|---|---|---|
| no | no | **47** | never captured |
| yes | no | 8 | lost by folding |
| no | yes | 4 | captured only when folded |
| yes | yes | 4 | captured on this run, not in the checkpoint's Summary (run variance) |

## Methodology

- Arms: each built at its ref; `--save-checkpoints` import with the supervisor resuming after a
  broker restart (Session 37 rerun from checkpoint 36; every arm 0 failed summarize calls), then
  `--from-checkpoints --decision-key` probe. One frozen key, one verdict cache.
- Attribution and the capture split are scratch scripts in the session folder; #348 and #349 make
  them runners.
- Reachability: 8 origin Sessions are outside the frozen corpus (#350). Since this change,
  `decisionRecall` counts them as `unreachable` and leaves them out of the shares.

## Reproduce

```sh
npm run eval:replay -- --projects=<frozen list> --cap 40 --min-turns 2 --llm-summary --save-checkpoints --out <arm>
npm run eval:replay -- --projects=<frozen list> --cap 40 --min-turns 2 --from-checkpoints <arm>/checkpoints --decision-key
npm run eval:fold-drift -- --store <arm>/checkpoints/040-*.sqlite --sessions <18 ids> --batch 20
```

## Notes

- A one-pass Summary keeps very few decisions on long Sessions: 3 from 655 Observations
  (`e77455c2`), 2 from 306 (`77ba5c04`).
- 54 of 190 fold calls (28%) failed and fell back to a full re-summarize, and fallbacks dropped
  about as many decisions (846) as successful folds (869).
- The model sometimes closes a `<decision>` with a wrong tag (`</div>`, `</divided>`,
  `</definition>`); `getXmlChildren` then merges two decisions into one (3 of 504 decisions here).
