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

Control (gate off, same commit). Search and session-start rows match the table above except
for p50 latency; `grep` and `random` do not touch the daemon.

| Adapter | Path | n | Recall | Precision | No-answer clean | Hit | Mean chars | p50 |
|---|---|---|---|---|---|---|---|---|
| agentmemory | prompt-submit | 15 | 0.907 | 0.822 | 0.833 | 14/15 | 195 | 25 ms |
| agentmemory-bm25 | prompt-submit | 15 | 0.907 | 0.822 | 0.833 | 14/15 | 195 | 30 ms |

## Methodology

As 2026-10-06, with the Injection Gate described in `CLAUDE.md` (Injection Gate). The eval
sandbox forwards the gate settings only when `AGENTMEMORY_PROMPT_RERANK_URL` is set and
otherwise sets `AGENTMEMORY_PROMPT_RERANK=off`, so CI's `eval:gate` stays BM25-only and its
baseline is unchanged.

## Reproduce

```sh
git checkout 1748c65
npm ci && npm run build
npm run eval:coding-life                                                         # gate off
AGENTMEMORY_PROMPT_RERANK_URL=http://ai.lan:9202/v1/rerank npm run eval:coding-life  # gate on
```

## Notes

- The gate ran: a fallback leaves BM25's order and top 3, which is the control, and five
  prompt-submit questions differ from it on both adapters. The returned count and precision
  eval Sessions found in the Injection, not Observations.
  - `p-006` and `p-007` drop off-topic Sessions (2 → 1, 3 → 1; precision 0.50 → 1.00,
    0.33 → 1.00).
  - The no-answer `p-n04`, which BM25 lets through on the corpus-size floor noted on
    2026-10-06, now injects nothing.
  - `p-002` and `p-003` trade places (precision 1.00 ↔ 0.50, net zero). The gate reranks every
    candidate above the floor before the top-3 cut, so it can promote one BM25
    ranked below third; that fits `p-002` gaining a second Session.
- End-to-end prompt-submit p50 rises 21–30 ms with the gate. #169 reported a reranker-call
  p50 of 142 ms (Vulkan) on this set; the two measure different spans, and why the
  end-to-end rise is smaller is not traced.
