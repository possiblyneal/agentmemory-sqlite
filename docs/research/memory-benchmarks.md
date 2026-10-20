# Memory benchmarks for the eval suite (2026-10-20)

A dated evaluation of the seven benchmarks listed at memorypapers.org/benchmarks, read from each
original arXiv paper and its dataset card or repo, never from the site's summary (memorypapers.org
is built by Mem0; it is an index, not evidence). Parent spec: #270. Nothing here implements an
adapter. Paper text, data and third-party code are not copied; every claim is in our words with
its arXiv id and section.

Measured against the Goal in `CLAUDE.md`: right content, right moment, right scope, least record
that restates, durable beats recent, never on the critical path. A conversational-QA score that
rewards putting the whole history in context counts against a benchmark, because it cannot show
Recall earning its keep.

What we run today: coding-life, PrecisionMemBench and a LongMemEval sample on `fast` (~2 min);
LongMemEval at 20 per type plus replay on `full` (~30 min). All score Recall (search, session
start, prompt submit) with no answerer and no judge. Splits come from `eval/runner/split.ts` (salt
`agentmemory-eval-split-v1`, 40% holdout, ranked within a group per bench); a new bench maps in by
supplying its id and group functions, so neither the salt nor the share changes.

## Verdicts

| Benchmark | arXiv | Verdict | Reason |
|---|---|---|---|
| DolphinBench | 2609.24971 | run once and publish | The only one whose test never names the fact (right moment); retrieval-only derivative is cheap, but the official score is not |
| BEAM | 2510.27246 | run once and publish | Has retrieval gold plus knowledge-update and contradiction subsets; CC-BY-SA data so fetched |
| LongMemEval | 2410.10813 | keep; change the sample | Already ours; sample never draws abstention and under-draws knowledge update |
| LoCoMo | 2402.17753 | skip | Tiny haystack at ceiling, overlaps LongMemEval, audited key errors, non-commercial licence |
| MemBench | 2506.21605 | skip | Needs an answerer, overlaps LongMemEval, no licence stated |
| MemoryArena | 2602.16313 | skip | Needs a task agent in simulated shopping, travel and math; cannot score Recall alone |
| MemoryBench | 2510.17281 | skip | Feedback-driven continual learning scored by many LLM judges; non-coding domains |

## DolphinBench (arXiv 2609.24971)

- **Measures.** Whether an agent, given a vague action request, uses facts established earlier in
  a long persona history (§3). Three personas (CEO, infrastructure engineer, product manager),
  about 500K user-message tokens each, 600 tests in simulated tool apps. Matches *right moment*
  best: the task never announces the fact, so memory must arrive unasked. Every test was checked
  with an oracle agent that passes with the relevant history and fails without it (§3.1).
- **Recall alone?** The official score cannot: it runs an agent and grades with deterministic
  checks plus an LLM judge (§3.2, Table 2). A retrieval-only derivative is possible because the
  dataset links each test's required facts to the messages that established them (HF
  `mem0ai/dolphinbench`: `facts`, `messages`, `tests`). Task request as a prompt-submit query,
  establishing messages as gold. Schema not yet downloaded; the adapter ticket verifies it.
- **Cost.** Official: the paper's Claude Code rows cost $1,132 to $1,830 for 600 tasks at 26-36%
  accuracy (§4, Table 2), so a full official run is out. Derivative: no LLM, but each persona is
  ~500K tokens, about 4x a LongMemEval haystack. Extrapolated from ~16 s per question before
  chunking and ~210 s after (#265): about 1 min per persona without chunking, up to ~15 min with
  it. Too slow for `fast`; `full` only if #265 is fixed.
- **Licence.** Dataset and repo Apache-2.0, about 3.2 MB of parquet. Committing is allowed in
  principle; fetch anyway, since the README asks not to train on it, and keep the repo free of
  third-party bulk.
- **Split.** Group by persona (3 groups), id by test id; 40% holdout per persona maps directly.
- **Protocol problems.** Authored by Mem0, who top the table (best 70.67%, §4): a conflict of
  interest with no third-party replication yet. The judge is a single LLM. Alex's history runs
  to Dec 2027, future-dated relative to the Sept 2026 release, which stresses date handling.
- **Overlap.** Little. Closest to PrecisionMemBench in being action-triggered, far larger.
- **Coding relevance.** Alex (infrastructure engineer) is the nearest to a coding agent; the
  rest are business tasks.
- **Supersession.** Facts are annotated as introduced or changed, with later updates (§3), so
  this is a source for #266.
- **Verdict.** Run once and publish the retrieval-only derivative on the Alex persona first.

## BEAM (arXiv 2510.27246)

- **Measures.** Ten abilities over 100 conversations from 100K to 10M tokens, 2,000 validated
  questions (§2.2): abstention, contradiction resolution, event ordering, information
  extraction, instruction following, information update, multi-hop, preference following,
  summarization, temporal reasoning; 2 per ability per conversation (§2.4). Matches *right
  content* and *durable beats recent* (update and contradiction).
- **Recall alone?** The official score cannot: an LLM judge scores against nuggets, event
  ordering uses Kendall tau-b (§2.4). Probing questions carry `source_chat_ids` for every ability
  except abstention (verified on row 0 of the 100K split via the HF datasets-server), so a
  retrieval-only scorer maps those ids to messages.
- **Cost.** 100K split 20 conversations, 500K 35, 1M 35. The 100K split is about our LongMemEval
  size, so about 20 conversations at the LongMemEval per-question rate: minutes without chunking,
  tens of minutes with it (extrapolated). Larger splits scale linearly; not for `fast`.
- **Licence.** Dataset CC-BY-SA-4.0 (share-alike): fetch, do not commit. Code MIT.
- **Split.** Group by ability, id by conversation id and ability; salt and share unchanged.
- **Protocol problems.** Contradiction resolution is near zero for every method (§5), so it
  separates little. The paper's best retrieval budget is K=15 and K=20 degrades from noise (§5);
  our `k` should be chosen deliberately. At 10M tokens the paper scores the largest recent
  segment that fits, not the whole conversation (§5).
- **Overlap.** Same abilities as LongMemEval, at scale; the unique parts are 10M-token reach,
  instruction following and event ordering.
- **Coding relevance.** Some conversations are in a Coding category; most are not.
- **Supersession.** `knowledge_update` and `contradiction_resolution`: a second, larger source
  for #266 beside LongMemEval's 78 knowledge-update questions.
- **Verdict.** Run once and publish a retrieval-only slice on 100K and 500K.

## LongMemEval (arXiv 2410.10813)

- **Measures.** Five abilities, seven question types over 500 questions (§3.1): extraction,
  multi-session, temporal, knowledge update, abstention. S is about 115K tokens per question;
  the local file averages 50.2 sessions. It also reports Recall@k and NDCG@k from evidence labels
  (§3.3), which is the part we use. Answer scoring uses gpt-4o-2024-08-06 with over 97% human
  agreement (§3.3); we do not.
- **Licence.** MIT (ethics statement; HF `longmemeval-cleaned` is MIT). Fetched, as today.
- **Local counts** (500 questions, 30 of them abstention): single-session-user 70, multi-session
  133, preference 30, temporal 133, knowledge-update 78, single-session-assistant 56. Dev is 60%
  of each type: 42, 80, 18, 80, 47, 34.
- **Cleaned release.** The 2025/09 cleaned data removes noisy sessions and replaces the original.
  `eval/README.md` still points at the original `longmemeval_s`, so our baselines are on
  pre-cleaning haystacks. Switching changes haystacks, not ids or the split, and needs a rerun.
  The repo's ground-truth issues #19 and #22 are also cited by DolphinBench §1 and §2.3.
- **Sampling gap.** `stratifySample` takes the first N per type in file order. The 30 abstention
  questions sit at file positions 64 to 441 and none falls in the first 4 or first 20 dev
  questions of any type, so neither tier ever draws one (their gold sessions are in the haystack,
  so Recall is scoreable). Fast draws 6 types x 4 = 24 questions, 4 of 47 dev knowledge-update
  questions.

### Should the fast-tier sample change given #265?

#265 reports the fast LongMemEval leg going from 129 s to 1,682 s, probably from Memory chunking
defaulting on (#263), about 210 s per question per worker against about 16 s. At that rate `full`
(~118 questions) is about 2.3 h and all 500 about 9.7 h, against roughly 11 and 45 minutes
without chunking (extrapolations). Resolve #265 first, because no sample change pays for a 13x
slowdown. Then: (1) draw by a seeded hash rank within each type instead of file order, so
abstention and later-file questions are sampled, on the existing ranking, with no salt change;
(2) raise knowledge update on `fast` from 4 to about 8, since #266 depends on it and 4 of 47 is
noise; (3) rebaseline once on the cleaned data. Do not enlarge `fast` until the per-question cost
is back near 16 s. These are recommendations, not edits: `suite.ts` and `load.ts` are outside
this ticket.

## LoCoMo (arXiv 2402.17753)

- **Measures.** Five QA categories (single-hop, multi-hop, temporal, open-domain, adversarial,
  §4.1), plus event summarization and multimodal generation (§4.2). Scored by F1; a RAG variant
  reports recall@k from annotated evidence dialogue ids (§4.1, Table 3).
- **Recall alone?** Yes for evidence recall; F1 needs an answerer.
- **Cost.** Negligible: public release is 10 conversations (the paper's 50, trimmed), about 305
  turns and 9.2K tokens each (Table 1). The ticket's "32 sessions, 16K tokens" is not what the
  paper reports.
- **Licence.** CC BY-NC 4.0: fetch only.
- **Split.** Would work by category, but 10 conversations give a holdout of 4: too small to mean
  anything.
- **Protocol problems.** A third-party audit (dial481/locomo-audit, cited by DolphinBench
  §2.2/§2.3) finds 99 of 1,540 non-adversarial questions (6.4%) with score-corrupting key errors
  and 57 more (3.7%) citing the wrong evidence, which corrupts retrieval gold. The judge accepted
  up to 63% of deliberately wrong answers. Adversarial has no ground-truth answers.
- **Overlap.** Single-session, multi-session and temporal in LongMemEval, at a haystack so small
  that recall is near ceiling.
- **Coding relevance.** None.
- **Supersession.** None.
- **Verdict.** Skip: it cannot discriminate and its gold is unreliable.

## MemBench (arXiv 2506.21605)

- **Measures.** Factual and reflective memory, in participation and observation scenarios;
  accuracy by multiple choice, recall of key-evidence dialogues, capacity and efficiency (§3.4).
  Sizes in Table 2 run from 2K to 51K sessions. Trajectories are about 10K tokens (participation)
  or 1K (observation); 100K variants pad with news text (§4.1).
- **Recall alone?** Evidence recall yes; accuracy needs an answerer but no judge.
- **Cost.** Cheap per trajectory, large in count.
- **Licence.** `import-myself/Membench` states none: fetch only, and the lack of a licence is a
  reason for caution.
- **Split.** Group by question type; maps cleanly.
- **Protocol problems.** RetrievalMemory Recall@10 is already about 0.75 to 0.85 (Tables 3, 4),
  near ceiling for small haystacks.
- **Overlap.** Factual types overlap LongMemEval; the new parts are reflective (preference
  inference) memory and efficiency.
- **Coding relevance.** Low.
- **Supersession.** A knowledge-updating factual type exists (Table 6); too small to be our source.
- **Verdict.** Skip.

## MemoryArena (arXiv 2602.16313)

- **Measures.** Interdependent multi-session agentic tasks in four environments (bundled web
  shopping, group travel planning, progressive web search, formal reasoning in math and physics);
  success rate and task progress (§5).
- **Recall alone?** No: it needs a task agent and simulated environments.
- **Cost.** Agent-loop cost per task; not estimated, as we would not run it.
- **Licence.** HF `ZexueHe/memoryarena` carries no licence tag.
- **Split.** Under 1K rows; per-environment groups would be tiny.
- **Protocol problems.** The paper finds external memory and RAG do not consistently beat long
  context (§5), and group-travel success is about zero for every method.
- **Overlap.** None, but also no coding content.
- **Supersession.** None.
- **Verdict.** Skip.

## MemoryBench (arXiv 2510.17281)

- **Measures.** Continual learning from simulated explicit and implicit feedback across 11
  datasets, three domains, two languages (LoCoMo, DialSim, LexEval, JuDGE, IdeaBench and others,
  §2.3). An LLM user simulator produces the feedback (§2.4).
- **Recall alone?** No: native per-dataset metrics, many LLM judges.
- **Cost.** High; the paper reports extreme time cost for memory systems (§3, Figure 4).
- **Licence.** HF `THUIR/MemoryBench` is MIT.
- **Split.** By source dataset; the units are not memory questions.
- **Protocol problems.** Mem0, A-Mem and MemoryOS do not consistently beat RAG baselines (§3), so
  it is a weak discriminator, and its domains (legal, academic writing) are far from ours.
- **Overlap.** Contains LoCoMo.
- **Supersession.** None.
- **Verdict.** Skip.

## Knowledge-update sources for #266

LongMemEval (78 questions), BEAM (`knowledge_update`, `contradiction_resolution`), DolphinBench
(changed-fact annotations), MemBench (small). LoCoMo, MemoryArena and MemoryBench have none.

## Open points

- DolphinBench's `facts`/`tests` schema and BEAM's `chat_id` mapping are unverified beyond one
  row; each issue's first step is to confirm them.
- Wall-time figures for DolphinBench, BEAM and LongMemEval-at-scale are extrapolations from
  #265's per-question rate, not measurements.
