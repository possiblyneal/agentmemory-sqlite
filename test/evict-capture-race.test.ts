import { expect, it } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { registerEvictFunction } from "../src/functions/evict.js";
import { registerExportImportFunction } from "../src/functions/export-import.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation } from "../src/types.js";

it("does not orphan an Observation arriving between empty scan and Session deletion", async () => {
  const sessionId = "ses-review";
  const scope = KV.observations(sessionId);
  const payload = { sessionId, hookType: "post_tool_use", project: "probe", cwd: "/probe", timestamp: new Date().toISOString() };
  const kv = { ...mockKV(), bytes: async () => 0 };
  const sdk = mockSdk({ looseTrigger: true });
  registerObserveFunction(sdk as never, kv as never);
  registerEvictFunction(sdk as never, kv as never);
  registerExportImportFunction(sdk as never, kv as never);
  await kv.set(KV.sessions, sessionId, { ...payload, id: sessionId, startedAt: "2020-01-01T00:00:00.000Z", status: "active", observationCount: 0 });
  const read = kv.list;
  let first = true;
  kv.list = async <T>(key: string): Promise<T[]> => {
    const rows = await read<T>(key);
    if (key === scope && first) {
      first = false;
      await sdk.trigger("mem::observe", { ...payload, data: { tool_name: "Read", tool_input: { file_path: "a" }, tool_output: "plain text" } });
    }
    return rows;
  };
  await sdk.trigger("mem::evict", {});
  const [retained] = await kv.list<CompressedObservation>(scope);
  expect(retained?.id).toBeDefined();
  const exported = await sdk.trigger("mem::export", {});
  expect(exported.observations[sessionId]?.map((o: CompressedObservation) => o.id) ?? []).toContain(retained.id);
});

it("holds capture's Session lookup until empty Session deletion finishes", async () => {
  const sessionId = "ses-delete-race";
  const payload = { sessionId, hookType: "post_tool_use", project: "probe", cwd: "/probe", timestamp: new Date().toISOString() };
  const kv = { ...mockKV(), bytes: async () => 0 };
  const sdk = mockSdk({ looseTrigger: true });
  registerObserveFunction(sdk as never, kv as never);
  registerEvictFunction(sdk as never, kv as never);
  registerExportImportFunction(sdk as never, kv as never);
  await kv.set(KV.sessions, sessionId, { ...payload, id: sessionId, startedAt: "2020-01-01T00:00:00.000Z", status: "active", observationCount: 0 });

  let deleting!: () => void;
  let release!: () => void;
  const deletionStarted = new Promise<void>((resolve) => { deleting = resolve; });
  const allowDeletion = new Promise<void>((resolve) => { release = resolve; });
  const remove = kv.delete;
  kv.delete = async (scope, key) => {
    if (scope === KV.sessions && key === sessionId) {
      deleting();
      await allowDeletion;
    }
    return remove(scope, key);
  };
  const get = kv.get;
  let lookedUp = false;
  kv.get = async <T>(scope: string, key: string): Promise<T | null> => {
    if (scope === KV.sessions && key === sessionId) lookedUp = true;
    return get<T>(scope, key);
  };
  const eviction = sdk.trigger("mem::evict", {});
  await deletionStarted;
  const capture = sdk.trigger("mem::observe", { ...payload, data: { tool_name: "Read", tool_input: { file_path: "a" }, tool_output: "plain text" } });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lookedUp).toBe(false);
  } finally {
    release();
    await Promise.all([eviction, capture]);
  }
  const exported = await sdk.trigger("mem::export", {});
  expect(exported.observations[sessionId]).toHaveLength(1);
});
