# 2026-10-23 — Observation near-twin cap in smart-search (#295)

**Commit:** before `2591b079` (main); after `5a386bc` (supersession, suite and gate); the review fix that pairs only one project's Observations follows it, and its reruns match every number below except the gate p95, now 12 ms (session start) and 16 ms (prompt submit)
**Bench:** supersession, dev split (`runner/supersession.ts`); `eval:suite --tier fast` (coding-life, PrecisionMemBench, LongMemEval sample); `eval:gate`
**N:** supersession 110 cases (5 per Observation cell); suite as listed below
**K:** 5 (search); an Injection is scored whole
**Hardware:** Linux 6.12, 8 cores, Node 22.23.2
**Embeddings:** none for supersession and the gate; the suite's own defaults otherwise
**LLM:** none

## Headline

Adopted. Observation / search with a stronger stale match falls from **0.80** stale-first to **0.00** (5/5 fresh-first). No other supersession cell moves, all 15 fast-suite metrics are identical to the baseline, and `eval:gate` passes with p95 12 ms (session start) and 16 ms (prompt submit) against the 500 ms ceiling.

## Lever

`HybridSearch` (`mem::smart-search`) fuses its legs by rank (RRF), then multiplies Observation scores by the recency factor (half-life 180 days, floor 0.6). The bench seeds every case into one store, so other projects hold the same claims and the newer Observation's global BM25 rank sits several places below the stronger stale one's; at 50 against 10 days the factor covers a gap of about three ranks, and four of five pairs were wider. `HybridSearch` now runs the near-twin cap `mem::search` already had (`capOlderNearTwins`, moved to `src/state/hybrid-search.ts` and shared by both) after the recency factor, over its enriched pool (at least 20 rows) and before the reranker and the cut to the limit: an older Observation whose title and narrative overlap a newer one's by Jaccard ≥ 0.5 is capped at 0.99 of its score. Memories and Lessons are untouched.

## Supersession

| Kind | Variant | Surface | Before | After | docs/supersession.md |
|---|---|---|---|---|---|
| Observation | equal match | search | 0.00 | 0.00 | T20 |
| Observation | stale matches more | search | **0.80** | **0.00** | T21, T21b |
| Observation | (all) | search | 0.40 | 0.00 | |

Every other cell is 0.00 before and after.

## Fast suite (`--against 2591b079`)

| Metric | Before | After |
|---|---|---|
| coding-life search recall / precision / hit | 1.000 / 0.708 / 0.833 | same |
| coding-life session-start recall / precision / hit | 0.625 / 1.000 / 1.000 | same |
| coding-life prompt-submit recall / precision / hit | 0.861 / 1.000 / 1.000 | same |
| PMB pass / activePass / precision / recall | 0.447 / 0.391 / 0.440 / 0.942 | same |
| LongMemEval recall@5 / hit | 0.896 / 0.958 | same |

All Δ 0.000: the cap changed no suite result, coding-life search precision included.

## Methodology

As in `eval/README.md`: dev split only (holdout not opened), supersession BM25-only on instance 32, the gate on instance 42, the fast suite on its default instances with the baseline labelled `2591b079` from main. The fixture T21b reproduces the bench case: the bench's wording and 50/10-day dates, with four other projects holding the same three Observations; it fails without the cap and passes with it. T21 passes either way.

## Reproduce

```sh
git checkout 5a386bc
npm ci && npm run build
npm run eval:supersession -- --instance 32
LONGMEMEVAL_PATH=~/datasets/longmemeval/longmemeval_s.json npm run eval:suite -- --tier fast --label <label> --against 2591b079
npm run eval:gate -- --instance 42
```

## Notes

- The cap is pairwise over the enriched pool, which is at least 20 rows and `limit` when larger; each text is tokenized once (`capBehindNewer`).
- Every suite metric is identical, so no scored answer changed place under the cap; the suite does not show whether it would demote an older near-twin that was the right answer. Such a pair restates one topic in nearly the same words, where the newer holds.
