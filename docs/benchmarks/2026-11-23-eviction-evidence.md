# Evict repeated evidence first (#541)

## Design

- **Baseline:** `c92dc8758e2310e4c521adc9aac94aadac6b4b4b`. Run the production `mem::evict` over independently seeded in-memory stores. In the isolated treatment build, preferentially Evict exact repeats of title, narrative, Facts, files, and concepts; protect the newest eligible copy from preferential removal. Other victims retain their usual importance order. The existing candidate filter and locked coverage check are unchanged.
- **Cohort:** Two synthetic four-Observation stores. Each has an uncovered Observation that both arms must keep. One store asks for a distinct low-importance detail; the other asks about a reversal with overlapping vocabulary. The labeled answer is present before Eviction in both stores.
- **Settings:** Project cap of three; the age and importance floor do not select victims. Equal-length records let both arms retain the same serialized Observation bytes, excluding indexes, audit, and Engine overhead. Retrieval is standalone BM25 over survivors, not full Recall. No model, private inputs, or holdout used.
- **Pre-measure rule:** At least one fewer pre-Eviction-answerable need loses its evidence, with no additional stale-first result and no coverage violation, at matched bytes.

## Results

| Arm | Bytes per store | Answerable after Eviction | Stale first | Uncovered retained |
|---|---:|---:|---:|---:|
| Importance order | 801 | 1 of 2 | 0 of 2 | 2 of 2 |
| Exact repeats first | 801 | 2 of 2 | 1 of 2 | 2 of 2 |

One paired answerability gain and no answerability losses, but one paired stale-first regression: the preferred deletion spared an obsolete result that BM25 ranked above the retained newer one. Both arms Evicted one Observation per store.

**Verdict: rejected in the synthetic screen; real Recall effect unmeasured.** Retry when a variant accounts for supersession and matched checkpoints have independently labeled answerability and current versus stale evidence. Measure with production Recall, which applies ranking beyond raw BM25.

## Reproduction

`npx tsx eval/runner/eviction-evidence.ts` compares both stores; `npx vitest run test/eval-eviction-evidence.test.ts` checks paired results and coverage preservation. The prototype writes its isolated bundle under `tmp/eviction-evidence/`.
