# 2026-10-05 — coding-agent-life-v2 (v0.9.29)

**Commit:** the commit that adds this file, on top of `c8c6407`
**Bench:** coding-agent-life-v2 (21 sessions across `shipctl` and `ledger-api`, 38 questions)
**N:** 20 search (4 no-answer), 3 session-start (1 no-answer), 15 prompt-submit (6 no-answer)
**K:** 5 (search only; an Injection is scored whole)
**Hardware:** Debian 13, 8 cores, Node 22.23
**Embeddings:** on-device (`EMBEDDING_PROVIDER=local`, `@huggingface/transformers`) or none
**LLM:** none (synthetic compression, no summaries)

Adds a relevance floor to `mem::smart-search`. Session-start and prompt-submit are
unchanged from the 2026-10-03 run. The pre-tool-use path is no longer in the question set.

## Headline

Search precision on `agentmemory-bm25` goes from **0.195** to **0.628** and no-answer clean
from **0.000** to **0.250**, with recall unchanged at **0.969**. On `agentmemory` (on-device
embeddings) precision goes from **0.190** to **0.601**, no-answer clean from **0.000** to
**0.250**, recall stays **1.000**.

## Per path

| Adapter | Path | n | Recall | Precision | No-answer clean | Hit | Mean chars | p50 |
|---|---|---|---|---|---|---|---|---|
| agentmemory | search | 20 | **1.000** | 0.601 | 0.250 | 17/20 | — | 24 ms |
| agentmemory | session-start | 3 | 0.813 | 1.000 | 1.000 | 3/3 | 2146 | 12 ms |
| agentmemory | prompt-submit | 15 | 0.907 | 0.822 | 0.833 | 14/15 | 184 | 24 ms |
| agentmemory-bm25 | search | 20 | 0.969 | 0.628 | 0.250 | 17/20 | — | 30 ms |
| agentmemory-bm25 | session-start | 3 | 0.813 | 1.000 | 1.000 | 3/3 | 2146 | 15 ms |
| agentmemory-bm25 | prompt-submit | 15 | 0.907 | 0.822 | 0.833 | 14/15 | 184 | 25 ms |
| grep | search | 20 | 0.906 | 0.240 | 0.000 | 15/20 | — | 0 ms |
| grep | prompt-submit | 15 | 1.000 | 0.350 | 0.333 | 11/15 | — | 0 ms |
| random | search | 20 | 0.125 | 0.020 | 0.000 | 2/20 | — | 0 ms |
| random | session-start | 3 | 0.394 | 0.400 | 0.000 | 2/3 | — | 0 ms |
| random | prompt-submit | 15 | 0.000 | 0.000 | 0.000 | 0/15 | — | 0 ms |

Search before the floor (2026-10-03): agentmemory 1.000 / 0.190 / 0.000, agentmemory-bm25
0.969 / 0.195 / 0.000 (recall / precision / no-answer clean).

## Floor trade-off (search)

Replayed from the raw per-hit scores of both search adapters; BM25 floor is
`max(absolute, ratio * best)`.

| Absolute | Ratio | bm25 recall | bm25 precision | no-answer clean |
|---|---|---|---|---|
| none | none | 0.969 | 0.185 | 0.00 |
| 3.5 (chosen) | 0.5 | 0.969 | 0.628 | 0.25 |
| 4 | 0.5 | 0.938 | 0.678 | 0.50 |
| 5 (prompt-context) | 0.5 | 0.875 | 0.714 | 0.75 |

The ratio does most of the precision work (none to 0.5 at absolute 3 is 0.309 to 0.624).
Raising the absolute floor to 4 would clean one more no-answer question and add 0.05
precision but loses one gold Session (sess-001 on q-015, BM25 3.8), so it is not taken.
The cosine rescue (0.3) is what keeps `agentmemory` recall at 1.000: the one gold Session
BM25 alone loses (sess-001 on q-011, BM25 3.2, cosine 0.33) comes back, at a cost of about
0.05 precision.

## Methodology

As 2026-10-03.

## Reproduce

```sh
git checkout <sha>
npm ci && npm run build
npm run eval:coding-life
```

## Notes

- The floor (`src/functions/smart-search.ts`) keeps a hybrid hit when its BM25 score is at
  least 3.5 and at least half the best hit's, or when its cosine is at least 0.3 and BM25 also
  matched it. It applies only to the query path's hybrid results, not `expandIds`, lessons,
  insights or semantic facts. Prompt-context's floor (5) is too high for search: gold
  Sessions here score as low as 3.8.
- Cosine alone never admits a hit. Off-topic vector-only hits stay at or under 0.17, but there
  is no gold vector-only hit on this corpus to calibrate a cosine-only floor, and off-topic hits
  with lexical overlap reach 0.58, so there is no clean separation to rely on.
- Remaining no-answer failures: q-n01 (best BM25 3.9), q-n02 (4.9), q-n03 (6.4). Only q-n04
  (ledger-api, best 1.4) returns nothing.
