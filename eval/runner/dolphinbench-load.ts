import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import type { Question, Session } from "./types.js";

export interface MessageRow {
  persona: string;
  message_id: string;
  date: string;
  content: string;
}

export interface FactRow {
  persona: string;
  fact_id: number | bigint;
  source_message_ids: string[];
}

export interface TestRow {
  persona: string;
  test_id: string;
  request: string;
  required_fact_ids: Array<number | bigint>;
}

export interface DolphinBenchTables {
  messages: MessageRow[];
  facts: FactRow[];
  tests: TestRow[];
}

// A test's gold is every message that established a fact the test requires
// (`facts.source_message_ids`); `related_message_ids` only touch a fact, so
// they are not gold. The haystack is the persona's whole history, one Session
// per message, ingested as a prompt Observation so the prompt-submit path can
// attribute an Injection to it.
export function buildQuestions(tables: DolphinBenchTables): Question[] {
  const haystacks = new Map<string, Session[]>();
  for (const m of tables.messages) {
    const sessions = haystacks.get(m.persona) ?? [];
    haystacks.set(m.persona, sessions);
    if (!m.content) continue;
    sessions.push({
      id: m.message_id,
      timestamp: new Date(m.date).toISOString(),
      observations: [{ tool: "prompt", output: m.content }],
    });
  }
  const sources = new Map<string, string[]>();
  for (const f of tables.facts) sources.set(`${f.persona}:${f.fact_id}`, f.source_message_ids);

  return tables.tests.map((t) => {
    const haystack = haystacks.get(t.persona);
    if (!haystack) throw new Error(`DolphinBench test ${t.persona}/${t.test_id}: no messages for persona`);
    const messageIds = new Set(haystack.map((s) => s.id));
    const gold = new Set<string>();
    for (const factId of t.required_fact_ids) {
      const ids = sources.get(`${t.persona}:${factId}`);
      if (!ids?.length) throw new Error(`DolphinBench test ${t.persona}/${t.test_id}: fact ${factId} has no source messages`);
      for (const id of ids) {
        if (!messageIds.has(id)) throw new Error(`DolphinBench test ${t.persona}/${t.test_id}: fact ${factId} names unknown message ${id}`);
        gold.add(id);
      }
    }
    return {
      id: `${t.persona}-${t.test_id}`,
      type: t.persona,
      question: t.request,
      goldSessionIds: [...gold],
      haystack,
    };
  });
}

async function readTable<T>(dir: string, file: string): Promise<T[]> {
  return (await parquetReadObjects({
    file: await asyncBufferFromFile(join(dir, file)),
    compressors: { ZSTD: (input) => new Uint8Array(zstdDecompressSync(input)) },
  })) as T[];
}

// `dir` is the `mem0ai/dolphinbench` download: messages/, facts/ and tests/.
export async function loadDolphinBench(dir: string): Promise<Question[]> {
  return buildQuestions({
    messages: await readTable<MessageRow>(dir, "messages/train.parquet"),
    facts: await readTable<FactRow>(dir, "facts/train.parquet"),
    tests: await readTable<TestRow>(dir, "tests/test.parquet"),
  });
}
