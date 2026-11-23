# Exact Recall date bounds — 2026-11-22

**Hypothesis (#513):** Date eligibility before the candidate limit retains in-range records even when higher-scoring records fall outside the range.

**Synthetic vector crowding:** 2,020 vectors, 20 eligible, a limit of 10, and 20 runs. Filtering after a capped unbounded search returned 0 of 200 eligible slots; filtering before the cap returned 200 of 200 with an in-memory eligibility map. A separate bounded `HybridSearch` run with a throwaway SQLite `StateKV` returned 200 of 200, with a p50 of 41.288 ms and a p95 of 53.193 ms. The latter measures vector-only retrieval, not HTTP, the smart-search relevance floor, or live-store latency.

**Unbounded control:** The omitted-bounds `npm run eval:gate` passed. This regression check does not measure the new bounded paths.

**Verdict:** Eligibility before truncation prevents starvation in the synthetic vector fixture. The fixture does not estimate bounded Recall quality on the Operator's workload.
