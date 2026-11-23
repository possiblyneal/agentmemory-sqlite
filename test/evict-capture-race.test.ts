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
