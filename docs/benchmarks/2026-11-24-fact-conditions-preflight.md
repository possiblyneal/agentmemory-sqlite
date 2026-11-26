# Real Recall preflight (#579)

The [synthetic trial](./2026-11-23-fact-conditions.md) tested an exact `when` match. This preflight asked whether local records support a paired test of real condition-sensitive queries, with applicable and inapplicable Facts keyed independently of ranking.

The scan inspected main-chain assistant tool requests from 105 local Agentmemory worktree transcripts, excluding this research Session. It found 7 recorded `memory_smart_search` requests with distinct queries. None contained the screened condition or negation cues, including `when`, `unless`, `if`, `without`, `not`, `before`, or `after`. The lexical screen does not determine applicability and can miss paraphrased conditions. It does not cover other query surfaces or archives.

The live read-only export returned HTTP 401. No Fact inventory, historical candidate-pool match, or ranking comparison was established. No private excerpts were published and no holdout was opened.

**Verdict: blocked at evidence preflight.** Retry when real Recall requests and a matching Fact snapshot can be paired locally. Before ranking, independently label applicability, including negation, ambiguity, and paraphrases, and distinguish unavailable or out-of-pool Facts from ranking losses at the production candidate cap. Freeze the required gain and the limits on misapplication and scope leakage before scoring a holdout.