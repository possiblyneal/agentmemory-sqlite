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

// "2023/05/20 (Sat) 02:21" -> "2023-05-20T02:21:00.000Z"
function haystackTimestamp(date: string | undefined): string | undefined {
  const m = date?.match(/^(\d{4})\/(\d{2})\/(\d{2})\b.*?(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const time = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`);
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
