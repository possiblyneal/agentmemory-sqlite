---
name: agentmemory-agents
description: How agentmemory wires into Claude Code, the only supported host agent, through the marketplace plugin or the connect command. Use when installing agentmemory, when asked which agents are supported, or when the MCP server is missing from Claude Code.
user-invocable: false
---

Claude Code is the only supported host. The marketplace plugin is the full install: it registers the MCP server, the lifecycle hooks, and the skills in one step.

## Quick start

```bash
/plugin marketplace add possiblyneal/agentmemory-sqlite
/plugin install agentmemory
```

Restart the session, then confirm Claude Code lists agentmemory's tools under `/mcp`.

## Workflow

1. Prefer the plugin. It is the only path that installs the hooks, so it is the only path that captures memory automatically.
2. Without the plugin, `agentmemory connect` merges the MCP server into `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when that is set), backs the file up first and preserves any existing servers. It wires tools only: no hooks, no skills. `--dry-run` previews the change and `--force` rewrites an existing entry.
3. Verify: with a server running, Claude Code shows the full tool set. Only 7 tools means the MCP shim could not reach a server (see ../_shared/TROUBLESHOOTING.md).

## Notes

- Other agents are not supported. `connect` rejects any agent name other than `claude-code`, and the plugin ships no hook manifest for them.
- Windows: use WSL2. Native Windows runs the server but `connect` is not supported there.

## See also

- agentmemory-hooks, agentmemory-mcp-tools, agentmemory-rest-api.

## Reference

The `connect` flags live in REFERENCE.md, generated from `src/cli/connect/index.ts`.
