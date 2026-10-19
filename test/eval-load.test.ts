import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadLongMemEval } from "../eval/runner/load.js";

const dirs: string[] = [];

function write(rows: unknown[]): string {
  mkdirSync(join(process.cwd(), "tmp"), { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp", "lme-load-"));
  dirs.push(dir);
  const path = join(dir, "longmemeval_s.json");
  writeFileSync(path, JSON.stringify(rows));
  return path;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const turn = (content: string) => [{ role: "user", content }];

describe("loadLongMemEval haystack dates", () => {
  it("carries each haystack date onto its Session as an ISO timestamp", () => {
    const [q] = loadLongMemEval(
      write([
        {
          question_id: "q1",
          question_type: "t",
          question: "?",
          answer_session_ids: ["s2"],
          haystack_session_ids: ["s1", "s2"],
          haystack_sessions: [turn("one"), turn("two")],
          haystack_dates: ["2023/05/20 (Sat) 02:21", "2023/05/21 (Sun) 23:59"],
        },
      ]),
    );
    expect(q.haystack.map((s) => s.timestamp)).toEqual([
      "2023-05-20T02:21:00.000Z",
      "2023-05-21T23:59:00.000Z",
    ]);
  });

  it("keeps each date with its Session when an empty Session is filtered out", () => {
    const [q] = loadLongMemEval(
      write([
        {
          question_id: "q1",
          question_type: "t",
          question: "?",
          answer_session_ids: [],
          haystack_session_ids: ["empty", "kept"],
          haystack_sessions: [[], turn("kept")],
          haystack_dates: ["2023/05/20 (Sat) 02:21", "2023/06/01 (Thu) 10:00"],
        },
      ]),
    );
    expect(q.haystack.map((s) => [s.id, s.timestamp])).toEqual([
      ["kept", "2023-06-01T10:00:00.000Z"],
    ]);
  });

  it("loads rows without haystack_dates as undated Sessions", () => {
    const [q] = loadLongMemEval(
      write([
        {
          question_id: "q1",
          question_type: "t",
          question: "?",
          answer_session_ids: [],
          haystack_session_ids: ["s1"],
          haystack_sessions: [turn("one")],
        },
      ]),
    );
    expect(q.haystack[0].timestamp).toBeUndefined();
  });
});
