# File-tagged Lessons immediately before the first edit (#539)

## Design

- **Baseline revision:** `d8d7346087ad6e262c0efdfd6fe8b128fca6b2ea`. The three arms are synthetic harness placements: the same file-tagged Lesson in startup context, immediately after the exact target path and file contents, or absent. The startup arm puts a fixed repository tour between the Lesson and task. No required host hook or production behavior changed.
- **Cohort:** Three format-sensitive edits to synthetic files. Each arm produces one first edit as a proposed path and complete new content. Independent content checks score whether the task edit is usable and whether it violates the file convention. No live files, private records, or holdout used.
- **Settings:** `general-eval-b`, one slot, temperature 0, seed 42, 2,048-token ceiling. Serial calls with the first arm rotated across cases. `ai.lan` reported 55 GiB available after the loaded-model probe and 55 GiB after the run.
- **Pre-measure rule:** Fewer first-edit violations than both controls, and no increase in aggregate model call time relative to either. Model call time does not include tool or task execution.

## Results

| Arm | Usable edits | Violations | Aggregate call time (ms) |
|---|---:|---:|---:|
| Startup | 3 of 3 | 0 | 4,462 |
| Just in time | 3 of 3 | 0 | 4,190 |
| No Lesson | 3 of 3 | 2 | 3,948 |

Both Lesson placements avoided the capitalization and zero-padding violations seen without a Lesson. None of the arms violated the lowercase-status convention. Just-in-time delivery did not beat startup on violations and was slower than no Lesson on aggregate call time. The measured time is a single small serial comparison, not a policy-level latency estimate.

**Verdict: inconclusive for real workflows.** The synthetic test finds value from showing the Lesson but no incremental benefit from moving it later. Retry with paired longer agent sessions where startup and first edit are separated by meaningful intervening work, judged first patches, and end-to-end task time. Keep exact paths and independently labeled edit constraints fixed across arms.

## Reproduction

`npx tsx eval/runner/first-edit-lesson.ts` sends synthetic prompts to the local `general-eval-b` endpoint. It checkpoints each first-edit proposal and result under `tmp/first-edit-lesson/`; `--resume` skips saved trials for the same revision and runner. The harness does not apply proposals to project files.
