# 2026-11-07 — Where key decisions are lost between the Session and the Injection

**Commit:** main `4fb24627` (arms), `03a66e74` (fold-drift)
**Bench:** greedy `eval:replay --llm-summary --decision-key` over the frozen corpus (21 project
directories, 41 Sessions, `--cap 40 --min-turns 2`, dev split); `eval:fold-drift --batch 20`
**N:** 451 key items (decision, turn), 262 reachable
**LLM:** local broker, `general-eval-b` profile, greedy decoding; same model judges
**Embeddings:** on-device
**Hardware:** not reported; the bench is LLM-bound and measures recall, not latency

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
  p = 1.2×10⁻⁴. main vs #335 + #336: main only 25, other only 13; p = 0.07.
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

### The 27 in-first-10 items not delivered

main's decision-key probe was rerun on its checkpoints for the 6 Sessions that carry them, and
every Injection text was matched by hash to its cached verdict, so no judge call was made. No
item was lost to decision cutting (`cutDecision()`) or to a judge disagreement:

| Surface | Cause | Items |
|---|---|---|
| session start | the Summary fell outside the 2000-token budget; Insights (1.1–2.1k chars) and Semantic Facts (0.5–0.9k) render before Summaries | 24 |
| session start | origin Session outside the 10 newest | 3 |
| prompt submit | Summary already injected intact at an earlier turn of the same Session, which the same-turn probe did not credit (since #358, `promptSubmitByTurn` does) | 19 |
| prompt submit | never in the top 3 on a vague prompt | 8 |

The reranker gate was off in the sandbox (`AGENTMEMORY_PROMPT_RERANK=off`).

### Summaries first at session start (2026-11-10)

Session start re-rendered at budget 2000 on all 24 checkpoints with Session Summaries given budget
before Insights and Semantic Facts (pinned slots, Rules and Lessons unchanged). The baseline
render matched the probe's Injection text byte for byte for the 6 Sessions that carry the 27. An
item counts as present when its Summary's whole `Decisions:` line appears; a Summary block renders
whole or not at all. No LLM call.

| | main | Summaries first |
|---|---|---|
| of the 24 cut by the budget, delivered | 0 | 3 |
| Summaries rendered (24 probe points) | 43 | 65 |
| Insights rendered | 73 | 3 |
| Semantic Facts rendered | 75 | 5 |
| delivered decisions that relied on a dropped Insight or Fact | — | 2 of 41 |

A Summary block is about 600 tokens, so 2000 tokens hold 2 to 5 of them; the origin Sessions of
the missed items rank 3 to 8 by recency and still fall off.

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
npm run eval:replay -- --projects=<frozen list> --cap 40 --min-turns 2 --llm-summary --decision-key --save-checkpoints --out <arm>
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
