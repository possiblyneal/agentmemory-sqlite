# 2026-10-20 — mem::search recency

**Commit:** the commit that adds this file, against control `a0de1e3`
**Bench:** coding-agent-life-v2 (`eval:coding-life`, dev split) and its CI gate (`eval:gate`)
**N:** dev: 12 search, 9 prompt-submit, 2 session-start; gate: every question (20 search, 15 prompt-submit, 3 session-start)
**K:** 5 (search only; an Injection is scored whole)
**Hardware:** Linux 6.12, Node 22
**Embeddings:** on-device (sandbox default)
**LLM:** none

## Headline

`mem::search` now multiplies Observation scores by `HybridSearch`'s recency factor (half-life
180 days, floor 0.6) before it cuts to the limit. Memories are exempt. Prompt-submit precision
rose, on dev from 0.889 to 1.000 and on the gate set from 0.822 to 0.889; nothing else moved.
Both p95 latencies stay far under the 500 ms ceiling.

## Per path

| Adapter | Path | n | Recall | Precision | No-answer clean | Hit | p50 | p95 |
|---|---|---|---|---|---|---|---|---|
| agentmemory | search | 12 | 1.000 | 0.708 | 0.000 | 10/12 | 20ms | 32ms |
| agentmemory | prompt-submit | 9 | 0.861 | 1.000 | 1.000 | 9/9 | 3ms | 13ms |
| agentmemory | session-start | 2 | 0.625 | 1.000 | 1.000 | 2/2 | 25ms | 25ms |
| agentmemory-bm25 | prompt-submit (gate) | 15 | 0.907 | 0.889 | 0.833 | 14/15 | 4ms | 9ms |
| agentmemory-bm25 | session-start (gate) | 3 | 0.813 | 1.000 | 1.000 | 3/3 | 4ms | 6ms |

## Methodology

As in `eval/README.md`. The prompt-submit precision before is the committed gate baseline
(0.822) and the 2026-10-19 query-stopwords dev scorecard (0.889).

## Reproduce

```sh
npm ci && npm run build
npm run eval:gate -- --instance 32
npm run eval:coding-life -- --instance 32
```

## Notes

T22 in `test/supersession.test.ts` stays `it.fails`: the older, stronger Observation
leads the newer one by about 7% on BM25 and the factor separates them by 5.8%.
`eval/baselines/coding-agent-life-v2.json` moves to the new prompt-submit precision.
