import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerObserveFunction } from "../src/functions/observe.js";
import { registerPromptContextFunction } from "../src/functions/prompt-context.js";
import { parseJsonlText } from "../src/replay/jsonl-parser.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const NOTIFICATIONS = [
  "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>",
  '<teammate-message teammate_id="fix-98">PR 98 review fixes pushed</teammate-message>',
  "<cross-session-message from=\"peer\">rebased the branch</cross-session-message>",
  "  <agent-message>done with the migration</agent-message>",
];

function prompt(text: string) {
  return {
    sessionId: "ses_1",
    project: "shipctl",
    cwd: "/repo",
    hookType: "prompt_submit",
    timestamp: "2026-10-03T00:00:00.000Z",
    data: { prompt: text },
  };
}

describe("harness messages delivered as user turns", () => {
  it.each(NOTIFICATIONS)("are not stored as Observations: %s", async (text) => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = await sdk.trigger("mem::observe", prompt(text));

    expect(result).toEqual({ skipped: "harness-message", sessionId: "ses_1" });
    expect(await kv.list(KV.observations("ses_1"))).toEqual([]);
  });

  it("still stores an Operator prompt that only mentions a notification", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger(
      "mem::observe",
      prompt("why did the <task-notification> for the eval never arrive"),
    )) as { observationId?: string };

    expect(result.observationId).toBeTruthy();
  });

  it.each(NOTIFICATIONS)("do not trigger a per-prompt search: %s", async (text) => {
    const sdk = mockSdk();
    const searched: unknown[] = [];
    sdk.registerFunction("mem::search", async (data: unknown) => {
      searched.push(data);
      return { results: [] };
    });
    registerPromptContextFunction(sdk as never, mockKV() as never);

    const result = await sdk.trigger("mem::prompt-context", { sessionId: "ses_1", project: "shipctl", prompt: text });

    expect(searched).toEqual([]);
    expect(result).toEqual({ context: "", tokens: 0, injected: [] });
  });

  it("are left out of an imported transcript", () => {
    const line = (uuid: string, text: string) =>
      JSON.stringify({
        type: "user",
        uuid,
        sessionId: "sess-import",
        timestamp: "2026-10-03T00:00:00.000Z",
        cwd: "/repo",
        message: { role: "user", content: [{ type: "text", text }] },
      });

    const out = parseJsonlText([line("u1", "fix the login bug"), line("u2", NOTIFICATIONS[0])].join("\n"));

    expect(out.observations.map((o) => o.userPrompt)).toEqual(["fix the login bug"]);
  });
});
