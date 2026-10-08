import { describe, it, expect } from "vitest";
import { isReadOnlyObservation } from "../src/functions/observe.js";
import type { RawObservation } from "../src/types.js";

function toolCall(
  toolName: string,
  toolInput: unknown,
  overrides: Partial<RawObservation> = {},
): RawObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: "2026-10-08T00:00:00.000Z",
    hookType: "post_tool_use",
    toolName,
    toolInput,
    toolOutput: { stdout: "out", stderr: "", interrupted: false },
    raw: {},
    ...overrides,
  };
}

const bash = (command: string) => toolCall("Bash", { command });

describe("isReadOnlyObservation", () => {
  const readOnly: Array<[string, RawObservation]> = [
    ["Read", toolCall("Read", { file_path: "src/a.ts" })],
    ["Grep", toolCall("Grep", { pattern: "foo" })],
    ["Glob", toolCall("Glob", { pattern: "**/*.ts" })],
    ["ToolSearch", toolCall("ToolSearch", { query: "select:Read" })],
    ["ListAgents", toolCall("ListAgents", {})],
    ["TaskList", toolCall("TaskList", {})],
    ["sed -n", bash("sed -n '1,40p' src/a.ts")],
    ["grep with quoted alternation", bash('grep -rn "foo\\|bar" src | head -20')],
    ["rg with a pipe in single quotes", bash("rg 'a|b' src")],
    ["cd then git status", bash("cd /repo && git status")],
    ["git log | head", bash("git log --oneline -5 | head")],
    ["git -C diff", bash("git -C /repo diff --stat")],
    ["git branch listing", bash("git branch -a")],
    ["stderr to /dev/null", bash("ls missing 2>/dev/null; wc -l a.ts b.ts")],
    ["2>&1", bash("cat a.ts 2>&1 | tail -5")],
    ["find without -exec", bash("find . -name '*.ts' -type f")],
    ["jq", bash("jq '.version' package.json")],
    ["absolute path to cat", bash("/usr/bin/cat a.ts")],
    ["echo", bash('echo "--- done"')],
    ["sort | uniq -c", bash("grep -o foo a | sort | uniq -c")],
  ];

  const notReadOnly: Array<[string, RawObservation]> = [
    ["Edit", toolCall("Edit", { file_path: "a.ts" })],
    ["Write", toolCall("Write", { file_path: "a.ts" })],
    ["WebFetch", toolCall("WebFetch", { url: "https://x" })],
    ["Agent", toolCall("Agent", { prompt: "go" })],
    ["AskUserQuestion", toolCall("AskUserQuestion", {})],
    ["unknown tool", toolCall("SomeTool", {})],
    ["failure hook", toolCall("Read", { file_path: "a.ts" }, { hookType: "post_tool_failure" })],
    ["prompt_submit", { ...toolCall("Read", {}), hookType: "prompt_submit", toolName: undefined, userPrompt: "hi" }],
    ["subagent_stop", { ...toolCall("Read", {}), hookType: "subagent_stop", toolName: undefined }],
    ["stderr output", toolCall("Bash", { command: "cat a" }, { toolOutput: { stdout: "", stderr: "No such file" } })],
    ["stderr in truncated string output", toolCall("Bash", { command: "cat a" }, { toolOutput: '{"stdout":"x","stderr":"boom"...[truncated]' })],
    ["interrupted", toolCall("Bash", { command: "cat a" }, { toolOutput: { stdout: "", interrupted: true } })],
    ["redirect to a file", bash("cat a.ts > b.ts")],
    ["append to a file", bash("echo x >> notes.md")],
    ["sed -i", bash("sed -i 's/a/b/' a.ts")],
    ["sed -ni", bash("sed -ni 's/a/b/p' a.ts")],
    ["find -delete", bash("find . -name '*.tmp' -delete")],
    ["find -exec", bash("find . -name x -exec rm {} \\;")],
    ["sort -o", bash("sort -o out.txt in.txt")],
    ["uniq writing a file", bash("uniq in.txt out.txt")],
    ["one write in a chain", bash("git status && npm test")],
    ["rm after a pipe", bash("ls | xargs rm")],
    ["command substitution", bash("cat $(git ls-files)")],
    ["backticks", bash("cat `which node`")],
    ["process substitution", bash("diff <(ls a) <(ls b)")],
    ["git commit", bash("git commit -m 'x'")],
    ["git branch create", bash("git branch feature")],
    ["git branch delete", bash("git branch -D feature")],
    ["git diff --output", bash("git diff --output=patch.diff")],
    ["git checkout", bash("git checkout main")],
    ["unterminated quote", bash("grep 'foo src")],
    ["empty command", bash("")],
    ["no command", toolCall("Bash", {})],
    ["Object prototype name", bash("toString a")],
  ];

  it.each(readOnly)("%s is read-only", (_label, raw) => {
    expect(isReadOnlyObservation(raw)).toBe(true);
  });

  it.each(notReadOnly)("%s stays on the LLM path", (_label, raw) => {
    expect(isReadOnlyObservation(raw)).toBe(false);
  });
});
