# 2026-10-19 — Memory chunking on by default

**Commit:** `c6ac817` against control `ddf1ab3` (`main2`, `main-hold4`)
**Bench:** `eval:suite --tier fast`: coding-agent-life-v2, PrecisionMemBench, LongMemEval `_s`
**N:** dev: coding-life 23 questions (4 no-answer), PMB 47 cases, LongMemEval 24 (4 per type);
holdout: coding-life 15, PMB 30, LongMemEval 112
**K:** 5 (search only; an Injection is scored whole)
**Hardware:** Linux 6.12, 8 cores, Node 22.23.2
**Embeddings:** on-device, `Xenova/all-MiniLM-L6-v2` (the sandbox default)
**LLM:** none

## Headline

Embedding each long Memory as one vector per ~1200-char chunk raised holdout LongMemEval
recall@5 from 0.917 to 0.947 and hit from 0.964 to 0.991. Every other metric on both splits is
unchanged. The difference is ≈ at 99.7% Bonferroni intervals (Δ0.031 [-0.011, 0.082], n=112).

## Per bench

The rows are metrics and the columns are dev and holdout before/after, unlike the per-path
table in `TEMPLATE.md`, because a single lever is judged on both splits. The n per split is in
the header.

| Metric | Dev before | Dev after | Holdout before | Holdout after |
|---|---|---|---|---|
| coding-life search recall | 1.000 | 1.000 | 1.000 | 1.000 |
| coding-life search precision | 0.708 | 0.708 | 0.556 | 0.556 |
| coding-life prompt-submit recall / precision | 0.861 / 0.889 | 0.861 / 0.889 | 1.000 / 0.722 | 1.000 / 0.722 |
| coding-life session-start recall / precision | 0.625 / 1.000 | 0.625 / 1.000 | 1.000 / 1.000 | 1.000 / 1.000 |
| PMB pass | 0.447 | 0.447 | 0.367 | 0.367 |
| PMB precision | 0.440 | 0.440 | 0.521 | 0.521 |
| PMB active pass | 0.391 | 0.391 | 0.350 | 0.350 |
| PMB recall | 0.942 | 0.942 | 0.961 | 0.961 |
| LongMemEval recall@5 | 0.865 | 0.896 | 0.917 | 0.947 |
| LongMemEval hit | 0.958 | 0.958 | 0.964 | 0.991 |

## Methodology

As in `eval/README.md`. The holdout looks are `main-hold4` and `chunk-hold` in
`eval/holdout-ledger.ndjson`. Chunking touches only the vector leg; BM25 still indexes each
Memory whole, so the BM25-only `eval:gate` cannot move.

## Reproduce

```sh
git checkout c6ac817
npm ci && npm run build
LONGMEMEVAL_PATH=<longmemeval_s.json> npm run eval:suite -- --tier fast --label chunk1 --against main2
LONGMEMEVAL_PATH=<longmemeval_s.json> npm run eval:suite -- --tier fast --holdout --label chunk-hold --against main-hold4
```

## Notes

- **Cost on the Operator's store is nil today.** The live store holds 3 current Memories and
  73,902 vectors (113 MB), almost all Observations; none of the Memories passes 1200 chars, so
  chunking adds no vector. A long Memory costs one extra vector per ~1050 chars past the first
  chunk. Observations are not chunked.
- **No migration.** A Memory that splits gets ids `<id>#<i>`; the next fill pass embeds the
  chunks and prunes the bare-id vector as an orphan. `AGENTMEMORY_MEMORY_CHUNKING=false`
  restores one vector per Memory the same way.
- **The gain is LongMemEval's.** A Session without Observations loads as one Memory
  (`ingestRemembered` in `eval/runner/adapters/agentmemory.ts`), and LongMemEval's haystack
  Sessions are whole chat transcripts, far past 1200 chars. Coding-life and PMB scores did not
  move on either split.
