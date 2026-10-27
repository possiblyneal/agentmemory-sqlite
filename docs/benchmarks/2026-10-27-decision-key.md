# 2026-10-27 — decision-key baseline

**Commit:** the commit that adds `eval:decision-key` (#334)
**Bench:** `eval:replay --decision-key` over the Operator's own transcripts (aggregates only)
**N:** 20 dev-split Sessions scored, 186 key items (a key item is one expected decision at one typed prompt)
**K:** an Injection is scored whole
**Hardware:** Operator workstation, Linux, Node 22+
**Embeddings:** on-device
**LLM:** none for the daemon (no `--llm`); the shell's OpenAI-compatible settings for key extraction, labelling and the judge

## Headline

Decision recall on the dev split is 3 of 186 (1.6%) overall: session start delivers 0 of 186, prompt submit 3 of 186. Almost none of the decisions the Operator made earlier reach the Agent through an Injection. This is the baseline later Recall and Injection changes are measured against.

## Per surface

| Surface | Items | Delivered | Recall |
|---|---|---|---|
| session-start | 186 | 0 | 0.0% |
| prompt-submit | 186 | 3 | 1.6% |
| either | 186 | 3 | 1.6% |

## Key

- 180 decisions extracted from 34 loaded Sessions; 147 typed prompts have at least one expected decision; 356 items across all splits, 186 of them in the dev split. The holdout split was not looked at.
- `byProject` holds one project (`agentmemory-sqlite`) with the same numbers as the pool, since every selected directory resolves to it.
- `typical` is empty (0 items): the only project is in the default `--atypical` list.

## Methodology

- Subset: the main `agentmemory-sqlite` project directory plus 13 orca workspace directories of the same repo. Excluded: the live parent Session, scratch (`*-tmp-*`, `wt-*`) directories and the scratchpad probe directory.
- `--cap 40 --min-turns 2`, `--instance 31` (throwaway daemon, never the live port), 0 failed probes.
- The key is built only from typed Operator turns and AskUserQuestion questions, options and answers. Harness Messages, compaction summaries and Agent prose are excluded.
- Verdicts are cached on disk by (decision id, sha256 of injected text); a rerun makes no judge call.
- No `--llm`: the stores hold synthetic memories and no real Session Summaries, so recall under `--llm` is likely higher. This number is the floor.
- Private: the key, verdicts and transcripts stay under `tmp/eval-replay/` and are not committed.

## Reproduce

```sh
npm ci && npm run build
npm run eval:decision-key -- --projects=<dirs>
npm run eval:replay -- --projects=<dirs> --decision-key --instance 31
```

## Notes

- Session start scoring 0 of 186 is consistent with the missing Session Summaries; this run did not isolate the cause.
