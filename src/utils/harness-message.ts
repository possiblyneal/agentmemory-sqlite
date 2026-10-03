// Claude Code delivers background-task results and messages from other
// Sessions as user turns, so UserPromptSubmit fires on them. They are the
// harness speaking, not the Operator, and recalling them later is noise.
const HARNESS_MESSAGE = /^\s*<(task-notification|teammate-message|cross-session-message|agent-message)\b/;

export function isHarnessMessage(prompt: string): boolean {
  return HARNESS_MESSAGE.test(prompt);
}
