# 2026-11-20 — Scoped smart-search (#444)

On a synthetic 20,000-Observation store, widening the candidate window recovered all three
in-project hits that the control missed. The crowded query cost 11.4 ms more at p95; the
full-page query took the existing path without widening.

| Project | Hits, control → candidate | p50, ms | p95, ms |
|---|---:|---:|---:|
| Crowded | 0 → 3 | 7.44 → 16.59 | 10.08 → 21.52 |
| Full page | 5 → 5 | 7.90 → 7.55 | 10.28 → 10.79 |

## Synthetic crowding method

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

## Canonical burst seed

Both builds queried fresh copies of `eval:burst`'s `seed-20000.sqlite`: 20,000 Observations in
12 Sessions, all in `burst-bench`. Calls were serial and BM25-only, with the same options as
above, rotating five queries: `search observations`, `session context`, `summary decisions`,
`database state`, and `async function`. Each build and project had ten warmups and 30 measured
requests. These are smart-search timings, not concurrent Injection latency.

| Project | Hits, control → candidate | p50, ms | p95, ms |
|---|---:|---:|---:|
| `burst-bench` | 5 → 5 | 40.16 → 46.24 | 49.15 → 78.14 |
| `absent-project` | 0 → 0 | 40.53 → 869.98 | 54.96 → 1,225.19 |

The absent project exercises the full widening path without adding hits. An earlier run on
this seed had similar empty-page p95 (50.88 → 1,146.57 ms), while its full-page p95 was
50.77 → 48.22 ms. Full pages do not widen; the serial runs do not isolate host-load variation.

The #459 fast eval matched all 15 baseline metrics; the local Recall and pinned-rule gates passed.
