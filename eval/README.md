# agentmemory-evals

Recall benchmarks for agentmemory, scored on what each Injection puts in front of the Agent.

Four benches, run together by `eval:suite`:

- **coding-agent-life-v2** — in-house corpus of 22 fictional Claude Code Sessions across two projects (`shipctl`, a Rust CLI, and `ledger-api`, which shares filenames with it), with 38 hand-graded questions split by the path that would answer them. Runs offline in about 30 seconds.
- **LongMemEval** — public 500-question long-term memory benchmark over multi-session chat, search path only.
- **BEAM** — 100K and 500K long-conversation splits, scored on Recall alone from each question's `source_chat_ids` (`npm run eval:beam`).
- **PrecisionMemBench** — public 77-case benchmark asserting exactly which of 35 beliefs a search must and must not return; noise fails a case.
- **Replay** — the Operator's own Claude Code transcripts, replayed in order and scored per Goal line. Private; never published beyond aggregates.

`eval:supersession` runs on its own, outside the suite: it scores whether a newer, contradicting claim outranks the older one (see Supersession below).

## Paths

A question names the path it exercises, and each path is scored on its own:

| Path | What the eval calls | Scored |
|---|---|---|
| `search` | `POST /agentmemory/smart-search` with the question's `project` | top K Sessions |
| `session-start` | `POST /agentmemory/session/start` for a probe Session — what the session-start hook injects | the whole Injection |
| `prompt-submit` | the user prompt as the question — what `POST /agentmemory/prompt-context` returns for it, the per-prompt Injection | the whole Injection |
| `pre-compact` | `POST /agentmemory/context` at budget 1500 for a probe Session, as the pre-compact hook posts it | the whole Injection |

An Injection is text, so the runner maps it back to eval Sessions by finding each Observation's output in it.

## Metrics

- **recall** — gold Sessions returned over gold Sessions, answerable questions only.
- **precision** — gold Sessions over Sessions returned, averaged over every question. A near-miss costs precision even when the gold Session is also there; a no-answer question that returns anything scores 0.
- **no-answer clean** — share of no-answer questions (`goldSessionIds: []`) that returned nothing. Every path has some: a topic never worked on and, on search and prompt-submit, one project's work asked from the other project. `prompt-submit` adds bare acknowledgements (`yes`, `continue`), which should never inject.
- **hit** — gold in results for answerable questions, empty results for no-answer ones.
- **chars** — mean size of the Injection, the cost the Agent pays to read it.
- **first** and **max share** (pinned-rule questions only, the `=== Pinned rules ===` table and `rules` in `summary.json`) — the share of answerable questions whose Injection leads with a gold Session, and the largest share of the Injection's budget the `## Rules` block took (its estimated tokens over 2000 at session start, 1500 at pre-compact).

## Adapters

| Adapter | Backend | Paths | Needs |
|---|---|---|---|
| `agentmemory` | sandbox daemon, on-device embeddings | all | `npm run build`; the embedding model downloads from Hugging Face on the first sandbox run |
| `agentmemory-bm25` | sandbox daemon, no embeddings | all | `npm run build` |
| `grep` | tokenized substring match, project-filtered | search, prompt-submit | nothing |
| `random` | k Sessions drawn per question, seeded by question id | search, session-start, prompt-submit | nothing — the floor every path must beat |
| `vector` | OpenAI `text-embedding-3-small` + cosine | search | `OPENAI_API_KEY` (paid) |

## Sandbox

The `agentmemory` adapters start their own daemon (`runner/sandbox.ts`) and stop it when they finish. It runs `dist/cli.mjs --instance 3` (REST 3411) with:

- a store and a scratch `HOME` under `tmp/eval-sandbox/instance-3/`, deleted before and after the run, so neither your real `~/.agentmemory` store nor its `.env` is touched;
- the embedding model cached in `tmp/eval-sandbox/models/` (`AGENTMEMORY_MODEL_CACHE_DIR`), which outlives every instance, so only the first run ever downloads it and a replay checkpoint restore does not re-download it into its first search's latency;
- an environment built from scratch: `PATH`, the `HF_*` cache variables, `EMBEDDING_PROVIDER=local` unless the adapter is `agentmemory-bm25`, the shell's `EMBEDDING_PROVIDER`, `OPENAI_EMBEDDING_*` and `AGENTMEMORY_LOCAL_EMBEDDING_*` (model, dimensions) when set (not for `agentmemory-bm25`), and `RERANK_ENABLED` when the shell sets it (`RERANK_ENABLED=true npm run eval:coding-life` scores the cross-encoder reranker), and `AGENTMEMORY_MEMORY_CHUNKING` when the shell sets it (`eval:suite` records it in the run's config). No LLM provider, so compression is synthetic and there are no summaries. Synthetic compression rates every Observation 5, so the runner writes each Observation's `importance` from `sessions.json` over the stored row (read back through `GET /observations`, merged through `POST /import`) and refuses to run unless the store ends up with more than one value;
- the Injection Gate (prompt-submit only) off (`AGENTMEMORY_PROMPT_RERANK=off`), so runs are BM25-only and never touch the network. To score the gate, set `AGENTMEMORY_PROMPT_RERANK_URL` in the shell (for example `AGENTMEMORY_PROMPT_RERANK_URL=http://ai.lan:9202/v1/rerank npm run eval:coding-life`); the sandbox then forwards `AGENTMEMORY_PROMPT_RERANK`, `_URL`, `_MIN` and `_TIMEOUT_MS` when set. Without the URL it ignores the other three. `npm run eval:gate` must stay BM25-only, so never set the URL for it;
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

The baseline also carries `latencyCeilingMs`, a per-adapter, per-path maximum for the p95 Injection latency: 500 ms for `prompt-submit` and `session-start` (and `pre-compact` in `baselines/pinned-rules.json`), none for `search`. 500 ms is `INJECT_TIMEOUT_MS` (1500 ms) minus the Injection Gate's 1000 ms reranker cap, so a slower p95 would risk Missed Injections once the reranker is on. Tolerance does not apply. The gate prints each gated path's p95, ceiling and margin, and fails when the p95 is over the ceiling or the path is missing from the run; p95 is nearest-rank, so on the 15 and 3 questions of those paths it is the slowest question.

```text
FAIL agentmemory-bm25/prompt-submit   p95 620ms  ceiling 500ms  margin -120ms
```

Search is gated on all three metrics. smart-search drops hybrid hits below a relevance floor (BM25 of at least 3.5 and half the best match, or a cosine of at least 0.3 on a hit BM25 also matched), so an off-topic query can return nothing. Search no-answer clean is 0.25, not 1: three of its four no-answer questions still have a lexical match above the floor (best BM25 3.9, 4.9 and 6.4), and gold Sessions score as low as 3.8, so a floor high enough to clear them (4.0 clears only the first) costs search recall.

CI runs it on the ubuntu / Node 22 leg. The gate is BM25-only so CI never downloads the embedding model and needs no network beyond `npm ci`; the on-device embedding stack is still measured by `npm run eval:coding-life`. A PR that changes these numbers on purpose updates the baseline file in the same PR and says why. One question gained or lost on a path moves recall by at least 0.05, so the tolerance only absorbs rounding.

### Pinned rules

```sh
npm run build
npm run eval:coding-life -- --data eval/data/pinned-rules --adapters agentmemory-bm25,agentmemory
npm run eval:gate:rules                       # CI: baselines/pinned-rules.json
```

`data/pinned-rules/` measures whether a `type: "rule"` Memory reaches the Agent through the `## Rules` block (`buildRulebook`, `src/functions/context.ts`) at session start and at pre-compact. It holds two projects of work Sessions, each with more Sessions than either budget fits, and three content-only Sessions that carry `"memoryType": "rule"`, which the runner saves through `POST /agentmemory/remember` as that type:

- **`rule-buried`** (#290 F3, a rule delivered but buried) — `tidepool` states its rule on the first day and works eight more Sessions; the rule must still be in the Injection although its day's work no longer fits.
- **`rule-amended`** (#290 F2, the stale rule followed) — `kelpie` states an exact-pin rule, then replaces it with a caret-range rule four days later; the gold is the newer rule only, so the stale one costs precision, and **first** says whether the newer one leads.
- a project never worked on, at each path, which must inject nothing.

It is a corpus of its own because its Sessions would shift BM25 scores for the coding-agent-life-v2 questions. `eval:gate:rules` gates recall and no-answer clean and the 500 ms p95 ceilings for both paths; precision is not gated, because with the rule as the only gold it counts how many work Sessions the budget fits. CI runs it after `eval:gate`, on the same leg. The share assumes the default session-start budget of 2000: against a live daemon (`--base-url`) with a changed `TOKEN_BUDGET`, session start is still reported against 2000. With six questions the dev split leaves only some of them, so the published numbers come from `--split all`.

### LongMemEval `_s` (public, 278MB download)

```sh
mkdir -p ~/datasets/longmemeval
curl -Lo ~/datasets/longmemeval/longmemeval_s.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s

LONGMEMEVAL_PATH=~/datasets/longmemeval/longmemeval_s.json \
  npm run eval:longmemeval -- --adapters grep,agentmemory --stratify 10
```

The `agentmemory` adapter starts a fresh sandbox per question there, since every question brings its own haystack, and dates each stored Session by its `haystack_dates` entry, so a query that names a date can match it.

### DolphinBench (public, 3.2MB download, run once)

```sh
D=~/datasets/dolphinbench
for f in facts/train messages/train tests/test; do
  mkdir -p $D/$(dirname $f)
  curl -Lo $D/$f.parquet https://huggingface.co/datasets/mem0ai/dolphinbench/resolve/main/$f.parquet
done

DOLPHINBENCH_PATH=$D npm run eval:dolphinbench -- --instance 21
```

A retrieval-only derivative of Mem0's benchmark (Apache-2.0; never commit the data): no answerer, no judge, and not comparable with Mem0's published scores. Each test's `request` is the query, and the gold is every message in `source_message_ids` of the facts the test requires. `runner/dolphinbench-load.ts` turns each persona's whole history into one Session per message, ingested as a prompt Observation. The runner ingests a persona once, queries all its tests against that store, runs Alex first, and scores each adapter on `search` and `prompt-submit` (`--paths`; `vector` only does search and needs an OpenAI key, so it is opt-in through `--adapters`). It splits through `selectSplit("dolphinbench", ...)` by persona, so it scores the dev share unless the holdout is named. It needs Node >=22.15 (zstd parquet through `node:zlib`). About 500K tokens per persona, and ingestion takes 20 to 30 minutes each, so it is a one-off, outside every tier.

### BEAM (public, 100K and 500K splits, retrieval only)

BEAM (arXiv 2510.27246) is scored on Recall alone: no answerer, no judge. Each probing question's `source_chat_ids` are the gold; abstention has none and is skipped, as is any probe without ids. The dataset is CC-BY-SA-4.0 (share-alike), so it is fetched into the gitignored, shared `tmp/datasets/beam/` and never committed. Fetch each split as one datasets-server page (about 15 MB and 90 MB):

```sh
mkdir -p /path/to/repo/tmp/datasets/beam && cd /path/to/repo/tmp/datasets/beam
for s in 100K 500K; do
  curl -so $s.json "https://datasets-server.huggingface.co/rows?dataset=Mohammadta/BEAM&config=default&split=$s&offset=0&length=100"
done

BEAM_PATH=/path/to/repo/tmp/datasets/beam npm run eval:beam -- --size 100K --adapters grep,agentmemory-bm25
```

`beam-load.ts` turns a conversation into one Session per Turn (a user message and the replies to it, dated by its batch's `time_anchor`), because a batch is 60 to 100 messages and `k=15` over 3 to 10 batches would return the whole chat. A chat id maps to the Turn that holds it. The `agentmemory` adapter ingests one conversation once and answers all its Questions from that sandbox, rather than one sandbox per question. `type` is the BEAM ability; `--k` (default 15, the paper's best budget, §5) is the primary cut and `--sweep` (default 5,10,20) rescoring the same retrieval at other cuts. `--conversations N` samples every Nth conversation, for a split too slow to run whole (the `agentmemory` adapter embeds each Turn, about 6 s per Turn on a loaded machine). `--split` works as for the other runners, and `--out` receives `scores.ndjson`, `ingest.ndjson` and `summary.json`.

### Suite: iterate without overfitting

```sh
export LONGMEMEVAL_PATH=~/datasets/longmemeval/longmemeval_s.json
npm run eval:suite -- --tier fast --label base             # once, on the commit you start from
npm run eval:suite -- --tier fast --label try1 --against base
```

`runner/suite.ts` builds, then runs every bench of the tier at once on its own sandbox instances (coding-life 3, PrecisionMemBench 4, LongMemEval 10-12, replay 9), and writes `tmp/eval-suite/<label>-<tier>/`: `meta.json` (commit, dirty, Recall config, per-bench seconds and exit code), `summary.json`, one directory and `.log` per bench, and `compare-<label>.json` under `--against`. The label defaults to the short commit, with `-dirty` for an uncommitted tree.

| Tier | Benches | Wall clock |
|---|---|---|
| `fast` | coding-life (`agentmemory` adapter), PrecisionMemBench, LongMemEval (4 per type) | ~2 min |
| `full` | the above with LongMemEval at 20 per type, plus replay of `AGENTMEMORY_EVAL_REPLAY_PROJECTS` | ~30 min, replay-bound |

`--against` compares item by item with a seeded paired bootstrap (2000 resamples) over the items both runs scored, widening each interval to 1 − 0.05/m for the m metrics compared (Bonferroni). It names any Recall config that differs between them, and calls each metric `better`, `worse` or `≈`. It exits 1 when any metric is `worse` or a bench failed. A replay metric pools over Sessions, so a long Session weighs more; `leakShare` and `charsPerUsedItem` are better lower. The interval covers item sampling, not rerun noise: with local embeddings and the reranker off, a rerun of one commit scores identically. A `--label` that would overwrite the `--against` run is refused.

Every bench is split by a salted hash of the item id, 40% to a holdout within each group (question path, case category, LongMemEval type, project), in `runner/split.ts`; a group of one stays in dev. Every runner scores the dev share unless told otherwise. The holdout is sealed: `--split holdout` and `--split all` (every item, as a published scorecard needs) are refused unless `AGENTMEMORY_EVAL_HOLDOUT` names the look, and the runner appends that name, bench and commit to the committed `holdout-ledger.ndjson` before it scores anything. `eval:suite --holdout` sets it to the run label and takes the larger LongMemEval sample; for a one-off, `AGENTMEMORY_EVAL_HOLDOUT=scorecard-<date> npm run eval:coding-life -- --split all`. Tune on dev, look at the holdout once per change worth shipping, and compare holdout runs only with holdout runs (`--holdout --against base` reads `base-<tier>-holdout`). Holdout per-item files exist for that paired comparison; read the summary, not the items. Never change the salt or the share: the new holdout would hold items already tuned on. Replay imports every Session whichever split runs but probes only the split's, and probing writes Session and Injection rows, so its dev and holdout stores differ. The CI gate scores every question and never splits.

### PrecisionMemBench

```sh
npm run build && npm run eval:pmb -- --split dev
```

`runner/pmb.ts` stores each of the 35 seed beliefs with one `/remember` under its user as the project, then runs each of the 77 cases through `smart-search` (project = the case's user, limit = its belief budget, 20 by default). `runner/pmb-score.ts` ports upstream's scoring: pinned facts, open questions and the persona prelude come from the seed, so only `relevantBeliefs` measures the daemon. `activePass` counts the 43 cases that need the right beliefs back; 34 cases pass when nothing comes back, which is why a precision miss (an extra belief) fails a case. Fixtures and license: `data/precisionmembench/`.

### Supersession

```sh
npm run build && npm run eval:supersession -- --instance N
```

`runner/supersession.ts` scores the stale-first rate: when a newer claim contradicts an older one, how often the older one leads in what the surface returns. The cells are the ones in `docs/supersession.md`: record kind (Memory restated, contradicted or replaced by `mem::evolve`; Semantic Fact; Lesson; Insight; Session Summary decision; Observation) by surface (`smart-search`, `context`, `prompt-context`). `runner/supersession-cases.ts` gives each cell eight lexical pairs (tabs/spaces, yarn/pnpm, jest/vitest, ...), each case in its own project. Rows that have no write route (Semantic Facts, Insights, Observations, Session Summaries) are written into the store file before the daemon boots, dated 50 and 10 days before the run; Memories and Lessons go through `/remember`, `/evolve` and `/lessons`, so their save-time supersession runs. `runner/supersession-score.ts` finds each claim by its stored text and classifies a case as `stale-first` (stale leads or is alone), `fresh-first`, `stale-hidden` (only the newer came back) or `neither`; the rate is `stale-first` over cases where a claim came back, per cell and rolled up per kind and surface.

It runs BM25-only by default (`--embeddings local` adds vectors), is not part of `eval:suite`, and takes `--split dev` unless the holdout is named through `AGENTMEMORY_EVAL_HOLDOUT`, like every runner. `--instance` defaults to 5; give each concurrent run its own.

### Fold drift

`npm run eval:fold-drift -- --store <replay checkpoint .sqlite> (--sessions id,... | --longest N) [--batch N]` measures whether folding new Observations into a Session Summary (`FOLD_SYSTEM`) loses decisions. Per Session it runs the daemon's own `mem::summarize` twice over a throwaway in-memory store: once over all Observations, and once as a sequence of growing prefixes, `--batch` Observations apart (default 50), so every step after the first folds into the previous Summary. Stop boundaries are not recorded on stored Observations, so batches are fixed-size. It reports decisions after the full pass, after the fold sequence, and full-pass decisions that no fold-sequence decision matches: by normalized exact text, and by word-set Jaccard >= 0.5 as a looser view; and, summed over every fold, the previous step's decisions that the fold's output no longer holds (`dropped-by-folds`, same two matches; drop events, so one decision can count more than once), and the same for steps that fell back (`dropped-by-fallbacks`). A live Session folds once per Stop, which in long Sessions comes every 10 to 30 Observations, so `--batch 20` approximates it. `eval:replay --llm` never folds: it awaits one `/summarize` per Session. To score a fold change against replay, write each arm's fold-sequence Summaries (`foldedSummary` in the output) into copies of a checkpoint store and probe each copy with `--from-checkpoints`. A step whose fold reply was empty, unparseable or held no decisions over a prior that had some, or whose fold prompt did not fit one chunk, falls back to a full summarize; it is counted under `fallbacks`, not `folds`. A Session that throws is listed under `failed` and the run continues. The provider is the daemon's own (`~/.agentmemory/.env`), so it spends real LLM calls; run it deliberately. Output goes to `tmp/eval-fold-drift/*.json`, which quotes private Observations and is never committed. The logic is `eval/runner/fold-drift-core.ts`, tested with a fake provider in `test/fold-drift.test.ts`.

### Replay (the Operator's own transcripts)

```sh
npm run build
npm run eval:replay -- --projects=-home-neal-code-homelab,-home-neal-orca-workspaces-homelab-eel,-home-neal-code-glydr --cap 40
```

`runner/replay.ts` replays real Claude Code Sessions from `~/.claude/projects/<dir>/*.jsonl` (read-only) in start-time order, all projects interleaved, into one throwaway daemon. It is not part of CI and not published: the data is private. Before it ingests Session k it probes what the Agent would have been given, against a store holding only Sessions 1..k-1:

- `session/start` with the Session's real id, cwd and project, so the session-start Injection and the per-Session dedupe of later Injections behave as in a live Session;
- `prompt-context` for each real human prompt (the per-prompt Injection), and `smart-search` (top 5, project-scoped) for the same prompt as a query-driven baseline;

then ingests Session k through `/agentmemory/replay/import-jsonl`, the path `agentmemory import-jsonl` uses, naming the project explicitly (below). What each probe delivered is read back from `GET /agentmemory/injections` (the daemon's own record of the Injected Memories), not guessed from the text.

Flags: `--projects=a,b` (directory names under `~/.claude/projects`; use `=` because they start with `-`), `--cap N` (Sessions per resolved project, earliest first, default 40), `--min-turns N` (default 2; drops the one-prompt automated `claude -p` runs that otherwise dominate), `--keyed-only` (replays only the scored Sessions with a non-empty answer key and the earlier Sessions their key items name, after the split is drawn; it saves the broker time a keyless Session costs under `--llm`, but the store holds fewer distractors, so compare it only with another `--keyed-only` run), `--save-checkpoints` (imports without probing and saves a copy of the store under `<out>/checkpoints/` wherever a scored Session would be probed, with a `manifest.json`, and its LLM metrics in `checkpoints/run.json` in place of a `summary.json`; it refuses an `--out` that already holds a manifest unless `--resume`), `--resume` (with `--save-checkpoints` only: continues an interrupted save pass in the same `--out` from its manifest's last checkpoint, which already holds every Session ingested before it, and appends the rest; pass the save pass's own options, since it refuses a manifest saved from other Sessions, and a finished pass; `run.json`'s LLM metrics then cover only the resumed part, and the later stores are not byte-comparable with an uninterrupted pass's, since the seeded daemon runs its boot maintenance and the last checkpoint may predate the previous Session's consolidation), `--from-checkpoints DIR` (probes each saved copy in a fresh sandbox, with no import and no LLM call; pass the same `--projects`, `--cap`, `--min-turns` and `--split` as the save pass (it refuses a checkpoint outside the split), so two probing passes that differ only in a setting such as the Injection Gate compare over identical compressed stores and the LLM's run-to-run variance drops out), `--maintenance PASS` (with `--from-checkpoints` only: runs one maintenance pass on each restored store after its vector fill and before it is probed, and reports the store's live bytes, pages in use rather than file size, after the pass; below), `--atypical a,b` (resolved project names, as `resolveProject()` names them, e.g. `agentmemory-sqlite`, left out of the `typical` rollup; default `agentmemory-sqlite,medical-researcher`, which are unlike the repositories the daemon mostly serves; recorded in `summary.json`), `--query-arm ARM` (default `control`; agentmemory only: `control`, `reply-tail`, `reply-head`, `reply-last`, `reply-terms`, `prev-prompt`; shapes the `prompt` sent to the prompt-context probe only, the smart-search baseline keeps the raw prompt; below), `--reply-chars N` (default 1000; cap on the text an arm adds), `--reply-scale K` (default 0 = fixed cap; K > 0 makes the cap `max(0, N − K × prompt length)`), `--max-prompts N` (prompts probed per Session, default 40), `--instance N` (default 9, never 0; ports 3111+100N), `--embeddings local|none` (default `local`), `--out DIR` (default `tmp/eval-replay`), `--llm` and `--backend agentmemory|hindsight` (below; checkpoints are agentmemory-only). Subagent transcripts (`agent-*.jsonl`, `subagents/`), sidechain entries and files over 20 MB are skipped. Only turns the Operator typed count as prompts, for the key and for probing: skill bodies (`Base directory for this skill:`, meta turns), continuation summaries, Harness Messages and the "Another Claude session sent a message" relay, slash-command wrappers, `!` shell escapes and their output, and turns that are only `<system-reminder>` are dropped.

`--maintenance` takes one pass, run as one REST call:

| Pass | Call | What it removes |
|---|---|---|
| `evict` | `POST /evict` with the current defaults | what the live daemon's eviction sweep would remove: every Observation with importance below 5 once it is a day old and its Session's stop has finished with it (#225, #230) (the 2026-10-15 maintenance scorecard's `evict` row ran the earlier schedule at `7c0415f`) |
| `auto-forget` | `POST /auto-forget` | what the hourly auto-forget would remove |
| `evict-importance:N` | `POST /evict` | every Observation with importance below N, whatever its age |
| `evict-cap:N` | `POST /evict` | the lowest-importance Observations past N per project |

Every `evict*` pass removes only Observations their Session's stop has finished with (a Summary covering the Observation, and with graph extraction on, the extraction watermark past it; #230), so a store whose Sessions lack Summaries loses far less. The 30-day age override that lifts the rule does not apply to the `evict-*` passes, whose `staleSessionDays` is 36,500. The `evict-*` passes write `mem:config/eviction` into the restored store before the daemon boots, which `mem::evict` merges over its defaults. Both set `staleSessionDays` to 36,500 so the pass never recovers a stale Session, which would need the LLM; plain `evict` keeps the daemon's recovery, which fails without the LLM. The sandbox sets `EVICTION_ENABLED=false`, so its boot sweep never evicts behind a pass. `evict-importance:N` also sets `lowImportanceMaxDays` to 0, and `evict-cap:N` sets `maxObservationsPerProject`. A checkpoint pass reports live bytes whether or not it runs a pass, so compare a maintenance pass with a `--from-checkpoints` pass that runs none. `summary.json` records the pass and the last checkpoint's live bytes before it. Retention eviction, Decay and consolidation are not passes: `mem::retention-evict` and Decay touch only Memories and semantic and procedural memories, no REST route reaches retention eviction, and consolidation needs the LLM, which a probe pass does not have.

Each Session is filed under its repository the way the live hooks' `resolveProject()` files it: the main checkout's basename, shared by every worktree. The runner asks git for the common dir from the Session's cwd (or its nearest surviving ancestor), falls back to the Orca layout `<...>/workspaces/<repo>/<worktree>` for a deleted worktree, and otherwise keeps the importer's name; it passes the result as `project` to the import. So list every directory of a repository (main checkout and worktrees) in `--projects` to replay it whole.

The sandbox runs with `AGENTMEMORY_INJECT_CONTEXT=true`, as the Operator's live daemon does, unless the shell sets it.

Providers are recorded in `summary.json`. Without `--llm` there is no LLM provider, so Memories are synthetic and there are no summaries worth recalling. Sessions then go in through `import-jsonl`, whose Observations rarely name a file (4% on the [2026-10-15 compression replay](../docs/benchmarks/2026-10-15-replay-compression.md), against 76% under `--llm`), so file key items score near zero: compare a no-`--llm` run only with another. To isolate LLM Compression, keep the hook path and turn compression off instead: `--llm` with `AGENTMEMORY_AUTO_COMPRESS=false` in the shell compresses synthetically and still summarizes through the LLM.

`--llm` forwards the OpenAI-compatible provider from the shell (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_REASONING_EFFORT`, `OPENAI_TIMEOUT_MS`, `AGENTMEMORY_LLM_TIMEOUT_MS`, `AGENTMEMORY_LLM_MAX_CONCURRENCY`) and sets `AGENTMEMORY_AUTO_COMPRESS=true` unless the shell sets it. `import-jsonl` always compresses synthetically, so under `--llm` Session k goes in the way the live hooks send it instead: each prompt and each finished tool call to `/observe` (the hooks' truncation; no assistant text), then the runner waits until every Observation has its compression, awaits `/summarize`, and posts `/session/end`. The consolidation that the end of a Session fans out is not waited for, and the importer's phrase-extracted lessons do not exist on this path. `summary.json` records the model, the base URL's host and the `mem::compress` / `mem::summarize` call counts and mean latency, never a key. Source the provider for that one command, for example `env $(grep -E '^(OPENAI_API_KEY|OPENAI_BASE_URL|OPENAI_MODEL|OPENAI_REASONING_EFFORT|AGENTMEMORY_LLM_[A-Z_]+)=' ~/.agentmemory/.env | xargs) npm run eval:replay -- --llm ...`.

`--backend hindsight` (default `agentmemory`) replays the same Sessions in the same order into [Hindsight](https://github.com/vectorize-io/hindsight) instead, driven the way its Claude Code integration (`hindsight-integrations/claude-code` 0.7.6, default settings) drives it, and scores the probes the same way (`runner/hindsight.ts`, mapping in `runner/replay-hindsight.ts`). It starts a throwaway `hindsight-eval` container (`ghcr.io/vectorize-io/hindsight:0.10.3`, pinned; docker or podman) on `127.0.0.1:--hindsight-port` (default 18888), with its Postgres under `tmp/eval-sandbox/hindsight/`, and removes both at the end. It always uses the shell's OpenAI-compatible provider, as `--llm` does (`OPENAI_*`; `AGENTMEMORY_LLM_MAX_CONCURRENCY` and `AGENTMEMORY_LLM_TIMEOUT_MS` become Hindsight's concurrency cap and timeout), embeds locally with `BAAI/bge-small-en-v1.5` (the model agentmemory's local embedder runs) and keeps Hindsight's default local reranker. `--embeddings none` is refused. As the integration with `dynamicBankId` does:

- one bank per resolved project, `claude-code::<project>`, with the integration's bank and retain missions;
- each prompt of at least 5 characters is a `prompt-context` probe: a recall of the prompt (first 800 characters) with `budget: mid`, `max_tokens: 1024`, `types: [observation]`, whose size is the `<hindsight_memories>` block recall.py would inject. There is no `session-start` probe, because the integration's SessionStart injects nothing; the `search` probe is a recall of every type, top 5, on the same 800 characters (agentmemory's `smart-search` probe gets the whole prompt). A prompt under 5 characters therefore has a `search` probe and no `prompt-context` probe;
- ingest replays Stop at the end of each answered turn (not after an interrupt): every 10th Stop retains the messages added since the last retain, and SessionEnd retains the rest, as text with tool calls, tool results and thinking left out. That is 0.7.6's default `full-session` mode: the first retain sends its whole window as document `<session>`, and each later one sends only from its last `role: user` message onward (a tool result counts) as `<session>-cN`, so a mid-Session retain usually carries the last turn or less. Hindsight's `main` has since changed this to the whole window and added timestamps; the runner follows the 0.7.6 tag. The runner then waits until the bank has no pending or processing operation (retain and the consolidation that writes observations) before probing the next Session.

Recalled units have no file list, so their files are the paths their text names, relative to any cwd the project ran in. Each probe recalls only its own project's bank, so Right scope reports 0 leaks by construction. `summary.json` records the image id, Hindsight's version, the model and base URL host, retains sent, and LLM calls and mean latency per operation from Hindsight's own request trace, never a key. Expect it to be LLM-bound: on the 2026-10-07 smoke (Hindsight 0.10.2, before the pin; 2 devex Sessions, about 68K retained characters) Hindsight made about 24 LLM calls per retain (fact extraction per chunk, then consolidation in batches of 5 facts), and draining took 31 minutes on a shared broker at concurrency 2.

For a remote embedder set the same variables the daemon reads in the shell, for example `EMBEDDING_PROVIDER=openai OPENAI_EMBEDDING_BASE_URL=... OPENAI_EMBEDDING_API_KEY=... OPENAI_EMBEDDING_MODEL=... OPENAI_EMBEDDING_DIMENSIONS=...`; the sandbox forwards `EMBEDDING_PROVIDER`, `OPENAI_EMBEDDING_*` and `AGENTMEMORY_LOCAL_EMBEDDING_*` (and `RERANK_ENABLED`) when set and `--embeddings` is not `none`. To pick a different on-device model, set it in the shell, for example `AGENTMEMORY_LOCAL_EMBEDDING_MODEL=Xenova/bge-small-en-v1.5 AGENTMEMORY_LOCAL_EMBEDDING_DIMENSIONS=384 npm run eval:suite -- --tier fast` (any model but the default needs its dimensions, or the sandbox daemon fails to start); `eval:suite` records the model (and dimensions) in the run's config, so `--against` names it when two runs differ. Never commit an endpoint.

### Query arms (#310)

Many Operator prompts are one word or a bare skill command, so the prompt-submit query has no terms and the meaning sits in the Agent's previous reply. `--query-arm` appends text to the prompt-context probe's `prompt` (never the smart-search baseline's) to measure what helps before the hook changes. `control` is today's behaviour, byte for byte. `reply-tail` and `reply-head` add the last or first N chars of the Agent's last reply (its text blocks after the last tool result, before the typed prompt; tool calls, tool results and thinking excluded). `reply-last` adds the reply's final paragraph, or its final sentence when it ends with a question. `reply-terms` adds the reply's file paths, identifiers (camelCase, PascalCase, snake_case, dotted, `::`) and `#123` refs, deduped, whole terms only. `prev-prompt` adds the Session's previous typed prompt. Each is capped at the `--reply-chars` / `--reply-scale` length. The arm, N and K are recorded in `summary.json` (`run.queryArm`) and printed before the run.

To compare arms, save checkpoints once, then probe the same checkpoints per arm with identical `--projects`, `--cap`, `--min-turns` and `--split`, each into its own `--out`: `npm run eval:replay -- --projects=… --from-checkpoints tmp/eval-replay/checkpoints --query-arm reply-tail --out tmp/eval-replay-tail`. Compare `rightMoment.terse` and the substantive hits together with injected chars (an arm that wins only by injecting more is visible there), on the per-project and `typical` rows (#315).

Output under `tmp/eval-replay/` (gitignored, because it quotes private transcripts): `summary.json` (run config, providers, per-Goal-line numbers), `scores.ndjson` (one row per Session), `worst-cases.md` (up to 20 misses, noise items and leaks, each with Session id and turn). Only the aggregates go into a scorecard under `docs/benchmarks/`.

#### Freezing the corpus

Claude Code deletes transcripts older than `cleanupPeriodDays` (default 30) from `~/.claude/projects`, so a later replay can select a different Session set and its numbers are not comparable. To compare runs, copy the projects directories once into a folder under `tmp/` (private, never committed), for example `mkdir -p tmp/replay-corpus && cp -rL ~/.claude/projects/<dir> tmp/replay-corpus/` (or `rsync -aL`), and pass `--root tmp/replay-corpus` to every run. Each run records `selection: { sessions, fingerprint }` in `summary.json` (and the checkpoint `run.json`); the fingerprint hashes the sorted ids of the scored Sessions. Two runs compare only when their fingerprints match: `eval:suite --against` prints a warning when they differ or one run predates the field, and still compares.

#### Answer key

Derived from Session k's transcript against earlier Sessions of the same project (Recall is project-scoped, so another project's Session could never have been injected):

| Rule | Key item | Delivered when |
|---|---|---|
| Files needed | a file Session k read or edited (project-relative path) that an earlier Session also read or edited, at its first turn of use; never `CLAUDE.md`, `AGENTS.md`, `CONTEXT.md`, `GLOSSARY.md` or `LESSONS.md`, which the Agent reads by convention | a probe at turn <= that turn returned an item whose files list names it |
| Repeated correction | a human turn of k that looks like a correction (`no`, `don't`, `I told you`, `stop doing`, ...; at most 500 chars) and shares >= 3 content words and at least half the shorter side with an earlier correction | an Injection at turn < k's turn returned an item holding >= 60% of the earlier correction's content words |
| Decision revisited | a non-correction turn of k that shares the same overlap with an earlier turn phrased as a decision (`decided`, `go with`, `from now on`, `we'll use`, ...) | an Injection at turn <= k's turn returned an item holding >= 60% of that earlier turn's words |

Session start is turn 0; a prompt's Injection arrives before the work on that prompt. A file need first used after a terse reply (fewer than 3 content words, such as "go ahead" or "2") that follows a substantive prompt of the same Session is keyed with `terse: true` and reported as `rightMoment.terse`, outside the headline and the worst cases: its need came from the earlier prompt, whose probes already count because they precede the deadline. A repeated correction means the Agent went wrong on the prompt before it, so the Injection at the correction's own turn is too late. The same key is also checked against the `smart-search` probes, for the "search alone" baseline (the same deadline).

#### Scoring per Goal line

| Goal line | Metric |
|---|---|
| Right content | share of Injected items Session k used (item files overlap files k touched, or the item delivers a key item, or it bears on a human turn of k); Injection chars per used item |
| Right moment | share of key items delivered in time by Injection alone, by search alone, and by either; split by rule |
| Right scope | Injected items whose project is not Session k's project (target 0) |
| Durable beats recent | share of repeated corrections whose earlier correction was injected before the repeat |
| Least record | store bytes at the end (database + WAL; live bytes, pages in use, in a checkpoint pass) per distinct item ever used |
| Never on the critical path | p50/p99 of each probe, and how many exceeded the 1.5 s hook timeout |
| Operator attention | store growth in bytes per replayed week (span of start times, at least one day; live bytes in a checkpoint pass) |

`summary.json` and the printed output also carry `byProject` (every metric above, per resolved project; store size and growth are run-wide, so only the pooled row carries `leastRecord` and `operatorAttention`) and `typical` (`{excluded, summary}`: the same metrics over the Sessions of projects not in `--atypical`). The pooled numbers are unchanged. Reading rule: a change ships on the pooled number only when it does not lose on the `typical` row.

#### Blind spots

The key is a proxy and the numbers are not accuracy:

- A file the Agent read again is not proof the Agent needed the Memory about it; a Memory that was used without touching a file is invisible. The audit in each scorecard measures how many proxy misses were real.
- Correction and decision detection is by phrase and word overlap. It misses paraphrases and corrections the Operator typed in an unusual way, and flags quotations or pasted text that happen to match.
- Items count as "used" by the same word-overlap test, so a Memory that shaped the Agent's behaviour without sharing words with any prompt counts as noise.
- The hooks' `-<6 hex>` suffix for a second repository with the same basename (`~/.agentmemory/project-names.json`) is not reproduced: two such repositories replay as one project.
- Sessions are ordered by start time and ingested whole, so a Session that overlapped a later-starting one (parallel worktrees) is in the store before the later one is probed, including turns that happened after that probe's moment.
- Under `--llm`, consolidation runs on the daemon's wall-clock cooldown, which a replay compresses, so how many consolidation passes a probe has seen differs from the live daemon.
- Without an LLM provider the sandbox holds no Memories beyond lessons the importer extracts by phrase, so the "titles and concepts of earlier Memories" form of a revisited decision is not measured; decisions come from earlier human turns.
- Which repositories to replay is the caller's pick; the runner does not choose the busiest N.
- Only prompts up to `--max-prompts` are probed (default 40, so the tail of a long Session is never scored), and only Sessions with `--min-turns` human turns are replayed. History before the oldest transcript on disk is absent.
- Every probe is compared against the 1.5 s Injection timeout of the context-injecting hooks (`INJECT_TIMEOUT_MS`), including `smart-search`, which has no hook.
- "Least record" divides the final store size (database plus WAL) by distinct used items; the WAL is not checkpointed first, and the store includes Sessions replayed after the last use.
- Files outside the Session's cwd (`~/.claude`, `/tmp`) are ignored on both sides.
- Under `--backend hindsight`, retains carry no timestamp (the integration sends none), so every unit is dated at replay time, not at the Session's time. Latency is the HTTP round trip to the container, compared against agentmemory's 1.5 s budget; the integration's own recall timeout is 10 s.

## Repo layout

```text
eval/
├── README.md
├── baselines/
│   ├── coding-agent-life-v2.json  CI gate: per adapter × path floors, tolerance and p95 latency ceilings
│   └── pinned-rules.json          CI gate for data/pinned-rules (eval:gate:rules)
├── runner/
│   ├── types.ts                   Adapter, Question, QueryResult, ScoreRow
│   ├── score.ts                   per-question scoring, per adapter × path aggregation, baseline gate
│   ├── sandbox.ts                 throwaway daemon under tmp/eval-sandbox/
│   ├── load.ts                    LongMemEval JSON → Question[]
│   ├── beam-load.ts               BEAM rows → Question[] (Turns as Sessions, source_chat_ids as gold)
│   ├── adapters/
│   │   ├── agentmemory.ts         capture path in; smart-search, session/start, prompt-context, context out
│   │   ├── grep.ts                tokenized substring baseline
│   │   ├── random.ts              seeded random control
│   │   └── vector.ts              OpenAI embeddings + cosine
│   ├── dolphinbench.ts            DolphinBench retrieval runner (eval:dolphinbench)
│   ├── dolphinbench-load.ts       DolphinBench parquet → Question[] (gold = establishing messages)
│   ├── longmemeval.ts             public benchmark runner (--concurrency N: one sandbox per worker)
│   ├── beam.ts                    BEAM retrieval-only runner (one sandbox per conversation)
│   ├── pmb.ts                     PrecisionMemBench runner
│   ├── pmb-score.ts               PrecisionMemBench case scoring, ported from upstream
│   ├── supersession.ts            supersession runner: stale-first rate per record kind and surface
│   ├── supersession-cases.ts      its fixtures: eight lexical pairs per docs/supersession.md cell
│   ├── supersession-score.ts      its per-case classification and per-cell rates
│   ├── split.ts                   dev/holdout split, the holdout seal and ledger
│   ├── suite.ts                   eval:suite: tiers, parallel benches, comparison
│   ├── suite-stats.ts             pooled ratios and the paired bootstrap
│   ├── coding-life.ts             in-house benchmark runner
│   ├── replay.ts                  replay runner over ~/.claude/projects transcripts (daemon glue)
│   ├── fold-drift.ts              eval:fold-drift CLI: store → providers → table and JSON
│   ├── fold-drift-core.ts         full pass vs fold sequence over mem::summarize, decision matching
│   ├── replay-transcript.ts       transcript JSONL → Session (prompts, files, turns, preceding reply)
│   ├── replay-query-arm.ts        --query-arm: prompt + reply/prev-prompt text per arm
│   ├── replay-answer-key.ts       files needed, repeated corrections, decisions revisited
│   ├── replay-checkpoints.ts      save-pass manifest, --resume checks, checkpoint write
│   ├── replay-selection.ts        scored-Session fingerprint and the cross-corpus comparison warning
│   ├── replay-hooks.ts            transcript → the /observe payloads the hooks would have sent (--llm)
│   ├── replay-hindsight.ts        transcript → Hindsight retains; recall results → probe items
│   ├── hindsight.ts               throwaway Hindsight container and its HTTP calls (--backend hindsight)
│   └── replay-score.ts            per-Goal-line scoring, summary, worst cases
├── holdout-ledger.ndjson          one line per holdout look (every `--split holdout` or `all`)
└── data/
    ├── precisionmembench/         upstream fixtures @ b95d6ab, MIT
    ├── pinned-rules/              17 Sessions (3 of them rules) and 6 session-start / pre-compact questions
    └── coding-agent-life-v2/
        ├── sessions.json          22 Sessions as tool-call Observations, each with a fixed 1-10 importance
        └── queries.json           38 questions with path, project and gold Session ids
```

Reports land in `eval/reports/<bench>/` (gitignored): `scores.ndjson` (one row per question, with the Session ids returned) and `summary.json`.

Published scorecards land in `docs/benchmarks/YYYY-MM-DD-<bench>.md`; the current one is [2026-10-06-coding-agent-life-v2](../docs/benchmarks/2026-10-06-coding-agent-life-v2.md).

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

Add it to `data/coding-agent-life-v2/queries.json` with a `path`, a `project`, and the gold Session ids — `[]` when the right Injection is nothing. Every captured Observation carries an `importance` (1-10: decisions and fixes high, routine reads low). Session-start keeps a Session's top 5 Observations by importance, so a rating only changes the Injection for a Session with more than 5 Observations. `ledg-006` is that Session: its gold content is four high-importance Observations, and its prompt and four low-importance ones carry `"routine": true`, which keeps them out of attribution, so inverting the sort in `src/functions/context.ts` drops the Session from the Injection and `eval:gate` fails. Do not mark gold content routine, and give a Session's Edits different files (the same tool input is deduplicated). Every Observation's first 48 output characters must be unique across Sessions, because that is how an Injection is attributed; `test/eval-adapters.test.ts` checks it.
