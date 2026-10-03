# 2026-10-03 — coding-agent-life-v2 (v0.9.29)

**Commit:** the commit that adds this file, on top of `0fa3ecf`
**Bench:** coding-agent-life-v2 (21 sessions across `shipctl` and `ledger-api`, 53 questions)
**N:** 20 search (4 no-answer), 15 pre-tool-use (4 no-answer), 3 session-start (1 no-answer), 15 prompt-submit (6 no-answer)
**K:** 5 (search only; an Injection is scored whole)
**Hardware:** Debian 13, 8 cores, Node 22.23
**Embeddings:** on-device (`EMBEDDING_PROVIDER=local`, `@huggingface/transformers`) or none
**LLM:** none (synthetic compression, no summaries)

Adds the prompt-submit path: the per-prompt Injection from
`POST /agentmemory/prompt-context` (#106). Search, pre-tool-use and
session-start are unchanged from the 2026-10-01 run.

## Headline

Filtering per-prompt Recall triples its precision for a small recall cost.
Against the unfiltered stand-in this path scored before #106 (the top K
Sessions smart-search returns for the prompt), precision goes from **0.303**
to **0.822**, no-answer clean from **0.333** to **0.833**, and recall from
0.963 to **0.907**. The mean Injection is **184** characters. All three
acknowledgements (`yes`, `continue`, `thanks, looks good, commit it`) inject
nothing.

## Per path

| Adapter | Path | n | Recall | Precision | No-answer clean | Hit | Mean chars | p50 |
|---|---|---|---|---|---|---|---|---|
| agentmemory | search | 20 | **1.000** | 0.190 | 0.000 | 16/20 | — | 33 ms |
| agentmemory | pre-tool-use | 15 | **0.667** | 0.694 | 0.750 | 11/15 | 261 | 27 ms |
| agentmemory | session-start | 3 | **0.813** | 1.000 | 1.000 | 3/3 | 1911 | 28 ms |
| agentmemory | prompt-submit | 15 | **0.907** | 0.822 | 0.833 | 14/15 | 184 | 26 ms |
| agentmemory-bm25 | search | 20 | 0.969 | 0.195 | 0.000 | 16/20 | — | 41 ms |
| agentmemory-bm25 | pre-tool-use | 15 | 0.667 | 0.694 | 0.750 | 11/15 | 261 | 29 ms |
| agentmemory-bm25 | session-start | 3 | 0.813 | 1.000 | 1.000 | 3/3 | 1911 | 28 ms |
| agentmemory-bm25 | prompt-submit | 15 | 0.907 | 0.822 | 0.833 | 14/15 | 184 | 22 ms |
| grep | search | 20 | 0.906 | 0.240 | 0.000 | 15/20 | — | 0 ms |
| grep | prompt-submit | 15 | 1.000 | 0.350 | 0.333 | 11/15 | — | 0 ms |
| random | search | 20 | 0.125 | 0.020 | 0.000 | 2/20 | — | 0 ms |
| random | pre-tool-use | 15 | 0.136 | 0.027 | 0.000 | 2/15 | — | 0 ms |
| random | session-start | 3 | 0.394 | 0.400 | 0.000 | 2/3 | — | 0 ms |
| random | prompt-submit | 15 | 0.000 | 0.000 | 0.000 | 0/15 | — | 0 ms |

Columns are defined in the 2026-10-01 scorecard and `eval/README.md`.

## Prompt-submit, per question (agentmemory-bm25)

Only the questions that lost recall or precision.

| Question | Gold | Injected | Note |
|---|---|---|---|
| p-001 | sess-001, sess-014, sess-016 | sess-001, sess-014 | sess-016 falls below half the best score |
| p-003 | sess-003 | sess-003, sess-004 | |
| p-006 | sess-008, sess-013 | sess-004, sess-008 | sess-004 (6.82) outranks the gold sess-008 (6.71); sess-013 is cut |
| p-007 | sess-015 | sess-015, sess-007, sess-013 | |
| p-n04 | none | sess-004 | `--verbose flag` matches sess-004's CLI work at 8.19, above the floor of 5 |

## Methodology

As 2026-10-01, plus:

- prompt-submit: `POST /agentmemory/prompt-context` with the question as
  `prompt` and its `project`, from a fresh probe Session, so no earlier
  question's Injection is excluded as already seen.

## Reproduce

```sh
git checkout <sha>
npm ci && npm run build
npm run eval:coding-life
```

## Notes

- The cutoff (`src/functions/prompt-context.ts`) is a BM25 score of at least
  5 and at least half the best match. The absolute floor was read off this
  21-Session corpus; BM25 scores grow with corpus size, so on a large store
  the relative cutoff does most of the work and the absolute floor may let
  weak matches through.
- The embedding stack scores the same as BM25-only here: prompt-context reads
  `mem::search`, which is BM25.
