# 2026-11-14 — One amendment search per prompt

**Commit:** this PR against main `ce36aa5d` (refs #371, possiblyneal/homelab#258)
**Bench:** `eval:suite --tier fast` (coding-life, PrecisionMemBench, LongMemEval sample) against
main; `eval:gate`; a throwaway pair of daemons (`--instance 61` main, `--instance 62` this
branch) on two copies of one `VACUUM INTO` copy of the live store (99,317 indexed records),
reranker off, auto-compress off. `POST /agentmemory/prompt-context` with 100 prompts
replayed from the live journal's last 24 h of searches (project `devex`), 1 and 4 concurrent
callers, plus 200 prompts sent to both daemons and their Injections compared
**N:** 100 requests per cell; 200 paired prompts
**LLM:** none
**Hardware:** Intel i3-10100T (8 threads), Node 22; load average 9.9 at the start of the probe
(other agents and an eval were running, so absolute times are rough; both arms ran back to back)

## Headline

Each prompt now runs one amendment search, not up to three. At 4 callers the share of
prompt-context requests over the hook's 1500 ms wait fell from 47 to 9 of 100. The fast suite
and the gate are identical to main on all 15 metrics, but they contain no amendment case. On
the Operator's real prompts, 12 of 200 Injections (6%) lose a Session that the old code added
as an amendment.

## Lever

`withLaterAmendments` (`src/functions/prompt-context.ts`) ran `laterAmendment` for every chosen
covered Session, each a full `mem::search` of the Summary's title and 10 decisions. They run on
the single search lane, so three of them cost most of a prompt's time. It now runs it for the
best-ranked covered Session only.

Reusing the prompt's own hit list was not possible: the amendment is the Session closest to the
*given Session's decisions*, which is a different query from the prompt, and its 0.35 and 1.25x
thresholds are scores against that query.

## Result

`/prompt-context` latency, ms (gate off):

| callers | arm | p50 | p90 | p99 | over 1500 ms |
|---|---|---|---|---|---|
| 1 | before | 349 | 868 | 2667 | 3 |
| 1 | after | 245 | 555 | 1452 | 0 |
| 4 | before | 1438 | 2033 | 2910 | 47 |
| 4 | after | 986 | 1450 | 1794 | 9 |

## Quality

`eval:suite --tier fast --against base`: 15 metrics, every Δ 0.000. `eval:gate`: every metric
equals its baseline.

Injection comparison on 200 real prompts (the `Session "..."` blocks of each Injection):
188 identical, 12 differ. In all 12 the old Injection holds extra Sessions the new one lacks
(1 or 2 each). From the four printed, the dropped Sessions are unrelated to the prompt (a font
tuning Session for a question about firmware, the OmniRoute retirement Session on several
others), which suggests they are noise, but this was not judged.

## Not measured

The amended sdebench tasks the thresholds were tuned on need an LLM agent per task and were
not run. A lost amendment on those tasks is the regression this change risks; run them before
shipping if the 6% matters.
