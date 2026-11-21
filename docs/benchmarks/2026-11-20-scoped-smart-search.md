# 2026-11-20 — Scoped smart-search (#444)

On a synthetic 20,000-Observation store, widening the candidate window recovered all three
in-project hits that the control missed. The crowded query cost 8.6 ms more at p95; the
full-page query took the existing path without widening.

| Project | Hits, control → candidate | p50, ms | p95, ms |
|---|---:|---:|---:|
| Crowded | 0 → 3 | 8.45 → 15.74 | 11.06 → 19.65 |
| Full page | 5 → 5 | 7.22 → 7.72 | 9.86 → 10.69 |

## Method

- **Builds:** `6f7b1a09` (no search changes from `04f889f5`) versus the #444 patch.
- **Store:** Identical fresh SQLite copies, 200 Sessions with 100 Observations each. The query
  matches three Observations in the target Session and one stronger Observation in each of
  150 foreign Sessions. Other Observations do not match. Spreading competitors across Sessions
  is necessary: HybridSearch diversification can otherwise admit the target into the first window.
- **Calls:** Serial `POST /agentmemory/smart-search`, `limit: 5`, Lessons and Insights off;
  five warmups and 30 measured requests per project and build. Linux x86_64, 12 CPUs, Node
  22.23.4; no embeddings or LLM.
- **Limits:** This fixture uses the burst-store size, not its content or concurrent hook traffic.
  It measures one query shape, not live-store latency. Earlier seeds did not demonstrate a
  hit gain: Session diversification admitted the target, or its hits were too weak.

The #459 fast eval matched all 15 baseline metrics; the local Recall and pinned-rule gates passed.
