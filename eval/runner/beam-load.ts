import { readFileSync } from "node:fs";
import type { Question, Session } from "./types.js";

interface BeamMessage {
  id: number | string;
  role: string;
  content: string;
  time_anchor?: string | null;
}

interface BeamRow {
  conversation_id: string;
  chat: BeamMessage[][];
  probing_questions: string;
}

interface BeamPage {
  rows: Array<{ row: BeamRow }>;
}

interface BeamProbe {
  question?: string;
  source_chat_ids?: unknown;
}

export interface BeamLoad {
  questions: Question[];
  skipped: { abstention: number; noGold: number };
}

// The dataset ships `probing_questions` as a Python repr, not JSON.
export function parsePythonLiteral(text: string): unknown {
  let i = 0;
  const fail = (what: string): never => {
    throw new Error(`python literal: ${what} at ${i}`);
  };
  const skipSpace = (): void => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const string = (): string => {
    const quote = text[i++];
    let out = "";
    while (i < text.length && text[i] !== quote) {
      if (text[i] !== "\\") {
        out += text[i++];
        continue;
      }
      const esc = text[i + 1];
      i += 2;
      if (esc === "n") out += "\n";
      else if (esc === "t") out += "\t";
      else if (esc === "r") out += "\r";
      else if (esc === "x") {
        out += String.fromCharCode(parseInt(text.slice(i, i + 2), 16));
        i += 2;
      } else if (esc === "u") {
        out += String.fromCharCode(parseInt(text.slice(i, i + 4), 16));
        i += 4;
      } else out += esc;
    }
    if (text[i] !== quote) fail("unterminated string");
    i++;
    return out;
  };
  const sequence = (close: string): unknown[] => {
    i++;
    const items: unknown[] = [];
    for (skipSpace(); text[i] !== close; skipSpace()) {
      items.push(value());
      skipSpace();
      if (text[i] === ",") i++;
      else if (text[i] !== close) fail("expected , or " + close);
    }
    i++;
    return items;
  };
  const dict = (): Record<string, unknown> => {
    i++;
    const out: Record<string, unknown> = {};
    for (skipSpace(); text[i] !== "}"; skipSpace()) {
      const key = String(value());
      skipSpace();
      if (text[i++] !== ":") fail("expected :");
      out[key] = value();
      skipSpace();
      if (text[i] === ",") i++;
      else if (text[i] !== "}") fail("expected , or }");
    }
    i++;
    return out;
  };
  const value = (): unknown => {
    skipSpace();
    const c = text[i];
    if (c === "'" || c === '"') return string();
    if (c === "[") return sequence("]");
    if (c === "(") return sequence(")");
    if (c === "{") return dict();
    const word = /^(?:-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|True|False|None)/.exec(text.slice(i, i + 40))?.[0];
    if (!word) return fail(`unexpected ${JSON.stringify(c)}`);
    i += word.length;
    if (word === "True") return true;
    if (word === "False") return false;
    if (word === "None") return null;
    return Number(word);
  };
  const result = value();
  skipSpace();
  if (i !== text.length) fail("trailing text");
  return result;
}

// Every chat id a probe cites, whatever its shape: a list, or a dict of lists
// keyed by role (original_info/updated_info, first_statement/second_statement).
export function chatIds(value: unknown): string[] {
  if (typeof value === "number" && Number.isInteger(value)) return [String(value)];
  if (typeof value === "string" && /^\d+$/.test(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(chatIds);
  if (value && typeof value === "object") return Object.values(value).flatMap(chatIds);
  return [];
}

// "March-15-2024" -> that day at 09:00 local; a Turn's index spaces it by the minute.
function anchorTimestamp(anchor: string | null | undefined, minute: number): string | undefined {
  const m = anchor?.match(/^([A-Za-z]+)-(\d{1,2})-(\d{4})$/);
  if (!m) return undefined;
  const month = new Date(`${m[1]} 1, 2000`).getMonth();
  if (Number.isNaN(month)) return undefined;
  return new Date(Number(m[3]), month, Number(m[2]), 9, minute).toISOString();
}

// The dataset marks each plan bullet's message with a trailing "->-> 1,3".
function cleanContent(content: string): string {
  return content.replace(/\s*->->\s*\d+(?:,\d+)*\s*$/, "");
}

// A Turn is a user message and the replies to it, so one retrieved unit reads
// as an exchange; a batch of ~60 messages is too coarse for a top-15 cut.
function turnsOf(row: BeamRow): { haystack: Session[]; turnOfChatId: Map<string, string> } {
  const haystack: Session[] = [];
  const turnOfChatId = new Map<string, string>();
  for (const batch of row.chat) {
    const anchor = batch.find((m) => m.time_anchor && m.time_anchor !== "None")?.time_anchor;
    let parts: string[] = [];
    let turnId = "";
    let turnIndex = 0;
    const close = (): void => {
      if (parts.length === 0) return;
      haystack.push({
        id: turnId,
        content: parts.join("\n\n"),
        timestamp: anchorTimestamp(anchor, turnIndex++),
      });
      parts = [];
    };
    for (const m of batch) {
      if (m.role === "user" || parts.length === 0) {
        close();
        turnId = `t${m.id}`;
      }
      turnOfChatId.set(String(m.id), turnId);
      parts.push(`[${m.role}] ${cleanContent(m.content)}`);
    }
    close();
  }
  return { haystack, turnOfChatId };
}

// One BEAM split as a datasets-server `rows` page. Every Question of a
// conversation shares one `haystack` array, which is how the runner knows to
// ingest it once.
export function loadBeam(path: string, split: string): BeamLoad {
  const page = JSON.parse(readFileSync(path, "utf8")) as BeamPage;
  const questions: Question[] = [];
  const skipped = { abstention: 0, noGold: 0 };
  for (const { row } of page.rows) {
    const { haystack, turnOfChatId } = turnsOf(row);
    const probes = parsePythonLiteral(row.probing_questions) as Record<string, BeamProbe[]>;
    for (const [ability, list] of Object.entries(probes)) {
      list.forEach((probe, n) => {
        if (ability === "abstention") {
          skipped.abstention++;
          return;
        }
        const gold = new Set<string>();
        for (const id of chatIds(probe.source_chat_ids)) {
          const turn = turnOfChatId.get(id);
          if (!turn) throw new Error(`BEAM ${row.conversation_id}: ${ability} cites chat id ${id}, which is not in the chat`);
          gold.add(turn);
        }
        if (gold.size === 0 || !probe.question) {
          skipped.noGold++;
          return;
        }
        questions.push({
          id: `${split}/${row.conversation_id}/${ability}/${n}`,
          type: ability,
          question: probe.question,
          goldSessionIds: [...gold],
          haystack,
        });
      });
    }
  }
  return { questions, skipped };
}
