# Verify exact decision details against source (#550)

## Design

- **Baseline:** `de200a182487f7e38e4010799f9ea478a337505d`. Both arms use the same fixed, structured drafts. Control publishes each draft as given; treatment receives the same source dialogue and can replace at most one scalar detail after one model call. The draft generator, real Summary publication, and Injection are outside this test.
- **Cohort:** Four paired synthetic tasks: a wrong number, a flipped negation, a missing condition, and a correct control with a superseded proposal. The same fixed key scores both arms' resulting action values without using the arm label. No edit, private data, or holdout was used.
- **Settings:** `general-eval-b`, temperature 0, seed 42, 2,048 output tokens, serial calls. `ai.lan` had 54 GiB available after the usable generation probe and after the trial.
- **Pre-measure rule:** Fewer incorrect action values, with no decisions removed, no unsupported claims added and at most one extra verifier call per draft. This narrow proxy does not measure decision Recall.

## Results

| Metric | Fixed draft | Verified draft |
|---|---:|---:|
| Detail-specific errors | 3 of 4 | 0 of 4 |
| Decisions retained | 4 of 4 | 4 of 4 |
| Verifier calls | 0 | 4 |
| Time spent on verifier calls | 0 ms | 2,997 ms |

Each wrong draft was a paired gain, the correct control stayed correct, and all four verifier replies were valid. The verifier was only allowed to replace the existing decision value, not add claims. The fixtures were deliberately seeded with errors, so the trial does not estimate how often a live Summary is wrong, what a verifier does on ambiguous evidence, or whether it improves real Agent actions.

**Verdict: inconclusive for Summary publication.** Retry when matched drafts from real Summary inputs have source-linked errors and clean or ambiguous controls, and replay can test decision Recall, unsupported decisions, and blind scoring of downstream edits.

## Reproduction

`npx tsx eval/runner/decision-source-check.ts` runs the paired trial using the local `general-eval-b` profile. `--resume` validates the baseline and runner hash and skips finished pairs. Synthetic replies and timings stay under `tmp/decision-source-check/`.
