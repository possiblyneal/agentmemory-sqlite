import { describe, it, expect, vi } from "vitest";
import { registerSlotsFunctions, DEFAULT_SLOTS } from "../src/functions/slots.js";
import { KV } from "../src/state/schema.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => (store.has(scope) ? (Array.from(store.get(scope)!.values()) as T[]) : []),
  };
}

type Handler = (d: Record<string, unknown>) => Promise<Record<string, unknown>>;

function wire(kv = mockKV()) {
  const handlers: Record<string, Handler> = {};
  const sdk = {
    registerFunction: vi.fn((id: string, cb) => {
      handlers[id] = cb;
    }),
  } as unknown as import("../src/engine/types.js").ISdk;
  registerSlotsFunctions(sdk, kv as never);
  return { kv, handlers };
}

const P = "proj";
const GLOBAL_DEFAULTS = DEFAULT_SLOTS.filter((s) => s.scope === "global").length;

async function waitForSeed(kv: ReturnType<typeof mockKV>) {
  for (let i = 0; i < 20; i++) {
    if ((await kv.list(KV.globalSlots)).length >= GLOBAL_DEFAULTS) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("slot-replace precondition and undo copy", () => {
  it("rejects a stale expectedVersion and keeps the first write", async () => {
    const { handlers } = wire();
    await handlers["mem::slot-create"]({ project: P, label: "cas", content: "v0" });
    const read = (await handlers["mem::slot-get"]({ project: P, label: "cas" })) as { slot: { version: number } };
    const first = await handlers["mem::slot-replace"]({
      project: P, label: "cas", content: "A", expectedVersion: read.slot.version,
    });
    expect(first.success).toBe(true);
    const second = (await handlers["mem::slot-replace"]({
      project: P, label: "cas", content: "B", expectedVersion: read.slot.version,
    })) as { success: boolean; error: string; currentVersion: number };
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/version conflict/);
    expect(second.currentVersion).toBe(read.slot.version + 1);
    const got = (await handlers["mem::slot-get"]({ project: P, label: "cas" })) as { slot: { content: string } };
    expect(got.slot.content).toBe("A");
  });

  it("an append between read and replace is a conflict", async () => {
    const { handlers } = wire();
    await handlers["mem::slot-create"]({ project: P, label: "cas2", content: "v0" });
    const read = (await handlers["mem::slot-get"]({ project: P, label: "cas2" })) as { slot: { version: number } };
    await handlers["mem::slot-append"]({ project: P, label: "cas2", text: "x" });
    const res = await handlers["mem::slot-replace"]({
      project: P, label: "cas2", content: "B", expectedVersion: read.slot.version,
    });
    expect(res.success).toBe(false);
  });

  it("omitting expectedVersion keeps last-write-wins", async () => {
    const { handlers } = wire();
    await handlers["mem::slot-create"]({ project: P, label: "lww", content: "v0" });
    await handlers["mem::slot-replace"]({ project: P, label: "lww", content: "A" });
    const res = await handlers["mem::slot-replace"]({ project: P, label: "lww", content: "B" });
    expect(res.success).toBe(true);
  });

  it("keeps only the previous content as a single undo copy", async () => {
    const { handlers } = wire();
    await handlers["mem::slot-create"]({ project: P, label: "undo", content: "one" });
    await handlers["mem::slot-replace"]({ project: P, label: "undo", content: "two" });
    const res = (await handlers["mem::slot-replace"]({ project: P, label: "undo", content: "three" })) as {
      slot: { content: string; previousContent: string };
    };
    expect(res.slot.content).toBe("three");
    expect(res.slot.previousContent).toBe("two");
  });
});

describe("slot-reflect truncates on line boundaries", () => {
  async function reflectInto(label: string, content: string, sizeLimit: number, obs: Record<string, unknown>[]) {
    const kv = mockKV();
    const { handlers } = wire(kv);
    await waitForSeed(kv);
    await kv.set(KV.sessions, "s1", { id: "s1", project: P });
    await handlers["mem::slot-list"]({ project: P });
    const seeded = (await kv.get<Record<string, unknown>>(KV.projectSlots(P), label))!;
    await kv.set(KV.projectSlots(P), label, { ...seeded, content, sizeLimit });
    for (const [i, o] of obs.entries()) {
      await kv.set(KV.observations("s1"), `o${i}`, { id: `o${i}`, timestamp: `2026-01-01T00:00:0${i}Z`, ...o });
    }
    await handlers["mem::slot-reflect"]({ sessionId: "s1" });
    return ((await kv.get(KV.projectSlots(P), label)) as { content: string }).content;
  }

  it("pending_items keeps whole trailing lines", async () => {
    const content = await reflectInto("pending_items", "- aaaaaaaaaa\n- bbbbbbbbbb", 30, [
      { title: "todo cccccccccc", narrative: "" },
    ]);
    expect(content).toBe("- bbbbbbbbbb\n- todo cccccccccc");
  });

  it("session_patterns keeps whole leading lines", async () => {
    const content = await reflectInto("session_patterns", "", 70, [
      { type: "error", title: "e" },
      { type: "command_run", title: "c" },
    ]);
    for (const l of content.split("\n")) {
      expect(l).toMatch(/^(last reflection: .+|- (errors|commands): \d+ in last \d+ observations)$/);
    }
    expect(content.length).toBeLessThanOrEqual(70);
  });

  it("project_context keeps whole trailing lines", async () => {
    const content = await reflectInto("project_context", "", 40, [
      { files: ["src/aaaaaaaaaa.ts", "src/bbbbbbbbbb.ts", "src/cccccccccc.ts"] },
    ]);
    for (const l of content.split("\n")) expect(l).toMatch(/^- src\/[a-c]+\.ts$|^Files touched/);
    expect(content.length).toBeLessThanOrEqual(40);
  });
});
