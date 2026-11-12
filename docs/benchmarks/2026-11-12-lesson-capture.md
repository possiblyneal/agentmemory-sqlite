# 2026-11-12 — /ship Lesson capture: recall and precision

**Commit:** `106f184a` (origin/main; no code under test, the store is the Operator's live one)
**Bench:** the Operator's merged `fix:`/`perf:` PRs and the Lessons in the live store, read-only
**N:** recall 63 PRs (41 holding hard-won knowledge); precision 40 Lessons, stratified by project
**K:** —
**Hardware:** Debian 13, 8 cores, Node 22.23.4
**Embeddings:** none
**LLM:** none; every verdict is a hand judgement

## Headline

`/ship`'s Lessons step captures most of what it should, and most of what it stores is worth
keeping. Recall is 30 of 41 (73%): 30 of the 41 PRs that held hard-won knowledge have a
same-project Lesson saved within about a day of the merge that records it. On PRs a `/ship` run
landed it is 27 of 35 (77%). Precision is 37 of 40 (93%) for hard-won content and 33 of 40 (83%)
for the right project. 30 of 40 (75%) are both.

Of the 11 misses, 4 were tooling failures: the daemon was unreachable, or `memory_lesson_save`
was not loaded and the run fell back to `memory_save`. Without those, recall is 30 of 37 (81%).
The project is the weaker half. 30 of the 217 Lessons that runs saved carry a project no Session
uses.

## Definitions

- **Hard-won knowledge**: a cause, constraint or workaround that the next agent in the repo
  would get wrong without being told. It cannot be guessed from the symptom or read off the diff.
  A one-pass review finding qualifies.
- **Captured**: a Lesson in the live store with the same project, created between one day
  before the PR was opened and one day after it merged, that records that knowledge.
- **Project correct**: the Lesson's `project` is the name the repo's Sessions use, the one
  `resolveProject()` gives the main checkout. A guessed name (an Orca workspace name, a name
  without its `-<6 hex>` suffix, or none) is wrong. So is a correct name on knowledge that
  belongs to another repo.

## Window

The Lessons step entered `/ship` with devex PR #186, merged 2026-10-24T22:29Z, and was refined
on 10-25 and 11-06. The window runs from that merge to 2026-11-12. The issue's suggested start
was the 11-05 burst of Lessons, but that burst is the `docs/LESSONS.md` import (one Session, 75
saves). Every Lesson has `source: "manual"`, so the store cannot tell a `/ship` save from any
other save. The start comes from the skill's history instead.

## Recall

All 63 merged `fix:`/`perf:` PRs across the 25 repositories the Operator pushed to in the
window (260 merged PRs in all), 14 of which had one. Each PR was linked to the Sessions that ran
on its head branch and named its URL. The PR body, those Sessions' final **Lessons** lines and
their `memory_lesson_save` calls were read, and the candidate Lessons in the store were checked.

| Slice | PRs | Hard-won | Captured | Recall |
|---|---|---|---|---|
| All | 63 | 41 | 30 | 73% |
| Landed by a `/ship` run | 50 | 35 | 27 | 77% |
| No `/ship` Session | 13 | 6 | 3 | 50% |
| `fix:` | 47 | 33 | — | — |
| `perf:` | 16 | 8 | — | — |

| Repository | Captured / hard-won |
|---|---|
| agentmemory-sqlite | 11 / 12 |
| glydr | 5 / 5 |
| devex | 4 / 7 |
| reverse-engineer | 3 / 4 |
| homelab | 2 / 5 |
| inference-runtime-broker | 2 / 3 |
| knowledge-base, medical-researcher, template | 1 / 1 each |
| compass, tasks-md | 0 / 1 each |

22 PRs held no hard-won knowledge. Most were routine `perf:` changes whose reason is read off the
diff, and dependency-advisory bumps that came with the `docs/LESSONS.md` retirement. Two fixed
`/ship` or `/close` itself: their knowledge went into the skill text, which `/ship` routes to
**Skill fixes**, not to Lessons.

### Misses

| Cause | PRs |
|---|---|
| The run ended with a Lessons line, or none, and the PR's cause was never saved | 6 (4 `/ship`-run) |
| Daemon unreachable at the Lessons step | 2 |
| `memory_lesson_save` not loaded; saved with `memory_save` as a Memory | 2 |
| No `/ship` Session (PR made by hand or by a follow-up) | 1 |

The six "never saved" PRs share one shape. The run saved a different, smaller Lesson (a test
or tooling gotcha) or reported none, and the root cause stayed only in the PR body. Two counted
captures are partial in the same way: the Lesson records a constraint the work hit, not the cause
the PR fixed. Counting only root causes, recall is 28 of 41 (68%).

## Precision

40 of the 217 Lessons runs saved in the window, drawn in proportion to each project's count
(seed 317). The 75 imported `docs/LESSONS.md` entries are excluded, because the Lessons step did
not write them.

| Measure | Count | Rate |
|---|---|---|
| Hard-won (not a restatement of the symptom or diff) | 37 / 40 | 93% |
| Project correct | 33 / 40 | 83% |
| Both | 30 / 40 | 75% |

- The 3 that are not hard-won each restate their own symptom: a missing `node_modules` fixed by
  `npm ci` (also saved twice, in different words), a 600 s timeout that says "run it in the
  background", and a merge conflict at a ledger's tail.
- 4 of the 7 wrong projects are one guessed name: a repo whose bare basename an earlier probe
  repo claimed, so its Sessions carry a `-<6 hex>` suffix the Lessons lack. 2 are knowledge
  filed under the repo the Session happened to run in (broker and homelab facts saved from
  agentmemory-sqlite and devex Sessions). 1 has no project.
- Across all 217, by name alone: 30 (14%) carry a project no Session uses. Of those, 19 use the
  bare unsuffixed name, 6 an Orca workspace name, 4 none and 1 the GitHub repository name where
  Sessions use the checkout's. #381 (merged 2026-11-11) now refuses
  a project nothing uses. Its dry-run rename script has not been applied to the live store: all
  19 bare-name Lessons are still filed under it.

## Methodology

- The store was read only through `node:sqlite` `new DatabaseSync(path, { readOnly: true })`.
- `memory_lesson_save` calls came from the Operator's `~/.claude/projects` transcripts. 282 of
  the 293 stored Lessons map to a call.
- PRs came from `gh pr list --state merged` across the Operator's repositories.
- One reviewer judged every item and the verdict files are private. A second judge was not run,
  so treat a ±3-item swing as noise.
- `eval:replay` cannot measure this, because it replays hooks and not `memory_lesson_save`
  calls.

## Notes

- Tooling, not judgement, causes over a third of the misses. A run that cannot reach the daemon,
  or whose session has not loaded `memory_lesson_save`, says so in its report and saves nothing,
  or saves a Memory instead. Nothing retries the Lesson later.
- Re-saves in different words are visible in the sample (`node_modules`, skills symlinked into
  the devex clone). This matches the 0.14–0.27 Jaccard band in the 2026-11-11 row: the
  near-twin merge does not catch them.
