# Session-start Summary shortening (#532)

## Verdict

**Inconclusive for real usage.** A deterministic synthetic screen demonstrates both a decision gain and a file-name loss; the latter fails the prespecified zero-regression rule. It is not a representative paired cohort and cannot estimate the real-world effect. Do not ship this treatment on these results.

## Design

- **Baseline:** `12d2abbcad84f39fdedb99f256acac6c9738b78d`, unchanged `mem::context`.
- **Treatment:** an isolated bundled copy of that function changes only Summary rendering: when decisions exist, render title and decisions, omitting narrative and files. Summaries without decisions are unchanged. Source matching fails closed if the baseline renderer changes.
- **Cohort:** five separately seeded, synthetic in-memory checkpoints, each replayed through both registrars. They include budget pressure across two Sessions, a file-only need, a decision-only need, a file beyond the rendered cap, and a Session without a Summary. Needs are independently specified as exact text or path strings; all names and contents are synthetic.
- **Settings:** both arms use identical inputs, Session ordering and a 180-token ceiling. This intentionally small budget creates pressure and is not the usual production budget. No live store, model, provider or private labels were used. No holdout was examined.
- **Pre-measure rule:** at least one additional needed decision delivered, and zero losses of needed file names in visible Injection text. Count paired individual needs, not Summary refs or blocks. This is a synthetic screening threshold, not a real-world effect-size estimate.

## Paired results

| Needed item | Total | Baseline delivered | Treatment delivered | Gained | Lost |
|---|---:|---:|---:|---:|---:|
| Decisions | 3 | 2 | 3 | 1 | 0 |
| File names | 2 | 1 | 0 | 0 | 1 |

The decision criterion passes in this screen; the file criterion fails. The capped-file control is absent from visible text in both arms while still present in the baseline Summary metadata ref, confirming that scoring refs would overstate delivered file names. The no-Summary output matches, and the decision-only control's needed decision is visible in both arms. This fixture does not measure downstream task correctness, stale claims, representative budgets, latency, or real Operator needs.

The parent run reported that the matching archived decision key, verdict cache and replay corpus were not found locally; older checkpoint files alone do not supply a valid matched cohort. No private data was used to reconstruct one. Retry only when a matched checkpoint set, key and offline judgments are available, or with a candidate that preserves needed file names; use the normal dev/holdout process and prespecify an appropriate practical threshold before the holdout.

## Reproduction

Run `npx tsx eval/runner/summary-shortening.ts` from the repository root to print aggregate paired counts, and `npx vitest run --project shared test/eval-summary-shortening.test.ts` to check the fixed fixture. The runner builds its isolated prototype under `tmp/summary-shortening/`; it does not alter production source. The treatment's exact source transformation is tied to the baseline and must be reviewed if that guard fails.
