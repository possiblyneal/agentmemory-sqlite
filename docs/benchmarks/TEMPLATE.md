# <YYYY-MM-DD> — <benchmark-name>

**Commit:** `<sha>`
**Bench:** coding-agent-life-v2 / LongMemEval `_s` / ...
**N:** per path, with the no-answer count
**K:** 5 (search only; an Injection is scored whole)
**Hardware:** <os, cores, node version>
**Embeddings:** on-device / none / <provider and model>
**LLM:** none / <provider and model>

## Headline

<the path that moved, by how much, and against which control>

## Per path

| Adapter | Path | n | Recall | Precision | No-answer clean | Hit | Mean chars | p50 |
|---|---|---|---|---|---|---|---|---|
| agentmemory | search | | | | | | — | |
| agentmemory | prompt-submit | | | | | | | |
| agentmemory | session-start | | | | | | | |
| agentmemory-bm25 | ... | | | | | | | |
| grep | search | | | | | | — | |
| random | ... | | | | | | — | |

## Methodology

<anything that differs from eval/README.md: dataset, sandbox, adapters, K>

## Reproduce

```sh
git checkout <sha>
npm ci && npm run build
npm run eval:coding-life
```

## Notes

<what surprised, what regressed, which questions explain the numbers>
