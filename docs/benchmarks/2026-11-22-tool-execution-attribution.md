# Tool execution attribution — 2026-11-22

**Hypothesis (#508):** Carrying Claude Code's execution ID and type separately from isolation scope preserves captured attribution and prevents deduplication across different subagents.

**Method:** Overlay the candidate's four synthetic test files on baseline `954c6583` and run the same files on candidate `d08f6e0a`:

```sh
npx vitest run test/observe-dedup-prompt.test.ts test/stop-hook.test.ts test/compress-batch.test.ts test/export-import.test.ts
```

| Arm | Passed | Failed |
|---|---:|---:|
| Baseline | 63 | 7 |
| Candidate | 70 | 0 |

Baseline failures cover hook forwarding, synthetic capture, single and batch Compression, and deduplication of successful and failed tool calls. Backup cases seed attribution directly and pass on both arms: they verify preservation, not capture.

**Verdict:** Keep. The fixtures do not measure storage size or exercise a live Claude Code session. Transcript replay does not infer missing identity.
