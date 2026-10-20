# Record-kind counts on the dashboard

Ticket #268 (parent #270). Snapshot of the live store on 2026-10-20, read-only
(`node:sqlite`, `readOnly: true`). Audit rows (`mem:audit`) start 2026-10-02T13:17Z, so
anything earlier has no audit trail; the Injection log (`mem:injections`) covers
2026-10-13 onward.

## Verdicts

| Kind | Dashboard | Rows in scope | Verdict |
|---|---|---|---|
| Memories | 3 | 5 (3 latest) | By design. The count is right. |
| Lessons | 0 | 0 | Dead in practice: nothing creates one without an explicit Agent call, and none was made. |
| Crystals | 0 | 0 | Dead feature for this Operator: needs completed Actions, and 1 Action ever exists. |
| Insights | 12,620 (12,628 now) | 12,628 | Mechanism works as written but accumulates without bound. Bug (follow-up filed). |

One bug fixed here: the Lessons and Crystals tiles counted the returned page (cap 50 and
20), not the rows. See "Fixed here".

## Memories

**Cause of "3".** `GET /agentmemory/memories?latest=true` returns `total = filtered.length`
where the filter is `isLatest` (`api::memories`, `src/triggers/api.ts`); the tile reads that
total. `mem:memories` holds 5 rows, 3 with `isLatest: true`.

**The "duplicate pairs" are supersession chains, not missed duplicates.**
`mem_mtbp48h0_6f6bc447...` (v1, 2026-08-27) is superseded by `mem_muqy2uuj_951e006b...`
(v2, `parentId` set, 2026-10-02T12:34:00Z, `project: "homelab"`); `mem_mtnb48ny_ceec624e...`
(v1) by `mem_muqy2vny_aa9ea19e...` (v2, 12:34:01Z). The v1 rows have `isLatest: false` and
their `updated_at` is the second the v2 row landed. `mem::remember` supersedes any latest
Memory whose content has Jaccard similarity above 0.7 (`src/functions/remember.ts`), and
an unscoped Memory is a wildcard, so the project-less v1 was replaced by the `homelab` v2.
The different "record shapes" are only that v1 predates the `origin` and `project` fields.
So the dashboard's 3 is 5 minus the 2 superseded, which is what Recall can return:
superseded versions are removed from the BM25 and vector indexes on supersession and
skipped on rebuild.

**Why `fingerprintId()` did not collapse them.** `mem::remember` never uses it. It builds
the id with `generateId("mem")` (random) and de-duplicates by similarity-supersession
instead. Lessons (`lsn`) and Insights (`ins`) are the kinds that fingerprint their content.
`CONTEXT.md` says Memories "are content-addressed, so the same content captured twice is
one Memory"; the code does not do that. An exact restatement produces a new version row and
retires the old one, so Recall sees one, but the store keeps both rows.

**Paths that write `mem:memories`.**
- `mem::remember` (MCP `memory_save`, `POST /agentmemory/remember`): explicit Agent call. The
  only path that has produced these 5 rows.
- `mem::consolidate` (`POST /agentmemory/consolidate`, MCP `memory_consolidate`): promotes
  Observations to Memories through the LLM. Nothing schedules it: no audit row has
  `functionId: "mem::consolidate"`. The scheduled pipeline (`mem::consolidate-pipeline`,
  572 audit rows) writes Semantic Facts instead.
- `mem::flow-compress`: from Actions, so unused here.

**Is the Agent saving?** No surviving Observation records a `memory_save` or
`memory_lesson_save` call; 35,000 Observations have been evicted so this is a floor, not
proof. The 5 Memories are 3 distinct claims, saved 2026-05-24, 08-27, 09-04 and re-saved
10-02. The `memory-discipline` skill is the only prompt to save, and nothing else promotes.

**Not injected.** In the 7-day Injection log, no Injection carries a `memory` ref. Memories
reach the Agent only as search hits; session start (`mem::context`) has no Memory-specific
block, unlike Lessons and Insights.

**Classification.** By design. Operator decision: whether to schedule `mem::consolidate`
(keep unscheduled, wire it into the pipeline, or remove it), and whether session start should
carry Global Memories. Both are product forks.

## Lessons

**Cause.** `mem:lessons` has 0 rows. Creators: `mem::lesson-save` (MCP, `POST
/agentmemory/lessons`), `mem::flow-compress` (needs Actions), and Replay import-jsonl
(`src/functions/replay.ts`, regex-extracted from past transcripts). No hook, and no
prompt-submit step, detects a correction and saves a Lesson. The `lesson` skill is the only
trigger.

**Evidence.** `mem:audit` has no `lesson_save`, `lesson_strengthen` or `lesson_delete` row
since 2026-10-02, and 8 `lesson_recall` rows all return `resultCount: 0` (2026-10-02 to
10-07). Earlier history is not audited, so "never existed" is unproven; "none in the last 18
days and none present" is.

**Classification.** Dead in practice, not a code bug: the write path works (`test/lessons.test.ts`).
The gap is that corrections only become Lessons if the Agent runs the skill. Operator
decision: keep as a skill-driven feature, or wire automatic capture from user corrections
(a hook-level feature, out of scope here).

**Dashboard.** The 0 is correct. The count was wrong for large stores (see Fixed here).

## Crystals

**Cause.** `mem::crystallize` consumes Actions with `status: "done"`. `mem::auto-crystallize`
runs from every debounced session stop and from the eviction recovery pass, and finds
nothing: `mem:actions` has 1 row, `act_msjtv1d6...` "placeholder", `cancelled`, 2026-08-08.
Actions come only from `memory_action_create` and `POST /agentmemory/actions`.

**Classification.** Dead feature for an Operator who does not use Actions. It also starves
two downstream consumers: Insights' Crystal input and Lessons' `crystal` source are always
empty. Operator decision: keep, wire to something this workflow produces (for example
Session Summaries), or remove. Not removed here.

## Insights

**What they are built from.** `mem::reflect` (`src/functions/reflect.ts`) clusters graph
concept nodes (or falls back to Jaccard clusters), then gives the LLM the Semantic Facts,
Lessons and Crystals that match each cluster's concepts. Of the 12,628 Insights, all 12,628
list Semantic Fact ids in `sourceMemoryIds`, 0 list Lessons, 0 list Crystals, and none
resolve to a Memory. So Insights here are summaries of Semantic Facts (30,270 rows,
themselves distilled from Session Summaries). `CONTEXT.md` defines an Insight as built from
"Memories, Lessons and Crystals"; the code reads Semantic Facts as the main input, and the
`sourceMemoryIds` field name is a misnomer for fact ids.

**Why 12,628.** 614 `mem::reflect` audit rows between 2026-10-02 and 10-20, each up to 50
new Insights (`maxTotal`). The oldest Insight is 2026-09-26, creation peaks at about 1,200
per day. An Insight is reinforced only when the LLM reproduces the same text, since the id
is a fingerprint of the generated content: 12,627 of 12,628 have 0 reinforcements, and the
`reinforced` field of the `mem::reflect` audit rows is 0 every time. Each run therefore
mints fresh Insights for clusters it has already covered. 740 clusters (project plus concept
set) hold 12,628 Insights: median 7, top clusters 270 to 356. Text is paraphrase rather than
copy (45 of 80,141 sampled in-cluster pairs exceed 0.5 Jaccard), so exact-text dedup cannot
catch it.

**Quality.** A sample reads as plausible, coherent syntheses ("Secret Leakage in Process
Argv", "Template Payload Drift as Systemic Risk"). The tags are noisy: 3,571 carry more
than 20 tags and some contain punctuation fragments (`,,`, `(language`). Content restates
clusters repeatedly, so any single cluster offers hundreds of overlapping Insights.

**Does Recall return them?**
- Session start (`mem::context`) injects the top 5 per project by project-weighted
  confidence. In the 7-day Injection log: 595 insight refs at session start and 330 via
  the context route, across 86 distinct Insights. That is 0.7 percent of 12,628; the other
  99 percent have never been shown in that window.
- `mem::smart-search` returns Insights only with `includeInsights`, and 8 `insight_search`
  audit rows exist (2026-10-02 to 10-07).
- `mem:access` has 0 Insight rows: the access tracker records Observation ids (10,488
  rows) and 2 Memories only. Insight use cannot be measured from it, so the question was
  answered from `mem:injections` instead.

**Decay.** `mem::insight-decay-sweep` ran 24 times; the 2026-10-20 run decayed 534 of
12,484 and deleted 0. Nothing has been deleted, so
the store only grows; disk growth is the cost.

**Classification.** Bug (unbounded accumulation of non-reinforcing paraphrases; the top 5
shown per project come from a pool ranked by confidence alone). Follow-up filed. Operator
decision needed for the fix direction (reflect only clusters whose facts changed, cap
Insights per cluster, or merge by similarity), because it changes what is retained.

## Fixed here

`GET /agentmemory/lessons` returned `lessons.slice(0, limit)` with a default limit of 50,
and `GET /agentmemory/crystals` a default of 20, and neither returned a total. The dashboard
tiles used `.length` of that page, so they would stop at 50 and 20 on a store with more.
Memories, Semantic Facts and Insights already read a response `total`.

- `mem::lesson-list` and `mem::crystal-list` now return `total` (matches after filters,
  before the page limit). Additive field.
- The dashboard Lessons and Crystals tiles read it (`lessonTotal`, `crystalTotal`).
- Tests: `test/lessons.test.ts`, `test/crystallize.test.ts` (60 and 25 rows against the
  50 and 20 caps), `test/viewer-dashboard.test.ts` (tile wiring).

The labels are accurate and unchanged: "Memories / latest versions" counts latest Memories,
which is what Recall can return.

## Decisions left for the Operator

1. Crystals: keep, rewire to a producer this workflow has, or remove (needs Actions).
2. Lessons: keep skill-driven, or add automatic capture of corrections.
3. `mem::consolidate` (Observation to Memory promotion): unscheduled; keep, schedule, or
   remove.
4. Insights: choice of retention strategy (#271).
   Glossary drift on Memory and Insight (#272): reword `CONTEXT.md` or change the code.
5. Session start carries no Memory block; whether Global Memories should be added.
