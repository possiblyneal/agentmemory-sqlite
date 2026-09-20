import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { SqliteState } from "../src/engine/inproc/state.js";
import { KV } from "../src/state/schema.js";
import {
  runStartupMaintenance,
  STARTUP_MAINTENANCE_VERSION,
} from "../src/state/startup-maintenance.js";

const MAX = 3;

function ids(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
}

// #11: rows written before the provenance bound existed are still unbounded on
// disk, and the deleted engine's index shards still occupy the store. One pass
// repairs both, once.
describe("startup maintenance", () => {
  let store: SqliteState;

  beforeEach(() => {
    process.env["AGENTMEMORY_GRAPH_MAX_SOURCE_IDS"] = String(MAX);
    store = new SqliteState(":memory:");
  });

  afterEach(() => {
    delete process.env["AGENTMEMORY_GRAPH_MAX_SOURCE_IDS"];
    store.close();
  });

  it("trims over-bound provenance to the cap, keeping the newest ids", () => {
    store.set(KV.graphNodes, "node-1", {
      id: "node-1",
      name: "auth",
      sourceObservationIds: ids("obs", 10),
    });

    const result = runStartupMaintenance(store);

    expect(result.skipped).toBe(false);
    expect(result.rowsTrimmed).toBe(1);
    expect(result.idsDropped).toBe(7);
    const node = store.get(KV.graphNodes, "node-1") as {
      name: string;
      sourceObservationIds: string[];
    };
    expect(node.sourceObservationIds).toEqual(["obs-7", "obs-8", "obs-9"]);
    expect(node.name).toBe("auth");
  });

  it("leaves rows already within the bound untouched", () => {
    store.set(KV.graphEdges, "edge-1", {
      id: "edge-1",
      sourceObservationIds: ["a", "b"],
    });
    store.set(KV.graphNodes, "node-1", { id: "node-1" });

    const result = runStartupMaintenance(store);

    expect(result.rowsTrimmed).toBe(0);
    expect(
      (store.get(KV.graphEdges, "edge-1") as { sourceObservationIds: string[] })
        .sourceObservationIds,
    ).toEqual(["a", "b"]);
    expect(store.get(KV.graphNodes, "node-1")).toEqual({ id: "node-1" });
  });

  it("trims nodes and edges alike", () => {
    store.set(KV.graphNodes, "node-1", { sourceObservationIds: ids("n", 5) });
    store.set(KV.graphEdges, "edge-1", { sourceObservationIds: ids("e", 6) });

    const result = runStartupMaintenance(store);

    expect(result.rowsTrimmed).toBe(2);
    expect(result.idsDropped).toBe(2 + 3);
  });

  it("deletes the dead index scopes and nothing else", () => {
    store.set(KV.bm25Index, "data:manifest", { generation: 4 });
    store.set(KV.bm25Index, "checkpoint:rollback", { at: 1 });
    store.set(`${KV.bm25Index}:bm25:4:0001`, "data", { postings: [] });
    store.set(`${KV.bm25Index}:vectors:4:0002`, "data", { vectors: [] });
    store.set(KV.observations("sess-1"), "obs-1", { id: "obs-1", content: "keep me" });
    store.set(KV.graphNodes, "node-1", { sourceObservationIds: ["a"] });

    const result = runStartupMaintenance(store);

    expect(result.deadIndexRowsDeleted).toBe(4);
    expect(store.list(KV.bm25Index)).toEqual([]);
    expect(store.list(`${KV.bm25Index}:bm25:4:0001`)).toEqual([]);
    expect(store.list(`${KV.bm25Index}:vectors:4:0002`)).toEqual([]);
    expect(store.get(KV.observations("sess-1"), "obs-1")).toEqual({
      id: "obs-1",
      content: "keep me",
    });
    expect(store.get(KV.graphNodes, "node-1")).toEqual({
      sourceObservationIds: ["a"],
    });
  });

  it("records the version so a second run is a no-op", () => {
    store.set(KV.graphNodes, "node-1", { sourceObservationIds: ids("obs", 10) });

    expect(runStartupMaintenance(store).skipped).toBe(false);
    expect(store.get(KV.state, "system:startupMaintenanceVersion")).toBe(
      STARTUP_MAINTENANCE_VERSION,
    );

    store.set(KV.graphNodes, "node-2", { sourceObservationIds: ids("later", 9) });
    const second = runStartupMaintenance(store);

    expect(second).toEqual({
      skipped: true,
      rowsTrimmed: 0,
      idsDropped: 0,
      deadIndexRowsDeleted: 0,
    });
    expect(
      (store.get(KV.graphNodes, "node-2") as { sourceObservationIds: string[] })
        .sourceObservationIds,
    ).toHaveLength(9);
  });

  it("skips a row whose provenance is missing or malformed", () => {
    store.set(KV.graphNodes, "node-1", { id: "node-1" });
    store.set(KV.graphNodes, "node-2", { sourceObservationIds: "not-an-array" });

    const result = runStartupMaintenance(store);

    expect(result.rowsTrimmed).toBe(0);
    expect(store.get(KV.graphNodes, "node-2")).toEqual({
      sourceObservationIds: "not-an-array",
    });
  });
});
