# Failed Summary chunk coverage — 2026-11-22

**Hypothesis (#510):** Capping `coveredThrough` at the earliest failed chunk leaves skipped Observations eligible for retry and ineligible for Summary-backed eviction.

**Fault fixture:** `test/summarize.test.ts` forces the middle chunk to fail persistently while the other chunks produce partials. On baseline `1481d6a8`, the Summary claimed coverage beyond the failed chunk; the candidate passed the same watermark assertion while retaining the useful partials.

**Recall guard:** `npm run eval:coding-life -- --llm --adapters agentmemory-bm25` with isolated sandboxes. The ordinary coding-life corpus did not induce a failed chunk; the fault fixture is what measures it. No embedding attempts were observed in either sandbox log.

| Surface | Queries | Baseline Recall | Candidate Recall |
|---|---:|---:|---:|
| Search | 12 | 0.950 | 0.950 |
| Session start | 2 | 0.125 | 0.125 |
| Prompt submit | 9 | 0.250 | 0.250 |

**Verdict:** Keep for the verified failure case. The paired Recall run is a regression check, not a latency or provider reliability measurement.

## Review corrections on `a9fa3e13`

Paired synthetic regressions, with scripted provider responses and isolated test stores:

| Fixture | Base | Corrected |
|---|---|---|
| Stale recovery writes a partial Summary | Counted the Session as evicted | Keeps the Session and its uncovered rows through the sweep; retries them on the next sweep |
| Oversized incremental fold after prefix Eviction | Fallback lost the prior-only decision | Fallback preserves the prior and new decisions |
| Identical Stops with pending Compression as the sole blocker | Did not reuse the Summary | One model call over the initial Stop and two identical repeats; Compression completion triggers another call |

The chunk fixture also verifies that a pending watermark does not suppress a failed-chunk retry.
These fixtures measure coverage, preservation, and call reuse; they do not measure live-provider Recall or latency.
