import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";

const SECRET = "whitelist-test-secret";

function mockKV() {
  return {
    get: async () => null,
    set: async <T>(_scope: string, _key: string, data: T) => data,
    delete: async () => {},
    list: async () => [],
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    registerFunction: (id: string, h: Function) => {
      fns.set(id, h);
    },
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: unknown }) =>
      fns.get(input.function_id)?.(input.payload),
    _fns: fns,
  };
}

const ARRAY_FIELDS = new Set([
  "files", "observations", "memoryIds", "type", "sharedScopes", "scopes",
  "memories", "semantic", "procedural", "relations", "graphNodes", "graphEdges",
  "categories", "matchAll", "matchAny",
]);

// [REST route, Engine function, fields the function reads]
const ROUTES: Array<[string, string, string[]]> = [
  ["api::file-context", "mem::file-context", ["sessionId", "files", "project"]],
  ["api::timeline", "mem::timeline", ["anchor", "project", "before", "after"]],
  ["api::import", "mem::import", ["exportData", "strategy"]],
  ["api::relations", "mem::relate", ["sourceId", "targetId", "type", "confidence"]],
  ["api::evolve", "mem::evolve", ["memoryId", "newContent", "newTitle"]],
  ["api::graph-extract", "mem::graph-extract", ["observations"]],
  ["api::consolidate-pipeline", "mem::consolidate-pipeline", ["tier", "project"]],
  ["api::team-share", "mem::team-share", ["itemId", "itemType", "sessionId", "project"]],
  ["api::governance-delete", "mem::governance-delete", ["memoryIds", "reason"]],
  ["api::governance-bulk", "mem::governance-bulk", ["type", "dateFrom", "dateTo", "project", "qualityBelow", "dryRun"]],
  ["api::snapshot-create", "mem::snapshot-create", ["message"]],
  ["api::snapshot-restore", "mem::snapshot-restore", ["commitHash"]],
  ["api::signal-send", "mem::signal-send", ["from", "to", "content", "type", "threadId", "replyTo", "metadata", "expiresInMs"]],
  ["api::mesh-register", "mem::mesh-register", ["url", "name", "sharedScopes", "syncFilter"]],
  ["api::mesh-sync", "mem::mesh-sync", ["peerId", "scopes", "direction"]],
  ["api::mesh-receive", "mem::mesh-receive", ["memories", "semantic", "procedural", "relations", "graphNodes", "graphEdges"]],
  ["api::diagnose", "mem::diagnose", ["categories"]],
  ["api::heal", "mem::heal", ["categories", "dryRun"]],
  ["api::facet-tag", "mem::facet-tag", ["targetId", "targetType", "dimension", "value"]],
  ["api::facet-untag", "mem::facet-untag", ["targetId", "dimension", "value"]],
  ["api::facet-query", "mem::facet-query", ["matchAll", "matchAny", "targetType", "limit"]],
  ["api::lesson-search", "mem::lesson-recall", ["query", "project", "minConfidence", "limit"]],
];

describe.each(ROUTES)("%s field whitelist", (route, fn, fields) => {
  let sdk: ReturnType<typeof mockSdk>;
  let received: unknown;

  beforeEach(() => {
    sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, SECRET);
    received = undefined;
    sdk._fns.set(fn, (data: unknown) => {
      received = data;
      return { success: true };
    });
  });

  it("forwards the fields the function reads and drops the rest", async () => {
    const allowed = Object.fromEntries(
      fields.map((f) => [f, ARRAY_FIELDS.has(f) ? ["x"] : "x"]),
    );
    await sdk._fns.get(route)!({
      headers: { authorization: `Bearer ${SECRET}` },
      body: { ...allowed, injected: "dropped" },
    });
    expect(received).toEqual(allowed);
  });
});
