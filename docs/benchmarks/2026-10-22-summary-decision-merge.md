# 2026-10-22 — Decisions kept when a long Session Summary is merged (#300)

**Commit:** control `73cfcb80` (main), fix `b9ebc987` (closed PR #301, branch `fix/summary-merge-decisions`), each with the #303 fetch fix applied
**Bench:** force-summarize of the 10 longest Sessions in the #259 replay store, one run per arm; then `eval:replay --from-checkpoints` over that store, dev split (holdout not opened)
**N:** 10 Sessions of 389 to 654 Observations; replay 38 probed checkpoints, 357 prompts, 37 key items (28 file, 7 correction, 2 decision)
**K:** 5 (search only; an Injection is scored whole)
**Hardware:** linux x86_64, 8 cores, Node v22.23.2, both arms run in parallel on one host
**Embeddings:** none for the count; on-device (replay default) for the replay
**LLM:** the Operator's OpenAI-compatible broker, model `general`; the replay probes make no LLM call

## Headline

Building the merged decision list in code keeps 510 decisions where the model's rewrite kept
212 (2.4x), with no repeats and the same length per decision, but no replay metric improves:
every hit is equal except one terse file key that the fix loses (10/13 against 11/13). The fix
fails #300's acceptance (no drop, at least one gain) and was not merged.

## Decisions kept per Session

| Observations | main decisions | #301 decisions |
|---|---|---|
| 654 | 62 | 70 |
| 623 | 23 | 66 |
| 620 | 6 | 59 |
| 486 | 30 | 59 |
| 450 | 15 | 49 |
| 560 | 14 | 46 |
| 457 | 21 | 46 |
| 494 | 9 | 39 |
| 389 | 22 | 39 |
| 457 | 10 | 37 |
| **Total** | **212** | **510** |

| Arm | Decision chars | Mean chars per decision | Longest | Near-repeats (word Jaccard >= 0.6) |
|---|---|---|---|---|
| main | 26,695 | 126 | — | 0 |
| #301 | 64,377 | 126 | 338 | 0 |

## Replay

| Arm | Injected items | Used | Injection chars | Injection hit | Search hit | Either | Terse Injection hit | Correction before repeat | session-start p50 / p99 | prompt-context p50 / p99 |
|---|---|---|---|---|---|---|---|---|---|---|
| main | 248 | 52 | 262,124 | 26/37 | 10/37 | 30/37 | 11/13 | 2/7 | 21 / 166 ms | 17 / 1294 ms |
| #301 | 248 | 51 | 259,068 | 26/37 | 10/37 | 30/37 | 10/13 | 2/7 | 17 / 144 ms | 15 / 1348 ms |

By kind (both arms equal): file 24/28 injected, correction 2/7, decision 0/2 injected and 2/2 by
search. Three file-key outcomes differ, all from a re-summarized earlier Session: one gained and
two lost, the terse loss among them. Latency is not attributable: the two probes shared one host.

## Methodology

- Both arms start from the same store: the last checkpoint of the #259 save pass after its
  repair, with every compression finished. Each arm force-summarizes the same 10 Sessions
  (`POST /agentmemory/summarize`, `force: true`); the other Sessions are left alone.
- For the replay, each arm's 10 Summaries were patched into a copy of every #259 checkpoint that
  holds their Session, and that arm's build probed its copy; the other Summaries are identical.
- The fix bounds what an Agent is shown at 10 decisions per Session: the 10 that best match the
  prompt at prompt submit, the newest 10 at session start. Keeping more decisions changes which
  10 are shown, not how many.

## Notes

- main's loss is erratic, not proportional: a 620-Observation Session kept 6 decisions, and one
  Session kept 2 in an earlier run and 30 in this one. One run per arm, so per-Session numbers
  carry that variance; every Session moved the same way.
- The corpus has 2 decision key items, too few to show a decision effect either way; a corpus
  with more could re-test the fix from its branch.
- The fold path (`FOLD_SYSTEM`) also rewrites the decision list, so a live Session summarized
  one Stop at a time can lose decisions as well.
