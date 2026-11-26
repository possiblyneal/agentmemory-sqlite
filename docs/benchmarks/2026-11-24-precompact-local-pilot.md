# Real compaction capture pilot (#578)

Baseline `3caf0743`. A local Claude Code Session made a documentation edit for #578 in an isolated checkout. The coding turn stopped at its invocation deadline after the edit; the same Session resumed with a manual `/compact`. The sandbox daemon imported only that pre-boundary transcript: one Session and 14 Observations. The real `PreCompact` event ran a pilot-only wrapper around the unchanged built hook. Inference used `general-eval-b` on the local broker; the live Memory store and global hook settings were not used for the pilot.

| Check | Observed |
|---|---:|
| Linked main-chain compaction boundary and Summary | 1 pair |
| Independent checkout restores matching the captured revision, staged and unstaged binary diffs, status, and allowlisted untracked file bytes | 2 |
| Capture overhead, including state recheck and checkpoint write | 141.05 ms |
| Existing hook subprocess time | 44.69 ms |
| Existing hook stdout | 0 bytes |

Both checkout restores refer to the same captured compacted transcript, verified by matching the pre-boundary transcript prefix and the Summary's parent to the new boundary. Neither restore was used to resume an Agent in this pilot. The hook wrote no Missed Injection log. The run used `claude --print` without `AGENTMEMORY_CAPTURE_HEADLESS=1`; empty stdout did not test the transport of a nonempty response. See the [delivery follow-up](./2026-11-24-precompact-delivery.md).

**Verdict: capture and checkout restore feasible in this one manual compaction; behavioral effect unmeasured.** Next collect independent dev compactions with representative isolated Memory and observable nonempty delivery, including routine compactions, and verify the common replay inputs at Agent invocation. Only then estimate paired sample size and freeze the comparison. No A/B action, power estimate, or holdout look was performed. Raw captures and per-Session artifacts stayed local. No production contracts changed.
