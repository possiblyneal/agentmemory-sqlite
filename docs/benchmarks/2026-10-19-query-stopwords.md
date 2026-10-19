# 2026-10-19 — query stopwords

**Commit:** `2675963` against control `e32ae98`
**Bench:** `eval:suite --tier fast`: coding-agent-life-v2, PrecisionMemBench, LongMemEval `_s`
**N:** dev: coding-life 23 questions (4 no-answer), PMB 47 cases, LongMemEval 24 (4 per type);
holdout: coding-life 15, PMB 30, LongMemEval 112
**K:** 5 (search only; an Injection is scored whole)
**Hardware:** Linux 6.12, 8 cores, Node 22.23.2
**Embeddings:** on-device, `Xenova/all-MiniLM-L6-v2` (the sandbox default)
**LLM:** none

## Headline

Dropping English stopwords from BM25 query terms raised these on dev:

- search precision on coding-life and PMB;
- PMB pass;
- LongMemEval recall@5 and hit.

On holdout, the precision gains held. Two recall metrics fell, both within noise. Every
paired difference is ≈ at 99.7% Bonferroni intervals.

## Per bench

The rows are metrics and the columns are dev and holdout before/after, unlike the per-path
table in `TEMPLATE.md`, because a single lever is judged on both splits. The n per split is in
the header.

| Metric | Dev before | Dev after | Holdout before | Holdout after |
|---|---|---|---|---|
| coding-life search recall | 1.000 | 1.000 | 1.000 | 0.917 |
| coding-life search precision | 0.686 | 0.708 | 0.462 | 0.556 |
| coding-life prompt-submit recall | 0.861 | 0.861 | 1.000 | 1.000 |
| coding-life prompt-submit precision | 0.889 | 0.889 | 0.722 | 0.722 |
| coding-life session-start recall | 0.625 | 0.625 | 1.000 | 1.000 |
| PMB pass | 0.383 | 0.447 | 0.300 | 0.367 |
| PMB active pass | 0.348 | 0.391 | 0.300 | 0.350 |
| PMB precision | 0.389 | 0.440 | 0.479 | 0.521 |
| PMB recall | 0.942 | 0.942 | 0.961 | 0.961 |
| LongMemEval recall@5 | 0.802 | 0.865 | 0.933 | 0.917 |
| LongMemEval hit | 0.875 | 0.958 | 0.964 | 0.964 |

CI gate (`eval:gate`, BM25-only, every question): search recall 0.969 → 0.938, precision
0.624 → 0.704. The rest is unchanged. `eval/baselines/coding-agent-life-v2.json` moves to the
new search numbers.

## Methodology

As in `eval/README.md`. The control is `main` at `e32ae98`, run under the same labels and
seeds. The holdout looks are `main-hold` and `stop-hold` in `eval/holdout-ledger.ndjson`.
`stop-hold` ran on the uncommitted change before `2675963` existed, so its ledger commit field
reads `e32ae98`, the base it sat on. A later review fix also drops a stopword with sentence
punctuation attached ("this."); a dev rerun with it (`stop2` against `stop1`) and `eval:gate`
moved no metric.

## Reproduce

```sh
git checkout 2675963
npm ci && npm run build
LONGMEMEVAL_PATH=<longmemeval_s.json> npm run eval:suite -- --tier fast --label stop1 --against main1
```

## Notes

- **The recall loss is q-015** ("What was shipped on April 8th 2026?"). Its gold Session
  sess-011 matched only on function words ("on"). Neither gold Session contains "april" or
  "8th", because the date lives only in the timestamp, which BM25 does not index. #256 targets
  that.
- **Rejected on dev against this change**, by an offline floor simulation confirmed by suite
  runs:
  - an absolute cosine floor of 0.2: LongMemEval recall@5 0.865 → 0.552;
  - a relative cosine floor of 0.5× best: recall@5 0.628;
  - a BM25 ratio floor of 0.6: recall@5 0.778;
  - prefix expansion for terms of 4+ characters only: recall@5 +0.010, nothing else moved.
- **Why cosine fails:** gold LongMemEval Sessions often score 0.015–0.09 cosine under MiniLM.
  Each long chat is one vector that sees only its opening words, so a cosine floor drops them.
  #258 targets that.
