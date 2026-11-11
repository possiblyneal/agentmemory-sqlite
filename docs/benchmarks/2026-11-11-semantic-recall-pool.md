# 2026-11-11 — Semantic Fact recall latency with a bounded near-twin pool

**Commit:** `987104a6` (#373) against main `72766485`
**Bench:** `recallSemanticFacts` called directly over a read-only backup of the live store
(37,246 Semantic Facts, 36,601 live, 45.6 MB of rows), no daemon; the two callers' shapes:
session start (project, no query, limit 5) and smart-search (project, query, limit 10)
**N:** 12 calls per arm: 2 projects (the largest, with 16,720 facts, and a mid-sized one with
6,101) x 6 prompts (no query, "go ahead", and four 7–16 word coding prompts)
**LLM:** none
**Embeddings:** none (facts are not in BM25 or the vector index)
**Hardware:** Intel i3-10100T (8 threads), Node 22.23.4; load average ~28 from other sessions
during the before arm, ~8 during the after arm

## Headline

The worst call fell from 215 s to 0.6 s. Before, the cap compared every pair of the project's
term-matched facts, and a prompt containing "the", "to" or "in" matched nearly all of them. After,
it compares the 50 best. What remains, 0.23–0.59 s, is mostly `kv.list(KV.semantic)` decoding all
45.6 MB of fact rows on every call (0.29 s alone on the idle machine), still synchronous.

## Result

| project (facts) | prompt | before | after |
|---|---|---|---|
| largest (16,720) | none (session start) | 214,582 ms | 412 ms |
| largest | "go ahead" | 4,931 ms | 385 ms |
| largest | 4 coding prompts | 71,174–123,076 ms | 442–525 ms |
| mid (6,101) | none (session start) | 18,943 ms | 588 ms |
| mid | "go ahead" | 1,102 ms | 230 ms |
| mid | 4 coding prompts | 13,216–17,389 ms | 253–455 ms |

The before arm ran at about 3.5 times the load of the after arm. Its cost grows with the square
of the matched facts, so the load cannot account for a 100x to 500x gap.

## Content

The returned facts changed. Overlap with the before arm's top 10 on the four coding prompts was
1–6 (mean 3.25); "go ahead" kept 8–9 of 10 and session start 4–5 of 5. On a coding prompt, a
stopword no longer counts toward a fact's relevance. Session start lost one fact on the largest
project, because the cap there now sees 50 facts instead of 16,720. No eval corpus contains
Semantic Facts, so `eval:gate` and `eval:coding-life` are unchanged by construction. The
supersession eval's Semantic Fact cells stay at 0.00 stale-first.

| eval | before | after |
|---|---|---|
| `eval:gate` (coding-agent-life-v2, BM25) | baseline | all 9 metrics +0.000, p95 17/23 ms |
| `eval:supersession` semantic-fact search / session-start | 0.00 / 0.00 | 0.00 / 0.00 |

## Method

The store was copied with `node:sqlite`'s `backup()` from a connection opened `readOnly`, into
the repo's `tmp/`. A throwaway script under `tmp/` opened the copy with `SqliteState` and timed
each `recallSemanticFacts` call over a `{get, list}` shim. The before arm loaded main's
`semantic-recall.ts`, copied beside the script. The script is not committed. The timings
include the call's own `kv.list`.
