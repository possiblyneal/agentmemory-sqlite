# 2026-10-25 — LongMemEval wall time after Memory chunking

**Commit:** chunking on/off timings at `b84e3614`; the re-embed skip at `b84e3614` plus the
`perf/longmemeval-chunk-cost` diff (run label `reembed-skip`), against control `2591b079`
**Bench:** `eval:suite --tier fast`: coding-agent-life-v2, PrecisionMemBench, LongMemEval `_s`
**N:** dev: coding-life 23 questions, PMB 47 cases, LongMemEval 24 (4 per type)
**K:** 5 (search only; an Injection is scored whole)
**Hardware:** Linux 6.12, 8 cores, Node 22.23.2, shared with other agents' runs
**Embeddings:** on-device, `Xenova/all-MiniLM-L6-v2` (the sandbox default)
**LLM:** none

## Headline

Memory chunking (#263) is the cause of the LongMemEval slowdown (#265). On one commit, the
LongMemEval leg takes 242 s with `AGENTMEMORY_MEMORY_CHUNKING=false` and 1,144 s with chunking
on. Import now skips re-embedding a chunk whose vector is already current. That halves the leg
to 604 s (555 s inside the suite, against 1,175 s for `2591b079`), and every suite metric is
unchanged (Δ 0.000 on all 15). The remaining cost of chunking is accepted, because chunking
was adopted for its recall gain.

## Wall time

LongMemEval leg only (`eval/runner/longmemeval.ts --stratify 4 --concurrency 3 --split dev`),
one run each, serialized under the suite lock.

| Run | Commit | Chunking | Seconds | recall@5 | hit |
|---|---|---|---|---|---|
| off | `b84e3614` | `false` | 242 | 0.865 | 23/24 |
| on | `b84e3614` | default (on) | 1,144 | 0.896 | 23/24 |
| on + re-embed skip | `b84e3614` + diff | default (on) | 604 | 0.896 | 23/24 |
| suite `2591b079-fast` | `2591b079` | default (on) | 1,175 | 0.896 | 23/24 |
| suite `reembed-skip-fast` | `b84e3614` + diff | default (on) | 555 | 0.896 | 23/24 |

## Embed work per run

The sample has 1,167 haystack Sessions. Each is loaded as one Memory of 10,158 chars on
average. With chunking on, those become 14,136 chunks: 12.1 per Memory, up to 36.

| | Chunking off | Chunking on, before | Chunking on, after |
|---|---|---|---|
| `embedBatch` calls (ingest) | 2,334 | 2,334 | 1,167 |
| texts embedded | 2,334 | 28,272 | 14,136 |
| chars embedded per pass | 11.9 M (MiniLM reads the first 512 tokens) | 15.1 M | 15.1 M |

There are two embed passes per Memory: `remember`, then the date import, which
(`dateMemory` in `eval/runner/adapters/agentmemory.ts`) rewrites `createdAt` through
`POST /import`. Before the fix, that import re-embedded every chunk through `indexRecords()`,
though the text had not changed. The fix removes the second pass. Each question's search adds
one query embed (24 per run).

## Methodology

As in `eval/README.md`. The sandbox now forwards `AGENTMEMORY_MEMORY_CHUNKING`, and
`eval:suite` records it in the run's config. Before this change, the off arm could not be run.

The fix: `indexRecords()` (`src/functions/search.ts`) skips a job when
`SqliteVectorStore.hasCurrentVector()` finds a row for that id, under the same session, whose
input hash matches. This is the test the fill pass already uses
(`vectorMatchesText()`, `src/state/index-corpus.ts`). Nothing new is stored: a skipped job's
row is the one re-embedding would have rewritten.

## Reproduce

```sh
git checkout perf/longmemeval-chunk-cost
npm ci && npm run build
export LONGMEMEVAL_PATH=<longmemeval_s.json>
AGENTMEMORY_MEMORY_CHUNKING=false npx tsx eval/runner/longmemeval.ts --data "$LONGMEMEVAL_PATH" \
  --adapters agentmemory --stratify 4 --concurrency 3 --split dev --instance 44 --out tmp/lme-off
npm run eval:suite -- --tier fast --label reembed-skip --against 2591b079
```

## Notes

- **The accepted cost.** With the fix, chunking on still takes 2.5x the wall time of chunking
  off (604 s against 242 s; off was measured before the fix, so it still had both embed
  passes). Chunking embeds 12x as many texts per Memory and reads the whole Memory, where the
  unchunked vector stops at MiniLM's 512-token window. That cost buys recall@5 0.865 → 0.896
  on dev and 0.917 → 0.947 on holdout (`2026-10-19-memory-chunking.md`). Capping chunks per
  Memory, or chunking only past a threshold, would change what is stored. Neither was tried.
- **Wall time is noisy here.** The off arm took 242 s, against 129 s for `main2` in #265. The
  machine is shared, and LongMemEval runs three sandboxes at once. Compare ratios within this
  table, not against older scorecards.
- **Live daemon.** A real import, snapshot restore or replay of unchanged Memories and
  Observations no longer re-embeds them. A Memory saved through `remember` embeds once, as
  before.
- **Gate.** `eval:gate` is BM25-only, so every metric equals its baseline. Injection p95 is
  ≤ 7 ms.
