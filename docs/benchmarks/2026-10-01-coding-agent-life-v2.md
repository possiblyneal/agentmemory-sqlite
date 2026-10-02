# 2026-10-01 — coding-agent-life-v2 (v0.9.29)

**Commit:** the commit that adds this file, on top of `a273b8b`
**Bench:** coding-agent-life-v2 (21 sessions across `shipctl` and `ledger-api`, 38 questions)
**N:** 20 search (4 no-answer), 15 pre-tool-use (4 no-answer), 3 session-start (1 no-answer)
**K:** 5 (search only; an Injection is scored whole)
**Hardware:** Debian 13, 8 cores, Node 22.23
**Embeddings:** on-device (`EMBEDDING_PROVIDER=local`, `@huggingface/transformers`) or none
**LLM:** none (synthetic compression, no summaries)

Supersedes the 2026-05-20 v1 run, which only measured smart-search over
`/remember`ed blobs, needed a hand-started daemon, and had no question whose
right answer was nothing.

## Headline

The Injection paths, not search, are where Recall loses content. Search finds
the gold Session for every answerable question but never returns nothing:
**0 of 4** no-answer search questions come back empty. Pre-tool-use recalls
**0.667** of the Sessions that touched the file and leaks across projects on
every filename the two projects share.

Every path beats the seeded `random` control by a wide margin, and BM25-only
search scores below the embedding stack on recall (0.969 vs 1.000) and on
q-011/q-016 precision.

## Per path

| Adapter | Path | n | Recall | Precision | No-answer clean | Hit | Mean chars | p50 |
|---|---|---|---|---|---|---|---|---|
| agentmemory | search | 20 | **1.000** | 0.190 | 0.000 | 16/20 | — | 361 ms |
| agentmemory | pre-tool-use | 15 | **0.667** | 0.694 | 0.750 | 11/15 | 261 | 10 ms |
| agentmemory | session-start | 3 | **0.813** | 1.000 | 1.000 | 3/3 | 1911 | 98 ms |
| agentmemory-bm25 | search | 20 | 0.969 | 0.195 | 0.000 | 16/20 | — | 203 ms |
| agentmemory-bm25 | pre-tool-use | 15 | 0.667 | 0.694 | 0.750 | 11/15 | 261 | 15 ms |
| agentmemory-bm25 | session-start | 3 | 0.813 | 1.000 | 1.000 | 3/3 | 1911 | 78 ms |
| grep | search | 20 | 0.906 | 0.240 | 0.000 | 15/20 | — | 0 ms |
| random | search | 20 | 0.125 | 0.020 | 0.000 | 2/20 | — | 0 ms |
| random | pre-tool-use | 15 | 0.136 | 0.027 | 0.000 | 2/15 | — | 0 ms |
| random | session-start | 3 | 0.394 | 0.400 | 0.000 | 2/3 | — | 0 ms |

Recall is over answerable questions only. Precision is gold hits over what was
returned, averaged over every question, so a no-answer question that returns
anything scores 0. No-answer clean is the share of no-answer questions that
returned nothing. Hit is gold-in-results for answerable questions and
empty-result for no-answer ones. Mean chars is the Injection's size, the cost
the Agent pays to read it.

## Pre-tool-use, per question (agentmemory)

| Question | File | Gold | Injected | Note |
|---|---|---|---|---|
| t-001 | shipctl `src/auth.rs` | sess-001, sess-014, sess-016 | sess-016 | sess-001 falls outside the 15-Session window; sess-014 is a prompt-only post-mortem with no file |
| t-002 | shipctl `src/retry.rs` | sess-003 | — | outside the 15-Session window |
| t-003 | shipctl `src/cache.rs` | sess-006 | ledg-005, sess-006 | cross-project leak |
| t-004 | shipctl `src/db/mod.rs` | sess-008, sess-013 | sess-013, sess-008, ledg-004 | cross-project leak |
| t-005 | shipctl `src/cli/mod.rs` | sess-004 | — | outside the 15-Session window |
| t-006 | shipctl `Dockerfile` | sess-002 | ledg-003, sess-002 | cross-project leak |
| t-008 | shipctl Grep `If-None-Match` | sess-007 | sess-007, sess-016, sess-003, sess-004 | the Grep path `src` becomes a search term that matches any Session touching `src/` |
| t-010 | ledger-api `src/auth.rs` | ledg-001 | sess-016 | wrong project only |
| t-011 | ledger-api `src/cache.rs` | ledg-005 | ledg-005, sess-006 | cross-project leak |
| t-n04 | ledger-api `.github/workflows/release.yml` | none | sess-010 | cross-project leak into a no-answer |

## Methodology

- The runner starts its own daemon (`eval/runner/sandbox.ts`) under
  `tmp/eval-sandbox/instance-3/` with a scratch `HOME` and a store built from
  scratch, and removes it afterwards.
- Sessions are ingested through the capture path, oldest first:
  `POST /agentmemory/session/start`, one `POST /agentmemory/observe` per
  Observation (`prompt_submit` or `post_tool_use`), `POST /agentmemory/session/end`.
- search: `POST /agentmemory/smart-search` with the question's `project`,
  deduped by Session, truncated to K.
- pre-tool-use: `POST /agentmemory/enrich` with the file, the Grep pattern as a
  term, and `project`, from a probe Session `eval-probe`.
- session-start: `POST /agentmemory/session/start` for `eval-probe` in the
  question's project.
- An Injection is mapped back to eval Sessions by finding each Observation's
  first 48 output characters in it (XML entities unescaped, whitespace
  collapsed), in order of first appearance.

## Reproduce

```sh
git checkout <sha>
npm ci && npm run build
npm run eval:coding-life
```

## Notes

- `mem::enrich` calls `mem::file-context` without `project`
  (`src/functions/enrich.ts:35-41`), so file history from one project is
  injected into another whenever paths match. That is t-003, t-004, t-006,
  t-010, t-011 and t-n04.
- `mem::file-context` only reads the 15 most recently started Sessions
  (`src/functions/file-index.ts:53-58`), across every project because of the
  leak above. Older file history is invisible to pre-tool-use, which is
  t-001, t-002 and t-005.
- smart-search has no relevance floor: it returned 3 to 5 Sessions for every
  no-answer question.
- session-start shows the 10 most recent Sessions, so s-001's 16-Session
  project recalls 0.625 by design; the number moves if that window does.
