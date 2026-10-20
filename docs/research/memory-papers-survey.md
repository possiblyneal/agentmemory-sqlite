# Memory-paper survey for coding-agent Recall (2026-10-20)

A dated snapshot of [memorypapers.org](https://memorypapers.org/) (built by Mem0), read for
levers that bear on this repo's Goal (`CLAUDE.md`) and that the findings logs do not already
cover. Read for ideas, never for patches. Companion to
[`memory-repos.md`](./memory-repos.md) (open-source systems) and the sdebench findings log
([`2026-10-18-sdebench.md`](../benchmarks/2026-10-18-sdebench.md)). Ticket #267, parent #270.

Every claim cites an arXiv id. A paper's own numbers are quoted as reported and were not
reproduced. The site's summaries were used only to shortlist; every kept paper's lever and
evidence below comes from its abstract and method/results on arXiv unless the row says
"site summary only".

## Method

- **Enumeration.** `curl` of `/sitemap.xml` lists 453 `/papers/<slug>` URLs. The same 453 are
  embedded in the Next.js HTML of `/papers/page/1` to `/papers/page/19` plus the home page, each
  with title, arXiv id and a summary paragraph; parsing either reproduces the list (every paper
  has an arXiv id). The two sources agree exactly (453 of 453). There are no per-paper
  explainer fetches; arXiv was the source of record.
- **Screen.** All 453 titles read by hand; summaries of 126 keyword hits
  (coding, SWE, supersede, stale, conflict, rerank, BM25, temporal, forget, admission, ...) and
  58 shortlisted papers read in full summary. The arXiv HTML of each kept paper not tagged
  otherwise was read for method and results, as was LifeFuse-Mem's, which was then excluded as
  latent memory; Threader had its abstract only because no HTML exists.
- **Result.** 24 kept in the tables (20 read on arXiv, 1 abstract only, 3 site summary only: Zep, ECHO, ChronoMem); 429 excluded.
  Per-category counts of the exclusions were not tallied; categories and reasons follow.
- **Baseline check.** Most conversational results (LoCoMo, LongMemEval) are against Mem0-style
  extraction, MemGPT-style summaries, full context or the paper's own earlier version, not a
  tuned BM25 plus embedding RAG. The column "Baseline" says which, because that decides whether a
  result transfers to this fork, whose Recall is already BM25 plus vector plus graph with RRF and
  a reranker gate.

## Kept papers

Status values: **in place** (shipped here), **tried** (scorecard or findings-log row),
**in flight** (open issue), **untried**, **not pursued** (Goal or scope conflict, reason given).
"Hot path" means inside prompt-submit's 500 ms `eval:gate` ceiling (1.5 s hook wait).

### Supersession and update of stale facts

| arXiv | Lever | Evidence (baseline) | Goal fit | Cost | Status here |
|---|---|---|---|---|---|
| 2608.20685 MemStrata | Key each value-bearing claim as (subject, relation, object); a new object under an active key closes the old row's validity, and retrieval returns only valid rows. No similarity threshold, no LLM judge. | 130 clean transitions from SWE-bench fixes: 0.91 answer accuracy against 0.57-0.59 for cosine top-k RAG; forced to answer, RAG serves the superseded value 36-38% of the time and an LLM reranker does not help (37.7%); method about 0. Caveats: one author, a vendor product, a 7B local model, and only about 18% of real fixes are clean single-value transitions. Baseline is naive embedding RAG. | Durable beats recent; Right content | Triple extraction is an LLM call at write time; read path adds none (2.13 s vs 2.16 s reported) | Untried for Semantic Facts and Observations. Memories already supersede by similarity in `remember.ts`; `#254` lists Semantic Fact supersession as a separate lever. Ranked 1 below. |
| 2608.07429 TEPA | Keyed precedents with an active set and a revoked archive; a contradicting observation under the same key revokes the active one; revoked rows stay for audit and can be re-promoted. | Controlled drift, 50 seeds: full-reversal success 0.950 against append-only 0.210, last-write-wins 0.210, no memory 0.309; same pattern with real file execution (0.203 / 0.298 / 0.950). On MemoryAgentBench SH-6k it only ties a last-write-wins cache. Synthetic regimes. | Durable beats recent | None on read | Untried. Confirms that append-only memory is worse than none once a value flips; same keyed mechanism as 2608.20685. |
| 2608.19652 StateMem | State-first memory: extraction, supersession marking, dependency propagation, then one recompute-guided answer call. | StateMemBench current-state accuracy 0.205 (best dense same-backbone) to 0.363 on DeepSeek-V4-Flash. Ablation: supersession marking is the largest single step (0.174 to 0.298). A prompt-only wrapper over six backends adds 32-67 points, 15-32 of them attributed to state structure by a length-matched control. Dependency propagation hurts on anti-trap cases (-12.5 pp). | Durable beats recent | The deterministic layer adds no LLM call; the wrapper adds one answer-time call | Marking half untried (as above). The answer-time call is an LLM in the Agent's loop, not ours: not pursued. |
| 2607.01935 A-TMA | Overlay for an existing store: keep superseded and transition records, build evidence for the requested view (current, historical, transition) and label them for the answerer. | LTP: Graphiti/Zep conflict accuracy 0.480 to 0.720; LoCoMo temporal F1 0.0295 to 0.1705. Gains depend on the host system. | Durable beats recent | Labels at read; no hot-path LLM | In place in spirit: Session Summaries are dated, newest first, under a header that says the newer rule holds (`CLAUDE.md`, "Session Summaries in Injection"; `laterAmendment`, shipped #242 `263dc44`). |
| 2609.08258 Revoked but Still Authoritative | Withhold, at read time, any record marked revoked or contradicted by its replacement; a mark that retrieval ignores does nothing. | Five systems, nine policy scenarios, nine models: where the mark was visible, the revoked policy was returned ranked first in every scenario and drove an unsafe action in 44.2% (Graphiti) and 42.1% (mem0 expiry) of trials. A store-level filter gave 0 of 1,620; prompt hardening alone only 43.1% to 37.2%. | Durable beats recent; Right content | One predicate per read | Partly in place: `search.ts` skips `isLatest === false` Memories. Whether every read path (Session Summary decisions, Semantic Facts, Insights, graph) honours a stale mark is the question `#266` audits; this paper is the reason to treat each unfiltered path as a defect. |
| 2609.01852 Memory Trust Gap | Study of what makes an agent trust a stale note over an authoritative source. | Qwen3 0.6-8B: stale value used 0.92-1.00 of the time; removing a label raises over-trust at every size; a recency cue fools the larger models more. Exposing metadata helps the capable models; only pre-resolving the conflict helps the small ones. Small models only. | Right content; Right moment | None | Tried in part: dated blocks, newest-first order and a "newer holds" header are in place; a stricter "a rule governs the code it names" header (v14) was rejected in sdebench. Supports pre-resolving over annotating, which the amendment lookup already does. |
| 2605.20926 MemConflict | Benchmark: dynamic, static and conditional conflicts with injected near-duplicate distractors; scores both the answer and the rank of the supporting memory. | Six systems; answer accuracy often diverges from retrieval rank; longer histories, distractors, implicit queries and larger conflict distance all hurt. | Right content | None (eval) | Input to `#266` fixture design; not a lever. Benchmark adoption belongs to `#269`. |
| 2605.06527 STALE | Benchmark of implicit conflicts (a later fact invalidates an earlier one without negating it) plus CUPMem, which adjudicates state at write time and propagates invalidation to related attributes. | 400 scenarios; best frontier model 55.2% overall; CUPMem 68.0%. Personal-assistant conversations, mostly outside coding. | Durable beats recent | Write-time LLM | Untried; the "one change invalidates a related rule" case (their Type II) is worth one `#266` fixture. |
| 2609.05441 MERIT | Cost-aware tool-use benchmark across six memory conditions. | Updated facts: embedding retrieval falls to 0.30-0.95 on updated facts while update-on-write memory stays at 0.70-1.00 and full replay at 0.95-1.00. gpt-4.1-mini, synthetic tasks. | Durable beats recent | None (eval) | Supports ranking 1; not a new lever. |
| 2501.13956 Zep | Temporal knowledge graph with validity intervals and a search, rerank, construct pipeline. | LongMemEval 71.2% against 60.2% full context (gpt-4o), latency 28.9 s to 2.58 s. Site summary only. | Durable beats recent | LLM graph construction at write | Not pursued: `temporal-graph.ts` and the graph leg exist; the survey in `memory-repos.md` already covers `isLatest` supersession. |

### Recall precision, ranking and cost

| arXiv | Lever | Evidence (baseline) | Goal fit | Cost | Status here |
|---|---|---|---|---|---|
| 2606.10842 ConvMemory v2 | Re-order only the first stage's top-10 with a small cross-encoder (22.7M parameters), so the candidate set and recall are unchanged. | LoCoMo, 5 seeds, n=4,955: MRR 0.5824 to 0.6560 over its own learned first-stage reranker; within 0.013 MRR of a large cross-encoder run over the top-500 at about 68x lower cost. Baseline is a learned reranker, not BM25. | Right content; Never on the critical path | Small on-device model, over 10 pairs | Untried. The gate sends about 30 candidates to a remote reranker that takes about 870 ms idle and serves one request at a time; no scorecard varies pool size or reranker model (`2026-10-18-sdebench.md`, Findings). Ranked 2. |
| 2605.06132 MemReranker | Distil a 0.6B/4B reranker with calibrated scores, trained on memory dialogue with temporal and coreference cases. | MAP 0.737 (4B); the 0.6B matches GPT-4o-mini at about 8x lower latency; beats a generic BGE reranker. Calibration matters because the problem it names is that raw reranker scores make a fixed threshold unreliable. | Right content | Smaller model per request | Untried; the gate's floor is a fixed `AGENTMEMORY_PROMPT_RERANK_MIN` (default 0.03), which is exactly the threshold this paper says is miscalibrated. Part of ranking 2. |
| 2605.25092 AgentIR | A confidence-triggered cascade: when the BM25 top-1 margin is large, skip the dense channel for that query. | LongMemEval: dense skipped on 63% of queries, 2.67x lower latency at parity LLM-judged accuracy; the dense channel is about 52 ms (BGE-small) against 0.4 ms for BM25. Baseline is its own always-hybrid pipeline. | Never on the critical path; Operator attention | A margin test per query | Untried. A cosine floor and a BM25 ratio floor were tried and rejected (`#254`, Further Notes); skipping a leg or the gate on margin is a different operation from dropping results, but shares their risk. Ranked 3. |
| 2603.02473 Diagnosing Retrieval vs Utilization | 3x3 study of write strategy against retrieval method. | LoCoMo: retrieval method spans 20 points (BM25 57.1%, cosine 73.4%, hybrid rerank 77.2%); write strategy only 3-8; raw chunks with zero LLM calls match Mem0-style extraction and MemGPT-style summaries. Baselines include BM25 and cosine. | Least record; Right content | None | In place. Raw Observations, BM25 plus vector plus RRF plus the gate already follow this; no new lever. |
| 2609.23570 VibeMemBench | Benchmark: 111 SWE-style targets from 3,634 repository histories, executable tests, memory toggled alone. | Frozen verified experience raises Resolved 1.1-4.5 points on four of five solvers (intervals cross zero); Mem0, SimpleMem, MemoryOS and A-MEM retrieval stays at or below memory-off in 11 of 12 pairings; the dominant failure is the form of the injected record, and a strip ablation traces it to transcript volume, not instruction content. A record helps a weak solver and harms a strong one. | Least record; Right content | None (eval) | Strongest outside evidence for the Goal's "least record" bullet and against injecting raw transcripts. Not a lever to build; its benchmark verdict belongs to `#269`. |
| 2608.20664 DreamBench-SWE | Multi-session hygiene benchmark with executable hidden oracles; raw episodes never destroyed, derived memory layered on top. | Original fold: typed-plus-raw 95/180 against verbatim event memory 89/180, p=0.518 (null). Successor audit: no memory 21/180, verbatim 82/180, typed-plus-raw 83/180, one hosted Mem0 configuration 97/180; no mechanism claim established. | Least record; Right content | None (eval) | Consistent with keeping raw Observations as the base layer; derived memory has no confirmed edge. Not a lever. |
| 2609.03467 LoCoMo-Conv | Rewrite queries into dialog, implicit, counterfactual and composed styles; test multi-facet query rewriting. | Raw-turn memory with multi-facet rewriting: dialog recall@10 0.754, +0.095 over the same system without it; abstractive memory (Memora) 0.387-0.445 on implicit and composed queries. The rewrite is an LLM call. | Right content | LLM per query | Not pursued on the prompt hook (LLM on the critical path). The finding, that a prompt which is not a question misses, is survey class F1 in `memory-repos.md`; RM3-style expansion is out of scope in `#254`. |
| 2609.33226 Threader | Keep raw interactions, segment them by topic incrementally, and retrieve over segment-level and local-evidence views instead of LLM-rewritten units. | LongMemEval overall 90.60% and knowledge-update 93.59%, beating an LLM-construction system (EverMemOS) by 6.84 and 5.80 points. Abstract only (no HTML). | Least record; cost | No write-time LLM | Partly in place: raw Observations stay, Memories are chunked (`2026-10-19-memory-chunking.md`), Summary decisions are `#259`. Segment-level Observation grouping is untried but unread beyond the abstract. |
| 2609.08279 What Eviction Destroys | The restore counterfactual: reinstate a question's gold evidence after eviction and rerun the reader, splitting each miss into irreversible (evicted) and recoverable (retained but not retrieved). | LongMemEval-S: irreversible share 0.67-0.73 at an 80k-token budget and 1.00 at 8k for FIFO, random and redundancy-aware eviction. | Durable beats recent; Operator attention | None (eval) | Untried as an eval metric; the Goal calls eviction expected, and nothing here measures what it destroys. Ranked 5. |
| 2608.22752 Compaction Cliff | Classify each stored line by type and give each type its own retention; at retrieval, pin in-scope rules ahead of relevance. | Claude Code's `/compact` on Sonnet 4.6 keeps 53% of safety rules after one round and 10% after five (20 production configurations). Type-routed retrieval 100% recall@50 against 73% for the best single-shot LLM retriever; also better on three downstream benchmarks. Corpus is agent configuration files, so rules there are explicit. | Right moment; Durable beats recent | Deterministic operators; a classifier | Untried: `src/hooks/pre-compact.ts` posts one generic `budget: 1500` context request and pins nothing. The session-start rulebook is rank 7 in `memory-repos.md`, never built (decoy Sessions share the project). Ranked 4. |

### Other kept, no lever

| arXiv | Why kept | Status |
|---|---|---|
| 2512.12818 Hindsight | The sdebench competitor arm; four networks (world, experience, entity summary, belief) with retain, recall, reflect. LongMemEval 83.6% against 39% for full context on the same 20B backbone. | Reflect is an LLM call at read: not pursued (`memory-repos.md`, "Not pursued"). |
| 2607.22690 LazyMem | Query-time compression by a trained 4B model, 0.85 LongMemEval accuracy at 213 answer tokens, 21x fewer than the baseline. | Not pursued: needs a trained model and an LLM in the read path. |
| 2608.21755 ECHO | Bitemporal ledger over immutable events; Hit@10 97.60% on LongMemEval-S but a matched QA sample 41.76% against Mem0's 64.84% (site summary only). | Not pursued: shows recall without use. |
| 2607.27773 ChronoMem | Snapshot every write and roll back by natural language; 55.1% rollback-consistent accuracy against 35.5% RAG-only (site summary only). | Not pursued: rollback is not an Operator need; supersession is. |

## Excluded categories

One line each; the 429 excluded papers fall in these.

- **Parametric, test-time-trained and latent memory** (Titans, MemoryLLM-style, KV-cache, Hopfield and associative-memory networks, fan-duality, LifeFuse-Mem 2609.12436): out of scope per `CLAUDE.md`; none retrieves a Memory.
- **Multi-user, team, shared and multi-agent memory** (GroupMemBench, GateMem, AIM, MELD, PlanFence 2609.03340, memory arbitration, collective memory): one Operator runs the daemon.
- **Chatbot persona, personalization and emotional support** (PersonaMem, PRAGMA, OP-Bench, ES-MemEval, CloneMem, AlpsBench and similar): the answerer is a human-facing assistant, not a coding Agent.
- **Non-English and multimodal** (RUMBA, Wontopos, video, egocentric, GUI and mobile-agent memory): out of scope.
- **Security, privacy and poisoning** (MemPrivacy, MemAudit, Zombie Agents, InjecMEM, Bad Memory, mnemonic-sovereignty survey): one Operator on loopback; defences are not a Recall lever. Revoked-but-authoritative 2609.08258 is kept because it is about staleness, not attack.
- **Within-session context management for SWE agents** (Context as a Tool 2512.22087, Focus 2601.07190, ContextWeaver 2604.23069, ACON): shrink one trajectory's context; they do not carry a claim across Sessions.
- **Code-structure indexes** (Codebase-Memory 2603.27277): answers "where is this function", which the Agent's own tools do; it is not a memory of decisions.
- **Learned memory management by reinforcement learning** (Memory-R1, MemRL, MemRouter, AtomMem, MemBuilder, CoEvo-Mem): needs training and a reward, and puts a model in the write or read path.
- **Procedural skill and experience libraries** (Memp, AutoSkill, CodeMem, EvoMemBench, SkillEvolBench, LEGOMem): distil workflows for reuse; none targets which stored claim reaches a prompt.
- **Surveys, position papers and general-purpose benchmarks** (LoCoMo, LongMemEval and their relatives): read for context; the benchmark verdicts are `#269`.
- **Hardware and serving cost** (KV-cache sharing, quantization, edge memory): inference-engine work.
- **Graph and hierarchical conversation memory built by an LLM at write** (A-MEM, MAGMA, GAM, HiMem, SYNAPSE and kin): conversational QA gains over Mem0-style baselines; 2603.02473 shows raw chunks with hybrid retrieval match them.

## Ranked untried levers

Ordered by Goal fit per unit of cost, with the evidence's weakness stated.

1. **Keyed supersession for Semantic Facts and rules at write time** (2608.20685, 2608.07429,
   2608.19652; read-path guard 2609.08258). Fit: Durable beats recent. No hot-path cost. Weakness:
   vendor and synthetic evidence, and only about 18% of real fixes are single-value transitions.
   Filed as #284; its fixtures come from `#266`.
2. **A smaller, calibrated reranker pool for the Injection Gate** (2606.10842, 2605.06132). Fit:
   Right content, Never on the critical path; the gate is the measured serial bottleneck
   (`2026-10-18-sdebench.md`). Weakness: the evidence is LoCoMo MRR against another learned
   reranker. Filed as #286.
3. **Confidence-triggered skip of the gate or the vector leg** (2605.25092). Fit: pay as little as
   possible. Weakness: the parity result is for the dense channel and LongMemEval, and a
   score-ratio cutoff was rejected before. Filed as #288.
4. **Pin rule-typed records ahead of relevance at pre-compact and session start**
   (2608.22752). Fit: Right moment, Durable beats recent. Weakness: the 53% and 10% retention is
   measured on configuration files, and Claude Code reloads `CLAUDE.md` after a compact, so the
   exposure is a rule given only in conversation. Filed as #290.
5. **Restore-counterfactual eval metric for Eviction** (2609.08279). Fit: Eviction is expected;
   this says what it costs. A diagnostic, not a Recall change; not filed. Fold into the next
   Eviction change's scorecard.
6. **Segment-level grouping of Observations** (2609.33226). Abstract only; wait for `#259`'s
   result before reading further.

Considered and not ranked: LLM query rewriting (2609.03467) and answer-time state recompute
(2608.19652's wrapper) both put a model in the Agent's loop or the hook.

## Note for supersession (`#266`)

- 2609.08258 argues that the read path, not the write path, decides whether a stale claim
  surfaces: every returned-and-unfiltered record kind is a leak. The audit table should list,
  per record kind (Memory, Observation, Session Summary decision, Semantic Fact, Insight, graph
  node), whether a stale mark exists and whether each read path filters it.
- 2608.20685 and 2609.05441 give the failure shape to fixture: value A stored, value A' stored
  later, a question that targets the current value, and no marker words in either statement.
  Embedding-ranked retrieval and an LLM reranker do not separate them (2608.20685, 37.7% stale
  with the reranker).
- 2605.06527 adds a case worth one fixture: a changed rule that invalidates a related rule
  without contradicting it.
- 2609.01852 suggests that dates and a newer-wins header help a capable model, but a small
  fallback model needs the conflict resolved before it reaches the prompt.
