# Capture miss or recall miss for repeated Operator instructions (#604)

Read-only labelling of the Operator's typed turns (3,485 in 377 Sessions) against the live store. A regex selected 128 candidate turns (correction or repeat wording); a reader kept 7 that genuinely restate an instruction given in an earlier, different Session, and dropped 121. Same-Session repeats were dropped because the Agent already holds them. Labels use the later turn's own text as the query against `smart-search` (top 50, Observations only). Aggregates only.

| Label | Cases |
|---|---|
| capture miss (earlier instruction not stored) | 0 |
| stored, rank 11-50 (outside `GATE_POOL`) | 1 |
| stored, never in top 50 for the later turn's query | 2 |
| stored, rank 8 (inside the pool, no gate verdict) | 1 |
| ambiguous (only topical Semantic Facts found) | 3 |
| delivered-possible (top 3) | 0 |

**Limits.** n=7. Smart-search ranks Observations, so Facts and Lessons have no pool rank. A bigger pool could reach 1 of 7 at most; 2 of 7 would need a different query, not a larger pool.

**Verdict.** Inconclusive for #604; the sample cannot support or refute raising `GATE_POOL`. The labels point away from capture (0 of 7 capture misses) and away from pool size as the main cause (1 of 7). No code change.
