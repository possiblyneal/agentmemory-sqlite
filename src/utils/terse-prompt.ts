// The terse-prompt rule shared by prompt-submit Injection and the replay eval
// that measured it (#310): a prompt like "yes", "go ahead" or "2" names too
// little to search on by itself.
const STOPWORDS = new Set(
  (
    "the and for that this with you your are was were have has had not but can could would should " +
    "will just from they them then than into about what when where which while there their here " +
    "also its our out all any more some been being does did doing done get got make made use using " +
    "please want need like let's lets one two now still"
  ).split(" "),
);

const TERSE_BELOW_TOKENS = 3;

// How much of the Agent's last reply a terse prompt's query carries: its end.
export const MAX_REPLY_QUERY_CHARS = 1000;

export function contentTokens(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9][a-z0-9_./-]*[a-z0-9]|[a-z0-9]/g) ?? [];
  return new Set(tokens.filter((t) => t.length >= 3 && !STOPWORDS.has(t)));
}

export function isTersePrompt(text: string): boolean {
  return contentTokens(text).size < TERSE_BELOW_TOKENS;
}
