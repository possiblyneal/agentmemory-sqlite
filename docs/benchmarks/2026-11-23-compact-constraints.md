# Current-task constraints at pre-compact (#543)

## Design

- **Baseline:** `bfa6971bbb76ffc40d971f7476f588dbef988d3d`. This is an action trial, not an implementation of the hook. Both arms get the same pinned Rule, simulated compacted transcript, and possible next actions. An equal-length Recall block presents either generic project history or already-known decisions about the active task. Matched context budgets were 60, 62, and 63 estimated tokens, all under the production pre-compact budget of 1,500; model-token counts were not measured.
- **Cohort:** Three synthetic tasks with known first outstanding actions, completed actions, and forbidden actions. The model selects one next action; nothing is executed. No private data or holdout used.
- **Settings:** `general-eval-b`, temperature 0, seed 42, 2,048 output tokens, serial calls with alternating arm order. `ai.lan` reported 55 GiB available after the successful generation probe and after the trial.
- **Decision rule:** Fewer repeated actions and constraint violations, with no increase in Missed Injections or loss of a required pinned Rule. The fixture can detect a changed Rule block, wrong proposed action, or invalid result; it cannot measure Missed Injections.

## Results

| Arm | Valid responses | Correct next action | Repeated actions | Constraint violations |
|---|---:|---:|---:|---:|
| Generic history | 3 of 3 | 1 of 3 | 2 of 3 | 0 of 3 |
| Active-task decisions | 3 of 3 | 3 of 3 | 0 of 3 | 0 of 3 |

Two paired gains in correct next action, no paired losses. Both gains avoided repeating a completed check. Pinned Rules were identical by construction. There were no violations in either arm, so their reduction and the effect on Missed Injections were not established.

**Verdict: inconclusive for pre-compact rollout.** Retry with matched real compaction turns with independently labeled outstanding actions and unresolved constraints; use the actual hook and measure Missed Injections and pinned Rule rendering under load.

## Reproduction

`npx tsx eval/runner/compact-constraints.ts` sends synthetic first-turn prompts to the local `general-eval-b` profile. It checkpoints results under `tmp/compact-constraints/`; `--resume` checks the baseline and runner hash before skipping completed trials.
