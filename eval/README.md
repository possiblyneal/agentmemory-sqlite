# agentmemory-evals

Recall benchmarks for agentmemory, scored on what each Injection puts in front of the Agent.

Two families:

- **coding-agent-life-v2** — in-house corpus of 21 fictional Claude Code Sessions across two projects (`shipctl`, a Rust CLI, and `ledger-api`, which shares filenames with it), with 38 hand-graded questions split by the path that would answer them. Runs offline in about 30 seconds.
- **LongMemEval** — public 500-question long-term memory benchmark over multi-session chat, search path only.

## Paths

A question names the path it exercises, and each path is scored on its own:

| Path | What the eval calls | Scored |
|---|---|---|
| `search` | `POST /agentmemory/smart-search` with the question's `project` | top K Sessions |
| `session-start` | `POST /agentmemory/session/start` for a probe Session — what the session-start hook injects | the whole Injection |
| `prompt-submit` | the user prompt as the question — what `POST /agentmemory/prompt-context` returns for it, the per-prompt Injection | the whole Injection |

An Injection is text, so the runner maps it back to eval Sessions by finding each Observation's output in it.

## Metrics

- **recall** — gold Sessions returned over gold Sessions, answerable questions only.
- **precision** — gold Sessions over Sessions returned, averaged over every question. A near-miss costs precision even when the gold Session is also there; a no-answer question that returns anything scores 0.
- **no-answer clean** — share of no-answer questions (`goldSessionIds: []`) that returned nothing. Every path has some: a topic never worked on and, on search and prompt-submit, one project's work asked from the other project. `prompt-submit` adds bare acknowledgements (`yes`, `continue`), which should never inject.
- **hit** — gold in results for answerable questions, empty results for no-answer ones.
- **chars** — mean size of the Injection, the cost the Agent pays to read it.

## Adapters

| Adapter | Backend | Paths | Needs |
|---|---|---|---|
| `agentmemory` | sandbox daemon, on-device embeddings | all | `npm run build`; the embedding model downloads from Hugging Face on first use |
| `agentmemory-bm25` | sandbox daemon, no embeddings | all | `npm run build` |
| `grep` | tokenized substring match, project-filtered | search, prompt-submit | nothing |
| `random` | k Sessions drawn per question, seeded by question id | all | nothing — the floor every path must beat |
| `vector` | OpenAI `text-embedding-3-small` + cosine | search | `OPENAI_API_KEY` (paid) |

## Sandbox

The `agentmemory` adapters start their own daemon (`runner/sandbox.ts`) and stop it when they finish. It runs `dist/cli.mjs --instance 3` (REST 3411) with:

- a store and a scratch `HOME` under `tmp/eval-sandbox/instance-3/`, deleted before and after the run, so neither your real `~/.agentmemory` store nor its `.env` is touched;
- an environment built from scratch: `PATH`, the `HF_*` cache variables, `EMBEDDING_PROVIDER=local` unless the adapter is `agentmemory-bm25`, the shell's `EMBEDDING_PROVIDER` and `OPENAI_EMBEDDING_*` when set (not for `agentmemory-bm25`), and `RERANK_ENABLED` when the shell sets it (`RERANK_ENABLED=true npm run eval:coding-life` scores the cross-encoder reranker). No LLM provider, so compression is synthetic and there are no summaries;
- its log at `tmp/eval-sandbox/instance-3.log`.

The run refuses to start if any of the instance's three ports (REST 3411, streams 3412, viewer 3413) is in use; pick another block with `--instance N`. On a stop the daemon gets 10 seconds to exit after SIGTERM before it is killed. To score a daemon you started yourself instead, pass `--base-url http://localhost:PORT` (or set `AGENTMEMORY_BASE_URL`) — the runner then ingests into that store, so point it at a throwaway one. `npm run eval:gate` ignores both and always starts a fresh sandbox.

## Quickstart

### coding-agent-life-v2

```sh
npm run build
npm run eval:coding-life                      # agentmemory, agentmemory-bm25, grep, random
npm run eval:coding-life -- --adapters grep   # no daemon
```

### CI gate

```sh
npm run build
npm run eval:gate
```

Runs the adapters named in `baselines/coding-agent-life-v2.json` (today `agentmemory-bm25`) and compares recall, precision and no-answer clean per path against the recorded numbers. Any metric more than `tolerance` (0.02) below its baseline fails the run with a per-metric diff:

```text
FAIL agentmemory-bm25/search          recall        baseline 0.969  got 0.156  -0.813
```

Search is gated on all three metrics. smart-search drops hybrid hits below a relevance floor (BM25 of at least 3.5 and half the best match, or a cosine of at least 0.3 on a hit BM25 also matched), so an off-topic query can return nothing. Search no-answer clean is 0.25, not 1: three of its four no-answer questions still have a lexical match above the floor (best BM25 3.9, 4.9 and 6.4), and gold Sessions score as low as 3.8, so a floor high enough to clear them (4.0 clears only the first) costs search recall.

CI runs it on the ubuntu / Node 22 leg. The gate is BM25-only so CI never downloads the embedding model and needs no network beyond `npm ci`; the on-device embedding stack is still measured by `npm run eval:coding-life`. A PR that changes these numbers on purpose updates the baseline file in the same PR and says why. One question gained or lost on a path moves recall by at least 0.05, so the tolerance only absorbs rounding.

### LongMemEval `_s` (public, 278MB download)

```sh
mkdir -p ~/datasets/longmemeval
curl -Lo ~/datasets/longmemeval/longmemeval_s.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s

LONGMEMEVAL_PATH=~/datasets/longmemeval/longmemeval_s.json \
  npm run eval:longmemeval -- --adapters grep,agentmemory --stratify 10
```

The `agentmemory` adapter starts a fresh sandbox per question there, since every question brings its own haystack.

### Replay (the Operator's own transcripts)

```sh
npm run build
npm run eval:replay -- --projects=-home-neal-code-homelab,-home-neal-code-glydr --cap 40
```

`runner/replay.ts` replays real Claude Code Sessions from `~/.claude/projects/<dir>/*.jsonl` (read-only) in start-time order, all projects interleaved, into one throwaway daemon. It is not part of CI and not published: the data is private. Before it ingests Session k it probes what the Agent would have been given, against a store holding only Sessions 1..k-1:

- `session/start` with the Session's real id, cwd and project, so the session-start Injection and the per-Session dedupe of later Injections behave as in a live Session;
- `prompt-context` for each real human prompt (the per-prompt Injection), and `smart-search` (top 5, project-scoped) for the same prompt as a query-driven baseline;

then ingests Session k through `/agentmemory/replay/import-jsonl`, the path `agentmemory import-jsonl` uses. What each probe delivered is read back from `GET /agentmemory/injections` (the daemon's own record of the Injected Memories), not guessed from the text.

Flags: `--projects=a,b` (directory names under `~/.claude/projects`; use `=` because they start with `-`), `--cap N` (Sessions per project, earliest first, default 40), `--min-turns N` (default 2; drops the one-prompt automated `claude -p` runs that otherwise dominate), `--max-prompts N` (prompts probed per Session, default 40), `--instance N` (default 9, never 0; ports 3111+100N), `--embeddings local|none` (default `local`), `--out DIR` (default `tmp/eval-replay`). Subagent transcripts (`agent-*.jsonl`, `subagents/`), sidechain entries, harness-written turns, slash-command wrappers and files over 20 MB are skipped.

Providers are recorded in `summary.json`. There is no LLM provider, so Memories are synthetic and there are no summaries or Crystals worth recalling. For a remote embedder set the same variables the daemon reads in the shell, for example `EMBEDDING_PROVIDER=openai OPENAI_EMBEDDING_BASE_URL=... OPENAI_EMBEDDING_API_KEY=... OPENAI_EMBEDDING_MODEL=... OPENAI_EMBEDDING_DIMENSIONS=...`; the sandbox forwards `EMBEDDING_PROVIDER` and `OPENAI_EMBEDDING_*` (and `RERANK_ENABLED`) when set and `--embeddings` is not `none`. Never commit an endpoint.

Output under `tmp/eval-replay/` (gitignored, because it quotes private transcripts): `summary.json` (run config, providers, per-Goal-line numbers), `scores.ndjson` (one row per Session), `worst-cases.md` (up to 20 misses, noise items and leaks, each with Session id and turn). Only the aggregates go into a scorecard under `docs/benchmarks/`.

#### Answer key

Derived from Session k's transcript against earlier Sessions of the same project (Recall is project-scoped, so another project's Session could never have been injected):

| Rule | Key item | Delivered when |
|---|---|---|
| Files needed | a file Session k read or edited (project-relative path) that an earlier Session also read or edited, at its first turn of use | a probe at turn <= that turn returned an item whose files list names it |
| Repeated correction | a human turn of k that looks like a correction (`no`, `don't`, `I told you`, `stop doing`, ...; at most 500 chars) and shares >= 3 content words and at least half the shorter side with an earlier correction | an Injection at turn < k's turn returned an item holding >= 60% of the earlier correction's content words |
| Decision revisited | a non-correction turn of k that shares the same overlap with an earlier turn phrased as a decision (`decided`, `go with`, `from now on`, `we'll use`, ...) | an Injection at turn <= k's turn returned an item holding >= 60% of that earlier turn's words |

Session start is turn 0; a prompt's Injection arrives before the work on that prompt. A repeated correction means the Agent went wrong on the prompt before it, so the Injection at the correction's own turn is too late. The same key is also checked against the `smart-search` probes, for the "search alone" baseline (the same deadline).

#### Scoring per Goal line

| Goal line | Metric |
|---|---|
| Right content | share of Injected items Session k used (item files overlap files k touched, or the item delivers a key item, or it bears on a human turn of k); Injection chars per used item |
| Right moment | share of key items delivered in time by Injection alone, by search alone, and by either; split by rule |
| Right scope | Injected items whose project is not Session k's project (target 0) |
| Durable beats recent | share of repeated corrections whose earlier correction was injected before the repeat |
| Least record | store bytes at the end per distinct item ever used |
| Never on the critical path | p50/p99 of each probe, and how many exceeded the 1.5 s hook timeout |
| Operator attention | store growth in bytes per replayed week (span of start times, at least one day) |

#### Blind spots

The key is a proxy and the numbers are not accuracy:

- A file the Agent read again is not proof the Agent needed the Memory about it; a Memory that was used without touching a file is invisible. The audit in each scorecard measures how many proxy misses were real.
- `CLAUDE.md` files count as needed files although Claude Code loads them without Recall, and an automated "Another Claude session sent a message" turn (a teammate agent's report) counts as a human prompt, as a probe and as a decision source. The first audit found these two behind 13 of 20 proxy misses (`docs/benchmarks/2026-10-06-replay-eval.md`).
- Correction and decision detection is by phrase and word overlap. It misses paraphrases and corrections the Operator typed in an unusual way, and flags quotations or pasted text that happen to match.
- Items count as "used" by the same word-overlap test, so a Memory that shaped the Agent's behaviour without sharing words with any prompt counts as noise.
- Project is the importer's (git toplevel basename, else cwd basename), not the live hooks' `resolveProject()`; a worktree of the same repository is a separate project here, so Sessions in different worktrees never recall each other.
- Without an LLM provider the sandbox holds no Memories beyond lessons the importer extracts by phrase, so the "titles and concepts of earlier Memories" form of a revisited decision is not measured; decisions come from earlier human turns.
- Only prompts up to `--max-prompts` are probed, and only Sessions with `--min-turns` human turns are replayed. History before the oldest transcript on disk is absent.
- Files outside the Session's cwd (`~/.claude`, `/tmp`) are ignored on both sides.

## Repo layout

```text
eval/
├── README.md
├── baselines/
│   └── coding-agent-life-v2.json  CI gate: per adapter × path floors and tolerance
├── runner/
│   ├── types.ts                   Adapter, Question, QueryResult, ScoreRow
│   ├── score.ts                   per-question scoring, per adapter × path aggregation, baseline gate
│   ├── sandbox.ts                 throwaway daemon under tmp/eval-sandbox/
│   ├── load.ts                    LongMemEval JSON → Question[]
│   ├── adapters/
│   │   ├── agentmemory.ts         capture path in; smart-search, session/start, prompt-context out
│   │   ├── grep.ts                tokenized substring baseline
│   │   ├── random.ts              seeded random control
│   │   └── vector.ts              OpenAI embeddings + cosine
│   ├── longmemeval.ts             public benchmark runner
│   ├── coding-life.ts             in-house benchmark runner
│   ├── replay.ts                  replay runner over ~/.claude/projects transcripts (daemon glue)
│   ├── replay-transcript.ts       transcript JSONL → Session (prompts, files, turns)
│   ├── replay-answer-key.ts       files needed, repeated corrections, decisions revisited
│   └── replay-score.ts            per-Goal-line scoring, summary, worst cases
└── data/
    └── coding-agent-life-v2/
        ├── sessions.json          21 Sessions as tool-call Observations
        └── queries.json           38 questions with path, project and gold Session ids
```

Reports land in `eval/reports/<bench>/` (gitignored): `scores.ndjson` (one row per question, with the Session ids returned) and `summary.json`.

Published scorecards land in `docs/benchmarks/YYYY-MM-DD-<bench>.md`; the current one is [2026-10-05-coding-agent-life-v2](../docs/benchmarks/2026-10-05-coding-agent-life-v2.md).

## Writing a new adapter

1. Implement `Adapter<State>` from `eval/runner/types.ts`:
   ```ts
   import type { Adapter } from "../types.js";
   export const myAdapter: Adapter<MyState> = {
     name: "my-adapter",
     paths: ["search"],
     async init(sessions, config) { /* index */ return state; },
     async query(q, state, k) { /* search q.question */ return { ranked }; },
   };
   ```
2. Register it in the `ADAPTERS` map of `eval/runner/{longmemeval,coding-life}.ts`.
3. Run it against `coding-agent-life-v2` before spending anything on LongMemEval.

## Writing a new question

Add it to `data/coding-agent-life-v2/queries.json` with a `path`, a `project`, and the gold Session ids — `[]` when the right Injection is nothing. Every Observation's first 48 output characters must be unique across Sessions, because that is how an Injection is attributed; `test/eval-adapters.test.ts` checks it.
