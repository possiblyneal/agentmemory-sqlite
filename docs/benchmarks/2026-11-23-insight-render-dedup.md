# Render repeated Insights once at Session start (#537)

## Design

- **Baseline:** `16512a3d54a56faa3b4b6213405b7215347c9aa0`, unchanged `mem::context`.
- **Treatment:** In an isolated build, keep the first rendered instance of each exact Insight body after the production top-five selection and ordering. Different bodies are untouched even if they overlap heavily. This tests identical bodies with generic titles, not semantic equivalence or significant qualifiers in titles.
- **Cohort:** One synthetic checkpoint with three copies of one body and two overlapping but distinct bodies. A frozen key checks five separately visible details, including time limits and exceptions. Both arms use the same 2,000-token budget and source records. No holdout, private records, or live store used.
- **Pre-measure rule:** Save at least 8 estimated tokens, preserve all needed details, and do not mutate any Insight.

## Results

| Measure | Baseline | Treatment |
|---|---:|---:|
| Estimated Injection tokens | 248 | 176 |
| Needed details visible | 5 | 5 |
| Additional copies of the repeated body | 2 | 0 |

The treatment saved 72 estimated tokens with no lost qualifier or change to the stored Insights. It passes the synthetic screen. The fixture does not measure how often duplicate bodies occur or whether their different titles carry information in real Sessions.

**Verdict: inconclusive for real use.** Retry with real project checkpoints showing repeated bodies, independently labeled title and body qualifiers, and a paired SessionStart budget test. The synthetic result is not rollout evidence.

## Reproduction

`npx tsx eval/runner/insight-render-dedup.ts` prints the paired result. `npx vitest run test/eval-insight-render-dedup.test.ts` verifies the fixture. The guarded prototype is built under `tmp/insight-render-dedup/`; production source is unchanged.
