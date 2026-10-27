import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { renderInput, type OperatorInput } from "./decision-inputs.js";
import { isTerse } from "./replay-answer-key.js";
import type { ReplaySession } from "./replay-transcript.js";

export type Complete = (system: string, user: string) => Promise<string>;

export interface Decision {
  id: string;
  sessionId: string;
  project: string;
  source: "typed" | "ask";
  text: string;
}

// A typed prompt and the earlier-Session decisions that bear on it.
export interface Expected {
  sessionId: string;
  turn: number;
  decisionIds: string[];
}

export interface DecisionKey {
  version: 1;
  builtAt: string;
  decisions: Decision[];
  expected: Expected[];
}

export interface KeyedSession {
  session: ReplaySession;
  inputs: OperatorInput[];
}

const EXTRACT_CHUNK = 40;
const LABEL_CHUNK = 20;
// Prompts past replay's default --max-prompts are never probed.
const LABEL_TURNS = 40;
// The newest earlier decisions of a project; older ones fall out of the label prompt.
const MAX_CANDIDATES = 100;
const ATTEMPTS = 2;
const CONCURRENCY = 4;

const EXTRACT_SYSTEM = `You read what a software Operator said to their coding Agent: prompts they typed and answers they gave to the Agent's multiple-choice questions.
List the decisions the Operator made: a durable choice, rule, preference, constraint or direction that should still hold in later work.
Not decisions: one-off task requests, questions, status remarks, approvals such as "yes" or "go ahead" with no content of their own.
Write each decision as one self-contained sentence a later reader can apply without the transcript.
Reply with JSON only: {"decisions":[{"input":<number of the input it came from>,"decision":"<sentence>"}]}. Reply {"decisions":[]} when there are none.`;

const LABEL_SYSTEM = `You match an Operator's new prompts to their earlier decisions.
For each prompt, list the ids of earlier decisions that bear on it: a decision the Agent must know to do what the prompt asks, or that the prompt would contradict or revisit if the Agent did not know it.
Be strict: shared topic alone is not enough. A prompt with no such decision gets an empty list.
Reply with JSON only: {"prompts":[{"prompt":<number>,"decisions":["<id>", ...]}]}.`;

function parseJsonObject(reply: string): Record<string, unknown> {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("reply holds no JSON object");
  return JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
}

async function askJson(complete: Complete, system: string, user: string): Promise<Record<string, unknown>> {
  let last: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      return parseJsonObject(await complete(system, user));
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`LLM call failed ${ATTEMPTS} times: ${last instanceof Error ? last.message : String(last)}`);
}

async function mapPool<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await run(items[i]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function chunks<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
}

async function extractDecisions(entry: KeyedSession, complete: Complete): Promise<Decision[]> {
  const { session, inputs } = entry;
  const found: Decision[] = [];
  for (const [c, slice] of chunks(inputs, EXTRACT_CHUNK).entries()) {
    const offset = c * EXTRACT_CHUNK;
    const reply = await askJson(complete, EXTRACT_SYSTEM, slice.map((input, i) => renderInput(i + 1, input)).join("\n\n"));
    const list = Array.isArray(reply.decisions) ? reply.decisions : [];
    for (const d of list as Array<Record<string, unknown>>) {
      const n = Number(d?.input);
      const input = Number.isInteger(n) ? slice[n - 1] : undefined;
      if (!input || typeof d.decision !== "string" || d.decision.trim() === "") continue;
      found.push({
        id: `${session.id.slice(0, 8)}.${offset + n}.${found.length}`,
        sessionId: session.id,
        project: session.project,
        source: input.kind,
        text: d.decision.trim(),
      });
    }
  }
  return found;
}

async function labelPrompts(
  session: ReplaySession,
  candidates: Decision[],
  complete: Complete,
): Promise<Expected[]> {
  const prompts = session.userTurns.filter((t) => t.turn <= LABEL_TURNS && !isTerse(t.text));
  if (candidates.length === 0 || prompts.length === 0) return [];
  const known = new Set(candidates.map((d) => d.id));
  const list = candidates.map((d) => `${d.id}: ${d.text}`).join("\n");
  const out: Expected[] = [];
  for (const slice of chunks(prompts, LABEL_CHUNK)) {
    const user = `Earlier decisions:\n${list}\n\nNew prompts:\n${slice.map((t) => `[${t.turn}] ${t.text.slice(0, 1500)}`).join("\n\n")}`;
    const reply = await askJson(complete, LABEL_SYSTEM, user);
    for (const p of (Array.isArray(reply.prompts) ? reply.prompts : []) as Array<Record<string, unknown>>) {
      const turn = Number(p?.prompt);
      const ids = Array.isArray(p?.decisions) ? [...new Set((p.decisions as unknown[]).filter((id): id is string => typeof id === "string" && known.has(id)))] : [];
      if (slice.some((t) => t.turn === turn) && ids.length > 0) out.push({ sessionId: session.id, turn, decisionIds: ids });
    }
  }
  return out;
}

export async function buildDecisionKey(entries: KeyedSession[], complete: Complete, now = new Date()): Promise<DecisionKey> {
  const extracted = await mapPool(entries, CONCURRENCY, (entry) => extractDecisions(entry, complete));
  const decisions = extracted.flat();
  const bySession = new Map(entries.map((e, i) => [e.session.id, extracted[i]]));
  const labelled = await mapPool(entries, CONCURRENCY, (entry) => {
    const { session } = entry;
    const earlier = entries
      .filter((e) => e.session.project === session.project && e.session.startedAt < session.startedAt)
      .flatMap((e) => bySession.get(e.session.id) ?? []);
    return labelPrompts(session, earlier.slice(-MAX_CANDIDATES), complete);
  });
  return { version: 1, builtAt: now.toISOString(), decisions, expected: labelled.flat() };
}

// Frozen once: a rerun reads the file and spends no LLM call unless rebuilt.
export async function loadOrBuildKey(
  path: string,
  rebuild: boolean,
  build: () => Promise<DecisionKey>,
): Promise<{ key: DecisionKey; reused: boolean }> {
  if (!rebuild && existsSync(path)) return { key: JSON.parse(readFileSync(path, "utf8")) as DecisionKey, reused: true };
  const key = await build();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(key, null, 2));
  return { key, reused: false };
}

export function readDecisionKey(path: string): DecisionKey {
  if (!existsSync(path)) throw new Error(`no decision key at ${path}; run \`npm run eval:decision-key -- --projects=...\` first`);
  return JSON.parse(readFileSync(path, "utf8")) as DecisionKey;
}
