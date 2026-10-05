---
name: agentmemory-hooks
description: The agentmemory plugin hooks that capture observations automatically across the agent session lifecycle. Use when explaining how memory gets captured without manual saves, when debugging missing observations, when backfilling past sessions with import-jsonl, or when tuning what gets recorded.
user-invocable: false
---

The Claude Code plugin registers lifecycle hooks so memory is captured automatically. You do not have to call `memory_save` for routine work; the hooks observe tool use, prompts, and session boundaries and write observations for you.

## Quick start

Install the plugin and the hooks register themselves:

```bash
/plugin marketplace add possiblyneal/agentmemory-sqlite
/plugin install agentmemory
```

Watch observations land live at `http://localhost:3113`.

## What the hooks do

- Session start and end frame each unit of work and let `handoff` resume it. `Stop` fires after every turn, so it only marks a turn end: the Session ends, and is summarized, once it has gone 30 minutes with no turn and no new Observation, or at once on `SessionEnd`.
- Tool-use hooks capture what changed and why, the raw material for `recall` and `recap`.
- Prompt-submit captures intent. Pre-compact preserves context before the host trims it.
- A post-commit hook links commits to sessions, which powers `commit-context` and `commit-history`.

## Important

- Capture is on by default and is zero-LLM. Turning observations into LLM summaries (`AGENTMEMORY_AUTO_COMPRESS`) and injecting them back into context are separate opt-ins because they spend tokens. `AGENTMEMORY_INJECT_CONTEXT` injects at session start and, on each user prompt, up to three memories that match it strongly.
- Headless Sessions are skipped by default: every hook returns early when `CLAUDE_CODE_ENTRYPOINT` starts with `sdk-` (`claude -p`, TS and Python Agent SDK). Set `AGENTMEMORY_CAPTURE_HEADLESS=1` to capture them. `AGENTMEMORY_SDK_CHILD=1` (agentmemory's own summarize calls) is skipped regardless.
- If observations are missing, confirm the plugin is enabled and the server is running. See ../_shared/TROUBLESHOOTING.md.

## Backfilling from transcripts

`agentmemory import-jsonl [path]` turns past Claude Code transcripts into Sessions and Observations.

- The daemon reads the files, not the CLI. The CLI posts the path to `http://localhost:<REST port>/agentmemory/replay/import-jsonl` (it does not follow `AGENTMEMORY_URL`), and the daemon opens that path on its own filesystem as its own user.
- With no path, the CLI sends its own `<Claude config dir>/projects`. The viewer's import and a bare `POST` let the daemon pick the default, resolved on the daemon host.
- For a daemon on another machine, copy the transcripts to that host and post a path that exists there.
- Claude Code deletes transcripts older than `cleanupPeriodDays` (default 30) in its `settings.json` at startup, so an import finds only what is left. Raise that setting before older history is needed; deleted transcripts cannot be recovered.

## See also

- agentmemory-config for the capture and injection flags.
- The handoff, recap, and session-history skills consume what these hooks record.

## Reference

The exact registered hook events live in REFERENCE.md, generated from `plugin/hooks/hooks.json`.
