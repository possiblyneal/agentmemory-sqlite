# 2026-11-16 — graph extraction on vs off (#420)

**Commit:** `ef548d85` plus the uncommitted `eval --llm` and graph-wait change that this scorecard's commit carries
**Bench:** coding-agent-life-v2 (search, session-start, prompt-submit) and LongMemEval `_s` dev sample (`--stratify 10`, 60 questions)
**N:** coding-life search 10 answerable (2 no-answer), session-start 1, prompt-submit 6; LongMemEval search 60
**K:** 5 (search only; an Injection is scored whole)
**Hardware:** Linux 6.12, 12 cores, Node 22.23.4
**Embeddings:** on-device (sandbox default)
**LLM:** coding-life: `general-eval-b` (OpenAI-compatible broker), greedy `{temperature: 0, seed: 42}`, concurrency 2; LongMemEval: none (heuristic extraction only)

## Headline

Turning graph extraction off loses no search Recall on either bench. On coding-life with an LLM
graph (117 nodes, 111 edges) recall and hit are 1.000 in both arms and search precision is higher
with extraction off (0.850 against 0.817), because the graph leg adds one extra result to three
of the ten questions (q-002, q-006, q-011 gain a non-gold Session). On LongMemEval every one of
the 60 questions returns the same ids with and without the graph. The second pair of runs
reproduced the first exactly, so the precision gap is an effect of the graph leg, not run noise.
LongMemEval was not run under an LLM graph (infeasible, below), so the claim covers a heuristic
graph there.

## Per path

Search, dev split. `on` is `GRAPH_EXTRACTION_ENABLED=true`, graph weight 0.3, indexes armed by a
snapshot rebuild; `off` is `GRAPH_EXTRACTION_ENABLED=false`. Each coding-life row is two runs
with identical numbers (on, on2; off, off2).

| Bench | Arm | Path | n | Recall | Precision | Hit |
|---|---|---|---|---|---|---|
| coding-life | on | search | 10 | 1.000 | 0.817 | 1.000 |
| coding-life | off | search | 10 | 1.000 | 0.850 | 1.000 |
| coding-life | on | session-start | 1 | 0.125 | 1.000 | 1.000 |
| coding-life | off | session-start | 1 | 0.125 | 1.000 | 1.000 |
| coding-life | on (run 1) | prompt-submit | 6 | 0.250 | 1.000 | 0.333 |
| coding-life | on (run 2) | prompt-submit | 6 | 0.167 | 1.000 | 0.167 |
| coding-life | off (both runs) | prompt-submit | 6 | 0.167 | 1.000 | 0.167 |
| LongMemEval | on (heuristic) | search | 60 | 0.9361 | 0.4892 | 0.9667 |
| LongMemEval | off | search | 60 | 0.9361 | 0.4892 | 0.9667 |

Prompt-submit and session-start do not read the graph (its only Recall reader is `HybridSearch`,
`mem::smart-search`), and the on arm's two runs differ from each other on prompt-submit, so that
row's one-item gap is run-to-run noise from LLM Summaries.

Graph rows in the coding-life on arm after the build: 117 nodes, 111 edges, 66 Observation nodes
(second run: 116, 108, 66), `indexesReady: true`. LongMemEval on arm: 40 to 51 nodes per question,
0 edges, all Observation nodes (heuristics emit no relations).

Wall time: coding-life on 1088 s and 1110 s, off 1152 s and 1679 s (the runs shared a host with
other replays); LongMemEval on 2795 s, off 1447 s. Search latency p50 on LongMemEval is dominated
by the on-device embedder under load (about 65 s per question) and is not comparable across arms.

Per differing question (coding-life search, returned ids in rank order):

| Question | on | off |
|---|---|---|
| q-002 | sess-002, sess-011 | sess-011, sess-002, sess-015 |
| q-006 | sess-006, sess-011 | sess-006 |
| q-008 | sess-013, sess-008 | sess-008, sess-013 |
| q-011 | sess-014, sess-001, sess-011 | sess-001, sess-014, sess-011 |

The graph changes order and membership but the gold Session is returned in both arms. Which of
the two orders is better by `topGoldRank` is not resolved at n = 10.

## Methodology

- Neither runner could build a graph before this change. `eval:coding-life --llm` (new) starts
  the sandbox with the shell's OpenAI settings, waits for every captured Session's Summary and,
  when `GRAPH_EXTRACTION_ENABLED=true` and the graph leg is not off, for each Session's
  `graphExtractedThrough` watermark and for the graph scopes to stop changing. It then POSTs
  `/agentmemory/graph/snapshot-rebuild`, because `graphReadable()` fails closed until
  `mem:graph:index-meta` exists and nothing else arms a fresh sandbox. Graph row counts are read
  with a read-only `node:sqlite` handle. LongMemEval takes no `--llm`: it builds a heuristic
  graph per question haystack, armed the same way.
- Both arms wait for Summaries, so the only difference is extraction. A first LLM pair that did
  not (off arm) was discarded.
- The first off arms were invalid: the runner copies `~/.agentmemory/.env` into `process.env`
  for unset keys, and that file sets `GRAPH_EXTRACTION_ENABLED=true`, so `unset` in the launcher
  left extraction on. Those results (kept in `tmp/graph-420/invalid-off-leak/`) were on versus
  on. Every reported off arm was rerun with `GRAPH_EXTRACTION_ENABLED=false` exported and the
  sandbox daemon's `/proc/<pid>/environ` checked for it. The on arms export `true`.
- LongMemEval with an LLM graph is infeasible: about 50 extraction calls per question, 3,000 for
  the 60-question dev sample; measured throughput was about 22 extractions in 8 minutes at
  concurrency 2, about 17 hours per arm. A 6-question subset is about 1.7 hours per arm with
  no statistical power.
- n = 10 answerable search questions on coding-life is small; a recall difference under 0.1
  is not detectable there. LongMemEval's 60 questions are identical item for item.

## Reproduce

```sh
git checkout <sha>
npm ci && npm run build
export OPENAI_API_KEY=... OPENAI_BASE_URL=... OPENAI_MODEL=general-eval-b AGENTMEMORY_LLM_MAX_CONCURRENCY=2
GRAPH_EXTRACTION_ENABLED=true  npx tsx eval/runner/coding-life.ts --llm --adapters agentmemory --instance 44 --out tmp/graph-420/on
GRAPH_EXTRACTION_ENABLED=false npx tsx eval/runner/coding-life.ts --llm --adapters agentmemory --instance 45 --out tmp/graph-420/off
export LONGMEMEVAL_PATH=<longmemeval_s.json>
GRAPH_EXTRACTION_ENABLED=true  npx tsx eval/runner/longmemeval.ts --adapters agentmemory --stratify 10 --concurrency 3 --instance 47 --out tmp/graph-420/lme-on
GRAPH_EXTRACTION_ENABLED=false npx tsx eval/runner/longmemeval.ts --adapters agentmemory --stratify 10 --concurrency 3 --instance 47 --out tmp/graph-420/lme-off
```

## Notes

- The live store's graph leg is inert today: it holds 174,983 graph nodes, above the 25,000
  boot-backfill ceiling (`GRAPH_INDEX_NODE_CEILING`), and has no `mem:graph:index-meta` row, so
  `graphReadable()` is false and `memory_smart_search` already ignores the graph. Recall on the
  live store therefore cannot be lost by switching extraction off.
- `event::session::stopped` skips extraction with `session-extracting` when one is already
  running for the Session, leaving the tail unextracted until a later stop. A graph built from
  Session stops can be missing its last Observations.
- Not measured: an LLM graph on LongMemEval, and graph effects on a store large enough to cross
  the backfill ceiling. Both are in the ledger row's Retry if.
