# Synthetic Compression for successful command retries (#540)

## Design

- **Baseline:** `b1278ebd1f72c0d1c12a720f996b296f13d72dcc`. Within each synthetic Session, the unchanged command fails, a configuration edit intervenes, and the command succeeds in the same directory. The normal arm batches all three Observations. The treatment batches the failure and edit and stores the success synthetically using the existing production functions in an in-memory fixture.
- **Cohort:** Two paired retries, one with short verification output and one with a novel checksum in the middle of otherwise routine trace lines. The fix identifier is scored in the edit record; the verification value is scored in the success record. Scoring checks stored titles, narratives, and Facts for the fixture's known literals, not whether an Agent received or understood them. No private inputs or holdout used.
- **Settings:** `general-eval-b`, temperature 0, seed 42, 2,048 output tokens, serial calls with arm order reversed for the second retry. `ai.lan` reported 55 GiB available after the successful generation probe and after the comparison.
- **Pre-measure rule:** Lower summed model-call time with no paired loss of a fix or verification detail.

## Results

| Arm | Fix retained | Verification retained | Model calls | Model time (ms) |
|---|---:|---:|---:|---:|
| Normal batch | 2 of 2 | 2 of 2 | 2 | 46,433 |
| Synthetic success | 2 of 2 | 1 of 2 | 2 | 33,902 |

The treatment took less model time in both pairs but dropped the checksum from the successful retry's output. There was no difference in call count and no degraded record at flush. These timings measure provider calls in one serial synthetic comparison, not daemon or task latency.

**Verdict: rejected for unconditional substitution.** Retry if a candidate preserves novel details from the middle of successful output and matched real retries can test its model-time savings against the existing batch path.

## Reproduction

`npx tsx eval/runner/retry-compression.ts` uses the local `general-eval-b` profile and checkpoints each trial under `tmp/retry-compression/`. `--resume` skips completed trials with the same baseline revision and runner hash.
