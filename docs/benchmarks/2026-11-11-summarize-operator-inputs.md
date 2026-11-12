# 2026-11-11 — Marking Operator inputs in the summarize prompt (#355)

**Commit:** main `d101c715` vs `8fd0faea` (arm A: `b6874c0d` merged onto main; the prompt change
is reproduced below). Stage 1 ran each arm as its commit's patch applied onto main: arm A `b6874c0d`
(mark), arm B `56e52ed3` (mark + digest). In stage 2's `eval:compare` output, A is arm A and B is
main. Neither arm ships.
**Bench:** stage 1 `eval:fold-drift --one-pass --decision-key --batch 20` on main's checkpoint 040
of the [2026-11-07 decision loss](./2026-11-07-decision-loss.md) arm; stage 2 `eval:arm` (save pass
`--llm-summary`, synthetic compression, then the `--decision-key` probe) and `eval:compare`, dev split
**N:** stage 1: 17 Sessions, 143 key decisions (15 Sessions and 137 decisions where arm A stopped
early). Stage 2: frozen corpus of 21 project directories, 41 Sessions saved per arm (`--cap 40
--min-turns 2`), 24 probed, 262 paired reachable decisions (189 unreachable); `typical` 8 Sessions,
48 reachable decisions
**K:** 1 probe per arm; arms paired by decision item, exact McNemar
**Embeddings:** local (probe)
**LLM:** local OpenAI-compatible broker. Stage 1: profile `general` for all three arms. Stage 2:
profile `general-eval-b` for arm A and `general-eval` for main, run at the same time on the two
single-slot eval profiles. Failed summarize calls 0 on both final save passes (arm A's first pass
failed 8 in Session 5; the runner resumed from checkpoint 004 and reran it clean)
**Hardware:** Linux 6.12.116, 8 cores, Node v22.23.4; both stage-2 arms ran concurrently

## Headline

Inconclusive. Arm A cleared stage 1 (+16 key decisions captured vs main, threshold +10) but in the
decision-key A/B it delivers 40 vs main's 38 of 262 paired reachable decisions (15 A-only, 13
main-only, McNemar p = 0.851). On `typical` it does not lose on either-surface recall (18 vs 16 of 48)
but loses one by turn (18 vs 19) and injects 29% more chars for fewer used items. The arms ran on
different broker models, which confounds every stage-2 difference. Per #355, the prompt change
does not ship.

## Stage 1: one-pass capture screen

Same 15 Sessions for all three arms (arm A stopped early once its gain cleared the threshold;
arm B ran all 17: 65 captured vs main's 55, +11).

| Arm | Key decisions captured | Never captured | Gain vs main | Decisions in Summaries | Decision chars |
|---|---|---|---|---|---|
| main `d101c715` | 50 / 137 | 87 | — | 199 | 26,234 |
| A: mark Operator inputs | 66 / 137 | 71 | +16 | 319 | 72,999 |
| B: mark + digest (`56e52ed3`) | 60 / 137 | 77 | +10 | 253 | 29,086 |

A and B were 6 apart on these Sessions (5 on the gains each run reported), more than the 4 that
would have sent A by default, so A went to stage 2 as the arm that captured more. Arm A's gain
came with 1.6x the decisions and 2.8x the decision text of main's Summaries; the narrative did
not grow (9,613 vs 9,585 chars).

## Stage 2: decision-key A/B

| Metric | A `8fd0faea` | main `d101c715` |
|---|---|---|
| decisionRecall either (paired, 262) | **40** | 38 |
| both / A-only / main-only / neither | 25 / 15 / 13 / 209 | |
| exact McNemar p | 0.851 | |
| delivered by turn | 55 | 54 |
| by turn both / A-only / main-only / neither | 35 / 20 / 19 / 188 | |
| decisionRecall session start | 25 | 26 |
| decisionRecall prompt submit | 15 | 13 |
| prompt submit by turn | 30 | 29 |
| turnOwn substantive needs (107) | 0.355 (38) | 0.299 (32) |
| turnOwn terse needs (36) | 0.111 (4) | 0.139 (5) |
| injected items / used | 362 / 45 | 351 / 48 |
| used share | 0.124 | 0.137 |
| injection chars | 311,159 | 312,208 |
| chars per used item | 6,915 | 6,504 |
| leaks | 0 | 0 |
| store bytes | 53,829,632 | 53,866,496 |
| prompt-context p50 / p99 | 110 / 566 ms | 107 / 496 ms |
| session-start p50 / p99 | 23 / 104 ms | 20 / 61 ms |
| search p50 / p99 | 48 / 258 ms | 44 / 197 ms |
| over hook timeout | 0 | 0 |

### `typical` (excluding agentmemory-sqlite, medical-researcher)

| Metric | A | main |
|---|---|---|
| Sessions | 8 | 8 |
| decisionRecall either (48) | **18** | 16 |
| session start | 13 | 12 |
| prompt submit | 5 | 5 |
| prompt submit by turn | 18 | **19** |
| turnOwn substantive needs (1) / terse needs (5) | 1 / 0 | 1 / 0 |
| injected items / used | 92 / 9 | 91 / 12 |
| used share | 0.098 | 0.132 |
| injection chars | 74,339 | 57,783 |
| chars per used item | 8,260 | 4,815 |
| prompt-context p99 | 274 ms | 319 ms |

## The prompt change (arm A)

`git diff d101c715 8fd0faea -- src/prompts/summary.ts`; the rest of the arm is tests. The same
rule text changed in `SUMMARY_SYSTEM` and `FOLD_SYSTEM`; `REDUCE_SYSTEM` already carried the rule
and gets no Observations to mark.

```diff
@@ -19,7 +19,7 @@ Output EXACTLY this XML format with no additional text:
 Rules:
 - Focus on outcomes, not individual tool calls
 - Highlight decisions and their rationale
-- Give every rule, requirement or constraint the user stated as its own decision, keeping its exact values (status codes, limits, thresholds, names) and conditions; never generalize a specific value away
+- Give every rule, requirement or constraint the user stated as its own decision (an observation marked Operator-stated is the user speaking: a typed prompt, or a question with the answer they chose), keeping its exact values (status codes, limits, thresholds, names) and conditions; never generalize a specific value away
 - When a rule applies only in some cases, keep in the same decision what the user said happens in the rest ("otherwise ...", "for any other ..."), so the rule cannot be read as excluding them; the two are one decision even when stated or summarized apart
 - When an agent reply restates the agreed rules (a recap or a "Settled:" line) and the user does not correct it, keep each restated rule verbatim as its own decision; read a user's short answer ("down", "yes") against the agent's question before it
 - List all files that were created or modified
@@ -33,6 +33,15 @@ export interface SummaryObservation {
   files: string[]
   concepts: string[]
   assistantResponse?: string
+  toolName?: string
+  origin?: { channel: string }
+}
+
+const OPERATOR_TOOL = 'AskUserQuestion'
+
+function isOperatorInput(obs: SummaryObservation): boolean {
+  if (obs.origin?.channel === 'user') return true
+  return obs.toolName === OPERATOR_TOOL && obs.type !== 'error'
 }
 
 // A reply's closing lines carry the recap and the question the user answers next, so a long one keeps its tail.
@@ -42,7 +51,8 @@ export const SUMMARY_REPLY_MAX = 2000
 // subagent's closing message is not one the user answers, so it is not given as the Agent's reply.
 export function renderSummaryObservation(obs: SummaryObservation, index: number): string {
   const facts = obs.facts.map((f) => `  - ${f}`).join('\n')
-  const base = `[${index + 1}] ${obs.type}: ${obs.title}\n${obs.narrative}\nFacts:\n${facts}\nFiles: ${obs.files.join(', ')}`
+  const label = isOperatorInput(obs) ? ' (Operator-stated)' : ''
+  const base = `[${index + 1}] ${obs.type}${label}: ${obs.title}\n${obs.narrative}\nFacts:\n${facts}\nFiles: ${obs.files.join(', ')}`
   const reply = obs.type === 'subagent' ? undefined : obs.assistantResponse?.trim()
   if (!reply) return base
   const tail = reply.slice(-SUMMARY_REPLY_MAX)
@@ -140,7 +150,7 @@ Output EXACTLY this XML format with no additional text:
 Rules:
 - Rewrite the narrative so it covers the whole session, not only the new observations
 - Keep every existing decision unless a new observation reverses it; add new ones
-- Give every rule, requirement or constraint the user stated as its own decision, keeping its exact values (status codes, limits, thresholds, names) and conditions; never generalize a specific value away
+- Give every rule, requirement or constraint the user stated as its own decision (an observation marked Operator-stated is the user speaking: a typed prompt, or a question with the answer they chose), keeping its exact values (status codes, limits, thresholds, names) and conditions; never generalize a specific value away
 - When a rule applies only in some cases, keep in the same decision what the user said happens in the rest ("otherwise ...", "for any other ..."), so the rule cannot be read as excluding them; the two are one decision even when stated or summarized apart
 - When an agent reply restates the agreed rules (a recap or a "Settled:" line) and the user does not correct it, keep each restated rule verbatim as its own decision; read a user's short answer ("down", "yes") against the agent's question before it
 - Union (deduplicate) all files and concepts
```

## Reproduce

```sh
# stage 1, per arm, from main with that arm's patch applied; main first, then each arm against main's output
npm run eval:fold-drift -- --store <main checkpoint 040> --sessions <the 17> --batch 20 \
  --decision-key tmp/eval-replay/decision-key.json --one-pass [--baseline <main screen.json> --threshold 10]
# stage 2, one broker profile per arm (OPENAI_MODEL), AGENTMEMORY_AUTO_COMPRESS=false
npm run eval:arm -- --ref <ref> --label <label> --instance <N> --root tmp/replay-corpus \
  --projects=<frozen list> --cap 40 --min-turns 2 --llm-summary
npm run eval:compare -- s2-armA s2-main
```

## Notes

- The confound: the two stage-2 arms summarized on different broker models
  (`general-eval-b` vs `general-eval`), so a 2-item difference cannot be told from the model.
  Stage 1 ran all arms on one model and is the cleaner reading of capture.
- Stage 1's capture gain did not carry into delivery: of 262 paired items, 209 are delivered by
  neither arm. The probe ran without `--attribute`, so this run does not say whether the extra
  decisions fell below the 10-decision render cap or were never captured on the stage-2 corpus.
- The guard in #355 (decisions per Summary and Summary chars must not balloon) fails at stage 1:
  2.8x the decision text. In stage 2 total injection chars are flat, but on `typical` arm A
  injects 29% more chars and its chars per used item rises from 4,815 to 8,260.
- The prompt-context p99 difference (566 vs 496 ms) comes from concurrent arms on one host and
  is not attributed to the change; `typical` shows the opposite order.
