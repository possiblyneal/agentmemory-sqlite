# 2026-10-19 — embedding model per record kind

**Commit:** `fb536e6` (`bge1`, reproduced exactly as `bge2` on a clean build of `9eef081`) against control `22e2bc0` (`main2`)
**Bench:** `eval:suite --tier fast`: coding-agent-life-v2, PrecisionMemBench, LongMemEval `_s`
**N:** dev only: coding-life 23 questions (4 no-answer), PMB 47 cases, LongMemEval 24 (4 per type)
**K:** 5 (search only; an Injection is scored whole)
**Hardware:** Linux 6.12, 8 cores, Node 22.23.2
**Embeddings:** on-device `Xenova/all-MiniLM-L6-v2` (default) vs `Xenova/bge-small-en-v1.5`
**LLM:** none

## Headline

MiniLM stays the default. BGE-small loses search precision at the shipped cosine floor
(coding-life 0.708 → 0.337, PMB pass 0.447 → 0.234). With its floor retuned it still trails on
coding-life precision (0.597 against 0.708), leads on PMB exact by one case, and ties
elsewhere. Neither model clearly wins one record kind while losing the other, so the record
kinds keep one model. The Operator's OpenAI-compatible model could not be scored.

## Per bench

Each bench stands for one record kind: coding-life holds Observations, PMB short Memories, and
LongMemEval long Memories.

| Metric | MiniLM | BGE-small |
|---|---|---|
| coding-life search recall | 1.000 | 1.000 |
| coding-life search precision | 0.708 | 0.337 |
| coding-life prompt-submit recall / precision | 0.861 / 0.889 | 0.861 / 0.889 |
| coding-life session-start recall | 0.625 | 0.625 |
| PMB pass | 0.447 | 0.234 |
| PMB active pass | 0.391 | 0.087 |
| PMB precision | 0.440 | 0.242 |
| PMB recall | 0.942 | 0.957 |
| LongMemEval recall@5 | 0.865 | 0.851 |
| LongMemEval hit | 0.958 | 0.917 |

Coding-life search precision, PMB pass, PMB active pass and PMB precision are `worse` at 99.7%
Bonferroni intervals (`bge1` against `main2`). Every other metric is ≈.

## Why BGE loses: the cosine floor

smart-search keeps a hit that BM25 matched when its cosine is at least `MIN_COSINE_SCORE`
(0.3, `src/functions/smart-search.ts`). That value fits MiniLM's scale. BGE scores every pair
high:

| Bench | Model | Gold p10 / p50 | Off-topic p50 / p90 / p99 |
|---|---|---|---|
| PMB | MiniLM | 0.240 / 0.389 | 0.055 / 0.175 / 0.440 |
| PMB | BGE | 0.605 / 0.673 | 0.493 / 0.567 / 0.654 |
| coding-life | MiniLM | 0.109 / 0.400 | 0.079 / 0.190 / 0.296 |
| coding-life | BGE | 0.581 / 0.673 | 0.551 / 0.612 / 0.664 |
| LongMemEval | MiniLM | 0.046 / 0.194 | 0.022 / 0.156 / 0.276 |
| LongMemEval | BGE | 0.453 / 0.517 | 0.419 / 0.509 / 0.583 |

At 0.3 the floor therefore admits nearly every BGE candidate. In an offline sweep over the same
dumps (hits before the floor), BGE did best at a floor of 0.62:

| | PMB exact | LongMemEval recall@5 | coding-life recall | coding-life precision |
|---|---|---|---|---|
| MiniLM, floor 0.3 | 0.295 | 0.865 | 1.000 | 0.708 |
| BGE, floor 0.62 | 0.318 | 0.865 | 1.000 | 0.597 |

BGE's gold and off-topic cosines overlap more than MiniLM's do, so no floor recovers the
precision. That is why no per-model floor shipped.

## Methodology

As in `eval/README.md`. The sandbox now forwards `AGENTMEMORY_LOCAL_EMBEDDING_MODEL` and
`_DIMENSIONS`, and `eval:suite` records both in its config. No holdout look was taken: #257
asks for one only for a changed default, and the default did not change. Each bench stands in for
one record kind; no bench is split into Observations and Memories, so the per-kind comparison is
that proxy. The cosine dumps come from a scratch build that returns BM25 and
cosine per hit with the floor removed; they are not in the repo.

## Reproduce

```sh
git checkout 05fb197
npm ci && npm run build
LONGMEMEVAL_PATH=<longmemeval_s.json> npm run eval:suite -- --tier fast --label main2
AGENTMEMORY_LOCAL_EMBEDDING_MODEL=Xenova/bge-small-en-v1.5 AGENTMEMORY_LOCAL_EMBEDDING_DIMENSIONS=384 \
  LONGMEMEVAL_PATH=<longmemeval_s.json> npm run eval:suite -- --tier fast --label bge1 --against main2
```

## Notes

- **The OpenAI-compatible model (`wemm-embedding`, 4096 dims) went unscored.** The broker
  answers `404 model_not_registered` and lists no embedding model. The fallback Qwen3-Embedding
  endpoint did not respond. Score it once an embedding model is served again, by setting
  `EMBEDDING_PROVIDER=openai` and `OPENAI_EMBEDDING_*` in the shell.
- **The Operator's daemon ran BGE-small at the MiniLM floor.** On 2026-10-19 it was switched to
  MiniLM, and the vector-space check re-embedded the store at boot.
