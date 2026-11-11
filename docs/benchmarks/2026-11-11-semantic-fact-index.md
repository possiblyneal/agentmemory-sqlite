# 2026-11-11 — Semantic Fact recall from an in-memory index

**Commit:** this PR (#374) against main `db339525`
**Bench:** `recallSemanticFacts` called directly over a read-only backup of the live store
(37,246 Semantic Facts, 36,601 live), no daemon; the two callers' shapes: session start
(project, no query, limit 5) and smart-search (project, query, limit 10)
**N:** 36 calls per arm: 2 projects (the largest, with 16,720 facts, and a mid-sized one with
6,704) x 6 prompts (no query, "go ahead", and four 7–16 word coding prompts) x 3 runs
**LLM:** none
**Embeddings:** none (facts are not in BM25 or the vector index)
**Hardware:** Intel i3-10100T (8 threads), Node 22; load average ~5.5–6 from other sessions
during both arms

## Headline

The longest synchronous stretch of a recall fell from 218–430 ms to 6–22 ms, and its wall time
from 267–475 ms to 11–53 ms. Before, every call decoded all 45.6 MB of fact rows with
`kv.list(KV.semantic)` in one synchronous step. After, recall reads an index of the live facts
held in memory, rebuilt only when `KV.semantic` has been written since, and fetches only the
facts it returns. The returned facts are identical, in content and order, for all 12 shapes.

## Result

Each cell is wall / longest synchronous stretch (the largest gap between event-loop turns
during the call), in ms, over 3 runs.

| project (facts) | prompt | before | after |
|---|---|---|---|
| largest (16,720) | none (session start) | 267–344 / 220–269 | 21–29 / 14–22 (first call, cold: 723 / 38) |
| largest | "go ahead" | 294–311 / 257–272 | 14–16 / 10–14 |
| largest | 4 coding prompts | 280–467 / 225–376 | 11–20 / 6–14 |
| mid (6,704) | none (session start) | 314–445 / 218–315 | 46–53 / 20–22 |
| mid | "go ahead" | 369–475 / 325–430 | 11–14 / 8–14 |
| mid | 4 coding prompts | 272–366 / 220–294 | 14–20 / 9–16 |

The first call after boot, or after any write to `KV.semantic`, rebuilds the index: 0.7 s of
wall time, paged 500 rows at a time, its longest synchronous stretch 38 ms. The index holds
about 39 MB of heap on this store (slim entries with interned session ids, plus the word
index).

## Content

Top-k overlap with the before arm was 5/5 at session start and 10/10 on every query, in the
same order. No eval corpus contains Semantic Facts, so `eval:gate` is unchanged by
construction; the supersession eval's Semantic Fact cells stay at 0.00 stale-first.

| eval | before | after |
|---|---|---|
| `eval:gate` (coding-agent-life-v2, BM25) | baseline | all 9 metrics +0.000, p95 session-start 3 ms, prompt-submit 7 ms |
| `eval:supersession` semantic-fact search / session-start | 0.00 / 0.00 | 0.00 / 0.00 |

## Method

The store was copied with `node:sqlite`'s `backup()` from a connection opened `readOnly`, into
the repo's `tmp/`, and deleted afterwards. A throwaway script under `tmp/` opened the copy with
`SqliteState` and a `StateKV` over its state functions, and timed each call; a `setImmediate`
loop running beside the call measured its longest synchronous stretch. The before arm loaded
main's `semantic-recall.ts`, copied beside the script. The script is not committed. Heap was
measured as `heapUsed` after `gc()` before and after one index build.
