# Distinguish Operator instructions from implementation notes (#545)

## Design

- **Baseline:** `3132e664041c405923c52f7007af40ba22ead860`. Use production `mem::prompt-context` rendering with a fixed Search hit and the Gate off. The treatment replaces the blanket requirements header with source guidance and adds two labels. Both arms preserve the exact decision text, order, and Session heading.
- **Cohort:** Four paired synthetic tasks. Each includes a known Operator instruction and an implementation note phrased as an instruction. The current task conflicts with the note while leaving the genuine requirement in force. The model selects one proposed value, scored by a frozen choice key without consulting the arm. No action was executed. Attribution comes from fixture design, not inference from private Sessions; no holdout was used.
- **Settings:** `general-eval-b`, temperature 0, seed 42, 2,048 output tokens, serial calls with alternating first arm. `ai.lan` reported 55 GiB available after the generation probe and after the trial.
- **Pre-measure rule:** Fewer non-mandatory notes followed as rules, with no increase in genuine-instruction violations or invalid responses.

## Results

| Arm | Valid choices | Correct choices | Notes treated as rules | Genuine instructions violated |
|---|---:|---:|---:|---:|
| Production rendering | 4 of 4 | 3 of 4 | 1 of 4 | 0 of 4 |
| Source-labeled rendering | 4 of 4 | 3 of 4 | 1 of 4 | 0 of 4 |

All paired choices were identical. In both arms the model applied the old capitalization convention despite the task's default and the genuine Rule permitting title case. This test does not estimate how often source labels would change real Agent actions.

**Verdict: inconclusive for real replay; no gain in this screen.** Retry on a matched cohort with verified source attribution and independently judged natural edits, including cases with several conflicting notes and genuine requirements. Keep exact decision text and order fixed.

## Reproduction

`npx tsx eval/runner/instruction-labels.ts` uses the local `general-eval-b` profile. `--resume` skips completed trials at the same baseline and runner hash. Raw synthetic trials are checkpointed under `tmp/instruction-labels/`.
