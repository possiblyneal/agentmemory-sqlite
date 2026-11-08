# 2026-11-08 — Terse prompts query with the Agent's last reply (#310)

**Commit:** base `20fe99c0`, arms via `eval:replay --query-arm`; shipped path on `feat/terse-prompt-310`
**Bench:** `eval:replay --from-checkpoints` over one synthetic-compression save pass (no `--llm`),
dev split, Turn needs (`rightMoment.turnOwn`) split by terse and substantive prompt
**N:** 237 Sessions from 18 projects, 143 dev-scored; 274 terse and 649 substantive scored prompts;
119 terse and 302 substantive Turn needs (80 and 184 `typical`)
**K:** 1 probe per arm; arms paired by (Session, turn, file), exact McNemar
**Embeddings:** local
**LLM:** none; rerank gate off (`AGENTMEMORY_PROMPT_RERANK=off`)
**Hardware:** Linux 6.12.107, 8 cores, Node v22.23.2; the arms ran four in parallel, so their latency is
contended

## Headline

Before this change, a terse prompt (under 3 content tokens) got no Injection at all: 0 of 119
terse Turn needs. Querying with the prompt plus the last 1000 chars of the Agent's previous reply,
only when the prompt is terse, delivers 23 of 119 (p < 0.001), and 16 of 80 on `typical`. Turns
with a substantive prompt keep their query and score the same (21 vs 22 of 302, p = 1). Shipped.

## Arms

Turn needs delivered, terse / substantive. "All prompts" arms replace the query on every turn;
"terse-only" arms replace it only on a terse prompt and send the raw prompt otherwise.

| Arm | Pooled terse | Pooled subst. | Typical terse | Typical subst. | Used share | Prompt-context p99 |
|---|---|---|---|---|---|---|
| control (before) | 0 / 119 | 22 / 302 | 0 / 80 | 18 / 184 | 5.7% | 505 ms |
| reply-tail, all | 22 | 33 | 16 | 23 | 4.0% | — |
| reply-terms, all | 23 | 37 | 16 | 26 | — | — |
| reply-head, all | 20 | 34 | 14 | 26 | — | — |
| reply-last, all | 13 | 27 | 12 | 22 | — | — |
| reply-tail 300, all | 16 | 37 | 14 | 27 | — | — |
| prev-prompt, all | 6 | 24 | 6 | 18 | — | — |
| **reply-tail, terse-only** | **23** | **21** | **16** | **17** | **5.7%** | 813 ms |
| reply-terms, terse-only | 22 | 22 | 14 | 18 | 5.3% | 899 ms |
| reply-head, terse-only | 17 | 21 | 11 | 17 | — | 992 ms |
| prev-prompt, terse-only | 9 | 22 | 8 | 18 | — | — |
| shipped path (control on branch) | 23 | 21 | 16 | 17 | 5.7% | 425 ms |

- Terse-only reply-tail vs control: terse 23 gained, 0 lost; substantive 1 lost, 0 gained.
- On typical terse turns, items the Agent then used: control 3 of 179 injected, reply-tail
  terse-only 22 of 427.
- The all-prompt arms raise substantive needs too but lower the used share (reply-tail 4.0% vs
  5.7%): the extra items mostly go unused. Terse-only keeps the share.
- The shipped path (hook sends `reply`, daemon composes the query) pairs identically to
  reply-tail terse-only on every cell. Probed alone, its prompt-context p50 is 46 ms against
  control's 32, p99 425 ms against 505, with 0 calls past the hook's 1500 ms against 2.
- A terse query averages 1,112 chars with the reply against 353 without. The arms' p99 column
  was measured with four arms in parallel; overHookTimeout there ran 2 to 6 per arm.

## Methodology

- A Turn need is a file the Agent touches in the turn that an earlier Session also touched. Only
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
```

## Notes and caveats

- Turn needs come partly from the turn's own Agent text, which can restate the preceding reply,
  so the metric favours reply arms. The substantive-turn result does not depend on this.
- The rerank gate was off; with it on, the gate scores the longer terse query, inside its
  1000 ms cap.
- Synthetic compression only; an `--llm` run was out of scope.
