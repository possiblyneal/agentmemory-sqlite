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
- an environment built from scratch: `PATH`, the `HF_*` cache variables, and `EMBEDDING_PROVIDER=local` unless the adapter is `agentmemory-bm25`. No LLM provider, so compression is synthetic and there are no summaries;
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

Search no-answer clean is not gated: smart-search has no relevance floor yet, so it returns something for every query and scores 0 there. That is known debt, and the search entry gains a `noAnswerClean` floor once a relevance cutoff lands.

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
│   └── coding-life.ts             in-house benchmark runner
└── data/
    └── coding-agent-life-v2/
        ├── sessions.json          21 Sessions as tool-call Observations
        └── queries.json           38 questions with path, project and gold Session ids
```

Reports land in `eval/reports/<bench>/` (gitignored): `scores.ndjson` (one row per question, with the Session ids returned) and `summary.json`.

Published scorecards land in `docs/benchmarks/YYYY-MM-DD-<bench>.md`; the current one is [2026-10-01-coding-agent-life-v2](../docs/benchmarks/2026-10-01-coding-agent-life-v2.md).

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
