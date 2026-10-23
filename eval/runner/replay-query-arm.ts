// Query arms (#310): what the prompt-context probe sends as `prompt`. The
// smart-search baseline always keeps the raw prompt. Every arm adds text to the
// prompt, never replaces it, and `control` adds nothing.
export const QUERY_ARMS = ["control", "reply-tail", "reply-head", "reply-last", "reply-terms", "prev-prompt"] as const;
export type QueryArm = (typeof QUERY_ARMS)[number];

export interface QueryArmOptions {
  arm: QueryArm;
  chars: number;
  scale: number;
}

export interface QueryContext {
  prompt: string;
  // Text blocks of the Agent's last reply before this prompt; "" when none.
  reply: string;
  // The previous Operator-typed prompt of the Session; "" for the first.
  prevPrompt: string;
}

export function isQueryArm(value: string): value is QueryArm {
  return (QUERY_ARMS as readonly string[]).includes(value);
}

// A fixed N, or N shrunk by K per prompt character so a long prompt brings
// little or no added context.
export function queryCap(prompt: string, chars: number, scale: number): number {
  return scale > 0 ? Math.max(0, chars - scale * prompt.length) : chars;
}

const FILE_EXTENSIONS = "tsx?|jsx?|mjs|cjs|json|md|ya?ml|sh|py|css|html|sql|toml|ndjson|jsonl";
const TERM = new RegExp(
  [
    `(?:[\\w.-]+\\/)+[\\w-]+\\.\\w+`,
    `\\b[\\w-]+\\.(?:${FILE_EXTENSIONS})\\b`,
    `\\b\\w+(?:::[\\w-]+)+`,
    `\\b[A-Za-z_]\\w+(?:\\.[A-Za-z_]\\w+)+\\b`,
    `\\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\\b`,
    `\\b(?:[A-Z][a-z0-9]+){2,}\\b`,
    `\\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+\\b`,
    `(?<![\\w&])#\\d+\\b`,
  ].join("|"),
  "g",
);

export function extractReplyTerms(text: string): string[] {
  return [...new Set(text.match(TERM) ?? [])];
}

function lastParagraphOrQuestion(reply: string): string {
  const paragraphs = reply.trim().split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1].trim();
  if (!last.endsWith("?")) return last;
  const sentences = last.split(/(?<=[.!?])\s+/);
  return sentences[sentences.length - 1];
}

function termsWithin(reply: string, cap: number): string {
  let out = "";
  for (const term of extractReplyTerms(reply)) {
    const next = out ? `${out} ${term}` : term;
    if (next.length > cap) break;
    out = next;
  }
  return out;
}

function addition(arm: QueryArm, ctx: QueryContext, cap: number): string {
  switch (arm) {
    case "control":
      return "";
    case "reply-tail":
      return ctx.reply.trim().slice(-cap);
    case "reply-head":
      return ctx.reply.trim().slice(0, cap);
    case "reply-last":
      return lastParagraphOrQuestion(ctx.reply).slice(0, cap);
    case "reply-terms":
      return termsWithin(ctx.reply, cap);
    case "prev-prompt":
      return ctx.prevPrompt.trim().slice(0, cap);
  }
}

export function composeQuery(arm: QueryArm, ctx: QueryContext, chars: number, scale: number): string {
  const cap = queryCap(ctx.prompt, chars, scale);
  if (arm === "control" || cap <= 0) return ctx.prompt;
  const extra = addition(arm, ctx, cap).trim();
  return extra ? `${ctx.prompt}\n${extra}` : ctx.prompt;
}
