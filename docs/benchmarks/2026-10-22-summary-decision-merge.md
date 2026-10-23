# 2026-10-22 — Decisions kept when a long Session Summary is merged (#300)

**Commit:** control `73cfcb80` (main), fix `b9ebc987` (#301), each with the #303 fetch fix applied
**Bench:** force-summarize of the 10 longest Sessions in the #259 replay store, one run per arm
**N:** 10 Sessions of 389 to 654 Observations
**Hardware:** linux x86_64, Node 22+, both arms run in parallel on one host
**Embeddings:** none
**LLM:** the Operator's OpenAI-compatible broker, model `general`

## Headline

Building the merged decision list in code keeps 510 decisions where the model's rewrite kept
212 (2.4x), with no repeats and the same length per decision. What an Agent is shown stays
bounded at 10 decisions per Session, at prompt submit and at session start.

## Per Session

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

## Methodology

- Both arms start from the same store: the last checkpoint of the #259 save pass after its
  repair, with every compression finished. Each arm force-summarizes the same 10 Sessions
  (`POST /agentmemory/summarize`, `force: true`); the other Sessions are left alone.
- A count of decisions kept, not a Recall score: the #259 replay corpus has 2 decision key
  items, too few to show a Recall effect either way.

## Notes

- main's loss is erratic, not proportional: a 620-Observation Session kept 6 decisions, and one
  Session kept 2 in an earlier run and 30 in this one. One run per arm, so per-Session numbers
  carry that variance; every Session moved the same way.
- The fold path (`FOLD_SYSTEM`) still rewrites the decision list, so a live Session summarized
  one Stop at a time can still lose decisions.
