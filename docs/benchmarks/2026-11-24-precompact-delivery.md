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

## Disposition

**Do not adopt #543 on the current evidence.** The synthetic screen improved action selection; the only restored real-task diagnostic tied, and the archive audit found no matched cohort. The proposal did not demonstrate the required gain or clear the regression guardrails. That is a no-merge decision, not evidence that the underlying hypothesis is false. No holdout or production changes; raw Session data and per-arm receipts stayed local.

Retry in #578 only with independent, restorable dev compactions and representative nonempty Recall, including routine compactions and cases whose Summary omits a still-live constraint. The delivery trace shows that the hook can influence the compaction request itself. A frozen-Summary test can isolate continuation behavior, but an end-to-end test must start both arms before compaction and let each produce its own Summary. Measure dev paired discordance before sizing and opening holdout under the [approved threshold](./2026-11-24-precompact-real-preflight.md).

## Dev checkpoint collection

Two additional isolated repository tasks each yielded a linked manual compaction and a verified checkout restore. Both captures include pre-boundary transcript bytes, an isolated Memory export, and nonempty baseline hook stdout. The capture wrapper took 268.63 ms and 3,949.36 ms respectively, before running the baseline hook; these measurements are collection overhead, not production hook latency. Each Memory export was imported into a fresh isolated daemon. Exported record counts matched and the real hook reproduced the captured stdout byte for byte in both restores. Each isolated store held only the active Session, with no stored Summaries; baseline stdout contained Rules and Lessons but no prior-Session history. These checkpoints validate capture and restoration but do not represent the generic-history control in #543. For the paired test, capture against isolated stores with prior same-project history established before the enrolled task. No replacement policy, paired action grading, automatic compaction, or holdout was tested.

A later preflight generated a Summary from one of those completed dev Sessions, then restarted the isolated daemon and exported it. The unchanged hook emitted 2,763 bytes for a fresh Session in the same project, including the prior Summary. The REST context excluded that Summary for both its own Session and a different project. The export was imported before starting the next dev task. The next dev task yielded one linked manual compaction and a matching checkout restore. Its capture wrapper imported 24 active-Session Observations and took 540.14 ms before running the hook. The unchanged hook rendered the prior Summary. A fresh daemon restored matching record counts and reproduced all 3,028 bytes of hook stdout. This verified a history-backed control checkpoint before paired replay.

## Paired dev replay

Both arms started from the same pre-boundary transcript, checkout, and restored Memory. Each ran manual compaction and generated its own linked Summary, then resumed on `general-eval-b` with the same continuation prompt and only the `Read` tool available. The treatment preserved the Rules and Lessons and replaced the prior Summary with a hand-written restatement of active-task constraints. It ran first in seeded randomized order. The comparison measures the first successful read of the draft after compaction, before claiming review was complete.

| Measure | Baseline | Constraints |
|---|---:|---:|
| Hook stdout (bytes) | 3,028 | 1,512 |
| Resumed turns with a successful draft read | 0 of 1 | 0 of 1 |

Both agents reported that review was complete without calling a tool. Neither verified the draft during the resumed turn, so the pair tied on the execution criterion. The hook payloads differed in size, and model-request delivery was not traced in this run. This was a dev diagnostic, not a matched-budget comparison or a test of an automated selection policy. No holdout was opened.

## Matched-token dev replay

One paired replay reused the same checkpoint. Both arms started before compaction and produced their own linked Summary. The treatment kept the Rules and Lessons intact, inserted the first task prompt and paths from successful pre-boundary writes, and shortened the generic Session Summary to match the unchanged hook output using the `general-eval-b` tokenizer. The local relay verified the full arm-specific output in the compaction request and the first resumed model request for each arm. Both arms had the same continuation prompt and `Read` tool. A successful read of the draft was the execution criterion.

| Measure | Baseline | Constraints |
|---|---:|---:|
| Hook payload tokens | 676 | 676 |
| Compaction request input tokens | 7,846 | 7,846 |
| Model tokens across compaction and resume | 16,986 | 17,509 |
| Resumed turns with a successful draft read | 0 of 1 | 0 of 1 |

Neither arm called a tool on resume. Matching Injection tokens did not match total model usage, and tokens per successful task were undefined because neither arm succeeded. This is a dev tie on the same checkpoint, not independent evidence or a holdout result. No production change was made.

## Independent dev Sessions

Four fresh active Sessions used the same prior-history seed. Both arms in each pair received the same number of hook tokens, with full delivery verified in compaction and on the first resumed request.

| Task | Hook tokens per arm | Draft read as first action, baseline / treatment | Total model tokens, baseline / treatment |
|---|---:|---:|---:|
| Offline Lesson saves | 622 | No / No | 40,068 / 38,320 |
| Replacement import | 674 | No / No | 41,115 / 57,397 |
| Terse-prompt classification | 676 | No / No | 25,039 / 24,080 |
| XML list recovery | 675 | No / Yes | 28,515 / 44,612 |

Neither arm called a tool on the Lesson or terse-prompt task. On replacement import, the baseline called no tool; the treatment successfully read a different file first and then reached the two-turn limit. On XML list recovery, the baseline called no tool; the treatment successfully opened the draft first, then reached the two-turn limit. The treatment passed the first-action criterion on 1 of 4 Sessions, versus 0 of 4 for baseline. That is one treatment-only success and no baseline-only successes. It does not establish a gain across Sessions or a saving per successful task. The earlier date-terms Session was excluded because the collector did not record the PreCompact event. No holdout was opened.
