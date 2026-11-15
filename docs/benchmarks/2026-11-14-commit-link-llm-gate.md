# 2026-11-14 — commit-link index under LLM compression and the Injection Gate

**Commit:** `main` after #408 (`src/functions/commit-index.ts`), built in the #403 worktree
**Bench:** `eval:replay --keyed-only --from-checkpoints` over the Operator's own transcripts, on a fresh LLM-compressed save pass (#403)
**N:** 33 keyed Sessions from 12 projects (235 loaded, cap 40, min 2 turns), 24 probed from checkpoints; 30 key items (20 on the typical rollup)
**K:** an Injection and a search are scored whole, as in the other replay scorecards
**Hardware:** Linux 6.12, 12 cores, Node 22
**Embeddings:** on-device (the default local model)
**LLM:** save pass compressed and summarized through the broker's `general-eval-b` (single slot, `AGENTMEMORY_LLM_MAX_CONCURRENCY=1`); probes run with the LLM off
**Injection Gate:** on, `AGENTMEMORY_PROMPT_RERANK_URL=http://ai.lan:9202/v1/rerank`, defaults otherwise

## Headline

The [2026-11-13](./2026-11-13-commit-link-index.md) gain does not hold under the production configuration. With LLM compression on, `none` already delivers 27 of 30 key items and all 22 file keys, so linking commits gains none and loses none (exact McNemar p = 1.0). It costs latency, and pooled Right content: the pooled used share falls from 25.0% to 19.9%, but on the typical rollup it is flat (22.1% to 22.4%), so the loss is pooled-only. The prompt-submit Injection p50 rises from 15 ms to 239 ms, with p99 at 1,002 ms, the gate's timeout, and 17 of 159 gate calls falling back. Latencies were measured on a shared host whose load was not recorded.

## Per arm

Both arms restore the same 24 checkpoints; only the ingest differs.

| Arm | Gate | Key delivered (injection / search / either) | File keys | Used / injected | Chars per used item | External used / injected | Prompt-context p50 / p99 | Gate calls / fallbacks |
|---|---|---|---|---|---|---|---|---|
| none | off | 27/30 | — | 28/116 (24.1%) | 4712 | 0/0 | — | — |
| commits | off | 27/30 | — | 93/575 (16.2%) | 3466 | 65/464 | — | — |
| none | on | 22 / 10 / 27 of 30 | 22/22 | 27/108 (25.0%) | 4508 | 0/0 | 15 / 339 ms | 29 / 0 |
| commits | on | 22 / 13 / 27 of 30 | 22/22 | 69/347 (19.9%) | 3215 | 41/241 | 239 / 1002 ms | 159 / 17 |

Typical rollup (without `agentmemory-sqlite` and `medical-researcher`), gate on: both arms 18/20 key items; used share 22.1% (`none`) and 22.4% (`commits`). Typical latencies, `none` against `commits`: session-start p50 12 against 30 ms, search p50 45 against 65 ms, prompt-context p50 18 against 298 ms (the pooled figures in the table are 15 against 239 ms for prompt-context).

## Why the synthetic result does not carry over

Under synthetic compression `none` delivered 4 of 30 key items, and the 7 the commits gained were all file keys. Here `none` delivers every file key (22/22), so a commit message and path list has no file key left to add. The 3 key items still missing are all corrections (corrections 3 of 6 delivered, decisions 2 of 2), which a commit message and path list does not answer. This run differs from the 2026-11-13 one in two ways at once, LLM compression and store size (`--keyed-only`, 33 Sessions against 141), and it did not separate them; the likelier reading is that a compressed Observation's own record answers the file keys, but that is an inference, not a measurement. The commit rows still get injected (241 with the gate on), and they are why the used share falls and the gate runs on 5x more prompts.

## Methodology

- **Save pass:** `eval:replay --llm --keyed-only --save-checkpoints`, 33 Sessions, 67,970 s, 91% of it draining the compression queue (the 32 Sessions of the last checkpoint hold 6,578 Observations and drained in 59,096 s, about 9.0 s each through the single-slot model; Session 33's 2,580 s drain is left out of that rate because its Observations are in no checkpoint). It ran with exit code 0; every Summary was written.
- **Probes:** each arm `--from-checkpoints` the save pass, `--external-corpus` the #396 corpus, `--external-arm none` or `commits --external-ingest commit-link` (commits posted to `POST /agentmemory/session/commit`). The gate-off pair ran first, then the same pair with the gate's URL set. Compared with `eval:external-compare`.

## Limits

- 24 probed Sessions and 30 key items; with 27 delivered by both arms only 3 items could move, so this run cannot show a gain smaller than that.
- Not comparable with the 2026-11-13 numbers: that run probed 141 Sessions of a synthetic store; this one probes a `--keyed-only` LLM-compressed store.
- Latency was measured on a shared host, without recording its load.
- One Operator, 12 projects, one replay per arm.

## Reproduce

```sh
npm ci && npm run build
OPENAI_BASE_URL=<broker> OPENAI_MODEL=general-eval-b OPENAI_REASONING_EFFORT=none \
  AGENTMEMORY_LLM_MAX_CONCURRENCY=1 \
  npm run eval:replay -- --projects=<dirs> --cap 40 --min-turns 2 --keyed-only --instance 45 \
  --llm --save-checkpoints --out tmp/ext403/save-llm
# the corpus is the #396 one (tmp/ext403/corpus.json, byte-identical to tmp/ext396/corpus.json)
probe() { # $1 = output dir; AGENTMEMORY_PROMPT_RERANK_URL is set by the caller for the gate-on run
  for arm in "none" "commits --external-ingest commit-link"; do
    npm run eval:replay -- --projects=<dirs> --cap 40 --min-turns 2 --keyed-only --instance 46 \
      --from-checkpoints tmp/ext403/save-llm/checkpoints --external-corpus tmp/ext403/corpus.json \
      --external-arm $arm --resume --out $1/arm-${arm%% *}
  done
}
probe tmp/ext403/llm                                                              # gate off
AGENTMEMORY_PROMPT_RERANK_URL=http://ai.lan:9202/v1/rerank probe tmp/ext403/llm-gate   # gate on
npm run eval:external-compare -- tmp/ext403/llm
npm run eval:external-compare -- tmp/ext403/llm-gate
```
