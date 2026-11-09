// Shared by the prompt-submit hook's reply reader and the replay eval, so the
// hook stops at the same Operator turns the eval measured.
export const CONTINUATION_SUMMARY = /^This session is being continued from a previous conversation/;

// Turns the Operator did not type as a request: slash-command wrappers, shell
// escapes and their output, interrupts, a loaded skill's body, a compaction
// summary, and a message relayed from another Session.
const NOT_A_HUMAN_TURN = [
  /^<command-(name|message|args)>/,
  /^<local-command-/,
  /^<bash-(input|stdout|stderr)>/,
  /^\[Request interrupted/,
  /^Caveat:/,
  /^Base directory for this skill:/,
  CONTINUATION_SUMMARY,
  /^Another Claude session sent a message:\s*<teammate-message[\s>]/,
];
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

export function isOperatorTurn(prompt: string): boolean {
  return !NOT_A_HUMAN_TURN.some((re) => re.test(prompt)) && prompt.replace(SYSTEM_REMINDER, "").trim() !== "";
}

