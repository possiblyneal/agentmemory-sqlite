# Recall budget allocation (#560)

## Frozen comparison

Baseline revision `bba7b848`. A small synthetic two-boundary replay isolates final allocation: the fixed control assigns roughly two-thirds of whole-record slots to startup and the rest to prompt submit. It is a modeled fixed policy, not the production defaults. Development selects a shift of zero, one or two slots toward prompt submit at a five-slot budget, maximizing absolute correct deliveries and preferring no change on ties. Apply the learned shift without refitting at four- and six-slot held-back budgets. Records, preset rank order, project eligibility, visibility times and stored bytes stay identical; both arms use zero model calls. Every slot has the same estimated token cost. No repository holdout was used.

Require a strict gain in absolute deliveries at an equal budget on at least one held-back budget, with no loss on either surface at either budget, no foreign or future record, and no additional cost. This prototype tests reallocating a fixed token budget, not choosing which bytes to retain or the full Recall frontier.

## Results

The two development Sessions delivered 4, 6 and 8 correct records for shifts of zero, one and two slots respectively. The learner chose two slots.

| Held-back estimated tokens | Startup correct, fixed → learned | Prompt correct, fixed → learned | Total correct, fixed → learned |
|---:|---:|---:|---:|
| 32 | 1 → 0 | 0 → 2 | 1 → 2 |
| 48 | 1 → 1 | 1 → 2 | 2 → 3 |

Both arms used 1,424 serialized bytes in each pair and emitted no foreign or future records. The lower budget gained one correct delivery overall but lost the startup decision before it was needed. The aggregate frontier alone misses that loss.

**Verdict: rejected for the tested two-slot shift.** It violates the frozen startup tolerance. Retry with a policy that protects critical per-surface deliveries and matched real replay checkpoints with independent labels at several byte, token and model-spend budgets. A gain against the production defaults and the effect of choosing which bytes to retain remain unmeasured.

Reproduce with `npx tsx eval/runner/budget-allocation.ts`; `npx vitest run test/eval-budget-allocation.test.ts` checks the held-back startup tradeoff.
