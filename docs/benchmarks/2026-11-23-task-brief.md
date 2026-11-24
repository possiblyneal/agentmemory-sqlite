# One task-specific memory brief (#559)

## Frozen comparison

Baseline `d93901eb`. Each synthetic pair runs the production `mem::context` and `mem::prompt-context` renderers against the same store. A fixed project-scoped Search hit and disabled Gate isolate presentation. The isolated compiler extracts whole Rules, Summary decisions and explicitly marked evidence. At startup it has no prompt; at prompt submit it deduplicates decisions and orders them by exact word overlap with the task. It sees only the two texts already available by that boundary. The scripted compile failure returns the ordinary prompt-submit text; its time and fallback tokens count against the treatment.

Require at least one more correct first applicable decision by the requested turn, fewer aggregate estimated tokens across both boundaries, and zero added stale-first answers, omitted Rules or exceptions, or scope leaks. Include a real exception, a duplicated ordinary decision and the scripted failure. Score order with an independent expected decision for each fixture, reading the latest Injection first. This is a delivery proxy, not a model action or repository holdout. Report local synthesis time including failure and fallback.

## Results

| Metric | Current startup and prompt submit | Brief with fallback |
|---|---:|---:|
| Correct first applicable decision | 2 of 3 | 3 of 3 |
| Inapplicable default first | 1 of 3 | 0 of 3 |
| Estimated tokens across both boundaries | 818 | 362 |
| Rule or evidence omissions | 0 | 0 |
| Foreign claims | 0 | 0 |

The brief moved the needed exception ahead of the general default without deleting either. It retained the Rule and marked evidence in every pair. One of three prompt compilations was scripted to fail; that prompt used ordinary Recall and the pair consumed 176 rather than 261 tokens solely from the shorter startup brief. Local synthesis across all three pairs, including the failed attempt, took about 0.611 ms. The failure rate is fixture design, not an estimate.

**Verdict: inconclusive for actual task effectiveness.** The compiler passed the synthetic delivery screen. It uses labeled evidence and extracts only the fixture's supported shapes; the gain is an ordering proxy and the token savings partly remove renderer framing and metadata whose importance is unmeasured. Retry on paired real boundary traces, with independently judged Agent actions, needed file references, unstructured evidence, and observed compile failures under the hook deadline.

Reproduce with `npx tsx eval/runner/task-brief.ts`; `npx vitest run test/eval-task-brief.test.ts` checks ordering, deduplication and retention.
