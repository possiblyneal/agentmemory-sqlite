# 2026-11-08 — Terse prompts query with the Agent's last reply (#310)

**Commit:** base `20fe99c0`, arms via `eval:replay --query-arm`; shipped path on `feat/terse-prompt-310`
**Bench:** `eval:replay --from-checkpoints` over one synthetic-compression save pass (no `--llm`),
dev split, Turn needs (`rightMoment.turnOwn`) split by terse and substantive prompt
**N:** 237 Sessions from 18 projects, 143 dev-scored; 274 terse and 649 substantive scored prompts;
119 terse and 302 substantive Turn needs (80 and 184 `typical`)
**K:** 1 probe per arm; arms paired by (Session, turn, file), exact McNemar
**Embeddings:** local
**LLM:** none for compression. The arms table ran with the rerank gate off; the gated table ran it
on, against the live default (`http://ai.lan:9202/v1/rerank`, Qwen3 reranker 0.6B q8 on
llama-server, min score 0.03, 1000 ms timeout)
**Hardware:** Linux 6.12.107, 8 cores, Node v22.23.2. The arms table ran four arms in parallel, so
its latency is contended. The before/shipped pairs ran two at a time, gated and ungated waves apart

## Headline

Before this change, a terse prompt (under 3 content tokens) delivered none of its Turn needs:
0 of 119. Querying with the prompt plus the last 1000 chars of the Agent's previous reply,
only when the prompt is terse, delivers 23 of 119 (p < 0.001), and 16 of 80 on `typical`. Turns
with a substantive prompt keep their query and score the same (21 vs 22 of 302, p = 1).

With the Injection Gate on, as the live daemon runs, it delivers 17 of 119 (p < 0.001), 12 of
80 on `typical`, and substantive turns tie at 24. Dropping needs that only the Agent's own text
names leaves 21 of 115 ungated and 16 of 115 gated, both p < 0.001. Shipped.

A view limited to files the Operator typed is empty: no terse Turn need and 1 substantive
need come from the Operator's text. That view can neither confirm nor refute the result.

## Gate on, and who named the file

The control is the pre-change query (`--query-arm reply-tail --reply-chars 0`, the raw prompt
with no `reply`; it reproduces the earlier control on every cell). The shipped arm is
`--query-arm control` on this branch. Needs are delivered as control → shipped. The p value is
exact McNemar on terse needs.

| View | Gate | Pooled terse | p | Pooled subst. | Typical terse | Typical subst. |
|---|---|---|---|---|---|---|
| as scored (Agent text or tool input) | off | 0 → 23 / 119 | < 0.001 | 22 → 21 / 302 | 0 → 16 / 80 | 18 → 17 / 184 |
| as scored | on | 0 → 17 / 119 | < 0.001 | 24 → 24 / 302 | 0 → 12 / 80 | 16 → 16 / 184 |
| no Agent text (tool input or Operator) | off | 0 → 21 / 115 | < 0.001 | 22 → 21 / 291 | 0 → 14 / 78 | 18 → 17 / 178 |
| no Agent text | on | 0 → 16 / 115 | < 0.001 | 24 → 24 / 291 | 0 → 11 / 78 | 16 → 16 / 178 |
| Operator-typed only | either | 0 / 0 | — | 0 / 1 | 0 / 0 | 0 / 0 |

| Arm | Gate | Used share | Injected chars per prompt, terse / subst. | Prompt-context p50 / p95 / p99 | Over 1500 ms | Gate calls / fell open |
|---|---|---|---|---|---|---|
| control (before) | off | 5.7% | 353 / 974 | 30 / 220 / 365 ms | 0 | — |
| shipped | off | 5.7% | 1,112 / 965 | 46 / 242 / 414 ms | 0 | — |
| control (before) | on | 6.2% | 170 / 651 | 222 / 482 / 678 ms | 0 | 661 / 15 |
| shipped | on | 6.0% | 742 / 633 | 280 / 513 / 739 ms | 0 | 841 / 0 |

- The gate keeps 17 of the 23 ungated terse gains. That is above the bar for trying a reranker
  query built from the reply's end, so that variant was not measured. The reranker sees the
  first 500 chars of the query (`RERANK_QUERY_CHARS`): for a terse prompt, that is the prompt plus
  the start of the reply tail.
- Terse queries give the gate work it skipped before: a terse prompt used to return nothing
  before the gate. Hence 841 calls against 661, and p50 rises 58 ms gated.
- The 15 fall-opens in the gated control are cooldown fallbacks after a reranker failure.

## Arms

Turn needs delivered, terse / substantive. "All prompts" arms replace the query on every turn;
"terse-only" arms replace it only on a terse prompt and send the raw prompt otherwise.

| Arm | Pooled terse | Pooled subst. | Typical terse | Typical subst. | Used share | Injected chars per prompt, terse / subst. | Prompt-context p99 |
|---|---|---|---|---|---|---|---|
| control (before) | 0 / 119 | 22 / 302 | 0 / 80 | 18 / 184 | 5.7% | 353 / 973 | 505 ms |
| reply-tail, all | 22 | 33 | 16 | 23 | 4.0% | 1,076 / 1,047 | — |
| reply-terms, all | 23 | 37 | 16 | 26 | — | 882 / 1,040 | — |
| reply-head, all | 20 | 34 | 14 | 26 | — | 1,088 / 1,038 | — |
| reply-last, all | 13 | 27 | 12 | 22 | — | 1,109 / 1,085 | — |
| reply-tail 300, all | 16 | 37 | 14 | 27 | — | 1,165 / 1,095 | — |
| prev-prompt, all | 6 | 24 | 6 | 18 | — | 894 / 987 | — |
| **reply-tail, terse-only** | **23** | **21** | **16** | **17** | **5.7%** | **1,112 / 965** | 813 ms |
| reply-terms, terse-only | 22 | 22 | 14 | 18 | 5.3% | 894 / 972 | 899 ms |
| reply-head, terse-only | 17 | 21 | 11 | 17 | — | 1,106 / 965 | 992 ms |
| prev-prompt, terse-only | 9 | 22 | 8 | 18 | — | 887 / 972 | — |
| shipped path (control on branch) | 23 | 21 | 16 | 17 | 5.7% | 1,112 / 965 | 425 ms |

- Terse-only reply-tail vs control: terse 23 gained, 0 lost; substantive 1 lost, 0 gained.
- On typical terse turns, items the Agent then used: control 3 of 179 injected, reply-tail
  terse-only 22 of 427.
- The all-prompt arms raise substantive needs too but lower the used share (reply-tail 4.0% vs
  5.7%): the extra items mostly go unused. Terse-only keeps the share.
- The shipped path (hook sends `reply`, daemon composes the query) pairs identically to
  reply-tail terse-only on every cell. Probed alone, its prompt-context p50 is 46 ms against
  control's 32, p99 425 ms against 505, with 0 calls past the hook's 1500 ms against 2.
- Injected chars per prompt are the prompt-context context length averaged over the 274 terse and
  649 substantive scored prompts. A terse prompt gets about 3x the context it got (1,112 vs 353
  chars ungated); the 23 terse needs come with that cost, while substantive prompts get slightly
  less. Every arm that delivers more terse needs also injects more, so none wins on volume alone:
  reply-terms terse-only delivers 22 at 894 chars. The arms' p99 column was measured with four
  arms in parallel; overHookTimeout there ran 2 to 6 per arm.

## Methodology

- A Turn need is a file named in the turn (by the typed prompt, a tool call's input or the
  Agent's text) that an earlier Session also touched. Each need records its sources. Only
  1.4% of Observations carry a `files` list, so an injected item also counts when its text names
  the path whole (`namesFile`, `eval/runner/replay-score.ts`).
- Terse is `isTersePrompt()` (`src/utils/terse-prompt.ts`), shared by the eval and the daemon.
- `--terse-only` sends the composed query only on terse turns. The shipped control sends the raw
  prompt with `reply`, as the hook does, and the daemon composes the query.

## Reproduce

```sh
npm run build
npm run eval:replay -- --projects=<dirs> --save-checkpoints <dir>
npm run eval:replay -- --projects=<dirs> --from-checkpoints <dir> --query-arm reply-tail --reply-chars 1000 --terse-only
npm run eval:replay -- --projects=<dirs> --from-checkpoints <dir> --query-arm control
npm run eval:replay -- --projects=<dirs> --from-checkpoints <dir> --query-arm reply-tail --reply-chars 0
# gate on: the same two with AGENTMEMORY_PROMPT_RERANK_URL=http://ai.lan:9202/v1/rerank in the shell
```

## Notes and caveats

- The "no Agent text" view keeps a need that a tool call's input names, even when the Agent's
  text names it too. A file the Agent opened after a "go ahead" is the work the reply planned,
  so that view still credits a reply query for it. That case is the one this change targets.
- Synthetic compression only; an `--llm` run was out of scope.
- Not measured: two scoring fixes made in review after these runs. `namesFile` no longer credits a
  longer path ending in the file or a name extending it (`lib/src/cart.ts`, `src/cart.ts.bak`),
  and tool-input mentions are read from each string value, so a path that starts a line in a
  heredoc counts. Both apply to every arm alike; the numbers above predate them.
