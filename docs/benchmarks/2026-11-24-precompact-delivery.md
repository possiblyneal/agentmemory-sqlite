# Nonempty PreCompact Injection delivery (#578)

## Delivery

Claude Code `2.1.330`, manual `/compact` in a fresh headless Session with `AGENTMEMORY_CAPTURE_HEADLESS=1`. A temporary Agentmemory daemon held one synthetic project Rule containing a unique marker not present in the task prompt. A pilot-only wrapper recorded stdout from the unchanged built `pre-compact.mjs` and forwarded it to Claude Code. A loopback Anthropic-protocol test receiver recorded marker presence in actual model requests and returned fixed responses. There was one linked main-chain boundary and compaction Summary.

| Surface | Rule marker present |
|---|---|
| Initial task request | No |
| PreCompact hook stdout | Yes, 333 bytes of context |
| Compaction requests | Yes, 2 of 2 |
| First resumed task request | Yes |

A separate `UserPromptSubmit` marker reached the subsequent control request, confirming the receiver could distinguish the two injections. With the headless opt-in omitted, a prior seeded probe emitted no context; that probe measured the configured guard, not delivery. This verifies delivery for manual headless compaction with capture enabled, not automatic or interactive compaction.

## Next-action diagnostic

One real coding checkpoint from the [capture pilot](./2026-11-24-precompact-local-pilot.md), with its actual compacted Summary and matching restored checkout status, was presented to `general-eval-b` at temperature 0 and seed 42. The baseline used the captured empty hook output; the treatment appended a hand-selected restatement of constraints verified in the pre-boundary task prompt. The correct action was keyed before inference. This measured action selection, not execution, and did not exercise automated selection, matched nonempty Recall, or actual hook delivery of the treatment.

| Measure | Baseline | Treatment |
|---|---:|---:|
| Correct next action | 1 of 1 | 1 of 1 |
| Prompt tokens | 1,577 | 1,609 |
| Total model tokens | 2,652 | 2,505 |
| Model request time | 49.68 s | 44.15 s |

Both selected verifying the existing edits without changing the index. The Summary already mentioned staging and committing. The paired outcome was a tie; the total token and timing differences are single-run observations, not a demonstrated saving.

**Verdict: delivery verified; usefulness inconclusive.** Do not ship or discard #543 based on one tie. Retry when there are independent, restorable dev compactions with representative nonempty Recall, including routine compactions and cases whose Summary omits a still-live constraint. Measure paired discordance on dev before freezing the sample size and opening holdout under the [approved threshold](./2026-11-24-precompact-real-preflight.md). No holdout or production changes; raw Session data and per-arm receipts stayed local.
