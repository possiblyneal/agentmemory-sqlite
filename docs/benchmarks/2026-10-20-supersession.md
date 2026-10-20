# 2026-10-20 — supersession (baseline)

**Commit:** `a0de1e3` (main, before any of the concurrent supersession fixes)
**Bench:** supersession, dev split (`runner/supersession.ts`)
**N:** 110 cases: 22 cells, 5 dev pairs each of 8 (3 held out per cell)
**K:** none; the whole surface is read (search: the record kind's own list)
**Hardware:** Linux 6.12, 8 cores, Node 22.23.2
**Embeddings:** none (BM25 only)
**LLM:** none

## Headline

Stale-first is the rule for most non-Observation kinds. Memory contradicted or replaced by `mem::evolve`, Semantic Facts, Lessons and Insights lead with the contradicted claim, or return only it, in 48 of 50 cases (ten cells at 0.80 to 1.00); the two exceptions are pairs whose newer Memory matched the query better. Memory restatement is the one fixed case: the old Memory is hidden in all 10. Session Summary decisions and Observations are 0.00 where the surface orders by time (work-order summaries, session start, search with an equal match) and 1.00 or near it where relevance ranks without recency (prompt-submit with a stronger stale match, a summary written early, a Memory against a summary).

## Per record kind and surface

Rate is stale-first over the cases where a claim came back; every cell had a claim back in all 5 cases.

| Kind | Variant | Surface | n | stale-first | fresh-first | stale hidden | Rate | docs/supersession.md |
|---|---|---|---|---|---|---|---|---|
| Memory | restated | search | 5 | 0 | 0 | 5 | 0.00 | T1 |
| Memory | restated | prompt-submit | 5 | 0 | 0 | 5 | 0.00 | T2 |
| Memory | contradicted | search | 5 | 4 | 1 | 0 | 0.80 | T3 |
| Memory | contradicted | prompt-submit | 5 | 4 | 1 | 0 | 0.80 | T4 |
| Memory | evolved | search | 5 | 5 | 0 | 0 | 1.00 | T5 |
| Memory | evolved | prompt-submit | 5 | 5 | 0 | 0 | 1.00 | T6 |
| Semantic Fact | reinforced | search | 5 | 5 | 0 | 0 | 1.00 | T8 |
| Semantic Fact | reinforced | session-start | 5 | 5 | 0 | 0 | 1.00 | T9 |
| Lesson | reinforced | search | 5 | 5 | 0 | 0 | 1.00 | T11 |
| Lesson | reinforced | session-start | 5 | 5 | 0 | 0 | 1.00 | T12 |
| Insight | reinforced | search | 5 | 5 | 0 | 0 | 1.00 | T13 |
| Insight | reinforced | session-start | 5 | 5 | 0 | 0 | 1.00 | T14 |
| Session Summary decision | work order | session-start | 5 | 0 | 5 | 0 | 0.00 | T17 |
| Session Summary decision | work order | prompt-submit | 5 | 0 | 5 | 0 | 0.00 | T16 |
| Session Summary decision | written early | session-start | 5 | 5 | 0 | 0 | 1.00 | T18 |
| Session Summary decision | against a Memory | prompt-submit | 5 | 5 | 0 | 0 | 1.00 | T19 |
| Observation | equal match | search | 5 | 0 | 5 | 0 | 0.00 | T20 |
| Observation | equal match | session-start | 5 | 0 | 5 | 0 | 0.00 | T24 |
| Observation | equal match | prompt-submit | 5 | 1 | 4 | 0 | 0.20 | T23 |
| Observation | stale matches more | search | 5 | 4 | 1 | 0 | 0.80 | T21 |
| Observation | stale matches more | session-start | 5 | 0 | 5 | 0 | 0.00 | T24 |
| Observation | stale matches more | prompt-submit | 5 | 5 | 0 | 0 | 1.00 | T22 |

Rolled up per kind and surface (all variants, in `eval/reports/supersession/summary.json`):

| Kind | search | session-start | prompt-submit |
|---|---|---|---|
| Memory | 0.60 (9/15) | not reachable | 0.60 (9/15) |
| Semantic Fact | 1.00 | 1.00 | not reachable |
| Lesson | 1.00 | 1.00 | not reachable |
| Insight | 1.00 | 1.00 | not reachable |
| Session Summary decision | not reachable | 0.50 | 0.50 |
| Observation | 0.40 | 0.00 | 0.60 |

Not reachable: Memory at session start, Semantic Facts, Lessons and Insights at prompt-submit, and a Session Summary decision through search (T7, T10, T15). The rollup for Memory mixes the restated variant, which the save-time Jaccard check already hides, with the two that leak, so read the variant rows.

## Methodology

- **Cells and pairs.** The cells are the ones `docs/supersession.md` names, plus its variants. Each has eight lexical pairs (tabs/spaces, yarn/pnpm, jest/vitest, merging/squashing, postgres/redis, camelCase/snake_case, eslint/biome, axios/undici) rather than the single tabs/spaces pair of `test/supersession.test.ts`. A case is one pair in one cell, in its own project, in one shared sandbox.
- **Seeding.** Semantic Facts, Insights, Observations and Session Summaries have no write route, so their rows are written into the store file before the daemon boots (as on a restart, the boot rebuild indexes them). Dated 50 days (older) and 10 days (newer) before the run. Memories and Lessons are written through REST so `mem::remember`'s restatement check and `mem::evolve` run as in production. The older Semantic Fact and Insight carry the higher confidence (0.8 against 0.7 and 0.5), and the older Lesson is saved three times against one, as in the test fixtures.
- **Reading a surface.** Search: the record kind's own list in the `smart-search` reply (`results`, `lessons`, `insights`, `semanticFacts`). Session start: `POST /agentmemory/context`. Prompt submit: `POST /agentmemory/prompt-context`. A claim is found by its stored text. When both appear, the one first in reading order leads. Only the stale claim returned counts as stale-first, as in the docs table.
- **Split.** Dev only, through `selectSplit` grouped by cell (`eval/runner/split.ts`). The holdout was not opened and the ledger not touched.
- **Lessons** are saved under a fingerprint of their text across projects, so each cell words its Lessons differently.
- **Not in `eval:suite`**; the Injection Gate is off (`AGENTMEMORY_PROMPT_RERANK=off`) and there is no vector leg, as in the fixtures.

## Reproduce

```sh
git checkout a0de1e3
npm ci && npm run build
npm run eval:supersession -- --instance 33
```

Per-case results: `eval/reports/supersession/scores.ndjson`.

## Notes

- Every cell agrees with the status in `docs/supersession.md` (`it.fails` cells are the rows with a high stale-first rate; passing ones sit at 0.00), which supports the single-pair fixtures; the new information is how steady each cell is across pairs.
- Cells that are not all-or-nothing: Memory contradicted (one pair in each of search and prompt-submit had the newer Memory first because its wording matched the query better), Observation search with a stronger stale match (0.80), and Observation prompt-submit with an equal match (0.20, one pair where the older Observation matched slightly more).
- The numbers are the before for the concurrent fixes. A fix to a cell should move its rate to 0.00 without moving the neighbouring cells; rerun the same command and publish a new dated card.
- Scoring is deterministic given the commit; the seeded dates shift with the run date, which only affects the recency-dependent cells (Observation search, Lesson recall) at the margin.
