# 2026-11-11 — Search on the event loop

**Commit:** this PR (#386, closes #371) against main `7681665e`
**Bench:** a throwaway daemon (`--instance 37`, eviction, auto-compress and the reranker off,
local embedder) on a fresh copy of one backup of the live store per arm: 97,301 indexed
records, about 477k BM25 terms. Each arm waits for the index fill to finish, then a probe polls
`GET /agentmemory/livez` every 50 ms while it sends 4 rounds of `POST /agentmemory/prompt-context`
and `POST /agentmemory/search` (limit 30, project `agentmemory-sqlite`), 8 coding prompts in
turn. Three passes per arm: cold (the first requests after boot), warm, and warm with one
Observation written before each request
**N:** 8 requests per pass, 3 passes per arm; both arms run back to back
**LLM:** none
**Embeddings:** local, used only by the vector leg
**Hardware:** Intel i3-10100T (8 threads), Node 22.23.4; load average 1.4–1.9 during both arms

## Headline

The worst `/livez` reply during a search fell from 489 ms to 59 ms, and during any request
from 624 ms to 125 ms (the first prompt-context after boot). With writes between requests, as on
a live daemon, every search and prompt-context held the loop 420–498 ms before and 8–72 ms after.

## Cause

A CPU profile of the before arm under writes put 78% of busy time (39.8 of 50.9 s) in
`SearchIndex.getSortedTerms`: any `add` cleared the sorted vocabulary, and the next search with
a prefix term sorted all ~477k terms again in one synchronous call. The live daemon indexes an
Observation between most searches, so nearly every search paid it. The rest was BM25 scoring of
12k–32k matched documents per prompt (17–48 ms) and `capBehindNewer`'s pairwise Jaccard, each
run without yielding.

## Fix

- Prefix expansion reads buckets keyed by a term's first 2 characters, kept current on
  `add`/`remove`, so nothing is sorted per search.
- `searchCooperatively()` scores one query term at a time and yields once 10 ms has run.
- `mem::search` yields between its phases.
- `capBehindNewer` skips pairs whose word-set sizes cannot reach the 0.5 overlap.

## Result

Max `/livez` latency (ms) seen during each request type, and over the pass:

| pass | arm | search | prompt-context | livez p50 / p95 / max |
|---|---|---|---|---|
| cold | before | 70–129 | 164–624 | 3 / 164 / 624 |
| cold | after | 10–38 | 39–125 | 3 / 44 / 125 |
| warm | before | 48–121 | 162–309 | 2 / 121 / 309 |
| warm | after | 10–44 | 34–76 | 3 / 43 / 76 |
| warm, writes | before | 420–489 | 432–498 | 3 / 432 / 498 |
| warm, writes | after | 8–59 | 33–72 | 3 / 37 / 72 |

Wall time: the first prompt-context after boot took 997 ms before and 687 ms after; under writes,
search took 442–515 ms before and 79–124 ms after. An earlier pair of runs at load 2.3–3.0 gave
the same picture (before, under writes, 449–584 ms).

## Remaining

Each prompt-context still runs up to 3 amendment searches in parallel, whose slices run back to
back in one event-loop turn, and ranking builds and sorts one object per matched document
(~20 ms on 30k matches). Those make the 60–125 ms stretches left in prompt-context.

## Content

Results are unchanged: `searchCooperatively()` ranks as `search()` does (test), prefix
expansion visits matching terms in sorted order as main's sorted vocabulary did, so tied
scores keep their order, and the
`capBehindNewer` prune skips only pairs whose Jaccard is below 0.5 by construction.
`eval:gate` is +0.000 on every metric; prompt-submit p95 7 ms, session-start p95 4 ms.
