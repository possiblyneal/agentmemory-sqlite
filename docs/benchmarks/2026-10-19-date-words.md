# 2026-10-19 — searchable record dates

**Commit:** `f8af46b` against control `22e2bc0` (`main2`, `main-hold3`)
**Bench:** `eval:suite --tier fast`: coding-agent-life-v2, PrecisionMemBench, LongMemEval `_s`
**N:** dev: coding-life 23 questions (4 no-answer), PMB 47 cases, LongMemEval 24 (4 per type);
holdout: coding-life 15, PMB 30, LongMemEval 112
**K:** 5 (search only; an Injection is scored whole)
**Hardware:** Linux 6.12, 8 cores, Node 22.23.2
**Embeddings:** on-device, `Xenova/all-MiniLM-L6-v2` (the sandbox default)
**LLM:** none

## Headline

Indexing each record's calendar date raised holdout coding-life search recall from 0.917 to
1.000. Every other metric on both splits is unchanged. The one question that moved is `q-015`
("What was shipped on April 8th 2026?"), which now returns both gold Sessions instead of one;
the query-stopwords lever had lost it. The difference is ≈ at 99.7% Bonferroni intervals (n=6).

## Per bench

| Metric | Dev before | Dev after | Holdout before | Holdout after |
|---|---|---|---|---|
| coding-life search recall | 1.000 | 1.000 | 0.917 | 1.000 |
| coding-life search precision | 0.708 | 0.708 | 0.556 | 0.556 |
| coding-life prompt-submit recall / precision | 0.861 / 0.889 | 0.861 / 0.889 | 1.000 / 0.722 | 1.000 / 0.722 |
| coding-life session-start recall | 0.625 | 0.625 | 1.000 | 1.000 |
| PMB pass | 0.447 | 0.447 | 0.367 | 0.367 |
| PMB precision | 0.440 | 0.440 | 0.521 | 0.521 |
| LongMemEval recall@5 | 0.865 | 0.865 | 0.917 | 0.917 |
| LongMemEval hit | 0.958 | 0.958 | 0.964 | 0.964 |

CI gate (`eval:gate`, BM25-only, every question): search recall 0.938 → 0.969. The rest is
unchanged, and Injection p95 stays under 10 ms. `eval/baselines/coding-agent-life-v2.json`
moves to the new search recall.

## Methodology

As in `eval/README.md`. The LongMemEval loader now gives each haystack Session its dataset
date, so its records carry real timestamps. The holdout looks are `main-hold3` and
`date-hold` in `eval/holdout-ledger.ndjson`.

## Reproduce

```sh
git checkout f8af46b
npm ci && npm run build
LONGMEMEVAL_PATH=<longmemeval_s.json> npm run eval:suite -- --tier fast --label date1 --against main2
LONGMEMEVAL_PATH=<longmemeval_s.json> npm run eval:suite -- --tier fast --holdout --label date-hold --against main-hold3
```

## Notes

- **The benches barely ask by date.** No dev question names a date, and only 14 of the 500
  LongMemEval questions do. Most of those name a month with no year ("in March"), which this
  lever does not match. One fell in the holdout sample, and it scored recall 1.000 both
  before and after. The gain is therefore one question;
  the lever's reach is the Operator's own date queries, which no bench measures.
