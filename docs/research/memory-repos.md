# Memory-system survey for sdebench (2026-10-18)

A dated snapshot of 22 open-source agent-memory projects, read for techniques that cut sdebench
interventions. It is read for ideas, never for patches, and is not kept current.
Results of the levers tried, kept or rejected, are logged in
[`docs/benchmarks/2026-10-18-sdebench.md`](../benchmarks/2026-10-18-sdebench.md).

sdebench (AMB harness, 61 boltons tasks) imports each task's past conversations, or its git
history, alongside 140 decoy Sessions. A fresh Claude Sonnet Agent then gets a vague task and
must apply the rules those Sessions settled. The score is interventions, the corrections the
Agent needs before the task is done; fewer is better.
Vanilla scores about 41 and Hindsight 17–25 (published, Sonnet 5).

Remaining failure causes, from the `s55am2` intervention analysis:

- **F1 wrong Session:** the vague prompt does not match the task's Session lexically, or a decoy
  outranks it.
- **F2 amended rule:** only the original Session matched, so the stale rule was followed.
- **F3 ignored:** the rule was delivered but buried, or phrased as history.
- **F4 git only:** the rule exists only in git history.
- **F5 no pull:** the Agent never calls the MCP tools, so only hook Injection counts.

## Repos

| Repo | What it is | Relevant to us |
|---|---|---|
| [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight) | Memory server; the sdebench competitor arm | Extracts from git (`deepen.ts`, `GIT_MISSION`); final-state-wins conversation extraction; first-prompt LLM reflect under a 20–30 s hook budget; "apply exact values as given, verify against code" wrapper |
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | Memory API and Claude Code plugin | "switched from X to Y because Z" transitions; BM25 plus semantic plus entity boost |
| [supermemoryai/supermemory](https://github.com/supermemoryai/supermemory) | Hosted API (engine closed) | `isLatest` supersession; per-Session dedupe of what was already injected |
| [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | Claude Code plugin with typed observations | `decision` observation type; ACT-R recency ranking |
| [topoteretes/cognee](https://github.com/topoteretes/cognee) | Graph RAG with a coding-rules pipeline | Rules nodeset always injected without query matching; fact status current/superseded |
| [MemTensor/MemOS](https://github.com/MemTensor/MemOS) | SQLite FTS5 plus vectors, layered | RRF across channels; drop below 0.4× top score; fail-closed LLM filter |
| [MemPalace/mempalace](https://github.com/MemPalace/mempalace) | Verbatim drawers over ChromaDB | Regex rule markers ("always use", "never", "my rule is") indexed as their own documents |
| [NevaMind-AI/memU](https://github.com/NevaMind-AI/memU) | Agent-written topic files | In-place patch per topic as supersession; pull-only, which fails F5 |
| [volcengine/OpenViking](https://github.com/volcengine/OpenViking) | `viking://` memory filesystem with a Claude Code plugin | Imperative experience blocks with `supersedes`; LLM query expansion; per-category quotas |
| [MemoriLabs/Memori](https://github.com/MemoriLabs/Memori) | Triples linked to summaries | Wide candidate pool (max(10×limit, 50)) |
| [CaviraOSS/LongMemory](https://github.com/CaviraOSS/LongMemory) | Claim graph | `kind:topic` keys with a current pointer; 0.2 penalty for superseded items; RM3 feedback |
| [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) | Four-layer memory | `instruction` type triggered by "from now on/must"; LLM store/skip/update/merge at write time |
| [ruvnet/RuVector](https://github.com/ruvnet/RuVector) | Vector and graph platform | Little: recency times coherence scoring that needs embeddings |
| [ruvnet/agenticow](https://github.com/ruvnet/agenticow) | Copy-on-write vector store | Nothing |
| [akitaonrails/ai-memory](https://github.com/akitaonrails/ai-memory) | Markdown wiki plus FTS5 for coding CLIs | Observation hits cast one vote per Session into page ranking (hit@5 0.66 → 0.95); verbatim literals kept in summaries; rules-first brief capped near 15 rules |
| [FlowElement-xinliuyuansu/m_flow](https://github.com/FlowElement-xinliuyuansu/m_flow) | Four-layer graph memory | Penalizes broad summary hits relative to precise ones; procedures superseded at write time |
| [memoket/memoket-kite](https://github.com/memoket/memoket-kite) | Typed dated facts under topics | Dated evidence in time order with "the most recent wins"; at most 5 rows per Session |
| [Dataojitori/nocturne_memory](https://github.com/Dataojitori/nocturne_memory) | Agent-written MCP memory | "disclosure" trigger text indexed beside content, so vague queries match; pull-only |
| [moorcheh-ai/memanto](https://github.com/moorcheh-ai/memanto) | Memory over a vendor search engine | Ablation: raising k from 10 to 40 was its largest gain, and the misses were retrieval misses |
| [memvid/memvid](https://github.com/memvid/memvid) | Rust single-file store | `entity:slot` version keys; corrections promoted last, newest first; always show the latest match |
| [pingcap/tidb](https://github.com/pingcap/tidb) | Distributed SQL | No agent-memory layer |
| [memgraph/memgraph](https://github.com/memgraph/memgraph) | Graph database | GraphRAG toolkit only; nothing on rule recall |

Published scores (LongMemEval, LoCoMo) are self-reported QA or retrieval numbers, not coding
benchmarks. None was reproduced here.

## Ranked techniques

Ordered by the expected cut in interventions per unit of work. Hot path means inside the
prompt-submit hook's 1,500 ms budget.

1. **One result slot per Session, from a wider pool** (memanto k ablation, ai-memory one vote
   per Session). Fixes F1. Size S, no hot-path LLM. Shipped in #242 (`3974ad8`).
2. **Fetch the later amending Session** (memvid latest match, LongMemory current pointer,
   Hindsight "LATEST wins"). When a covered Session is chosen, also inject a later Session of
   the project that shares its files or concepts. The newest-first header already settles the
   conflict. Fixes F2. Size S, no hot-path LLM. Shipped in #242 (`263dc44`).
3. **Search Session Summary decisions directly, with trigger words** (nocturne disclosure,
   ai-memory, MemPalace rule documents). Index each Session Summary's decisions, plus an LLM-written
   "applies when" line naming the words a future task would use, and fuse them with Observation
   hits by RRF. Fixes F1. Size M, LLM at Session Summary time only.
4. **Wrapper that asks for the exact values** (Hindsight `buildSystemInjection`). Tell the Agent
   to apply the stated values and conditions as given and check them against the code. Fixes
   F3. Size S.
5. **Final-state-wins Session Summaries** (Hindsight `CONVERSATION_MISSION`, mem0
   transitions). Keep only the last value of a rule the conversation changed, with "changed
   from X". Fixes F2 within one Session. Size S, prompt only.
6. **Rules from git history** (Hindsight `GIT_MISSION`). Summarize commits, message and diff, as
   decision records. Fixes F4. Size M, LLM at ingest only. Low priority: history tasks rarely
   need an intervention.
7. **Session-start rulebook** (cognee rules nodeset, ai-memory `_rules/`, memanto `MEMORY.md`).
   A small current-rules digest injected regardless of the prompt. Fixes F1 and F5. Size M.
   Risk: decoy Sessions share the project, so their rules compete for the same slots.
8. **Query expansion: RM3 or Session context** (LongMemory, OpenViking). Fixes F1. Size S.
   Risk: it amplifies a decoy when the first pass is already wrong.

Not pursued:

- **First-prompt LLM reflect** (Hindsight). It needs a hook budget near 20 s, against the
  Goal's "never on the critical path".
- **Pull designs** (memU, nocturne, LongMemory and MemPalace skills). They fail F5.
- **Per-candidate LLM rerank.** The Injection Gate already reranks each candidate with a reranker
  model.

## Decision capture (2026-11-07)

Read for ticket #353, the same question as the dated section of
[`memory-papers-survey.md`](./memory-papers-survey.md): how systems extract durable decisions
and keep them across incremental updates. Evidence driving it:
[`2026-11-07-decision-loss`](../benchmarks/2026-11-07-decision-loss.md). Read for ideas, never
patches. Prompt or code files were read for Mem0, Letta, claude-mem and cognee; Graphiti through
a DeepWiki page generated from its source plus the Zep paper (2501.13956); Hindsight and
LangMem from their documentation only. Candidate levers:
[`../experiments.md`](../experiments.md) (Candidate hypotheses).

Today's Summary here: one XML record per Session (title, narrative, decisions, files,
concepts), built from compressed Observations by one pass, a map-reduce over chunks, or a fold
of new Observations into the prior record that the model rewrites in full
(`src/prompts/summary.ts`, `src/functions/summarize.ts`).

| System | Unit and input | Update path | Supersession | Relevant to us |
|---|---|---|---|---|
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | Per call: the new messages (user and assistant both), a profile summary, up to 20 preceding messages (each cut to 300 chars) and up to 20 memories already extracted this session (`ADDITIVE_EXTRACTION_PROMPT`, `mem0/configs/prompts.py`) | v3 migration guide: one ADD-only LLM call; UPDATE and DELETE removed, `add()` returns ADD events only. The prompt lists existing memories "ONLY for deduplication and linking" and returns `linked_memory_ids` | A changed preference is a new memory linked to the old one; the old stays. Docs claim LoCoMo 71.4 to 91.6 and LongMemEval 67.8 to 93.4, self-reported, not reproduced | The prompt says to extract each topic separately so a dominant topic does not hide a secondary one, and to skip only a fact already captured, not an entity already known. The opposite of one rewritten list |
| [letta-ai/letta](https://github.com/letta-ai/letta) | Compaction when the context fills: default `sliding_window` summarizes the oldest ~30% of messages and keeps ~70% verbatim; summary clipped at 50,000 chars (docs) | The new summary replaces the aged messages; `ANTHROPIC_SUMMARY_PROMPT` asks for task, state, discoveries including "decisions made and their rationale", next steps and user preferences | None; the latest summary is the record | Recent turns stay verbatim, so the freshest decisions never pass through a summarizer; only the aged slice is compressed |
| [getzep/graphiti](https://github.com/getzep/graphiti) | One episode (a message or chunk) at a time; edges extracted against a reference time | Per extracted edge: an exact-match fast path appends the episode id to the existing edge; otherwise an LLM decides duplicate or contradiction against related existing edges (DeepWiki 5.3, `edge_operations.py`) | A contradicted edge has its invalid time set to the new edge's valid time, never deleted (2501.13956) | Every fact keeps a pointer to the episodes that support it, so a restated rule adds evidence instead of a copy |
| [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight) | `retain()` extracts facts additively and also stores the original text, chunked (blog 2026-07-13); a retain mission narrows what is kept | Background consolidation compares each new fact with the observations recall found: restates (attached as evidence), chatter (skipped), changes or adds (sent to the LLM). A cheap decision model settles the first two and cut LLM calls about 40% at the same pass rate (docs) | Observations carry evidence quotes and a proof count and are "refined rather than overwritten"; near-duplicates merge at cosine 0.97 only after a check that reads both, so a differing number or negation keeps them apart | Raw facts stay and the consolidated layer is derived, so consolidation can be rerun when it loses something. The number and negation check is the guard our fold lacks |
| [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | A long-lived observer model sees each tool event (the session's user prompt is in its init and continuation prompts) and emits a typed `<observation>` at once; a `<summary>` (request, investigated, learned, completed, next steps, notes) is requested at a checkpoint (`src/sdk/prompts.ts`) | Observations are append-only; the checkpoint summary is a separate record | None in the file read | Extraction is per event while the observer still holds the Session in context, so no later pass has to rediscover a decision. Tool outputs are cut to head and tail at 16,000 chars |
| [topoteretes/cognee](https://github.com/topoteretes/cognee) | Rules extracted from conversation text, one `Rule` node per rule, each linked to its source chunk (`rule_associated_from`, `coding_rule_associations.py`) | The nodeset's existing rules are read back (`get_existing_rules`) for the extraction prompt, so only unseen rules are added | Not in the file read | A dedicated rule extractor, apart from any narrative summary, with the rule list as the dedupe reference |
| [langchain-ai/langmem](https://github.com/langchain-ai/langmem) | A background manager extracts memories from messages, with existing memories passed in | `PatchDoc` rewrites a memory keeping its id; `RemoveDoc` is off by default (a third-party tutorial for 0.0.30) | Overwrite in place; the tutorial warns that a misread update ("text me when urgent" read as "text me") loses the earlier preference and suggests `enable_updates=False` | The in-place rewrite is our fold's failure mode, in a library whose own tutorial advises against it for anything you cannot lose |

### Reading across the systems

- **Mem0, Graphiti and Hindsight keep captured items outside the model's rewrite.** Mem0 v3 is
  ADD only, Graphiti appends evidence and closes edges by time, Hindsight keeps additive facts
  under a derived layer. Mem0 dropped UPDATE and DELETE rather than tune them. Only LangMem
  patches in place, with a warning.
- **Extraction input is the conversation, not a digest.** Mem0 reads user and assistant
  messages; claude-mem sees events as they happen. None builds decisions from an
  already-compressed record as a second stage the way our Summary does, which is where the 47
  never-captured may sit (the first Candidate hypothesis asks whether they are in the
  Observations at all).
- **A separate, decision-only call is common.** Mem0's sole operation is ADD, cognee returns
  only rules, and claude-mem's observation has a `decision` type apart from its summary. Our one
  prompt asks for title, narrative, files, concepts and decisions together.
- **A dedupe reference without a rewrite.** Mem0 (existing memories), cognee (existing rules)
  and Hindsight (observations recall found) show the model what is held and ask only for what
  is new or changed.
- **Not read:** Mem0's pre-v3 UPDATE prompt, Letta's sliding-window code and Hindsight's
  consolidation prompt.
