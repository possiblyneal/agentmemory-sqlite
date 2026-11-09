# What Lessons need to replace docs/LESSONS.md (#317)

Investigation of 2026-11-08 into whether agentmemory Lessons can take over from each repo's
`docs/LESSONS.md`. No LLM was called and the live store was read through GET requests only.
Aggregates only: no prompt or transcript text is quoted.

Line references in #317 have moved: the `Lesson` type is now `src/types.ts:804` (not `:955`),
and session start's Lesson block is `src/functions/context.ts:213-263` (not `:220-255`).

## How Lessons behave today

- **Save**: `mem::lesson-save` (`src/functions/lessons.ts:72`) stores at 0.5 or the caller's
  confidence. Only an exact re-save (fingerprint of the lowercased content) reinforces it, with
  `confidence += 0.1 × (1 − confidence)`. A restatement in other words is a new Lesson.
- **Decay and deletion** (`lessons.ts:359-365`): `decayRate` 0.05 per active week of Project
  Time. A Lesson at ≤ 0.1 with 0 reinforcements is hard-deleted; a reinforced one stops at a
  0.05 floor and is never deleted.
- **Retrieval**: session start and pre-compact only. `rankLessons` scores
  (1.5 own project, else 1) × confidence / (1 + days × 0.01), caps near-twins
  (`capBehindNewer`) and takes the top 10, which must then fit the pinned share
  (`RULEBOOK_BUDGET_SHARE` 0.4: 800 tokens at session start's default 2000, 600 at
  pre-compact's 1500; tokens are chars/3). A Lesson with no project is shown in every project.
  Prompt-submit (`src/functions/prompt-context.ts`) never retrieves Lessons.
- **Indexing**: `lessonToObservation` (`src/state/memory-utils.ts:95`) maps `context` to
  narrative, `content` to title and facts, and tags to concepts, so a symptom written into
  `context` is already searchable. There is no separate symptom ("Tell") field.
- **Use**: `injectedItemUse` (`src/functions/injections.ts`) counts an injected item as used
  when a later Observation touches one of its ref's files or names its id. Lesson refs carry
  no files, so every Lesson Injection is unscorable today.

## The store on 2026-11-08

`GET /agentmemory/lessons?limit=500` and `GET /agentmemory/audit`:

| Measure | Value |
|---|---|
| Lessons | 197, all `source: manual`, all with `context` and tags |
| Reinforcements | 195 at 0, 2 at 1 |
| Confidence | 86 at 0.8–0.82 (bulk imports of retired LESSONS.md files, 11-05/11-06), 70 at 0.5, 34 already decayed to 0.4–0.45, the rest 0.55–0.75 |
| Size | content mean 466 chars, context mean 103 chars, about 193 tokens per Lesson as rendered |
| Largest projects | devex 35, inference-runtime-broker 31, homelab 27, agentmemory-sqlite 21, template 20, glydr 20 |
| Audit (from 10-30, the audit bound) | 156 `lesson_save`, 39 `lesson_strengthen` (37 decay sweeps, 2 re-saves), 7 `lesson_recall`, 0 `lesson_delete` |

Placement defects: one project is split across two names (`nanokvm-boot-lab` and
`nanokvm-boot-lab-0c7806`, 6 each), so is another (`reverse-engineer` and
`reverse-engineering`), and 4 Lessons have no project.

## Q1: does the /ship Lessons step capture the right Lessons?

**Answer: what it saves is the right kind of Lesson, but saves leak, land in the wrong place,
and restatements never merge. Recall against the three named fixes is blocked on the LLM.**

Evidence (`/ship` gained its Lessons step in devex b70f06d on 2026-10-24; transcripts in
`~/.claude/projects` scanned for `/ship`, `**Lessons**` report lines and
`memory_lesson_save` calls):

- 47 transcripts ran `/ship` since then. 25 saved at least one Lesson, 19 carry a Lessons line,
  6 ended `Lessons: none`.
- **Delivery leak**: at least 4 runs found Lessons they could not save, because the tool was
  not loaded in the Session (3) or the daemon was unreachable (1). The Lesson is lost, with
  only the report line left.
- **Precision**: a hand review of 28 Lessons below 0.8 (the /ship-saved ones, not imports)
  found all 28 hard-won and specific (cause, fix and symptom). Problems were placement: 1 saved
  under the wrong project (a broker race filed under agentmemory-sqlite), 1 that is really a
  fix to the `/ship` skill itself, saved in an unrelated project.
- **Duplicates**: word-set Jaccard on content finds 2 cross-project pairs at ≥ 0.5 (0.98 and
  0.70) and 6 same-project restatement pairs at ≥ 0.2. None is merged, because reinforcement
  needs identical text; that is why only 2 of 197 were ever reinforced.
- **The three named fixes** (the fastembed/Pillow cap and concurrent vector-table drop in
  knowledge-base, the urllib PDF fall-through in medical-researcher) have no Lesson.
  knowledge-base's 4 Lessons are about other things; medical-researcher has none.

What remains unknown: capture recall. `eval:replay` (synthetic) cannot measure it: replay
import derives Lessons only from assistant and user sentences starting with a trigger word
(`extractLessons`, `src/functions/replay.ts:80-130`, saved at 0.4 as `consolidation`), while
`/ship` saves them by an Agent MCP call that replay never makes.

Blocked measurement (needs the LLM): run the `/ship` Lessons step as a prompt over the
knowledge-base Session `cbf10bf3` and the medical-researcher Session `8e960884` (positives),
and over the commits `46e2e02`, `839faa7`, `41ceca0` and `5b56891` (negatives: routine work
that should yield `Lessons: none`). Score: each named fix captured with its cause, fix and
symptom; no Lesson from a negative. Arms: the current step vs a step that adds "search
existing Lessons first and re-save the matching one verbatim".

## Q2: what counts as "used", and how long should a Lesson last?

**Answer: no signal says a Lesson was used today. A file-touch proxy separates injected from
non-injected Lessons, and the recurrence of those touches fits a decay of about 0.025 per
active week with no never-delete exception. Both are proposals, not validated.**

Evidence:

- **Exposure**: a simulation of the current ranking over the live store pins only 42 of 197
  Lessons in any project. At about 193 tokens each, the 800-token share holds about 4 Lessons
  before any pinned rule; the simulation pins devex 3, homelab 2, inference-runtime-broker 2,
  glydr 1, template 3. The 0.8 imports
  outrank `/ship` Lessons (19 of the 111 below 0.8 are ever pinned), and the 4 project-less
  Lessons take 4 of compass's 5 slots.
- **Injection records** (41 Sessions since 11-01, 7-day retention): session start injected
  852 Lesson refs, pre-compact 516; prompt-submit none. 56 distinct Lessons were shown.
- **Use proxy** (a later Observation in the Session touches a path-like tag of the Lesson;
  126 of 197 Lessons have one): injected 23 of 101 scorable pairs (22.8%), against a control
  of same-project Lessons not injected at 11 of 168 (6.5%). Hand review of the 23: about 8
  match through broad tags (a skills directory, a docs directory, a shared script) and are
  spurious; about 15 are a Session working where the Lesson applies. Whether the Agent acted
  on the Lesson is not observable.
- **Recurrence**: of 105 Lessons with file-level tags (a tag with an extension), 86 had a file
  touched in at least one week of the 806 stored Sessions and 75 in at least two. The gap
  between touched weeks, in active weeks of the project, is p50 1, p75 1, p90 2, max 7
  (n = 209). The store starts 2026-08-21, so gaps longer than about 12 active weeks cannot be
  seen.

Proposals:

- **Used** = shown at session start or pre-compact, then a file touch on a file-level tag
  (not a directory or shared-script tag) later in the Session, counted at most once per
  Session. Lesson refs would need to carry those files for `injectedItemUse` to score them.
  Validate against a hand-labelled set of shown/touched pairs before reinforcing on it.
- **Retention**: reinforcing on every touch would keep almost every Lesson forever, since
  most tagged files recur within 2 active weeks. Decay at about 0.025 per active week instead
  (0.5 reaches 0.1 in 16 active weeks, beyond the longest observed gap of 7), reinforce on
  "used" as defined above, and drop both the 0.05 floor and the delete's
  `reinforcements === 0` condition (`lessons.ts:365`), so a reinforced Lesson also expires
  (confidence − 0.1) / 0.025 active weeks after its last use: 16 from 0.5, 28 from 0.8.

What remains unknown: whether "used" by file touch means the Lesson helped, and gaps longer
than the store's 12 active weeks.

## Q3: should Lessons reach prompt-submit, and how?

**Answer: not through a raw BM25 floor. Only through the reranker gate, and that arm is
blocked on the broker.**

Evidence (BM25 over the live Lessons with `SearchIndex` and `lessonToObservation`, queried by
Operator-typed prompts since 10-24 from main-Session transcripts; harness messages and
continuations removed; a prompt counts only when its project already had a Lesson):

- 1893 typed prompts, 840 eligible. Top Lesson score p50 5.2, p75 8.5, p90 11.9.
- Prompts that would fire: 448 at floor 5 (prompt-submit's current floor), 250 at 8, 144 at
  10, 35 at 15.
- A hand-judged sample of 21 fires at floor 10 found about 0 relevant. A small Lesson index
  gives high BM25 scores to common words, so an absolute floor fires on noise.
- Indexing `context` (the symptom) or not changes the top Lesson on 131 of 840 prompts and
  fires at floor 10 on 144 vs 134. Prompts rarely state the symptom, so they cannot show
  whether the symptom field earns its place; tool errors are where symptoms appear, and no
  Observation type marks one.
- Latency of the Lesson search: p50 0.17 ms, p95 0.83 ms. The 500 ms prompt-submit ceiling is
  at risk only from a larger gate pool.

Blocked measurement (needs `AGENTMEMORY_PROMPT_RERANK` on, so the broker): a separate corpus
of Lessons, symptom probes, tool-error probes and distractors, kept apart from
`coding-agent-life-v2` like `eval/data/pinned-rules`. Arms: A main (no Lessons); B Lessons in
the 10-candidate gate pool; C one slot of 3 reserved for the best gated Lesson; each with and
without `context` indexed. Metrics: precision, no-answer clean, and prompt-submit p95 under
the `eval:gate` 500 ms ceiling.

## Q4 blockers

Retiring `docs/LESSONS.md` has already started: inference-runtime-broker, template,
reverse-engineering, compass and nanokvm-boot-lab have retired theirs. homelab (17 entries),
glydr (6), curator (4, with 0 Lessons in the store) and knowledge-base (1) still keep one.
Before more go:

- **Silent loss**: an imported 0.8 Lesson that is never reinforced decays to 0.1 in 14 active
  weeks and is hard-deleted, and nothing reinforces it but an exact re-save. The retired
  files' contents will go without notice.
- **Exposure**: 42 of 197 Lessons are ever pinned (56 were shown in a week of Injection records); imports crowd out `/ship` Lessons, and
  project-less Lessons fill small projects' slots.
- **No prompt-time path**: a Lesson reaches the Agent only at session start and pre-compact.
- **Placement**: split project names, Lessons with no project, and the save-delivery leak.
- **curator** would lose its 4 entries outright: none are in the store.
