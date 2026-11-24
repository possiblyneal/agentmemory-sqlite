# Skipping amendment lookups near the Injection deadline (#536)

## Design

- **Baseline:** `4a7834742c033a64feff6d1a7a8de186a865a5fb`, the production `mem::prompt-context` registrar with its amendment lookup.
- **Treatment:** In the synthetic `mem::search` adapter, skip the lookup's work and return no amendment when less than 200 ms remains. Both arms use the production hook's 2,500 ms cutoff; a virtual clock advances by the assigned search costs. Neither arm invokes the reranker. No production code changed.
- **Cohort:** Four synthetic pairs, crossing a present or absent reversal with primary work of 1,450 or 2,350 ms. Amendment work costs 240 ms whenever performed. This holds simulated load constant. The first rendered decision is the action proxy; a result that reaches or exceeds the cutoff counts as missed. These costs are inputs, not latency measurements. No holdout used.
- **Pre-measure rule:** More timely correct decisions, with no increase in timely stale decisions.

## Paired results

| Outcome | Baseline | Treatment |
|---|---:|---:|
| Timely correct rule | 2 | 3 |
| Timely stale rule | 0 | 1 |
| Missed Injection | 2 | 0 |

Both skipped lookups avoided a timeout. With no reversal, the rule became useful in time. With a reversal, the old rule was delivered in time instead. The faster arm fails the stale-rule criterion.

**Verdict: rejected in the synthetic screen.** Remaining time alone cannot distinguish the two late cases in this fixture. This result does not estimate frequency, real queue behavior, or Agent actions. Retry with a candidate that can avoid delivering an unverified rule in the reversal case and a matched-load replay with real end-to-end timings.

## Reproduction

`npx tsx eval/runner/amendment-deadline.ts` prints the aggregate. `npx vitest run test/eval-amendment-deadline.test.ts` verifies the fixture.
