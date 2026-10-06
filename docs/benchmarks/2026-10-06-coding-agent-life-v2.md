# 2026-10-06 — coding-agent-life-v2 (v0.9.29)

**Commit:** the commit that adds this file, on top of `97a85b4`
**Bench:** coding-agent-life-v2 (22 sessions across `shipctl` and `ledger-api`, 38 questions)
**N:** 20 search (4 no-answer), 3 session-start (1 no-answer), 15 prompt-submit (6 no-answer)
**K:** 5 (search only; an Injection is scored whole)
**Hardware:** Debian 13, 8 cores, Node 22.23
**Embeddings:** none (`agentmemory-bm25`); the on-device `agentmemory` adapter was not run, its model is unavailable on this machine
**LLM:** none (synthetic compression, no summaries)

Gives every Observation a fixed importance rating and adds `ledg-006`, a 9-Observation
Session whose gold content only reaches the session-start Injection if it is ranked by
importance. No product code changed.

## Headline

The numbers barely move: session-start recall stays **0.813**, precision **1.000**, and
search precision goes from **0.628** to **0.624**. What changes is that the gate can now see
the session-start ranking. With the importance sort in `src/functions/context.ts` inverted,
`eval:gate` fails on session-start recall (**0.813** to **0.729**, below the 0.02 tolerance).

## Per path

| Adapter | Path | n | Recall | Precision | No-answer clean | Hit | Mean chars | p50 |
|---|---|---|---|---|---|---|---|---|
| agentmemory-bm25 | search | 20 | 0.969 | 0.624 | 0.250 | 17/20 | — | 31 ms |
| agentmemory-bm25 | session-start | 3 | 0.813 | 1.000 | 1.000 | 3/3 | 2411 | 24 ms |
| agentmemory-bm25 | prompt-submit | 15 | 0.907 | 0.822 | 0.833 | 14/15 | 195 | 21 ms |
| grep | search | 20 | 0.906 | 0.232 | 0.000 | 15/20 | — | 0 ms |
| grep | prompt-submit | 15 | 1.000 | 0.347 | 0.333 | 11/15 | — | 0 ms |
| random | search | 20 | 0.156 | 0.030 | 0.000 | 3/20 | — | 0 ms |
| random | session-start | 3 | 0.208 | 0.333 | 0.000 | 2/3 | — | 0 ms |
| random | prompt-submit | 15 | 0.056 | 0.013 | 0.000 | 1/15 | — | 0 ms |

Previous run (2026-10-05, same adapters): bm25 search 0.969 / 0.628 / 0.250, session-start
0.813 / 1.000 / 1.000, prompt-submit 0.907 / 0.822 / 0.833 (recall / precision / no-answer
clean). The `random` and `grep` rows move because the corpus grew by one Session.

## Methodology

As 2026-10-05, plus:

- `sessions.json` carries a 1-10 `importance` per Observation. The runner writes it over the
  stored row after each Session ends and refuses to run unless the sandbox holds more than
  one value.
- `ledg-006` has 9 Observations. Its four substantive ones (importance 9, 8, 7, 6) are the
  gold content; the prompt and four routine reads and checks rate 2-4 and are marked
  `routine`, so an Injection counts as carrying `ledg-006` only if one of the substantive
  ones is in it. Session-start keeps a Session's top 5 Observations by importance: by
  importance that is the four substantive ones plus the prompt, by inverted importance it is
  only filler, and the Session drops out of the Injection. Question `s-002` lists `ledg-006`
  among its gold Sessions.

## Reproduce

```sh
git checkout <sha>
npm ci && npm run build
npm run eval:coding-life -- --adapters agentmemory-bm25,grep,random
```

## Notes

- Inverted-sort check: with `b.importance - a.importance` flipped to `a.importance -
  b.importance` in `src/functions/context.ts`, `agentmemory-bm25/session-start recall`
  reports baseline 0.813, got 0.729, -0.084 and the gate exits FAIL. The change was reverted.
- Corpus growth moves the prompt-submit path: BM25 scores rise with corpus size, and the
  first draft of `ledg-006` (longer Observations, so a higher average length) pushed the
  acknowledgement `p-n03` and the no-answer `p-n04` over prompt-context's absolute floor of 5,
  taking prompt-submit precision to 0.756 and no-answer clean to 0.667. Trimming the new
  Observations to the corpus's average length restored 0.822 and 0.833. Prompt-context's
  absolute floor is sensitive to corpus size; the next Session added here may need the same
  care.
- Two Edits to one file in one Session collapse to one Observation (the dedup key is the
  tool input), so a Session's Edits must each name a different file.
