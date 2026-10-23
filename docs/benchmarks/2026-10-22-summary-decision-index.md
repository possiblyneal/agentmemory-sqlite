# 2026-10-22 — Session Summary decisions as a BM25 layer (#259)

**Commit:** control `4d11b60`, A `a3576cf` (decision layer), B `4215e7b` (A plus `appliesWhen`)
**Bench:** `eval:replay --from-checkpoints` over one `--llm --save-checkpoints --keyed-only` store, dev split
**N:** 38 probed checkpoints of 51 replayed Sessions (51 of 203 keyed), 357 prompts, 37 key items (28 file, 7 correction, 2 decision)
**Hardware:** linux x86_64, Node 22+, the three arms probed in parallel on one host
**Embeddings:** on-device (replay default)
**LLM:** save pass only: the Operator's OpenAI-compatible broker, model `general`; probes make no LLM call

## Headline

Neither variant moves a replay metric. A and B inject the same items on every prompt, so the
`appliesWhen` line changes nothing here; both differ from the control in 5 of 38 Sessions, and
none of those changes alters a hit. #259's sdebench passes run only if replay improves on the
control, so they were not run. No variant wins on this evidence.

## Per arm

| Arm | Injected items | Used | Injection chars | Injection hit | Search hit | Either | Correction before repeat | prompt-context p50 / p99 |
|---|---|---|---|---|---|---|---|---|
| control | 248 | 50 | 260,133 | 27/37 | 10/37 | 31/37 | 2/7 | 24 / 1333 ms |
| A | 244 | 49 | 255,940 | 27/37 | 10/37 | 31/37 | 2/7 | 20 / 1549 ms |
| B | 244 | 49 | 255,940 | 27/37 | 10/37 | 31/37 | 2/7 | 24 / 1548 ms |

By kind (all arms equal): file 25/28 injected, correction 2/7, decision 0/2 injected and 2/2 by
search. Every used item is a Session Summary (control 50 of 146 Summary items, A 49 of 142).
The p99 and the 1 vs 4 prompts over the hook timeout come from three probes sharing the host, not
from the arms; replay latency is not comparable across parallel runs.

## Methodology

- One save pass built the checkpoints with B's summarizer, so all three arms probe identical
  stores; the probes differ only in the build that reads them.
- The save pass hit Node's 300 s undici headers timeout (#302), which left Summaries written
  before compression finished. Every Session Summary in the checkpoints was re-written by a
  force-summarize on a build carrying the #303 fix, after the compression queue drained and
  failed compressions were retried, then patched into each checkpoint. No checkpoint holds a
  Session without a Summary or a pending compression.
- Long Sessions still carry few decisions (a Session of 560 Observations has 5): the merge step drops
  them (#300). The fix (#301) is not in any arm; `2026-10-22-summary-decision-merge.md` measures it.
- The corpus's keyed selection depends on every transcript under the root; pruned transcripts
  were restored from a frozen copy so the selection stayed 51 of 203.

## Reproduce

```sh
npm run eval:replay -- --llm --save-checkpoints --keyed-only --cap 1000 --min-turns 2 \
  --max-prompts 40 --split dev --projects=<list> --out tmp/eval-replay/ckpt   # on B
npm run eval:replay -- --from-checkpoints tmp/eval-replay/ckpt/checkpoints --keyed-only \
  --cap 1000 --min-turns 2 --max-prompts 40 --split dev --projects=<list>      # per arm
```

## Notes

- Only 2 key items are decisions, the kind the layer targets; this corpus cannot show a decision
  effect in either direction.
- The 5 differing Sessions trade one Summary block for another of similar size (about 4 kB less
  injected in total) with the same hits.
