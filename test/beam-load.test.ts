import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatIds, loadBeam, parsePythonLiteral } from "../eval/runner/beam-load.js";

const dirs: string[] = [];

function writePage(rows: unknown[]): string {
  mkdirSync(join(process.cwd(), "tmp"), { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp", "beam-load-"));
  dirs.push(dir);
  const path = join(dir, "100K.json");
  writeFileSync(path, JSON.stringify({ rows: rows.map((row) => ({ row })) }));
  return path;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const msg = (id: number, role: string, content: string, anchor: string | null = null) => ({
  id,
  role,
  content,
  time_anchor: anchor,
});

// Two batches of two Turns each: chat ids 0-3 and 4-7.
const chat = [
  [
    msg(0, "user", "I use Redis for caching ->-> 1,1", "March-15-2024"),
    msg(1, "assistant", "Redis is a fine cache."),
    msg(2, "user", "Add a Flask route"),
    msg(3, "assistant", "Done."),
  ],
  [
    msg(4, "user", "I switched to Memcached", "April-02-2024"),
    msg(5, "assistant", "Noted."),
    msg(6, "user", "What did I pick?"),
    msg(7, "assistant", "Memcached."),
  ],
];

const probes = `{'abstention': [{'question': 'Unanswerable?', 'ideal_response': 'none'}],
 'information_extraction': [{'question': "What do I use for caching?", 'source_chat_ids': [0]}],
 'knowledge_update': [{'question': 'Which cache now?', 'source_chat_ids': {'original_info': [0], 'updated_info': [4, 5]}}],
 'event_ordering': [{'question': 'Order?', 'source_chat_ids': [2, 3, 6]}],
 'summarization': [{'question': 'Summarise?'}]}`;

const fixture = [{ conversation_id: "c1", chat, probing_questions: probes }];

describe("parsePythonLiteral", () => {
  it("reads dicts, lists, mixed quotes, escapes, numbers and the Python constants", () => {
    expect(
      parsePythonLiteral(`{'a': [1, -2.5, True, None, False], "b": 'it\\'s', 'c': ("x", 'y\\n'), 'd': {}}`),
    ).toEqual({ a: [1, -2.5, true, null, false], b: "it's", c: ["x", "y\n"], d: {} });
  });

  it("rejects text that is not a single literal", () => {
    expect(() => parsePythonLiteral("{'a': 1} junk")).toThrow(/trailing/);
    expect(() => parsePythonLiteral("{'a': oops}")).toThrow(/unexpected/);
  });
});

describe("chatIds", () => {
  it("flattens a list, a dict of lists and nested lists, and ignores everything else", () => {
    expect(chatIds([1, 2])).toEqual(["1", "2"]);
    expect(chatIds({ first_event: [62], second_event: [230] })).toEqual(["62", "230"]);
    expect(chatIds([[3, 4], "5", "chat_id: 6", null, 1.5])).toEqual(["3", "4", "5"]);
    expect(chatIds(undefined)).toEqual([]);
  });
});

describe("loadBeam", () => {
  it("makes one Session per user Turn, dated by its batch's time anchor, with the plan marker stripped", () => {
    const { questions } = loadBeam(writePage(fixture), "100K");
    const haystack = questions[0].haystack;
    expect(haystack.map((s) => s.id)).toEqual(["t0", "t2", "t4", "t6"]);
    expect(haystack[0].content).toBe("[user] I use Redis for caching\n\n[assistant] Redis is a fine cache.");
    expect(haystack.map((s) => s.timestamp)).toEqual([
      new Date(2024, 2, 15, 9, 0).toISOString(),
      new Date(2024, 2, 15, 9, 1).toISOString(),
      new Date(2024, 3, 2, 9, 0).toISOString(),
      new Date(2024, 3, 2, 9, 1).toISOString(),
    ]);
  });

  it("maps source_chat_ids to the Turns holding those messages, once each", () => {
    const { questions } = loadBeam(writePage(fixture), "100K");
    const gold = Object.fromEntries(questions.map((q) => [q.type, q.goldSessionIds]));
    expect(gold.information_extraction).toEqual(["t0"]);
    expect(gold.knowledge_update).toEqual(["t0", "t4"]);
    expect(gold.event_ordering).toEqual(["t2", "t6"]);
  });

  it("types each Question by its ability and ids it by split, conversation, ability and position", () => {
    const { questions } = loadBeam(writePage(fixture), "100K");
    expect(questions.map((q) => [q.id, q.type, q.question])).toEqual([
      ["100K/c1/information_extraction/0", "information_extraction", "What do I use for caching?"],
      ["100K/c1/knowledge_update/0", "knowledge_update", "Which cache now?"],
      ["100K/c1/event_ordering/0", "event_ordering", "Order?"],
    ]);
  });

  it("skips abstention and a probe with no source_chat_ids, and counts both", () => {
    const { questions, skipped } = loadBeam(writePage(fixture), "100K");
    expect(questions.map((q) => q.type)).not.toContain("abstention");
    expect(questions.map((q) => q.type)).not.toContain("summarization");
    expect(skipped).toEqual({ abstention: 1, noGold: 1 });
  });

  it("shares one haystack array across a conversation's Questions", () => {
    const { questions } = loadBeam(writePage(fixture), "100K");
    expect(new Set(questions.map((q) => q.haystack)).size).toBe(1);
  });

  it("refuses a chat id that is not in the chat", () => {
    const bad = [{ ...fixture[0], probing_questions: "{'information_extraction': [{'question': 'q', 'source_chat_ids': [99]}]}" }];
    expect(() => loadBeam(writePage(bad), "100K")).toThrow(/chat id 99/);
  });
});
