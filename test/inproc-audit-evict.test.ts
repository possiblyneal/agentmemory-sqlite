import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteState, stateFunctions } from "../src/engine/inproc/state.js";
import { StateKV } from "../src/state/kv.js";
import { evictOldestAudit } from "../src/functions/audit.js";
import { KV } from "../src/state/schema.js";

function kvOver(store: SqliteState, timing?: { maxCall: number }): StateKV {
  const handlers = stateFunctions(store);
  const sdk = {
    trigger: async (req: { function_id: string; payload: unknown }) => {
      const start = performance.now();
      const pending = handlers[req.function_id](req.payload);
      if (timing) timing.maxCall = Math.max(timing.maxCall, performance.now() - start);
      return pending;
    },
  };
  return new StateKV(sdk as never);
}

describe("audit eviction on the real SqliteState", () => {
  let dir: string;
  let store: SqliteState;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "am-audit-evict-"));
    store = new SqliteState(join(dir, "state.sqlite"));
  });

  afterEach(() => {
    delete process.env.AGENTMEMORY_AUDIT_MAX;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(total: number, stamp: (i: number) => string): void {
    for (let i = 0; i < total; i += 1000) {
      const entries = [];
      for (let j = i; j < Math.min(total, i + 1000); j++) {
        entries.push({
          key: `aud_${j}`,
          value: { id: `aud_${j}`, timestamp: stamp(j), operation: "observe", functionId: "mem::observe", targetIds: [`obs_${j}`], details: { note: "x".repeat(200) } },
        });
      }
      store.setMany(KV.audit, entries);
    }
  }

  it("keeps the newest rows by timestamp, ties by insertion order, and leaves other scopes", async () => {
    const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString();
    const stamps = [day(3), day(0), day(2), day(2), day(1)];
    stamps.forEach((timestamp, i) => store.set(KV.audit, `a${i}`, { id: `a${i}`, timestamp }));
    store.set("other", "z", { id: "z", timestamp: day(0) });
    process.env.AGENTMEMORY_AUDIT_MAX = "3";

    expect(await evictOldestAudit(kvOver(store))).toBe(2);
    expect((store.list(KV.audit) as Array<{ id: string }>).map((r) => r.id)).toEqual(["a0", "a2", "a3"]);
    expect(store.list("other")).toHaveLength(1);
    expect(await evictOldestAudit(kvOver(store))).toBe(0);
  });

  it("listTimestamps pages through every row in seq order", async () => {
    seed(4_500, (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString());
    const rows = await kvOver(store).listTimestamps(KV.audit);
    expect(rows).toHaveLength(4_500);
    expect(rows[0]).toEqual({ key: "aud_0", timestamp: "2026-01-01T00:00:00.000Z" });
    expect(rows[4_499].key).toBe("aud_4499");
  });

  it("a pass over 57k rows keeps the newest 50k with no long synchronous call or event-loop stall", async () => {
    const total = 57_436;
    const base = Date.UTC(2026, 0, 1);
    seed(total, (i) => new Date(base + i * 1000).toISOString());
    process.env.AGENTMEMORY_AUDIT_MAX = "50000";

    const timing = { maxCall: 0 };
    const kv = kvOver(store, timing);

    let maxStall = 0;
    let last = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      maxStall = Math.max(maxStall, now - last - 5);
      last = now;
    }, 5);
    last = performance.now();
    const removed = await evictOldestAudit(kv);
    clearInterval(probe);

    expect(removed).toBe(total - 50_000);
    const left = store.db
      .prepare("SELECT COUNT(*) AS n, MIN(json_extract(value,'$.timestamp')) AS oldest FROM kv WHERE scope = ?")
      .get(KV.audit) as { n: number; oldest: string };
    expect(left.n).toBe(50_000);
    expect(left.oldest).toBe(new Date(base + (total - 50_000) * 1000).toISOString());
    console.log(`max single state call ${timing.maxCall.toFixed(0)} ms, max event-loop stall ${maxStall.toFixed(0)} ms`);
    expect(timing.maxCall).toBeLessThan(1_500);
    expect(maxStall).toBeLessThan(1_500);
  }, 60_000);
});
