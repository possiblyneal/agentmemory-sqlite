import { describe, it, expect } from "vitest";
import { buildQuestions, type DolphinBenchTables } from "../eval/runner/dolphinbench-load.js";

const tables = (): DolphinBenchTables => ({
  messages: [
    { persona: "alex", message_id: "000001", date: "2024-03-01T09:00:00-08:00", content: "we deploy with argo" },
    { persona: "alex", message_id: "000002", date: "2024-03-02T09:00:00-08:00", content: "pager goes to Sam" },
    { persona: "alex", message_id: "000003", date: "2024-03-03T09:00:00-08:00", content: "lunch" },
    { persona: "riley", message_id: "000001", date: "2024-04-01T09:00:00-08:00", content: "riley's first" },
  ],
  facts: [
    { persona: "alex", fact_id: 1n, source_message_ids: ["000001"] },
    { persona: "alex", fact_id: 2n, source_message_ids: ["000002", "000001"] },
    { persona: "riley", fact_id: 1n, source_message_ids: ["000001"] },
  ],
  tests: [
    { persona: "alex", test_id: "001", request: "Roll back the deploy", required_fact_ids: [1n] },
    { persona: "alex", test_id: "002", request: "Page the on-call", required_fact_ids: [1n, 2n] },
    { persona: "riley", test_id: "001", request: "Say hi", required_fact_ids: [1n] },
  ],
});

describe("buildQuestions", () => {
  it("scores the messages that established the required facts as gold, per persona", () => {
    const [rollback, page, riley] = buildQuestions(tables());
    expect(rollback.goldSessionIds).toEqual(["000001"]);
    expect(page.goldSessionIds.sort()).toEqual(["000001", "000002"]);
    expect(riley.goldSessionIds).toEqual(["000001"]);
    expect(riley.haystack.map((s) => s.observations?.[0].output)).toEqual(["riley's first"]);
  });

  it("queries with the task request, types the question by persona and ids it uniquely", () => {
    const qs = buildQuestions(tables());
    expect(qs.map((q) => [q.id, q.type, q.question])).toEqual([
      ["alex-001", "alex", "Roll back the deploy"],
      ["alex-002", "alex", "Page the on-call"],
      ["riley-001", "riley", "Say hi"],
    ]);
  });

  it("makes each message of the persona a dated prompt Session", () => {
    const [q] = buildQuestions(tables());
    expect(q.haystack.map((s) => s.id)).toEqual(["000001", "000002", "000003"]);
    expect(q.haystack[0].timestamp).toBe("2024-03-01T17:00:00.000Z");
    expect(q.haystack[0].observations).toEqual([{ tool: "prompt", output: "we deploy with argo" }]);
  });

  it("refuses a test whose fact has no source message, rather than scoring it as unanswerable", () => {
    const t = tables();
    t.facts[0].source_message_ids = [];
    expect(() => buildQuestions(t)).toThrow(/fact 1 has no source messages/);
  });

  it("refuses a fact that names a message the persona does not have", () => {
    const t = tables();
    t.facts[0].source_message_ids = ["999999"];
    expect(() => buildQuestions(t)).toThrow(/unknown message 999999/);
  });
});
