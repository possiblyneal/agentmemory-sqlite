import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { recordAudit, queryAudit, evictOldestAudit } from "../src/functions/audit.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const listNewestCalls: Array<{ scope: string; opts: Record<string, unknown> }> = [];
  return {
    listNewestCalls,
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
    listNewest: async <T>(
      scope: string,
      opts: { limit: number; operation?: string; from?: string; to?: string },
    ): Promise<T[]> => {
      listNewestCalls.push({ scope, opts });
      const rows = Array.from(store.get(scope)?.values() ?? []) as Array<{
        timestamp: string;
        operation: string;
      }>;
      return rows
        .filter(
          (e) =>
            (opts.operation === undefined || e.operation === opts.operation) &&
            (opts.from === undefined || e.timestamp >= opts.from) &&
            (opts.to === undefined || e.timestamp <= opts.to),
        )
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, opts.limit) as T[];
    },
  };
}

describe("Audit Functions", () => {
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    kv = mockKV();
  });

  it("recordAudit creates an entry with proper fields", async () => {
    const entry = await recordAudit(
      kv as never,
      "observe",
      "mem::compress",
      ["obs_1", "obs_2"],
      { count: 2 },
      0.85,
      "user-1",
    );

    expect(entry.id).toMatch(/^aud_/);
    expect(entry.timestamp).toBeDefined();
    expect(entry.operation).toBe("observe");
    expect(entry.functionId).toBe("mem::compress");
    expect(entry.targetIds).toEqual(["obs_1", "obs_2"]);
    expect(entry.details).toEqual({ count: 2 });
    expect(entry.qualityScore).toBe(0.85);
    expect(entry.userId).toBe("user-1");
  });

  it("queryAudit returns entries sorted by timestamp desc", async () => {
    await recordAudit(kv as never, "observe", "fn1", ["a"], {});
    await new Promise((r) => setTimeout(r, 10));
    await recordAudit(kv as never, "delete", "fn2", ["b"], {});

    const entries = await queryAudit(kv as never);
    expect(entries.length).toBe(2);
    expect(
      new Date(entries[0].timestamp).getTime(),
    ).toBeGreaterThanOrEqual(new Date(entries[1].timestamp).getTime());
  });

  it("queryAudit filters by operation", async () => {
    await recordAudit(kv as never, "observe", "fn1", [], {});
    await recordAudit(kv as never, "delete", "fn2", [], {});
    await recordAudit(kv as never, "observe", "fn3", [], {});

    const entries = await queryAudit(kv as never, { operation: "observe" });
    expect(entries.length).toBe(2);
    expect(entries.every((e) => e.operation === "observe")).toBe(true);
  });

  it("queryAudit filters by dateFrom/dateTo", async () => {
    const early = await recordAudit(kv as never, "observe", "fn1", [], {});
    await new Promise((r) => setTimeout(r, 20));
    const late = await recordAudit(kv as never, "delete", "fn2", [], {});

    const entries = await queryAudit(kv as never, {
      dateFrom: late.timestamp,
    });
    expect(entries.length).toBe(1);
    expect(entries[0].operation).toBe("delete");

    const entriesBefore = await queryAudit(kv as never, {
      dateTo: early.timestamp,
    });
    expect(entriesBefore.length).toBe(1);
    expect(entriesBefore[0].operation).toBe("observe");
  });

  it("queryAudit respects limit", async () => {
    for (let i = 0; i < 10; i++) {
      await recordAudit(kv as never, "observe", `fn${i}`, [], {});
    }

    const entries = await queryAudit(kv as never, { limit: 3 });
    expect(entries.length).toBe(3);
  });

  it("queryAudit asks storage for only the newest matches and never lists the scope", async () => {
    const list = vi.spyOn(kv, "list");
    for (let i = 0; i < 6; i++) {
      await kv.set("mem:audit", `aud_${i}`, {
        id: `aud_${i}`,
        timestamp: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
        operation: i % 2 ? "delete" : "observe",
      });
    }

    const entries = await queryAudit(kv as never, {
      operation: "observe",
      dateFrom: "2026-01-02T00:00:00.000Z",
      limit: 2,
    });

    expect(entries.map((e) => e.id)).toEqual(["aud_4", "aud_2"]);
    expect(list).not.toHaveBeenCalled();
    expect(kv.listNewestCalls).toEqual([
      {
        scope: "mem:audit",
        opts: {
          limit: 2,
          operation: "observe",
          from: "2026-01-02T00:00:00.000Z",
          to: undefined,
        },
      },
    ]);
  });

  it("queryAudit defaults the limit to 100 and rejects an invalid date", async () => {
    await queryAudit(kv as never);
    expect(kv.listNewestCalls[0].opts.limit).toBe(100);
    await expect(queryAudit(kv as never, { dateFrom: "nope" })).rejects.toThrow("Invalid dateFrom");
    await expect(queryAudit(kv as never, { dateTo: "nope" })).rejects.toThrow("Invalid dateTo");
  });

  it("evictOldestAudit keeps the newest AGENTMEMORY_AUDIT_MAX entries", async () => {
    process.env.AGENTMEMORY_AUDIT_MAX = "2";
    try {
      for (let i = 0; i < 4; i++) {
        await kv.set("mem:audit", `aud_${i}`, {
          id: `aud_${i}`,
          timestamp: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
          operation: "observe",
          functionId: "mem::observe",
          targetIds: [],
          details: {},
        });
      }

      expect(await evictOldestAudit(kv as never)).toBe(2);

      const kept = (await kv.list<{ id: string }>("mem:audit")).map((e) => e.id).sort();
      expect(kept).toEqual(["aud_2", "aud_3"]);
    } finally {
      delete process.env.AGENTMEMORY_AUDIT_MAX;
    }
  });
});
