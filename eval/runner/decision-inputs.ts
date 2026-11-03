import type { ReplaySession } from "./replay-transcript.js";

export interface AskQuestion {
  question: string;
  options: string[];
}

// What the Operator said or chose in a Session. Nothing else reaches the
// decision extractor: not Agent prose, Harness Messages or compaction
// summaries (replay-transcript already drops those from userTurns), and an
// AskUserQuestion contributes only its questions, their options and the
// Operator's answer.
export type OperatorInput =
  | { kind: "typed"; turn: number; text: string }
  | { kind: "ask"; afterTurn: number; questions: AskQuestion[]; answer: string };

interface PendingAsk {
  questions: AskQuestion[];
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function askQuestions(input: unknown): AskQuestion[] {
  const raw = asObject(input)?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((q) => {
    const o = asObject(q);
    if (!o || typeof o.question !== "string") return [];
    const options = Array.isArray(o.options)
      ? o.options.flatMap((opt) => {
          const label = asObject(opt)?.label;
          return typeof label === "string" ? [label] : [];
        })
      : [];
    return [{ question: o.question, options }];
  });
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (typeof asObject(b)?.text === "string" ? (asObject(b)!.text as string) : "")).join("\n");
}

function asks(jsonl: string, session: ReplaySession): OperatorInput[] {
  const pending = new Map<string, PendingAsk>();
  const out: OperatorInput[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.isSidechain === true) continue;
    const content = asObject(entry.message)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = asObject(block);
      if (!b) continue;
      if (b.type === "tool_use" && b.name === "AskUserQuestion" && typeof b.id === "string") {
        pending.set(b.id, { questions: askQuestions(b.input) });
      } else if (b.type === "tool_result" && typeof b.tool_use_id === "string" && b.is_error !== true) {
        const ask = pending.get(b.tool_use_id);
        const answer = resultText(b.content).trim();
        if (!ask || ask.questions.length === 0 || answer === "") continue;
        const at = typeof entry.timestamp === "string" ? entry.timestamp : "";
        const afterTurn = session.userTurns.filter((t) => t.timestamp <= at).length;
        out.push({ kind: "ask", afterTurn, questions: ask.questions, answer });
      }
    }
  }
  return out;
}

// Typed turns and answered questions in the order the Operator gave them.
export function operatorInputs(jsonl: string, session: ReplaySession): OperatorInput[] {
  const answered = asks(jsonl, session);
  const out: OperatorInput[] = answered.filter((a) => a.kind === "ask" && a.afterTurn === 0);
  for (const t of session.userTurns) {
    out.push({ kind: "typed", turn: t.turn, text: t.text });
    out.push(...answered.filter((a) => a.kind === "ask" && a.afterTurn === t.turn));
  }
  return out;
}

const MAX_INPUT_CHARS = 1500;

const clip = (text: string): string => (text.length > MAX_INPUT_CHARS ? `${text.slice(0, MAX_INPUT_CHARS)}…` : text);

export function renderInput(n: number, input: OperatorInput): string {
  if (input.kind === "typed") return `[${n}] Operator typed: ${clip(input.text)}`;
  const questions = input.questions.map((q) => `${q.question} (options: ${q.options.join(" | ")})`).join("\n");
  return `[${n}] Operator was asked:\n${clip(questions)}\nOperator answered: ${clip(input.answer)}`;
}
