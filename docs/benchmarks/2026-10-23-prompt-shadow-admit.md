# 2026-10-23 — Admit a below-floor shadowing Memory at prompt submit (#296)

**Commit:** before `2591b079` (main); after `3de47ec` (on `2591b079`); the review fixes after it change only which left-out Memory is admitted and where, which no eval reaches
**Bench:** supersession, dev split (`runner/supersession.ts`); `eval:suite --tier fast` (coding-life, PrecisionMemBench, LongMemEval sample); `eval:gate`
**N:** supersession 110 cases (5 per cell); suite as listed below
**K:** 5 (search); an Injection is scored whole
**Hardware:** Linux 6.12, 8 cores, Node 22.23.2
**Embeddings:** none for supersession and the gate; the suite's own defaults otherwise
**LLM:** none

## Headline

Adopted. T4 in `test/supersession.test.ts` flips from `it.fails` to `it`: the newer, differently worded Memory is now given above the stale one. No supersession cell moves, all 15 fast-suite metrics are identical to the baseline, and `eval:gate` passes unchanged (prompt-submit precision 0.889, p95 12 ms session start / 24 ms prompt submit against the 500 ms ceiling).

## Lever

`mem::prompt-context` reordered only the Memory hits that passed its floor and the gate, so a newer Memory that contradicts a passed one in other words, and scores below the floor, was never given. `withShadowingMemories` (`src/functions/prompt-context.ts`) now runs `shadowedMemoryIds` over the passed Memory hits plus every Memory hit the floor or gate left out, injected ones included. A left-out Memory that is the newest shadower of a passed one, is shadowed by none, and was not injected earlier this Session is admitted directly above the first passed Memory it shadows, skips the gate, and counts toward the 3 results. When no Memory passed, nothing extra is loaded.

## Supersession

| Kind | Variant | Surface | Before | After | docs/supersession.md |
|---|---|---|---|---|---|
| Memory | contradicted | prompt-submit | 0.00 | 0.00 | T4 |
| Observation | stale matches more | search | 0.80 | 0.80 | T21 (#295) |

Every other cell is 0.00 before and after. The bench's contradicted Memory pairs already pass the prompt-submit floor at baseline (5/5 fresh-first), so the cell cannot show this lever; T4's low-overlap fixture is the only case where the newer Memory falls below the floor, and it is covered by the unit test alone.

## Fast suite (`--against 2591b079`)

| Metric | Before | After |
|---|---|---|
| coding-life search recall / precision / hit | 1.000 / 0.708 / 0.833 | same |
| coding-life session-start recall / precision / hit | 0.625 / 1.000 / 1.000 | same |
| coding-life prompt-submit recall / precision / hit | 0.861 / 1.000 / 1.000 | same |
| PMB pass / activePass / precision / recall | 0.447 / 0.391 / 0.440 / 0.942 | same |
| LongMemEval recall@5 / hit | 0.896 / 0.958 | same |

All Δ 0.000.

## Gate

| Path | recall | precision | no-answer clean | p95 |
|---|---|---|---|---|
| search | 0.969 | 0.704 | 0.250 | — |
| session-start | 0.813 | 1.000 | 1.000 | 12 ms |
| prompt-submit | 0.907 | 0.889 | 0.833 | 24 ms |

Every metric equals its floor in `eval/baselines/coding-agent-life-v2.json` (Δ 0.000).

## Methodology

As in `eval/README.md`: dev split only (holdout not opened), BM25-only supersession on instance 33, the gate on instance 43, the fast suite on its default instances under the shared lock with the baseline labelled `2591b079`.

## Reproduce

```sh
git checkout 3de47ec
npm ci && npm run build
npm run eval:supersession -- --instance 33
LONGMEMEVAL_PATH=~/datasets/longmemeval/longmemeval_s.json npm run eval:suite -- --tier fast --label <label> --against 2591b079
npm run eval:gate -- --instance 43
```

## Notes

- No eval exercises the admission path: neither coding-life nor the supersession bench has a passed Memory shadowed by a below-floor one. The unchanged numbers show the lever costs nothing where it does not fire, not that it helps at scale. A misfiring shadow test (two unrelated Memories sharing 2 distinctive terms) would now add a below-floor Memory to the Injection.
- The reranker gate is off in every run here, as in CI; an admitted Memory skips it in production too.
