import { readFileSync } from "node:fs";
import type { Question, Session } from "./types.js";

interface LongMemEvalRaw {
  question_id: string;
  question_type: string;
  question: string;
  answer?: string;
  answer_session_ids: string[];
  haystack_session_ids: string[];
  haystack_sessions: Array<Array<{ role: string; content: string }>>;
  haystack_dates?: string[];
}

function haystackTimestamp(date: string | undefined): string | undefined {
  const m = date?.match(/^(\d{4})\/(\d{2})\/(\d{2})\b.*?(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  const time = new Date(year, month - 1, day, hour, minute);
  return Number.isNaN(time.getTime()) ? undefined : time.toISOString();
}

function flattenSession(turns: Array<{ role: string; content: string }>): string {
  return turns.map((t) => `[${t.role}] ${t.content}`).join("\n\n");
}

export function loadLongMemEval(path: string, limit?: number): Question[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as LongMemEvalRaw[];
  const slice = typeof limit === "number" ? raw.slice(0, limit) : raw;
  const questions: Question[] = [];
  for (const r of slice) {
    if (r.haystack_session_ids.length !== r.haystack_sessions.length) {
      throw new Error(
        `LongMemEval row ${r.question_id}: haystack_session_ids (${r.haystack_session_ids.length}) and haystack_sessions (${r.haystack_sessions.length}) length mismatch`,
      );
    }
    // _s ships some empty haystack Sessions (never gold); /remember rejects them.
    const haystack: Session[] = r.haystack_session_ids
      .map((id, i) => ({
        id,
        content: flattenSession(r.haystack_sessions[i]),
        timestamp: haystackTimestamp(r.haystack_dates?.[i]),
      }))
      .filter((s) => s.content);
    questions.push({
      id: r.question_id,
      type: r.question_type,
      question: r.question,
      answer: r.answer,
      goldSessionIds: r.answer_session_ids,
      haystack,
    });
  }
  return questions;
}

export function stratifySample(questions: Question[], perType: number): Question[] {
  const buckets: Record<string, Question[]> = {};
  for (const q of questions) {
    (buckets[q.type] ??= []).push(q);
  }
  const out: Question[] = [];
  for (const type of Object.keys(buckets).sort()) {
    out.push(...buckets[type].slice(0, perType));
  }
  return out;
}
