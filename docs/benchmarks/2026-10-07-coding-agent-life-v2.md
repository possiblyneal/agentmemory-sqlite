# 2026-10-07 — coding-agent-life-v2 (v0.9.29), Injection Gate on

**Commit:** `1748c65` (PR #170 merged); this file is the only change on top
**Bench:** coding-agent-life-v2 (22 sessions across `shipctl` and `ledger-api`, 38 questions)
**N:** 20 search (4 no-answer), 3 session-start (1 no-answer), 15 prompt-submit (6 no-answer)
**K:** 5 (search only; an Injection is scored whole)
**Hardware:** Debian 13, 8 cores, Node 22.23
**Embeddings:** on-device (`agentmemory`); none (`agentmemory-bm25`)
**LLM:** none (synthetic compression, no summaries)
**Reranker:** Qwen3-Reranker-0.6B Q8, llama.cpp Vulkan on `ai` (`http://ai.lan:9202/v1/rerank`), `AGENTMEMORY_PROMPT_RERANK_MIN=0.03`

The dated scorecard PR #170 promised once the hosted reranker was live. Both runs use the
same commit; the control sets no `AGENTMEMORY_PROMPT_RERANK_URL`, so the sandbox keeps the
Injection Gate off.

## Headline

The Injection Gate raises prompt-submit precision from **0.822** to **0.967** and no-answer
clean from **0.833** to **1.000** at unchanged recall **0.907**, on both adapters. Hit goes
14/15 → 15/15 and the mean Injection shrinks 195 → 137 chars. The cost is latency: p50 rises
25 → 55 ms (agentmemory) and 30 → 51 ms (bm25), within the hook's 1.5 s budget. Search and
session-start do not move.

## Per path

| Adapter | Path | n | Recall | Precision | No-answer clean | Hit | Mean chars | p50 |
|---|---|---|---|---|---|---|---|---|
| agentmemory | search | 20 | 1.000 | 0.597 | 0.250 | 17/20 | — | 28 ms |
| agentmemory | session-start | 3 | 0.813 | 1.000 | 1.000 | 3/3 | 2411 | 21 ms |
| agentmemory | prompt-submit | 15 | 0.907 | 0.967 | 1.000 | 15/15 | 137 | 55 ms |
| agentmemory-bm25 | search | 20 | 0.969 | 0.624 | 0.250 | 17/20 | — | 30 ms |
| agentmemory-bm25 | session-start | 3 | 0.813 | 1.000 | 1.000 | 3/3 | 2411 | 33 ms |
| agentmemory-bm25 | prompt-submit | 15 | 0.907 | 0.967 | 1.000 | 15/15 | 137 | 51 ms |
| grep | search | 20 | 0.906 | 0.232 | 0.000 | 15/20 | — | 0 ms |
| grep | prompt-submit | 15 | 1.000 | 0.347 | 0.333 | 11/15 | — | 0 ms |
| random | search | 20 | 0.156 | 0.030 | 0.000 | 3/20 | — | 0 ms |
| random | session-start | 3 | 0.208 | 0.333 | 0.000 | 2/3 | — | 0 ms |
| random | prompt-submit | 15 | 0.056 | 0.013 | 0.000 | 1/15 | — | 0 ms |

Control (gate off, same commit), prompt-submit on both adapters: 0.907 / 0.822 / 0.833
(recall / precision / no-answer clean), 14/15, 195 chars, p50 25 ms (agentmemory) and 30 ms
(bm25). Every other row matches the table above within latency noise.

## Methodology

As 2026-10-06. The gate reorders the BM25 candidates that pass prompt-context's floor by
reranker score, drops those below `AGENTMEMORY_PROMPT_RERANK_MIN`, then keeps the top 3
(`src/functions/prompt-context.ts`). The eval sandbox forces the gate off unless
`AGENTMEMORY_PROMPT_RERANK_URL` is set, so CI's `eval:gate` stays BM25-only and its baseline
is unchanged.

## Reproduce

```sh
git checkout 1748c65
npm ci && npm run build
npm run eval:coding-life                                                         # gate off
AGENTMEMORY_PROMPT_RERANK_URL=http://ai.lan:9202/v1/rerank npm run eval:coding-life  # gate on
```

## Notes

- Per question (bm25 adapter), the gate changes five prompt-submit items: `p-006` and `p-007`
  drop off-topic Observations (precision 0.50 → 1.00, 0.33 → 1.00); the no-answer `p-n04`,
  which BM25 lets through on the corpus-size floor noted on 2026-10-06, now injects nothing.
  `p-002` and `p-003` trade places (precision 1.00 ↔ 0.50, net zero). The gate cannot add a
  candidate, so `p-002`'s second item is one the control had already injected earlier in
  the same Session and therefore skipped; this mechanism is inferred, not traced.
- The reranker is a network dependency on `ai`. It fails open to BM25 with a 60 s cooldown;
  with the host down the prompt-submit path is the control's BM25 path.
