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
| Memory | stale hidden for a near-restatement (T1); stale hidden when `mem::evolve` replaced it (T5); stale demoted when a contradiction shares at least two terms (T3) | not reachable (T7) | stale hidden for a near-restatement (T2); stale hidden when `mem::evolve` replaced it (T6); **stale given alone** when the contradiction scores below the relevance floor (T4) |
| Semantic Fact | unkeyed: stale capped behind the newer fact (T8); keyed: stale hidden (T8k) | unkeyed: stale demoted by the recency factor (T9); keyed: stale hidden (T9k) | not reachable (T10) |
| Lesson | **newer ranked first** (T11) | stale capped behind the newer Lesson (T12, T12r) | not reachable (T10) |
| Insight | stale demoted when it shares the newer one's title (T13) | stale demoted, newer Insight first (T14) | not reachable (T10) |
| Session Summary decision | not reachable (T15) | stale demoted when summaries were written in work order (T17); newest work first even when summarized earlier (T18) | stale demoted, newest Session first (T16); stale demoted behind a newer Memory (T19) |
| Observation | stale demoted by the recency factor (T20, T21); stale capped below the newer near-twin of its own project (T21b, T21c) | stale demoted, newer Session first (T24) | stale capped below the newer near-twin (T22); stale demoted when equal (T23) |

"Hidden" means the stale record is absent. "Demoted" means both are returned and the newer
one is first. "Ranked first" means the stale record leads, or is the only one returned.

## Tests

| ID | Test (in `test/supersession.test.ts`) | Status |
|---|---|---|
| T1 | Memory: smart-search hides a Memory that a near-restatement saved later superseded | passes |
| T2 | Memory: prompt-submit hides a Memory that a near-restatement saved later superseded | passes |
| T3 | Memory: smart-search ranks a contradicting Memory with little wording in common above the stale one | passes |
| T4 | Memory: prompt-submit gives a contradicting Memory with little wording in common ahead of the stale one | `it.fails` |
| T5 | Memory: smart-search hides a Memory that mem::evolve replaced | passes |
| T6 | Memory: prompt-submit hides a Memory that mem::evolve replaced | passes |
| T7 | Memory: session start does not reach Memories, so a superseded one cannot appear | passes |
| T8 | Semantic Fact: smart-search returns the newer Semantic Fact ahead of the contradicted one | passes |
| T9 | Semantic Fact: session start lists the newer Semantic Fact ahead of the contradicted one | passes |
| T8k | Semantic Fact (keyed, `test/semantic-supersession.test.ts`): consolidation closes the live fact on a new object under the same key, and `recallSemanticFacts` (smart-search) leaves it out; a different subject, relation or project does not supersede; an unkeyed fact is untouched | passes |
| T9k | Semantic Fact (keyed, same file): session start reads the same `recallSemanticFacts`, so it shares T8k's filter | passes |
| T10 | prompt-submit does not reach Semantic Facts, Lessons or Insights: prompt-submit gives none of them | passes |
| T11 | Lesson: smart-search returns the newer Lesson ahead of the contradicted one | passes |
| T12 | Lesson: session start lists the newer Lesson ahead of the contradicted one | passes |
| T12r | Lesson saved just after a more-reinforced one: session start lists the newer Lesson ahead of the contradicted one | passes |
| T13 | Insight: smart-search returns the newer Insight ahead of the contradicted one | passes |
| T14 | Insight: session start lists the newer Insight ahead of the contradicted one | passes |
| T15 | Session Summary decision: smart-search never returns a Session Summary decision on its own | passes |
| T16 | Session Summary decision: prompt-submit gives the newer Session's decisions ahead of the older one's | passes |
| T17 | Session Summary decision: session start lists the Session whose work is newer first when summaries were written in work order | passes |
| T18 | Session Summary decision: session start lists the Session whose work is newer first when its summary was written earlier | passes |
| T19 | Session Summary decision: prompt-submit puts a Memory that contradicts a Session decision ahead of that decision | passes |
| T20 | Observation: smart-search ranks the newer Observation above the contradicted one | passes |
| T21 | Observation: smart-search ranks the newer Observation above a contradicted one that matches the query more strongly | passes |
| T21b | Observation (`eval:supersession` wording, other projects holding the same claims): smart-search ranks the newer Observation above a contradicted one whose stronger match outweighs the recency factor | passes |
| T21c | Observation: smart-search does not cap an Observation behind a newer twin from another project | passes |
| T22 | Observation: prompt-submit gives the newer Observation ahead of a contradicted one that matches the prompt more strongly | passes |
| T23 | Observation: prompt-submit gives the newer Observation ahead of the contradicted one | passes |
| T24 | Observation: session start lists the newer Session's Observation ahead of the contradicted one | passes |

The Semantic Fact, Lesson and Insight fixtures give A the higher confidence (0.8 against 0.7
or 0.5, or three saves of the same Lesson against one), since A has had time to be reinforced
and A′ is new. With equal confidence, Lesson and Insight search fall to their recency term.

## Mechanisms

**Memory save (`mem::remember`).** The only path that marks a Memory superseded on arrival.
It compares the new content with existing Memories of the same project and scope by word-set
Jaccard similarity, and above 0.7 sets the old one `isLatest: false` and removes it from the BM25
and vector indexes, so search and both Injections stop returning it (T1, T2). It needs no LLM.
It detects restatement, not contradiction: a reversal worded differently stays below 0.7 and
both Memories stay live. An exact repeat (same `fingerprintId()` of the trimmed,
lowercased content, same project and scope) is checked first and does not supersede: it raises
the existing Memory's `strength` by 1 (cap 10), keeps its id, audits `reinforce` and returns
that id; a valid `type` on the repeat replaces the stored one, so re-saving a Memory as a rule
promotes it. Only a near-restatement gets a new id.

**Read-side shadowing (`shadowedMemoryIds`, `newerAboveShadowed`, `src/functions/memory-shadow.ts`).**
Of the Memories one query returns, an older one is shadowed by a newer one of the same type and
Global marker that shares at least 2 distinctive terms (3+ letters, not stop words) covering 0.3 of
the smaller term set. The newer is moved directly above the older, which stays; nothing is marked,
hidden or deleted, and no LLM or stored field is involved. `mem::smart-search` reorders the hits
above its relevance floor (T3). `mem::prompt-context` reorders the hits that passed its floor and
the gate, so it never adds a newer Memory that scored below the floor: in T4 only the stale
Memory passes, it is given alone, and the test stays `it.fails` until the newer one is admitted.

**Memory evolve, consolidation and auto-forget.** `mem::evolve`, `mem::consolidate` (LLM) and
`mem::auto-forget` (Jaccard above 0.9) set `isLatest: false` and then call
`deindexSupersededMemory()` (`src/functions/search.ts`, the helper `mem::remember` uses), which
removes the row from BM25 and the vector index. `mem::evolve` and the evolve branch of
`mem::consolidate` add the new version through `indexNewMemoryVersion()`, so a replaced Memory is
neither returned nor the only hit (T5, T6). A Memory `mem::consolidate` creates fresh (no
predecessor) is still not added to the live index until the next boot. A daemon restart rebuilds
BM25 from content and skips non-latest Memories. `mem::evict` deletes a non-latest Memory after
`nonLatestMemoryMaxDays`; `AGENTMEMORY_NONLATEST_FILTER` stays off by default.

**Semantic Facts.** Consolidation's one LLM call per project returns each fact with an optional
key: `subject`, `relation`, `object`. All three present, stored lowercased and trimmed with the
project, make a keyed fact. A new keyed fact whose (subject, relation) matches a live keyed fact
of the same project but whose object differs closes that fact (`isLatest: false`, `supersededBy`)
and audits it (`evolve`, `semantic.supersede`); the same key and object reinforces, as exact text
does. A keyed fact whose text matches a live unkeyed fact whose cited Sessions are all this project's
reinforces it and gives it the key (otherwise a new keyed fact is written), so a fact written before keys existed can be closed later. Facts are not in BM25 or the vector index, so closing one has nothing to de-index; the
filter is on the read side: `recallSemanticFacts` (smart-search, session start) and the facts
Reflect reads skip `isLatest === false`. An unkeyed fact (old rows, or the LLM omitted the key)
merges on exact text only, and recall ranks it by recency instead (`recallSemanticFacts`, the
same cap as Lessons, shared as `capBehindNewer` in `src/functions/recency-cap.ts`): on a search, a hit whose
text overlaps another hit's by Jaccard 0.5 or more and was first stated (`createdAt`) earlier is
capped just below that newer hit, however recently consolidation reinforced it (T8); at session
start, with no query, confidence is also divided by 1 + 0.01 x days since `updatedAt` (T9). The
cap runs after the project filter, so another project's fact never demotes this one's. There is
no backfill.

**Lessons.** Saved under a fingerprint of the lowercased content, so only an identical lesson
strengthens one. A contradicting lesson is a new row. Recall ranks by `confidence x relevance x
recency`, where the recency boost decays 1% per day; a hit whose content overlaps another hit's by
Jaccard 0.5 or more and was last reinforced (else created) earlier is capped just below that newer
hit, so reinforcement cannot outvote a correction (T11). Lessons date by reinforcement, since only
an explicit save reinforces one. Session start ranks by project-weighted
confidence over the same boost, from `lastReinforcedAt` else `createdAt`, and applies the same cap
to the project's Lessons before taking the top 10, so a stale Lesson is capped behind a newer near-twin
however often it was reinforced, even when both were saved milliseconds apart (T12, T12r); a stale
Lesson reinforced after it still leads.

**Insights.** Written by `mem::reflect` from concept clusters. The reflect prompt lists the cluster's
existing Insights, and the model may answer one as `reinforces="<id>"`, which reinforces that Insight
instead of writing a row (#271); a contradiction is not detected. Search ranks like Lessons, but `mem::insight-search` gives Insights of one project and title the same slots in newest-first order (by `lastReinforcedAt`, else `createdAt`), so a restated claim leads; a contradiction under a different title is not detected (T13). Session start picks the top 5 by
confidence and lists them newest `createdAt` first (T14).

**Session Summary decisions.** Prompt submit renders covered Sessions newest first by
`lastObservationAt`, under a header saying the newer of two conflicting rules holds, and adds a
later Session that amends a given one (`laterAmendment`) (T16). Session start orders Summary
blocks by the same date (`decidedAt`), so a Session whose work is newer sorts first even when it was
summarized earlier (T18). A Memory whose `updatedAt` is later than a rendered Session's date takes its place among the
Sessions by date, so it is not rendered after a decision it may supersede (T19); older Memories
and Observations follow the Sessions.

**Observations.** Never superseded. `HybridSearch` multiplies Observation scores by a mild
recency factor (half-life 180 days, floor 0.6), which lets a newer Observation beat an older one
within that margin (T20, T21). `mem::search`, which prompt submit calls, applies the same factor to Observation scores
(Memories are exempt) before it cuts to the limit, so the newer one leads on an equal match (T23).
The factor separates the two fixtures by 5.8%, less than the 7% by which the older one's BM25
score leads in T22, and less than the fused-rank gap when other projects hold the same claims
(T21b), so both surfaces also apply the near-twin rule Lessons use (`capOlderNearTwins`,
`src/state/hybrid-search.ts`): among the Observation hits scored for the query, an older
Observation whose title and narrative overlap a newer one's by word-set Jaccard of at least 0.5 is
capped at 0.99 of the newer one's score, by Observation timestamp, before the cut to the limit
(T21b, T22). Only two Observations of one project pair: a newer twin in another repository never
caps this one's claim (T21c). An Observation's project is its Session's, else its Session
Summary's; one with neither pairs only within its own Session. `HybridSearch` runs the cap after
the recency factor over its enriched pool (at least 20 rows), and again over the merged ranking
when query expansion ran, before the reranker and the cut. With `RERANK_ENABLED=true` the
reranker's order inside its window wins, so the cap does not hold there. Other Observations keep
their scores. Session start lists Sessions newest first (T24).

## Not covered

The fixtures use one lexical pair (`tabs` against `spaces`). The vector leg of search is off
(`null` provider), so a semantic match that BM25 misses is not exercised, and the reranker
Injection Gate is off as in CI. `mem::consolidate` and `mem::auto-forget` are described from their
code; the fixtures reach their effect through `mem::evolve`, which leaves the same `isLatest` state
on the old row; whether each indexes its new row is not tested. The fixture clock is pinned to
2026-10-20, so the recency-dependent cells do not drift as the fixture dates age.
