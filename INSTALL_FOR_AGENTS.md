# Install agentmemory (agent runbook)

You are a coding agent. Follow this runbook top to bottom to install agentmemory, wire it into yourself, and verify that persistent memory works. Run each command, check the result against the "Expect" note, then move on. If a step fails, jump to Troubleshooting, and if it still fails, stop and report the step, the exact command, and the error output.

## What you are installing

agentmemory is a local memory server for coding agents. It runs on your machine, exposes a REST API on port 3111 and an MCP server, and stores memories in a SQLite file on disk. It is a single Node process with nothing else to install: no native binary, no Docker, no database server.

Default mode needs no API key and no cloud account. Out of the box it runs hybrid retrieval (BM25 keyword search plus local on-device embeddings), so a full install proves real semantic recall with zero credentials. An LLM provider key is optional and only unlocks richer summaries and auto-injection (see "Optional: richer features").

## Prerequisites

- Node.js >= 22.13 and npm. Check with `node -v`. The Engine imports `node:sqlite`, which is unflagged from 22.13; older Node fails at import.
- macOS, Linux, or Windows. `agentmemory connect` is not supported on Windows; wire MCP config by hand there, or use WSL2.
- Ports 3111 (REST), 3112 (streams), and 3113 (viewer) free. If any are taken, stop whatever is using them before starting (see Troubleshooting), or pass `--port <N>` to move all three.

## Running non-interactively

Several commands prompt on a TTY. As an agent you usually want no prompts. Either set `CI=1` in the environment for the commands below, or rely on the fact that agentmemory skips all prompts automatically when stdin/stdout are not a TTY. Prompts are also never-nag: once answered they persist and are not asked again. Re-run onboarding any time with `agentmemory --reset`.

## 1. Clone, build, and link

This fork is not published to npm, so there is nothing to install from a registry. Build it from source:

```bash
git clone https://github.com/possiblyneal/agentmemory-sqlite.git
cd agentmemory-sqlite
npm install --legacy-peer-deps
npm run build
npm link
```

`npm link` puts `agentmemory` on your `PATH`. If it fails with `EACCES` on a system Node install (macOS/Linux), point npm at a writable prefix (`npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to `PATH`), then re-run `npm link`.

No-link alternative: skip `npm link` and run `node dist/cli.mjs` from the clone everywhere this runbook says `agentmemory`.

Expect: each command completes without errors.

## 2. Verify the install

```bash
agentmemory --version
```

Expect: a version string is printed. If `command not found`, the linked bin is not on `PATH`; use the `node dist/cli.mjs` form from the clone instead.

## 3. Start the server

The server listens on port 3111. Run it in the background or in a separate terminal so the rest of the runbook can talk to it.

```bash
agentmemory &
```

Or run `agentmemory` in the foreground in a dedicated terminal.

Wait until it is reachable, then continue:

```bash
curl -fsS http://localhost:3111/agentmemory/livez
```

Expect: a `200` response. Retry for a few seconds on first run while the database is created and the index is built.

## 4. Prove recall in one command

```bash
agentmemory demo --serve
```

`--serve` boots the server, seeds three realistic sessions (JWT auth, an N+1 query fix, rate limiting), runs semantic searches against them, prints the results, and tears everything down. No second terminal needed.

Expect: the demo finds the "N+1 query fix" memory when it searches for "database performance optimization", which keyword matching alone cannot do. Open `http://localhost:3113` while it runs to watch the memory build live.

## 5. Wire MCP into the calling agent

Detect which agent is running this runbook, then wire its MCP config:

```bash
agentmemory connect <agent>
```

`connect` merges agentmemory into that agent's MCP config and preserves any existing servers. Supported agent names:

`claude-code`, `copilot-cli`, `gemini-cli`, `opencode`, `cline`, `continue`, `droid`, `hermes`, `openclaw`, `openhuman`, `pi`, `qwen`, `warp`, `zed`, `antigravity`, `kiro`.

If you cannot tell which agent you are, default to `claude-code`. After wiring, restart the agent or run its MCP reload command (for example `/mcp` in Claude Code) so it picks up the server.

Expect: the agent now lists agentmemory's tools. With the server running you should see the full set of 54 tools (for example `memory_save`, `memory_smart_search`, `memory_sessions`). If you see only 7 tools, the MCP shim could not reach a server, see Troubleshooting.

## 6. Install native skills

```bash
npx skills add possiblyneal/agentmemory-sqlite -y
```

This installs the native skills so the agent knows when to call the memory tools, not just that they exist. `connect` makes the tools available; skills teach the agent when to use them.

Expect: the skills are installed for the detected agent.

## 7. Verify a save and recall round-trip

Confirm health first:

```bash
curl -fsS http://localhost:3111/agentmemory/health
```

Expect: a JSON body with an ok status.

Now write a memory and read it back. If MCP is wired, call the `memory_save` tool followed by `memory_smart_search`. Otherwise use REST directly (note: these are the REST paths, which differ from the MCP tool names):

```bash
curl -X POST http://localhost:3111/agentmemory/remember \
  -H "Content-Type: application/json" \
  -d '{"content":"agentmemory install verification probe","concepts":["install-check"]}'

curl -X POST http://localhost:3111/agentmemory/smart-search \
  -H "Content-Type: application/json" \
  -d '{"query":"install verification probe","limit":5}'
```

Expect: the first call returns `201`, the second returns `200` with results that include the probe memory you just saved.

If `AGENTMEMORY_SECRET` is set in the environment, the REST API requires it. Add `-H "Authorization: Bearer $AGENTMEMORY_SECRET"` to both calls. By default no secret is set and localhost is open.

## Optional: richer features

These are off by default because they spend tokens. Enable them only if the user wants them. Put configuration in `~/.agentmemory/.env` (no `export` prefix), then restart the server.

- `AGENTMEMORY_INJECT_CONTEXT=true` makes the SessionStart and PreToolUse hooks inject past memory into the agent's context automatically. Cost: spends session tokens proportional to tool-call frequency.
- `AGENTMEMORY_AUTO_COMPRESS=true` sends each observation to your LLM provider for a richer summary. Cost: spends API tokens proportional to tool-use frequency. Requires a provider key.
- Provider key: set one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, and similar, in the same file. Without a key, agentmemory stays in zero-LLM mode and still indexes and recalls via BM25 plus local embeddings.

## Tool surface

The MCP server exposes 54 tools by default (`--tools all`). Use `--tools core` (or `AGENTMEMORY_TOOLS=core`) for a lean 8-tool set on hosts with tight tool limits. The 8 core tools cover save, recall, consolidate, smart search, sessions, diagnose, lesson save, and reflect.

## Lifecycle commands

- `agentmemory status` shows connection status, memory count, flags, and health.
- `agentmemory doctor` runs diagnostics and reports what is misconfigured.
- `agentmemory stop` stops the daemon this CLI started (`stop --force` also signals whatever holds the REST port when the pidfile is gone).
- `agentmemory upgrade` refreshes JavaScript dependencies in the current directory, best effort.
- `agentmemory --reset` wipes onboarding preferences and re-runs the wizard.
- `agentmemory import-jsonl <file>` imports prior Claude Code session logs as memories.

## Troubleshooting

- `command not found: agentmemory`: the linked bin is not on `PATH`. Run `node dist/cli.mjs` from the clone instead.
- `EACCES` during `npm link`: set a writable npm prefix (`npm config set prefix ~/.npm-global`), or use the `node dist/cli.mjs` form.
- Stale build after a `git pull`: re-run `npm install --legacy-peer-deps && npm run build`.
- Port already in use: another process holds 3111, 3112, or 3113. Stop that process, or start with `--port <N>` to move all three at once.
- Server starts but `livez` never returns 200: re-run with `agentmemory --verbose` to see the boot log.
- Only 7 tools visible in the agent: the MCP shim is in local fallback because it could not reach a server. Start `agentmemory` and ensure `AGENTMEMORY_URL` points at it (default `http://localhost:3111`), then reload MCP.
- Windows: the server runs natively, but `connect` has no Windows adapters. Wire the agent's MCP config by hand, or use WSL2.

## Report success

Report back to the user:

- agentmemory installed, version, and the server running on port 3111
- which agent was wired via `agentmemory connect`, and the tool count the agent now sees
- the save and recall round-trip returned the probe memory
- the viewer is available at `http://localhost:3113`
- whether any optional features were enabled

If any step failed, report which step, the exact command, and the error output.
