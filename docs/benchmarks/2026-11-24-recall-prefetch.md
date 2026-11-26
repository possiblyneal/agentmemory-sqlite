# Prefetch Recall from tool activity (#569)

Baseline `562ed60d`. A synthetic timestamp replay feeds identical arrivals to one FIFO lane. Each search occupies six virtual time units; each Injection has seven units from prompt arrival. Completed tool activity can enqueue a search using only the tool's Session, project, query and observed version. The prompt reuses a ready result only when those fields still match, otherwise it enqueues normal Recall. Validation is free in this model. Assume a matching result is correct; this tests scheduling, not ranking. Require a net gain in timely correct-result proxies and no deadline loss for another Session. No live daemon, model, or repository holdout was used.

| Measure | On demand | Tool prefetch |
|---|---:|---:|
| Timely result proxies | 5 of 6 | 4 of 6 |
| Searches | 6 | 9 |
| Lane time (virtual units) | 36 | 54 |
| Unused prefetches | 0 | 3 |

Prefetch made one late prompt timely and turned two timely prompts from other Sessions into misses; each waited three additional units. The idle matching prompt improved from six units to zero. The stale candidate, the query/project mismatch and the candidate with no following prompt were discarded.

**Verdict: rejected.** Non-preemptive prefetch lost timely results and used more search work. Retry with a measured idle-only or cancellable lane policy under live matched load, tracking actual relevance, validation latency, and cross-Session interference.

Reproduce with `npx tsx eval/runner/recall-prefetch.ts`; verify with `npx vitest run test/eval-recall-prefetch.test.ts`.
