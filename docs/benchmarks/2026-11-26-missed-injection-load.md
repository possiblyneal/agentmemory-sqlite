# Missed Injections against concurrent Session activity (#603)

Read-only look at `~/.agentmemory/missed-injections.jsonl` (2,853 rows, 2026-10-29 to 2026-11-26: timeout 2,749, http_503 75, connection 29) against the typed-turn timestamps of 3,485 Operator turns in 377 Sessions under `~/.claude/projects`. Aggregates only; the transcripts stay private.

**Method.** A minute counts a Session as concurrent when it has a typed Operator turn within ±10 min. Rate is Missed Injections per 1,000 minutes at each concurrency level (4 = four or more). The log window holds 1,177 typed turns.

| Concurrent Sessions | Missed Injections | Minutes | Per 1,000 min |
|---|---|---|---|
| 0 | 1,646 | 33,958 | 48.5 |
| 1 | 412 | 3,280 | 125.6 |
| 2 | 420 | 2,020 | 207.9 |
| 3 | 219 | 839 | 261.0 |
| 4+ | 156 | 744 | 209.7 |

Active minutes (1+) run 175 per 1,000 (1,207 rows over 6,883 minutes) against 48.5 idle: 3.6x. Repeats: splitting the log at its median time gave idle 33.7 / active 179.2 (first half) and idle 53.6 / active 132.4 (second half); a ±5 min window gave 167.4, 255.6, 280.4, 189.1 for 1 to 4+; a ±30 min window gave 68.5, 182.1, 144.6, 202.4.

**Limits.** 1,646 of 2,853 rows fall where no typed Session is active, so load that transcripts do not show (evals, subagents, replays) also causes timeouts. The 10 busiest hours hold 29.2% of rows (2026-11-11 04:00 UTC alone holds 185). The association is not a causal estimate; the log holds no per-request latency.

**Verdict.** An association, not a lever. The queueing fix (`ShedQueue`, #400) already targets it. No code change.
