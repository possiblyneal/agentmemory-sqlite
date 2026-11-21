# Prefix scoring experiment

## Hypothesis and method

On base `fdc3d459`, suppress a prefix sibling's bonus when a document already matches the exact query term. Compare the prototype with the base using the fast evaluation suite and the coding-life gate. The prototype was reverted; it is not part of this change.

## Results

| Metric | Base | Prototype |
|---|---:|---:|
| PrecisionMemBench pass | 0.447 | 0.468 |
| PrecisionMemBench active pass | 0.391 | 0.435 |
| Prompt-submit precision | 0.889 | 0.856 |

The pass difference was 0.021 with confidence interval [0.000, 0.106]; active pass had interval [0.000, 0.217]. PrecisionMemBench precision rose 0.014. Coding-life dev and LongMemEval did not change. The prompt-submit precision loss exceeded the gate's 0.02 tolerance, so the prototype failed the gate.

## Verdict

Inconclusive. Retry if a fuller PrecisionMemBench or LongMemEval run shows a gain whose interval clears zero and the prompt-submit loss is traced to a fixable gate item; or if the fast suite shows a LongMemEval or coding-life dev gain without a PrecisionMemBench loss. Evidence and scope: #467.
