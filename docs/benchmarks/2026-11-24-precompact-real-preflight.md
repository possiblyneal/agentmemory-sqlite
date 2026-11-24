# Real compaction replay preflight (#578)

Baseline planned: `3caf0743`. The follow-up to #543 needs the same actual checkout and compacted conversation in both arms, with an independently keyed first action and constraints. The approved bar is a paired 95% interval whose lower bound exceeds a five-point improvement, without a lost required pinned Rule, cross-project leakage, an added Missed Injection, or an increase in model tokens per successful task.

## Archive check

| Check | Result |
|---|---:|
| Local Session files containing a compaction Summary marker | 1,109 |
| Main-chain `compact_boundary` records in those files | 3,509 |
| Boundaries recording a branch | 3,509 |
| Boundaries with an explicit revision field or a checkout snapshot field | 0 |
| Agentmemory candidate Session files with a direct tool result showing both a full SHA and a clean working tree in the same output | 0 of 39 |

File-history snapshots inspected contain tracked-file backups rather than complete checkout manifests. The existing 40-entry daemon checkpoint manifest holds Memory stores, not historical checkouts. The archive audit does not establish that individual checkouts could never be reconstructed from other records; it did not establish a matched cohort. Using current branch tips or assuming clean worktrees would risk grading a repeated edit or check against the wrong state.

**Verdict: blocked at evidence preflight; no behavioral result.** No dev pairs or holdout cases were run and no model calls were made. Retry when an independently verifiable reconstruction is available for enough historical compactions, or collect future compactions with a checkpoint of the exact checkout (including dirty and untracked task files), pre-boundary Memory evidence and the compacted conversation, then run the approved paired test without lowering its threshold. Transcript identifiers, excerpts and audit intermediates stayed local.
