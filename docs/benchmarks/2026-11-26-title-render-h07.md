# Render a raw-JSON narrative as its title in Injection (#601, H07)

Gate run only: `npm run eval:gate` (coding-agent-life-v2, tolerance 0.02), the head of PR #607 (`e49e2e09`, which changes `renderedNarrative()` in `src/functions/prompt-context.ts`) against `origin/main` `d5af287b`. No eval was run beyond the gate.

**Commit:** `e49e2e09` (change), `d5af287b` (control)
**Bench:** coding-agent-life-v2, bm25 adapter, via `eval:gate`
**Hardware:** local run on Node v22.23.4; CI is the Node 22 leg of the `test` job (the gate runs on 22 only)

## Headline

prompt-submit recall fell below the gate: baseline 0.907, got 0.852 (-0.055, tolerance 0.02). Search and session-start rows were unchanged on the change's head (search recall 0.969, precision 0.704, no-answer clean 0.250; session-start recall 0.813, precision 1.000, no-answer clean 1.000). The control `origin/main` passed the gate (exit 0; only its prompt-submit rows were inspected), as did its CI runs.

## Reproduce

```sh
git checkout e49e2e09   # exits 1; on d5af287b it exits 0
npm ci && npm run build && npm run eval:gate
```

## Notes

The gate failed on the Node 22 CI leg of PR #607 and reproduced locally on the same head. The Injection Gate (`gateByRelevance`) scores the raw narrative while the render now shows the title, which is untested as the cause.
