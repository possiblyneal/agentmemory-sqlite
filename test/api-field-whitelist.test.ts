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
  "files", "observations", "memoryIds", "type", "tags", "sourceObservationIds",
  "sourceMemoryIds", "edges", "steps", "sourceProceduralIds", "linkedActionIds",
  "sharedScopes", "scopes", "memories", "actions", "semantic", "procedural",
  "relations", "graphNodes", "graphEdges", "actionIds", "categories", "matchAll",
  "matchAny",
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
  ["api::action-create", "mem::action-create", ["title", "description", "priority", "createdBy", "project", "tags", "parentId", "sourceObservationIds", "sourceMemoryIds", "edges"]],
  ["api::action-update", "mem::action-update", ["actionId", "status", "title", "description", "priority", "assignedTo", "result", "tags"]],
  ["api::action-edge", "mem::action-edge-create", ["sourceActionId", "targetActionId", "type", "metadata"]],
  ["api::lease-acquire", "mem::lease-acquire", ["actionId", "agentId", "ttlMs"]],
  ["api::lease-release", "mem::lease-release", ["actionId", "agentId", "result"]],
  ["api::lease-renew", "mem::lease-renew", ["actionId", "agentId", "ttlMs"]],
  ["api::routine-create", "mem::routine-create", ["name", "description", "steps", "tags", "frozen", "sourceProceduralIds"]],
  ["api::routine-run", "mem::routine-run", ["routineId", "initiatedBy", "project", "overrides"]],
  ["api::signal-send", "mem::signal-send", ["from", "to", "content", "type", "threadId", "replyTo", "metadata", "expiresInMs"]],
  ["api::checkpoint-create", "mem::checkpoint-create", ["name", "description", "type", "linkedActionIds", "expiresInMs"]],
  ["api::checkpoint-resolve", "mem::checkpoint-resolve", ["checkpointId", "status", "resolvedBy", "result"]],
  ["api::mesh-register", "mem::mesh-register", ["url", "name", "sharedScopes", "syncFilter"]],
  ["api::mesh-sync", "mem::mesh-sync", ["peerId", "scopes", "direction"]],
  ["api::mesh-receive", "mem::mesh-receive", ["memories", "actions", "semantic", "procedural", "relations", "graphNodes", "graphEdges"]],
  ["api::flow-compress", "mem::flow-compress", ["runId", "actionIds", "project"]],
  ["api::sentinel-create", "mem::sentinel-create", ["name", "type", "config", "linkedActionIds", "expiresInMs"]],
  ["api::sentinel-trigger", "mem::sentinel-trigger", ["sentinelId", "result"]],
  ["api::sentinel-cancel", "mem::sentinel-cancel", ["sentinelId"]],
  ["api::sketch-create", "mem::sketch-create", ["title", "description", "expiresInMs", "project"]],
  ["api::sketch-add", "mem::sketch-add", ["sketchId", "title", "description", "priority", "dependsOn"]],
  ["api::sketch-promote", "mem::sketch-promote", ["sketchId", "project"]],
  ["api::sketch-discard", "mem::sketch-discard", ["sketchId"]],
  ["api::crystallize", "mem::crystallize", ["actionIds", "sessionId", "project"]],
  ["api::auto-crystallize", "mem::auto-crystallize", ["olderThanDays", "project", "dryRun"]],
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
