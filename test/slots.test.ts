import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerSlotsFunctions, DEFAULT_SLOTS, listPinnedSlots, renderPinnedContext } from "../src/functions/slots.js";
import { KV } from "../src/state/schema.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
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
      if (!store.has(scope)) return [];
      return Array.from(store.get(scope)!.values()) as T[];
    },
  };
}

function wire() {
  const kv = mockKV();
  const handlers: Record<string, (data: Record<string, unknown>) => Promise<Record<string, unknown>>> = {};
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
    const g = await kv.list(KV.globalSlots);
    if (g.length >= GLOBAL_DEFAULTS) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("slots — primitive", () => {
  let kv: ReturnType<typeof mockKV>;
  let handlers: Record<string, (d: Record<string, unknown>) => Promise<Record<string, unknown>>>;

  beforeEach(async () => {
    ({ kv, handlers } = wire());
    await waitForSeed(kv);
  });

  it("seeds global defaults at boot and a project's defaults on its first slot call", async () => {
    type Listed = { slots: Array<{ label: string; scope: string }> };
    const unscoped = (await handlers["mem::slot-list"]({})) as Listed;
    expect(unscoped.slots.map((s) => s.label)).toEqual(
      ["persona", "tool_guidelines", "user_preferences"],
    );

    const scoped = (await handlers["mem::slot-list"]({ project: P })) as Listed;
    expect(scoped.slots.map((s) => s.label)).toEqual([
      "guidance",
      "pending_items",
      "persona",
      "project_context",
      "self_notes",
      "session_patterns",
      "tool_guidelines",
      "user_preferences",
    ]);
    expect(await kv.list(KV.legacySlots)).toEqual([]);
  });

  it("refuses a project-scoped create without a project", async () => {
    const res = (await handlers["mem::slot-create"]({ label: "orphan" })) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/project required/);
  });

  it("rejects labels with bad shape", async () => {
    const res = (await handlers["mem::slot-create"]({ project: P, label: "Bad Label!" })) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/label required/);
  });

  it("create then get round-trips a new slot", async () => {
    const created = (await handlers["mem::slot-create"]({ project: P,
      label: "notes_todo",
      content: "hello",
      description: "scratchpad",
    })) as { success: boolean; slot: { label: string; content: string } };
    expect(created.success).toBe(true);
    expect(created.slot.content).toBe("hello");

    const fetched = (await handlers["mem::slot-get"]({ project: P, label: "notes_todo" })) as {
      success: boolean;
      slot: { content: string };
    };
    expect(fetched.success).toBe(true);
    expect(fetched.slot.content).toBe("hello");
  });

  it("rejects duplicate create", async () => {
    await handlers["mem::slot-create"]({ project: P, label: "scratch", content: "a" });
    const dup = (await handlers["mem::slot-create"]({ project: P, label: "scratch", content: "b" })) as {
      success: boolean;
      error: string;
    };
    expect(dup.success).toBe(false);
    expect(dup.error).toMatch(/already exists/);
  });

  it("append refuses writes that would blow the sizeLimit", async () => {
    await handlers["mem::slot-create"]({ project: P, label: "tight", content: "", sizeLimit: 10 });
    const ok = (await handlers["mem::slot-append"]({ project: P, label: "tight", text: "short" })) as { success: boolean };
    expect(ok.success).toBe(true);
    const tooBig = (await handlers["mem::slot-append"]({ project: P, label: "tight", text: "way too long for this slot" })) as {
      success: boolean;
      error: string;
    };
    expect(tooBig.success).toBe(false);
    expect(tooBig.error).toMatch(/exceed sizeLimit/);
  });

  it("replace refuses content above sizeLimit", async () => {
    await handlers["mem::slot-create"]({ project: P, label: "tiny", content: "", sizeLimit: 5 });
    const res = (await handlers["mem::slot-replace"]({ project: P, label: "tiny", content: "exceeds" })) as {
      success: boolean;
      error: string;
    };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/exceeds/);
  });

  it("delete removes the slot", async () => {
    await handlers["mem::slot-create"]({ project: P, label: "throwaway", content: "bye" });
    const del = (await handlers["mem::slot-delete"]({ project: P, label: "throwaway" })) as { success: boolean };
    expect(del.success).toBe(true);
    const get = (await handlers["mem::slot-get"]({ project: P, label: "throwaway" })) as { success: boolean };
    expect(get.success).toBe(false);
  });

  it("project slot shadows global slot of the same label", async () => {
    // Default seed already created a global `persona`. Populate it through
    // the public handler, then create a project-scoped override through the
    // same handler so scope validation + shadowing logic is exercised end
    // to end (no direct kv.set).
    await handlers["mem::slot-replace"]({ project: P, label: "persona", content: "global-persona" });
    const createRes = (await handlers["mem::slot-create"]({ project: P,
      label: "persona",
      content: "project-override",
      scope: "project",
    })) as { success: boolean };
    expect(createRes.success).toBe(true);

    const res = (await handlers["mem::slot-get"]({ project: P, label: "persona" })) as {
      slot: { content: string };
      scope: string;
    };
    expect(res.slot.content).toBe("project-override");
    expect(res.scope).toBe("project");
  });

  it("rejects invalid sizeLimit instead of silently defaulting", async () => {
    const tooBig = (await handlers["mem::slot-create"]({ project: P,
      label: "oversize",
      sizeLimit: 99999,
    })) as { success: boolean; error: string };
    expect(tooBig.success).toBe(false);
    expect(tooBig.error).toMatch(/sizeLimit must be/);

    const negative = (await handlers["mem::slot-create"]({ project: P,
      label: "negative",
      sizeLimit: -1,
    })) as { success: boolean; error: string };
    expect(negative.success).toBe(false);

    const nonInteger = (await handlers["mem::slot-create"]({ project: P,
      label: "fractional",
      sizeLimit: 1.5,
    })) as { success: boolean; error: string };
    expect(nonInteger.success).toBe(false);
  });

  it("rejects unknown scope values", async () => {
    const res = (await handlers["mem::slot-create"]({ project: P,
      label: "bad_scope",
      scope: "wrong" as unknown as "project",
    })) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/scope must be/);
  });

  it("listPinnedSlots returns only pinned slots with content", async () => {
    await handlers["mem::slot-append"]({ project: P, label: "persona", text: "helpful senior engineer" });
    const pinned = await listPinnedSlots(kv as never, P);
    expect(pinned.some((s) => s.label === "persona")).toBe(true);
    expect(pinned.every((s) => s.pinned && s.content.trim().length > 0)).toBe(true);
  });

  it("renderPinnedContext serialises slots into markdown", async () => {
    await handlers["mem::slot-append"]({ project: P, label: "persona", text: "senior eng" });
    const pinned = await listPinnedSlots(kv as never, P);
    const rendered = renderPinnedContext(pinned);
    expect(rendered).toContain("## persona");
    expect(rendered).toContain("senior eng");
  });
});

describe("slots — reflect", () => {
  let kv: ReturnType<typeof mockKV>;
  let handlers: Record<string, (d: Record<string, unknown>) => Promise<Record<string, unknown>>>;

  beforeEach(async () => {
    ({ kv, handlers } = wire());
    await waitForSeed(kv);
  });

  it("no-ops when the session has no observations", async () => {
    const res = (await handlers["mem::slot-reflect"]({ sessionId: "empty-session" })) as {
      success: boolean;
      applied: number;
    };
    expect(res.success).toBe(true);
    expect(res.applied).toBe(0);
  });

  it("moves TODO-flavoured observations into the Session's project slots and counts patterns", async () => {
    const sessionId = "sess_reflect";
    await kv.set(KV.sessions, sessionId, { id: sessionId, project: P });
    const obsKey = KV.observations(sessionId);
    const base = {
      id: "obs1",
      sessionId,
      timestamp: new Date().toISOString(),
      type: "error" as const,
      title: "TODO: wire up retries",
      subtitle: "",
      facts: [],
      narrative: "agent left a TODO for retries",
      concepts: [],
      files: ["src/retry.ts"],
      importance: 5,
    };
    await kv.set(obsKey, "obs1", base);
    await kv.set(obsKey, "obs2", {
      ...base,
      id: "obs2",
      title: "compile error",
      narrative: "tsc failed",
      files: ["src/other.ts"],
      type: "error",
    });
    const res = (await handlers["mem::slot-reflect"]({ sessionId })) as {
      success: boolean;
      applied: number;
      observationsReviewed: number;
    };
    expect(res.success).toBe(true);
    expect(res.observationsReviewed).toBe(2);
    expect(res.applied).toBeGreaterThan(0);

    const pending = (await handlers["mem::slot-get"]({ project: P, label: "pending_items" })) as {
      slot: { content: string };
    };
    expect(pending.slot.content).toContain("TODO: wire up retries");

    const patterns = (await handlers["mem::slot-get"]({ project: P, label: "session_patterns" })) as {
      slot: { content: string };
    };
    expect(patterns.slot.content).toMatch(/errors: 2/);
  });
});

describe("slots — project scope (rohitg00/agentmemory#1108)", () => {
  let kv: ReturnType<typeof mockKV>;
  let handlers: Record<string, (d: Record<string, unknown>) => Promise<Record<string, unknown>>>;

  beforeEach(async () => {
    ({ kv, handlers } = wire());
    await waitForSeed(kv);
  });

  it("each project reads only its own project_context", async () => {
    const a = await handlers["mem::slot-append"]({ label: "project_context", text: "alpha-ctx", project: "alpha" });
    const b = await handlers["mem::slot-append"]({ label: "project_context", text: "beta-ctx", project: "beta" });
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);

    const readA = (await handlers["mem::slot-get"]({ label: "project_context", project: "alpha" })) as {
      slot: { content: string };
    };
    const readB = (await handlers["mem::slot-get"]({ label: "project_context", project: "beta" })) as {
      slot: { content: string };
    };
    expect(readA.slot.content).toBe("alpha-ctx");
    expect(readB.slot.content).toBe("beta-ctx");
  });

  it("lists pre-upgrade flat rows with content under legacy, never as a project's own slot", async () => {
    const ts = new Date().toISOString();
    const flat = (label: string, content: string) => ({
      label, content, description: "", sizeLimit: 3000, pinned: true, readOnly: false,
      scope: "project", createdAt: ts, updatedAt: ts,
    });
    await kv.set(KV.legacySlots, "project_context", flat("project_context", "old-shared-ctx"));
    await kv.set(KV.legacySlots, "guidance", flat("guidance", ""));

    const listed = (await handlers["mem::slot-list"]({ project: "alpha" })) as {
      slots: Array<{ label: string; content: string }>;
      legacy: Array<{ label: string; content: string }>;
    };
    expect(listed.legacy.map((s) => [s.label, s.content])).toEqual([["project_context", "old-shared-ctx"]]);
    expect(listed.slots.find((s) => s.label === "project_context")?.content).toBe("");

    const own = (await handlers["mem::slot-get"]({ label: "project_context", project: "alpha" })) as {
      slot: { content: string };
    };
    expect(own.slot.content).toBe("");
  });

  it("a project slot is invisible without its project", async () => {
    await handlers["mem::slot-append"]({ label: "project_context", text: "alpha-ctx", project: "alpha" });
    const res = (await handlers["mem::slot-get"]({ label: "project_context" })) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/pass project/);
  });
});
