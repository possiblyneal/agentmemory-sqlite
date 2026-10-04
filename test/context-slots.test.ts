import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerContextFunction } from "../src/functions/context.js";
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

type ContextHandler = (data: {
  sessionId: string;
  project: string;
  budget?: number;
}) => Promise<{ context: string; blocks: number; tokens: number }>;

function wireContext(kv: ReturnType<typeof mockKV>) {
  let handler: ContextHandler | undefined;
  const sdk = {
    registerFunction: vi.fn((id: string, cb: ContextHandler) => {
      if (id === "mem::context") handler = cb;
    }),
  } as unknown as import("../src/engine/types.js").ISdk;
  registerContextFunction(sdk, kv as never, 2000);
  if (!handler) throw new Error("mem::context not registered");
  return handler;
}

async function seedPinnedSlot(
  kv: ReturnType<typeof mockKV>,
  label: string,
  content: string,
  scope: "project" | "global" = "global",
  project = "/tmp/proj",
) {
  const target = scope === "global" ? KV.globalSlots : KV.projectSlots(project);
  await kv.set(target, label, {
    label,
    content,
    description: "",
    sizeLimit: 2000,
    pinned: true,
    readOnly: false,
    scope,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

describe("mem::context — pinned slot injection", () => {
  const ORIGINAL_SLOTS_ENV = process.env["AGENTMEMORY_SLOTS"];

  afterEach(() => {
    if (ORIGINAL_SLOTS_ENV === undefined) {
      delete process.env["AGENTMEMORY_SLOTS"];
    } else {
      process.env["AGENTMEMORY_SLOTS"] = ORIGINAL_SLOTS_ENV;
    }
  });

  describe("when AGENTMEMORY_SLOTS=true", () => {
    let kv: ReturnType<typeof mockKV>;
    let handler: ContextHandler;

    beforeEach(() => {
      process.env["AGENTMEMORY_SLOTS"] = "true";
      kv = mockKV();
      handler = wireContext(kv);
    });

    it("includes pinned global slot content in returned context", async () => {
      await seedPinnedSlot(kv, "tool_guidelines", "rule-alpha", "global");

      const result = await handler({
        sessionId: "ses_a",
        project: "/tmp/proj",
      });

      expect(result.context).toContain("tool_guidelines");
      expect(result.context).toContain("rule-alpha");
      expect(result.blocks).toBeGreaterThan(0);
    });

    it("truncates pinned slots that exceed the budget instead of dropping them (#1333)", async () => {
      await seedPinnedSlot(kv, "tool_guidelines", "rule-alpha " + "x".repeat(3000), "global");

      const result = await handler({
        sessionId: "ses_big",
        project: "/tmp/proj",
        budget: 300,
      });

      expect(result.context).toContain("rule-alpha");
      expect(result.context).toContain("[pinned slots truncated to fit the context budget]");
      expect(result.tokens).toBeLessThanOrEqual(300);
    });

    it("renders multiple pinned slots, sorted by label", async () => {
      await seedPinnedSlot(kv, "user_preferences", "pref-alpha", "global");
      await seedPinnedSlot(kv, "tool_guidelines", "rule-alpha", "global");

      const result = await handler({
        sessionId: "ses_b",
        project: "/tmp/proj",
      });

      const guidelinesIdx = result.context.indexOf("tool_guidelines");
      const prefsIdx = result.context.indexOf("user_preferences");
      expect(guidelinesIdx).toBeGreaterThan(-1);
      expect(prefsIdx).toBeGreaterThan(-1);
      expect(guidelinesIdx).toBeLessThan(prefsIdx);
    });

    it("skips unpinned slots even when they have content", async () => {
      await kv.set(KV.globalSlots, "self_notes", {
        label: "self_notes",
        content: "unpinned-content-alpha",
        description: "",
        sizeLimit: 1500,
        pinned: false,
        readOnly: false,
        scope: "global",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const result = await handler({
        sessionId: "ses_c",
        project: "/tmp/proj",
      });

      expect(result.context).not.toContain("unpinned-content-alpha");
    });

    it("skips empty pinned slots (the seeded defaults)", async () => {
      await seedPinnedSlot(kv, "persona", "", "global");

      const result = await handler({
        sessionId: "ses_d",
        project: "/tmp/proj",
      });

      expect(result.context).not.toContain("persona");
    });

    it("project-scoped slot shadows global slot with the same label", async () => {
      await seedPinnedSlot(kv, "tool_guidelines", "global-value", "global");
      await seedPinnedSlot(kv, "tool_guidelines", "project-value", "project");

      const result = await handler({
        sessionId: "ses_e",
        project: "/tmp/proj",
      });

      expect(result.context).toContain("project-value");
      expect(result.context).not.toContain("global-value");
    });

    it("injects only the Session's own project slots, plus global slots in every project (rohitg00/agentmemory#1108)", async () => {
      await seedPinnedSlot(kv, "user_preferences", "pref-shared", "global");
      await seedPinnedSlot(kv, "project_context", "alpha-ctx", "project", "alpha");
      await seedPinnedSlot(kv, "project_context", "beta-ctx", "project", "beta");

      const a = await handler({ sessionId: "ses_a1", project: "alpha" });
      const b = await handler({ sessionId: "ses_b1", project: "beta" });

      expect(a.context).toContain("pref-shared");
      expect(b.context).toContain("pref-shared");
      expect(a.context).toContain("alpha-ctx");
      expect(a.context).not.toContain("beta-ctx");
      expect(b.context).toContain("beta-ctx");
      expect(b.context).not.toContain("alpha-ctx");
    });

    it("trims the Session's project the way the slot tools do", async () => {
      await seedPinnedSlot(kv, "project_context", "alpha-ctx", "project", "alpha");

      const result = await handler({ sessionId: "ses_t", project: " alpha " });

      expect(result.context).toContain("alpha-ctx");
    });

    it("never injects pre-upgrade flat project slots", async () => {
      await kv.set(KV.legacySlots, "project_context", {
        label: "project_context",
        content: "legacy-flat-ctx",
        description: "",
        sizeLimit: 3000,
        pinned: true,
        readOnly: false,
        scope: "project",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const result = await handler({ sessionId: "ses_l", project: "alpha" });

      expect(result.context).not.toContain("legacy-flat-ctx");
    });
  });

  describe("when AGENTMEMORY_SLOTS is off", () => {
    it("does not include any slot content", async () => {
      delete process.env["AGENTMEMORY_SLOTS"];
      const kv = mockKV();
      const handler = wireContext(kv);

      await seedPinnedSlot(kv, "tool_guidelines", "rule-alpha", "global");

      const result = await handler({
        sessionId: "ses_f",
        project: "/tmp/proj",
      });

      expect(result.context).not.toContain("tool_guidelines");
      expect(result.context).not.toContain("rule-alpha");
    });
  });
});

describe("mem::context — contentless Observations", () => {
  it("leaves out Observations with an empty narrative", async () => {
    const kv = mockKV();
    const handler = wireContext(kv);
    await kv.set(KV.sessions, "ses_old", {
      id: "ses_old",
      project: "/tmp/proj",
      startedAt: new Date().toISOString(),
      status: "completed",
    });
    const obs = (id: string, title: string, narrative: string) => ({
      id,
      sessionId: "ses_old",
      timestamp: new Date().toISOString(),
      type: "other",
      title,
      facts: [],
      narrative,
      concepts: [],
      files: [],
      importance: 5,
      confidence: 0.3,
    });
    await kv.set(KV.observations("ses_old"), "o1", obs("o1", "empty-title", ""));
    await kv.set(KV.observations("ses_old"), "o2", obs("o2", "blank-title", "   "));
    await kv.set(KV.observations("ses_old"), "o3", obs("o3", "real-title", "real narrative"));

    const result = await handler({ sessionId: "ses_new", project: "/tmp/proj" });

    expect(result.context).toContain("real-title");
    expect(result.context).not.toContain("empty-title");
    expect(result.context).not.toContain("blank-title");
  });
});
