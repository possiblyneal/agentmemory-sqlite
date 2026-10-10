# 2026-10-10 — coding-agent-life-v2 (v0.9.29), Injection Gate on search

**Commit:** `de8992d` plus the change that ships this file (smart-search gate, dated rerank documents)
**Bench:** coding-agent-life-v2 (22 sessions across `shipctl` and `ledger-api`, 38 questions)
**N:** 20 search (4 no-answer), 3 session-start (1 no-answer), 15 prompt-submit (6 no-answer)
**K:** 5 (search only; an Injection is scored whole)
**Hardware:** Debian 13, 8 cores, Node 22.23
**Embeddings:** on-device (`agentmemory`); none (`agentmemory-bm25`)
**LLM:** none (synthetic compression, no summaries)
**Reranker:** Qwen3-Reranker-0.6B Q8, llama.cpp Vulkan on `ai` (`http://ai.lan:9202/v1/rerank`), `AGENTMEMORY_PROMPT_RERANK_MIN=0.03`

The control is `de8992d` with the same reranker URL, so prompt-submit is already gated and
only search differs.

## Headline

Gating `mem::smart-search` raises search precision from **0.624** to **0.933** and no-answer
clean from **0.250** to **1.000**; hit goes 17/20 → 19/20. Recall falls **0.969** → **0.906**:
q-011 (multi-session causal) now returns nothing, because the reranker scores its gold
post-mortem 0.004. p50 rises 28 → 64 ms. Prompt-submit and session-start do not move.

## Per path

| Adapter | Path | n | Recall | Precision | No-answer clean | Hit | Mean chars | p50 |
|---|---|---|---|---|---|---|---|---|
| agentmemory (control) | search | 20 | 0.969 | 0.624 | 0.250 | 17/20 | — | 28 ms |
| agentmemory | search | 20 | 0.906 | 0.933 | 1.000 | 19/20 | — | 64 ms |
| agentmemory | session-start | 3 | 0.813 | 1.000 | 1.000 | 3/3 | 2411 | 21 ms |
| agentmemory | prompt-submit | 15 | 0.907 | 0.967 | 1.000 | 15/15 | 137 | 44 ms |
| agentmemory-bm25 | search | 20 | 0.906 | 0.933 | 1.000 | 19/20 | — | 56 ms |
| agentmemory-bm25 | session-start | 3 | 0.813 | 1.000 | 1.000 | 3/3 | 2411 | 21 ms |
| agentmemory-bm25 | prompt-submit | 15 | 0.907 | 0.967 | 1.000 | 15/15 | 137 | 43 ms |
| grep | search | 20 | 0.906 | 0.232 | 0.000 | 15/20 | — | 0 ms |
| grep | prompt-submit | 15 | 1.000 | 0.347 | 0.333 | 11/15 | — | 0 ms |
| random | search | 20 | 0.156 | 0.030 | 0.000 | 3/20 | — | 0 ms |
| random | session-start | 3 | 0.208 | 0.333 | 0.000 | 2/3 | — | 0 ms |
| random | prompt-submit | 15 | 0.056 | 0.013 | 0.000 | 1/15 | — | 0 ms |

## Methodology

Unchanged from `eval/README.md`. The control ran `agentmemory` only.

## Reproduce

```sh
git checkout <this change>
npm ci && npm run build
AGENTMEMORY_PROMPT_RERANK_URL=http://ai.lan:9202/v1/rerank npm run eval:coding-life
```

## Notes

- Without the date in the rerank document, q-015 ("What was shipped on April 8th 2026?") also
  returned nothing: its gold scored 0.006, and 0.993 once each document leads with
  `YYYY-MM-DD`. That run scored search recall 0.844, hit 18/20, precision 0.950.
- Cutoffs 0.01–0.1 were swept on the shared threshold. 0.01 lets prompt-submit inject on a
  no-answer prompt (no-answer clean 0.833); 0.05 and up lose p-007. 0.03 stays.
- PrecisionMemBench single-turn (AMB harness, `general` model), same daemon code: 27/77 →
  52/77, active passes 14/43 → 26/43. Hindsight on the same model scores 55/77 with the
  dataset's per-case recall filter and 9/77 without it.
