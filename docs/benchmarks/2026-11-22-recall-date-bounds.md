# Exact Recall date bounds — 2026-11-22

**Hypothesis (#513):** Date eligibility before the candidate limit retains in-range records even when higher-scoring records fall outside the range.

**Synthetic vector crowding:** 2,020 vectors, 20 eligible, a limit of 10, and 20 runs. Filtering after a capped unbounded search returned 0 of 200 eligible slots; filtering before the cap returned 200 of 200 with an in-memory eligibility map. A separate bounded `HybridSearch` run with a throwaway SQLite `StateKV` returned 200 of 200, with a p50 of 41.288 ms and a p95 of 53.193 ms. The latter measures vector-only retrieval, not HTTP, the smart-search relevance floor, or live-store latency.

**Unbounded control:** The omitted-bounds `npm run eval:gate` passed. This regression check does not measure the new bounded paths.

**Coding-life unbounded control:** The dev split compared baseline `3262da407645dbada448a984c915da310b5b3e39` with candidate `e9dfaf025117b749bd81e5bbe73f707e5f628db3`, each in a separate throwaway daemon with local `Xenova/all-MiniLM-L6-v2` embeddings. All 23 paired query results matched apart from latency. Search recall/precision were 1.000/0.708 in both arms (12 queries); session-start 0.625/1.000 (2); prompt-submit 0.861/1.000 (9). A separate post-scoring diagnostic in each arm reported 67 vector rows, a 384-dimensional query embedding and 5 vector hits; it witnesses that diagnostic query, not every scored query. These runs omit date bounds, and the later fractional-timestamp correction was not measured. Single runs under uncontrolled load do not establish a latency difference.

**Verdict:** Eligibility before truncation prevents starvation in the synthetic vector fixture. The fixture does not estimate bounded Recall quality on the Operator's workload.
