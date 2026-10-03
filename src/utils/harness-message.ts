// Claude Code delivers background-task results and messages from other
// Sessions as user turns, so UserPromptSubmit fires on them. They are the
// harness speaking, not the Operator, and recalling them later is noise.
const TAGS = "task-notification|teammate-message|cross-session-message|agent-message";
const OPENS_WITH_TAG = new RegExp(`^<(${TAGS})[\\s>]`);
const LEADING_ELEMENT = new RegExp(`^<(${TAGS})[\\s>][\\s\\S]*?</\\1>\\s*`);

export function isHarnessMessage(prompt: string): boolean {
  let rest = prompt.trim();
  if (!OPENS_WITH_TAG.test(rest)) return false;
  for (let m; (m = LEADING_ELEMENT.exec(rest)); ) rest = rest.slice(m[0].length);
  // Operator text after the elements keeps the turn; an element with no
  // closing tag was truncated, not followed by anything.
  return rest === "" || OPENS_WITH_TAG.test(rest);
}

// Claude Code also writes its own background jobs to ~/.claude/projects
// beside real work: a Warmup probe and the conversation-list summary job
// (rohitg00/agentmemory#1064). Import skips a transcript that opens with one.
export function isHarnessPrompt(firstPrompt: string): boolean {
  return (
    firstPrompt === "Warmup" ||
    firstPrompt.startsWith("Context: This summary will be shown in a list")
  );
}
