# 2026-10-20 — DolphinBench (retrieval derivative)

**Commit:** `a0de1e3` plus the runner in this change
**Bench:** DolphinBench (arXiv 2609.24971, `mem0ai/dolphinbench`), dev split, retrieval only
**N:** 120 tests per persona (Alex, Morgan, Riley), 360 in all, no no-answer tests; holdout not opened
**K:** 5 (search only; an Injection is scored whole)
**Hardware:** Linux 6.12, 8 cores, Node 22.23.2 (machine shared with other eval runs)
**Embeddings:** on-device, `Xenova/all-MiniLM-L6-v2` (the sandbox default)
**LLM:** none

This is a retrieval derivative, not DolphinBench's score. Mem0 authored the benchmark and publishes agent-action
results from an answerer and a grader; none of that ran here, so these numbers must not be set beside theirs.

## Headline

On the dev split the prompt-submit Injection carries an establishing message for 175 of 360 tests (49%), at
recall 0.430 and precision 0.166. Search at k=5 reaches recall 0.395 and a hit on 154. A tokenized-substring
baseline reaches recall 0.283 and a hit on 115. The gap to the baseline is largest on Morgan (recall 0.419 against
0.146) and absent on Alex (0.392 against 0.308) and Riley's search path (0.385 against 0.396). Roughly half the tests
get no establishing message in the top results, from a request that never names the fact.

## Per path

Recall is per test, averaged over the persona's 120 tests; precision is the share of returned messages that are gold.
The agentmemory prompt-submit rows return about 1,200 characters per Injection.

| Persona | Adapter | Path | n | Recall | Precision | Hit | Mean chars | p50 |
|---|---|---|---|---|---|---|---|---|
| Alex | agentmemory | search | 120 | 0.354 | 0.083 | 46 | — | 200 ms |
| Alex | agentmemory | prompt-submit | 120 | 0.392 | 0.151 | 54 | 1211 | 213 ms |
| Alex | grep | search | 120 | 0.308 | 0.072 | 41 | — | 44 ms |
| Morgan | agentmemory | search | 120 | 0.446 | 0.097 | 56 | — | 314 ms |
| Morgan | agentmemory | prompt-submit | 120 | 0.419 | 0.155 | 55 | 1201 | 332 ms |
| Morgan | grep | search | 120 | 0.146 | 0.030 | 18 | — | 125 ms |
| Riley | agentmemory | search | 120 | 0.385 | 0.097 | 52 | — | 361 ms |
| Riley | agentmemory | prompt-submit | 120 | 0.478 | 0.191 | 66 | 1235 | 426 ms |
| Riley | grep | search | 120 | 0.396 | 0.103 | 56 | — | 606 ms |
| All | agentmemory | search | 360 | 0.395 | 0.092 | 154 | — | — |
| All | agentmemory | prompt-submit | 360 | 0.430 | 0.166 | 175 | — | — |
| All | grep | search | 360 | 0.283 | 0.068 | 115 | — | — |

"All" is the mean of the three persona rows (equal n). The `grep` adapter ignores the path, so its prompt-submit
rows repeat its search rows and are left out. `vector` needs an OpenAI key and was not run.

## Methodology

- **Gold.** A test's `required_fact_ids` map to `facts.source_message_ids`; the gold is every such message (1.2 per
  test on average). The schema was checked on all 600 tests first: every test names at least one fact, every fact
  at least one source message, and every source message exists in its persona's history. `related_message_ids`
  are not gold.
- **Haystack.** A persona's whole history, 3,400 to 5,128 messages, one Session per message, dated by the
  message's own timestamp and ingested as a prompt Observation. The store is built once per persona and all 120
  tests query it, unlike LongMemEval's store per question. Ingestion took 1,296 to 1,881 s per persona.
- **Query.** The test's `request`, as `smart-search` at k=5 and as the prompt-submit `prompt-context` call. An
  Injection is mapped back to messages by the same needle attribution the coding-life bench uses.
- **Split.** `selectSplit("dolphinbench", ...)` grouped by persona, dev share only. Holdout and `all` stay sealed.
- **Not measured.** Whether the right action followed from what was retrieved; whether a message that was returned
  but not gold still established the fact (a restated or superseded fact has several candidate messages).

## Reproduce

```sh
git checkout <sha>
npm ci && npm run build
DOLPHINBENCH_PATH=~/datasets/dolphinbench npm run eval:dolphinbench -- --instance <N> --persona alex
```

Repeat with `--persona morgan` and `--persona riley`. Download steps are in `eval/README.md`.

## Notes

- Alex was run first as the persona nearest a coding agent. It gains least over the baseline, so the nearest persona
  is not where the lead is.
- Prompt-submit beats search on precision for every persona (1.6x to 2.0x) and on recall for Alex and Riley, but not
  for Morgan, whose messages run to 17,939 characters.
- The ticket's cost estimate of about 1 min per persona was far low: ingestion through the capture path costs
  roughly 0.3 s per message because each message is a Session start, an Observation and a Session end. A
  tier-sized run is out of reach on this path.
- One run, one commit; differences of a few points between adapters on a persona are within what 120 tests can
  resolve.
