# 2026-11-11 — prompt-submit Lessons behind a 0.5 reranker floor

**Commit:** branch `feat/prompt-submit-lessons` on `db339525` (#379)
**Bench:** the Operator's own prompts against a read-only copy of the live store; coding-agent-life-v2 (`eval:gate`, `eval:coding-life`)
**N:** 616 Operator-typed, non-terse prompts from 56 Sessions in 11 projects, 2026-11-05 to 2026-11-11
**K:** an Injection is scored whole (3 places)
**Hardware:** Debian 13, 8 cores, Node 22.23.4
**Embeddings:** none
**LLM:** none; reranker qwen3-rr-0.6b at `ai.lan:9202`, shared and under load during the run

## Headline

One Lesson takes the gate pool's 10th place and is injected when the reranker scores it 0.5 or
more. On 616 of the Operator's prompts it was injected on 12 (2%), and 5 of those 12 bear on the
prompt, with a sixth borderline: 42–50% precision, the band #317 measured and the Operator
accepted. 9 of the 12 filled an otherwise empty place. Prompt-submit latency is unchanged
overall (p95 1303 ms on main, 1266 ms on the branch, both inflated by the loaded reranker), and
the BM25-only gates are unchanged: Lessons need the reranker, so `eval:gate` and
`eval:coding-life` cannot see them.

## Pipeline A/B on the Operator's prompts

Both arms run the full `mem::prompt-context` against copies of one seed store, instances 47
(main) and 48 (branch), posting each prompt in order.

| Arm | Calls with an Injection | Calls reranked | p50 | p95 | p99 |
|---|---|---|---|---|---|
| main | 153 | 299 | 283 ms | 1303 ms | 1576 ms |
| branch | 152 | 496 | 311 ms | 1266 ms | 1660 ms |

| Arm | Rerank requests | p50 | p95 | Over 1000 ms (timed out) |
|---|---|---|---|---|
| main | 318 | 346 ms | 1758 ms | 34 |
| branch | 509 | 190 ms | 1057 ms | 28 |

- 212 prompts were reranked on the branch only, because a Lesson was the only candidate
  (184 single-document pools). On those, prompt-submit p50/p95 went from 146/1275 ms (no rerank)
  to 263/785 ms: one extra small rerank call. Main makes no rerank call on these
  prompts; its 1275 ms p95 is other daemon work in that arm.
- 284 prompts were reranked in both arms: p50/p95 521/1360 ms on main, 519/1356 ms on the branch.
  Swapping the 10th Observation for a Lesson does not slow the gate.
- Non-Lesson units differ on 66 prompts. The causes are the pool's 10th Observation being
  replaced and reranker variance or timeouts on a loaded host.

### What the Lesson did

| Step | Prompts |
|---|---|
| A Lesson in the gate pool | 430 |
| Scored 0.5 or more | 19 |
| Injected | 12 (9 filled an empty place, 3 displaced a unit) |
| Scored 0.5 or more, lost to a gate timeout | 4 |
| Scored 0.5 or more, outranked out of the 3 places (rank 5, 7, 9) | 3 |

Hand judgement of the 12 injected: 5 relevant (a bare-id convention, a status-cursor rule, a
ticket-on-main rule, an ownership rule for template dotfiles, a payload-versus-root rule),
1 borderline, 6 not relevant. Of the 3 displacements, 2 put a relevant Lesson in place of a
unit and 1 put an irrelevant Lesson in place of a Session Summary.

## Offline probe

Before the pipeline A/B, every prompt was scored against the BM25 top 10 of the Lessons that
existed before it (its project plus Global), reranked live.

- The best of the top 10 scored 0.5 or more on 52 prompts; the BM25 top 1, which is what the
  pool takes, reached it on 23.
- Of the 23 top-1 Lessons at 0.5 or more, 11 bear on the prompt (48%).

## coding-agent-life-v2

Unchanged, by construction: the evals run with `AGENTMEMORY_PROMPT_RERANK=off`, and with the
gate off no Lesson is injected.

| Adapter | Path | n | Recall | Precision | No-answer clean | Hit | Mean chars | p50 | p95 |
|---|---|---|---|---|---|---|---|---|---|
| agentmemory-bm25 (`eval:gate`) | search | 20 | 0.969 | 0.704 | 0.250 | 17/20 | — | 3 ms | 13 ms |
| agentmemory-bm25 (`eval:gate`) | session-start | 3 | 0.813 | 1.000 | 1.000 | 3/3 | 2411 | 3 ms | 3 ms |
| agentmemory-bm25 (`eval:gate`) | prompt-submit | 15 | 0.907 | 0.889 | 0.833 | 14/15 | 160 | 3 ms | 6 ms |
| agentmemory (`eval:coding-life`) | prompt-submit | 9 | 0.861 | 1.000 | 1.000 | 9/9 | 143 | 3 ms | 7 ms |

`eval:gate` passes with +0.000 on every metric; its prompt-submit p95 is 6 ms against the
500 ms ceiling.

## Methodology

- Seed: a `node:sqlite` `backup()` copy of the live store; each arm works on its own copy.
- Lessons are made time-correct: every Lesson created at or after the first prompt is deleted
  from the copy, then saved through `POST /agentmemory/lessons` just before the first later
  prompt, so a prompt sees only the Lessons that existed when the Operator typed it.
- A local proxy in front of the reranker logs each request's documents, scores and latency.
- Both arms run from scratch builds with `RERANK_COOLDOWN_MS` patched to 0. Without that, each
  gate timeout opens a 60 s cooldown, and a fast replay sends most prompts to the BM25
  fallback, where no Lesson is injected. The shipped code keeps the cooldown.
- An earlier run without these two fixes was discarded: 3 of its 4 injected Lessons were
  created after the prompt.

## Reproduce

The runner and analysis are scratch in the worktree's `tmp/agent-379/` (`ab.ts`,
`analyze-ab2.mjs`, `lesson-probe.ts`); their output quotes private prompts and stays there.

```sh
npm ci && npm run build
npm run eval:gate
npm run eval:coding-life
```

## Notes

- The BM25 top 1 reaches only 23 of the 52 prompts where some Lesson scores 0.5 or more. A wider
  Lesson look into the pool would need a Lesson-specific pool or a second rerank call.
- 4 of the 19 qualifying Lessons were lost to gate timeouts on a loaded reranker. Prompt-submit
  p95 on the real store passes 500 ms on main as well; the ceiling in `eval:gate` holds.
- No BM25-only eval and no `eval:supersession` cell can see a prompt-submit Lesson, since the
  gate is off in both.
