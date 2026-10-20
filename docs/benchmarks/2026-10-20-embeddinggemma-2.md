# 2026-10-20 — EmbeddingGemma 2

**Commit:** `feat/embeddinggemma` off `3973ca9`; control `mini431` is MiniLM on the same branch (transformers 4.3.1)
**Bench:** `eval:suite --tier fast`: coding-agent-life-v2, PrecisionMemBench, LongMemEval `_s`
**N:** dev only: coding-life 23 questions (4 no-answer), PMB 47 cases, LongMemEval 24 (4 per type)
**K:** 5 (search only; an Injection is scored whole)
**Hardware:** Linux 6.12, 8 cores, Node 22.23.2; served runs embed on a separate LAN host (Ryzen AI MAX+ 395, Vulkan)
**Embeddings:** on-device `Xenova/all-MiniLM-L6-v2` (default) vs EmbeddingGemma 2 (768 dims, mean pooling, search-task prefixes), on-device (`onnx-community/embeddinggemma-2-ONNX` q4) and served (`unsloth/embeddinggemma-2-GGUF` Q8_0 under llama.cpp, OpenAI-compatible)
**LLM:** none

## Headline

MiniLM stays the default. At the shipped cosine floor EmbeddingGemma 2 loses search precision
exactly as BGE did (coding-life 0.708 → 0.337, PMB pass 0.447 → 0.234). With its own floor of
0.69, calibrated without eval labels, nothing differs significantly from MiniLM: coding-life
search precision trails (0.542), PMB and LongMemEval lead slightly. Gemma does not win dev, so no
holdout look was taken. The prefixes and the per-model floor ship, so a later switch to Gemma
runs it correctly.

## Per bench

| Metric | MiniLM (`mini431`) | Gemma, floor 0.3 (`gemma1`, `gemma2-gguf`) | Gemma, floor 0.69 (`gemma2-floor`) |
|---|---|---|---|
| coding-life search recall | 1.000 | 1.000 | 1.000 |
| coding-life search precision | 0.708 | 0.337 | 0.542 |
| coding-life prompt-submit recall / precision | 0.861 / 0.889 | 0.861 / 0.889 | 0.861 / 0.889 |
| coding-life session-start recall | 0.625 | 0.625 | 0.625 |
| PMB pass | 0.447 | 0.234 | 0.468 |
| PMB active pass | 0.391 | 0.087 | 0.435 |
| PMB precision | 0.440 | 0.242 | 0.454 |
| PMB recall | 0.942 | 0.957 | 0.942 |
| LongMemEval recall@5 | 0.896 | 0.958 / 0.948 | 0.927 |
| LongMemEval hit | 0.958 | 1.000 | 1.000 |

At floor 0.3, coding-life search precision, PMB pass, PMB active pass and PMB precision are
`worse` at 99.7% Bonferroni intervals; at floor 0.69 every metric is ≈. The on-device and
served runs score alike at floor 0.3 (they differ only in LongMemEval recall@5).

## The floor

smart-search rescues a hit BM25 matched when its cosine reaches the floor
(`src/functions/smart-search.ts`). MiniLM's 0.3 rejects 93.5% of 1,765 random pairs of the
Operator's Observations (one Observation's title against another Session's text). Gemma 2 scores
the same pairs at p50 0.626 / p90 0.680 / p99 0.759 against MiniLM's 0.130 / 0.267 / 0.451, and
rejects the same 93.5% at 0.693. Every Observation's title still clears that floor against its
own text (MiniLM at 0.3: 98.3%). The floor is a property of the model's scale, not a fit to the
benches, so it is not retuned on them.

## Vector agreement and speed

Cosine between builds of the same prefixed texts (≥ 0.99 means the same model):

| Pair | 1200-char doc | query |
|---|---|---|
| onnx-community fp32 vs GGUF Q8_0 | 0.9998 | 0.9999 |
| onnx-community fp32 vs `wesjos/embeddinggemma-2-onnx-fix` fp32 | 0.978 | 0.991 |

The `-onnx-fix` export, which rewrites ONNX Runtime contrib ops for other engines, disagrees with
two independent implementations, so it was not scored.

| Path | Per query | Per 1200-char doc |
|---|---|---|
| MiniLM q8, on-device | 3 ms | 30 ms |
| Gemma q4, on-device (4-core i3) | 30 ms | 360 ms |
| Gemma GGUF Q8_0, served (batches of 16) | 16 ms | 34 ms |

LongMemEval wall time: Gemma on-device 11,648 s, served 327 s.

## Methodology

As in `eval/README.md`. Served runs set `EMBEDDING_PROVIDER=openai` and `OPENAI_EMBEDDING_*`
(model `embeddinggemma-2`, 768 dims) in the shell; the endpoint is not recorded. transformers.js
4.3.1 is the first release that loads EmbeddingGemma 2. MiniLM on 4.3.1 scores identically to
4.2.0 and takes the same LongMemEval time on an idle CPU (1,683 s against 1,682 s on `3973ca9`).

## Reproduce

```sh
npm ci && npm run build
LONGMEMEVAL_PATH=<longmemeval_s.json> npm run eval:suite -- --tier fast --label mini431
EMBEDDING_PROVIDER=openai OPENAI_EMBEDDING_BASE_URL=<llama.cpp --embeddings --pooling mean> \
  OPENAI_EMBEDDING_API_KEY=local OPENAI_EMBEDDING_MODEL=embeddinggemma-2 OPENAI_EMBEDDING_DIMENSIONS=768 \
  LONGMEMEVAL_PATH=<longmemeval_s.json> npm run eval:suite -- --tier fast --label gemma2-floor --against mini431
```

## Notes

- **LongMemEval wall time on `main` rose from 129 s (`main2`) to 1,682 s (`main3`)** with
  scores unchanged; Memory chunking (#263), which multiplies the vectors per long Memory, is the
  likely cause and is not isolated here.
- **Qwen3-Embedding-0.6B was dropped before scoring.** On-device it is 2-3x slower than Gemma
  and its batched and single vectors disagree (cosine 0.96) under last-token pooling.
