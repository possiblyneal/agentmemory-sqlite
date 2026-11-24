# Outcome-triggered Rule review (#561)

## Frozen comparison

Baseline `c23a8847`. A prior `mem::context` Injection identifies the recalled Rule in each synthetic pair. The baseline stays unchanged. The offline treatment flags a disagreement with that Rule, then looks up a separately supplied approved requirement before changing only the fixture's in-memory Rule. Both arms call the actual startup renderer for the next task. Cases: truly outdated Rule, non-Memory execution failure, and agreement. Require at least one more next-task correct Rule, no unverified or unrelated writes, and at most one false flag. Record reviewer workload and scripted lookup time separately. No Operator participated, so Operator review time remains unmeasured. No live store or repository holdout was used.

## Results

Correct Rules in the next startup Injection rose from 2 of 3 to 3 of 3. The treatment flagged two outcomes; one was a false flag from a non-Memory failure. The independent requirement blocked that rewrite and allowed only the outdated Rule's correction. The unrelated and foreign-project rows stayed unchanged in all pairs. The two scripted reviews took about 0.065 ms combined in memory; neither Operator review time nor subsequent Agent behavior was measured.

**Verdict: inconclusive for real use.** The fixture met the frozen screen but supplied the link from failure to Rule and the approved source. Retry on independently adjudicated failures, including non-Memory causes, with actual Operator review time and blinded next-task action scoring.

Reproduce with `npx tsx eval/runner/outcome-review.ts`; `npx vitest run test/eval-outcome-review.test.ts` checks the approval guard and subsequent delivery.
