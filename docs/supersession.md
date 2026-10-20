# Supersession audit

Does a newer claim A′ that contradicts an older claim A replace it in Recall and Injection?
Each cell below is backed by a fixture in `test/supersession.test.ts`, which drives the
registered functions (`mem::smart-search`, `mem::context`, `mem::prompt-context`) through
`mockKV()`/`mockSdk()` over the real BM25 index. The fixtures store A, then A′, and assert what
the surface returns. A cell where the stale claim ranks first is an `it.fails` test: the suite
stays green, and the test starts failing (so must be flipped to `it`) when the behaviour is fixed.

Surfaces: **search** is `mem::smart-search` (also what `memory_smart_search` returns),
**session start** is `mem::context`, **prompt submit** is `mem::prompt-context`.

| Record kind | search | session start | prompt submit |
|---|---|---|---|
| Memory | stale hidden for a near-restatement (T1); **stale ranked first** for a contradiction with little shared wording (T3) or the only result when superseded by `mem::evolve` (T5) | not reachable (T7) | stale hidden for a near-restatement (T2); **stale ranked first** or alone for a low-overlap contradiction (T4) or `mem::evolve` (T6) |
| Semantic Fact | **stale ranked first** (T8) | **stale ranked first** (T9) | not reachable (T10) |
| Lesson | **stale ranked first** (T11) | **stale ranked first** (T12) | not reachable (T10) |
| Insight | stale demoted when it shares the newer one's title (T13) | **stale ranked first** (T14) | not reachable (T10) |
| Session Summary decision | not reachable (T15) | stale demoted when summaries were written in work order (T17); **stale ranked first** when the newer work was summarized first (T18) | stale demoted, newest Session first (T16); **stale ranked first** against a contradicting Memory (T19) |
| Observation | stale demoted by the recency factor (T20, T21) | stale demoted, newer Session first (T24) | **stale ranked first** when it matches the prompt more strongly (T22) or equally (T23) |

"Hidden" means the stale record is absent. "Demoted" means both are returned and the newer
one is first. "Ranked first" means the stale record leads, or is the only one returned.

## Tests

| ID | Test (in `test/supersession.test.ts`) | Status |
|---|---|---|
| T1 | Memory: smart-search hides a Memory that a near-restatement saved later superseded | passes |
| T2 | Memory: prompt-submit hides a Memory that a near-restatement saved later superseded | passes |
| T3 | Memory: smart-search ranks a contradicting Memory with little wording in common above the stale one | `it.fails` |
| T4 | Memory: prompt-submit gives a contradicting Memory with little wording in common and not the stale one | `it.fails` |
| T5 | Memory: smart-search hides a Memory that mem::evolve replaced | `it.fails` |
| T6 | Memory: prompt-submit hides a Memory that mem::evolve replaced | `it.fails` |
| T7 | Memory: session start does not reach Memories, so a superseded one cannot appear | passes |
| T8 | Semantic Fact: smart-search returns the newer Semantic Fact ahead of the contradicted one | `it.fails` |
| T9 | Semantic Fact: session start lists the newer Semantic Fact ahead of the contradicted one | `it.fails` |
| T10 | prompt-submit does not reach Semantic Facts, Lessons or Insights: prompt-submit gives none of them | passes |
| T11 | Lesson: smart-search returns the newer Lesson ahead of the contradicted one | `it.fails` |
| T12 | Lesson: session start lists the newer Lesson ahead of the contradicted one | `it.fails` |
| T13 | Insight: smart-search returns the newer Insight ahead of the contradicted one | `passes` |
| T14 | Insight: session start lists the newer Insight ahead of the contradicted one | `it.fails` |
| T15 | Session Summary decision: smart-search never returns a Session Summary decision on its own | passes |
| T16 | Session Summary decision: prompt-submit gives the newer Session's decisions ahead of the older one's | passes |
| T17 | Session Summary decision: session start lists the Session whose work is newer first when summaries were written in work order | passes |
| T18 | Session Summary decision: session start lists the Session whose work is newer first when its summary was written earlier | `it.fails` |
| T19 | Session Summary decision: prompt-submit puts a Memory that contradicts a Session decision ahead of that decision | `it.fails` |
| T20 | Observation: smart-search ranks the newer Observation above the contradicted one | passes |
| T21 | Observation: smart-search ranks the newer Observation above a contradicted one that matches the query more strongly | passes |
| T22 | Observation: prompt-submit gives the newer Observation ahead of a contradicted one that matches the prompt more strongly | `it.fails` |
| T23 | Observation: prompt-submit gives the newer Observation ahead of the contradicted one | `it.fails` |
| T24 | Observation: session start lists the newer Session's Observation ahead of the contradicted one | passes |

The Semantic Fact, Lesson and Insight fixtures give A the higher confidence (0.8 against 0.7
or 0.5, or three saves of the same Lesson against one), since A has had time to be reinforced
and A′ is new. With equal confidence, Lesson and Insight search fall to their recency term and Semantic Facts
to wording alone.

## Mechanisms

**Memory save (`mem::remember`).** The only path that marks a Memory superseded on arrival.
It compares the new content with existing Memories of the same project and scope by word-set
Jaccard similarity, and above 0.7 sets the old one `isLatest: false` and removes it from the BM25
and vector indexes, so search and both Injections stop returning it (T1, T2). It needs no LLM.
It detects restatement, not contradiction: a reversal worded differently stays below 0.7 and
both Memories stay live (T3, T4). Memories are not content-addressed here; `generateId()` gives
each save a new id, and `fingerprintId()` is used by Lessons.

**Memory evolve, consolidation and auto-forget.** `mem::evolve`, `mem::consolidate` (LLM) and
`mem::auto-forget` (Jaccard above 0.9) set `isLatest: false` in the store but do not remove the
row from the live index. `mem::evolve` also never adds the new version to BM25, so until the next
boot the stale Memory is the only BM25 hit (T5, T6 seed the stale Memory as `mem::remember`
would, and leave the evolved one unindexed as production does). `mem::search` and `HybridSearch` drop such a row only when
`AGENTMEMORY_NONLATEST_FILTER=true`; by default they count it as `nonlatestLeaked` and return it
(T5, T6). A daemon restart rebuilds BM25 from content and skips non-latest Memories, so the leak
lasts until the next boot. `mem::evict` deletes a non-latest Memory after `nonLatestMemoryMaxDays`.

**Semantic Facts.** Consolidation merges a fact into an existing one only on exact
case-insensitive text equality, then keeps the higher confidence. A contradicting fact is a new
row. Recall ranks by `confidence x term match` with no recency term, and session start by
confidence alone, so the reinforced stale fact leads (T8, T9).

**Lessons.** Saved under a fingerprint of the lowercased content, so only an identical lesson
strengthens one. A contradicting lesson is a new row. Recall ranks by `confidence x relevance x
recency`, where the recency boost decays 1% per day, and session start by confidence (T11, T12).

**Insights.** Written by `mem::reflect` from concept clusters and never compared with earlier
Insights. Search ranks like Lessons, but `mem::insight-search` gives Insights of one project and title the same slots in newest-first order (by `lastReinforcedAt`, else `createdAt`), so a restated claim leads; a contradiction under a different title is not detected. Session start ranks by confidence (T14).

**Session Summary decisions.** Prompt submit renders covered Sessions newest first by
`lastObservationAt`, under a header saying the newer of two conflicting rules holds, and adds a
later Session that amends a given one (`laterAmendment`) (T16). Session start orders Summary
blocks by `createdAt`, the write time, so a Session whose work is newer but was summarized first
sorts after the older work (T18). Prompt submit also renders every Summary decision before any
Memory fragment, so a Memory that supersedes a decision comes second (T19).

**Observations.** Never superseded. `HybridSearch` multiplies Observation scores by a mild
recency factor (half-life 180 days, floor 0.6), which lets a newer Observation beat an older one
within that margin (T20, T21). `mem::search`, which prompt submit calls, has no recency term, so
an older Observation that matches the prompt more strongly leads (T22), and an equal match ties
and keeps insertion order, so the older one leads there too (T23). Session start lists Sessions newest first (T24).

## Not covered

The fixtures use one lexical pair (`tabs` against `spaces`). The vector leg of search is off
(`null` provider), so a semantic match that BM25 misses is not exercised, and the reranker
Injection Gate is off as in CI. `mem::consolidate` and `mem::auto-forget` are described from their
code; the fixtures reach their effect through `mem::evolve`, which leaves the same `isLatest` state
on the old row; whether each indexes its new row is not tested. The fixture clock is pinned to
2026-10-20, so the recency-dependent cells do not drift as the fixture dates age.
