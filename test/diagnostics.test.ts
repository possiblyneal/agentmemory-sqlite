import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ALL_CATEGORIES, registerDiagnosticsFunction } from "../src/functions/diagnostics.js";
import { getAllTools } from "../src/mcp/tools-registry.js";
import type {
  Action,
  ActionEdge,
  DiagnosticCheck,
  Lease,
  Sentinel,
  Sketch,
  Signal,
  Session,
  Memory,
  MeshPeer,
} from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

function makeAction(overrides: Partial<Action> = {}): Action {
  return {
    id: `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    title: "Test action",
    description: "",
    status: "pending",
    priority: 5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: "agent-1",
    tags: [],
    sourceObservationIds: [],
    sourceMemoryIds: [],
    ...overrides,
  };
}

function makeLease(overrides: Partial<Lease> = {}): Lease {
  return {
    id: `lease_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    actionId: "act_missing",
    agentId: "agent-1",
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "active",
    ...overrides,
  };
}

function makeEdge(overrides: Partial<ActionEdge> = {}): ActionEdge {
  return {
    id: `ae_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    type: "requires",
    sourceActionId: "src",
    targetActionId: "tgt",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSentinel(overrides: Partial<Sentinel> = {}): Sentinel {
  return {
    id: `sen_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: "Test sentinel",
    type: "timer",
    status: "watching",
    config: {},
    createdAt: new Date().toISOString(),
    linkedActionIds: [],
    ...overrides,
  };
}

function makeSketch(overrides: Partial<Sketch> = {}): Sketch {
  return {
    id: `sk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    title: "Test sketch",
    description: "",
    status: "active",
    actionIds: [],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: `sig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    from: "agent-1",
    type: "info",
    content: "test",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    project: "test",
    cwd: "/tmp",
    startedAt: new Date().toISOString(),
    status: "active",
    observationCount: 0,
    ...overrides,
  };
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    type: "fact",
    title: "Test memory",
    content: "content",
    concepts: [],
    files: [],
    sessionIds: [],
    strength: 1,
    version: 1,
    isLatest: true,
    ...overrides,
  };
}

function makePeer(overrides: Partial<MeshPeer> = {}): MeshPeer {
  return {
    id: `peer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    url: "http://localhost:3111",
    name: "Test peer",
    status: "connected",
    sharedScopes: [],
    ...overrides,
  };
}

describe("Diagnostics Functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let home = "";
  const originalHome = process.env["HOME"];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "diagnostics-home-"));
    process.env["HOME"] = home;
    sdk = mockSdk();
    kv = mockKV();
    registerDiagnosticsFunction(sdk as never, kv as never);
  });

  afterEach(() => {
    process.env["HOME"] = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  describe("mem::diagnose", () => {
    it("memory_diagnose names every category it accepts", () => {
      const tool = getAllTools().find((t) => t.name === "memory_diagnose")!;
      const listed = tool.description.match(/\(([^)]*)\)/)![1].split(", ");
      expect(listed).toEqual(ALL_CATEGORIES);
    });

    it("empty system warns that no sessions exist and passes the rest (#1166)", async () => {
      const result = (await sdk.trigger("mem::diagnose", {})) as {
        success: boolean;
        checks: DiagnosticCheck[];
        summary: { pass: number; warn: number; fail: number; fixable: number };
      };

      expect(result.success).toBe(true);
      // 20 checks = 8 original (actions, leases, sentinels, sketches, signals,
      // sessions, memories, mesh) + 6 added in #lesson-visibility
      // (lessons, summaries, semantic, procedural, crystals, insights) +
      // 1 added in #memory-project-scope (memory-project-coverage) +
      // 1 for observations, the last record type that had no check +
      // 1 store write probe (#1166) +
      // 1 Missed Injection record (#73) +
      // 1 Unrecalled Memory report (#76) +
      // 1 injected-item use report (#85).
      expect(result.summary.pass).toBe(19);
      expect(result.summary.warn).toBe(1);
      expect(result.summary.fail).toBe(0);
      expect(result.summary.fixable).toBe(0);
      expect(result.checks.filter((c) => c.status === "warn").map((c) => c.name)).toEqual([
        "sessions-empty",
      ]);
    });

    it("fails when the store rejects a write (#1166)", async () => {
      kv.set = async () => {
        throw new Error("SQLITE_READONLY");
      };
      const result = (await sdk.trigger("mem::diagnose", { categories: ["sessions"] })) as {
        checks: DiagnosticCheck[];
      };
      const probe = result.checks.find((c) => c.name === "store-unwritable");
      expect(probe?.status).toBe("fail");
    });

    // Guards the detection gap that let the v0.1.0 compression-orphan defect
    // run silently: observations were the only record type with no check.
    it("raw-shaped observation past the grace window produces warn", async () => {
      const session = makeSession();
      await kv.set(KV.sessions, session.id, session);
      await kv.set(KV.observations(session.id), "obs_orphan", {
        id: "obs_orphan",
        sessionId: session.id,
        timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        hookType: "post_tool_use",
        toolName: "Read",
        raw: {},
      });

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["observations"],
      })) as { checks: DiagnosticCheck[] };

      const check = result.checks.find((c) =>
        c.name.startsWith("observations-uncompressed:"),
      );
      expect(check).toBeDefined();
      expect(check!.status).toBe("warn");
      expect(check!.message).toContain("obs_orphan");
    });

    it("raw observation still inside the grace window is not flagged", async () => {
      const session = makeSession();
      await kv.set(KV.sessions, session.id, session);
      await kv.set(KV.observations(session.id), "obs_inflight", {
        id: "obs_inflight",
        sessionId: session.id,
        timestamp: new Date().toISOString(),
        hookType: "post_tool_use",
        raw: {},
      });

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["observations"],
      })) as { checks: DiagnosticCheck[] };

      expect(result.checks.find((c) => c.name === "observations-ok")).toBeDefined();
    });

    it("compressed observation is not flagged", async () => {
      const session = makeSession();
      await kv.set(KV.sessions, session.id, session);
      await kv.set(KV.observations(session.id), "obs_ok", {
        id: "obs_ok",
        sessionId: session.id,
        timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        type: "file_read",
        title: "Read foo.ts",
        narrative: "Read the file before editing it.",
        facts: ["a"],
        concepts: [],
        files: [],
        importance: 3,
      });

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["observations"],
      })) as { checks: DiagnosticCheck[] };

      expect(result.checks.find((c) => c.name === "observations-ok")).toBeDefined();
    });

    it("active action with no lease produces warn", async () => {
      const action = makeAction({ status: "active" });
      await kv.set(KV.actions, action.id, action);

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["actions"],
      })) as { checks: DiagnosticCheck[] };

      const check = result.checks.find((c) =>
        c.name.startsWith("active-no-lease:"),
      );
      expect(check).toBeDefined();
      expect(check!.status).toBe("warn");
      expect(check!.fixable).toBe(false);
    });

    it("blocked action with all deps done produces fail (fixable)", async () => {
      const dep = makeAction({ status: "done" });
      const blocked = makeAction({ status: "blocked" });
      const edge = makeEdge({
        sourceActionId: blocked.id,
        targetActionId: dep.id,
        type: "requires",
      });
      await kv.set(KV.actions, dep.id, dep);
      await kv.set(KV.actions, blocked.id, blocked);
      await kv.set(KV.actionEdges, edge.id, edge);

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["actions"],
      })) as { checks: DiagnosticCheck[] };

      const check = result.checks.find((c) =>
        c.name.startsWith("blocked-deps-done:"),
      );
      expect(check).toBeDefined();
      expect(check!.status).toBe("fail");
      expect(check!.fixable).toBe(true);
    });

    it("pending action with unsatisfied deps produces fail (fixable)", async () => {
      const dep = makeAction({ status: "active" });
      const pending = makeAction({ status: "pending" });
      const edge = makeEdge({
        sourceActionId: pending.id,
        targetActionId: dep.id,
        type: "requires",
      });
      await kv.set(KV.actions, dep.id, dep);
      await kv.set(KV.actions, pending.id, pending);
      await kv.set(KV.actionEdges, edge.id, edge);

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["actions"],
      })) as { checks: DiagnosticCheck[] };

      const check = result.checks.find((c) =>
        c.name.startsWith("pending-unsatisfied-deps:"),
      );
      expect(check).toBeDefined();
      expect(check!.status).toBe("fail");
      expect(check!.fixable).toBe(true);
    });

    it("expired active lease produces fail (fixable)", async () => {
      const action = makeAction({ status: "active" });
      const lease = makeLease({
        actionId: action.id,
        status: "active",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      await kv.set(KV.actions, action.id, action);
      await kv.set(KV.leases, lease.id, lease);

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["leases"],
      })) as { checks: DiagnosticCheck[] };

      const check = result.checks.find((c) =>
        c.name.startsWith("expired-lease:"),
      );
      expect(check).toBeDefined();
      expect(check!.status).toBe("fail");
      expect(check!.fixable).toBe(true);
    });

    it("orphaned lease (action gone) produces fail (fixable)", async () => {
      const lease = makeLease({
        actionId: "act_gone",
        status: "active",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await kv.set(KV.leases, lease.id, lease);

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["leases"],
      })) as { checks: DiagnosticCheck[] };

      const check = result.checks.find((c) =>
        c.name.startsWith("orphaned-lease:"),
      );
      expect(check).toBeDefined();
      expect(check!.status).toBe("fail");
      expect(check!.fixable).toBe(true);
    });

    it("expired watching sentinel produces fail (fixable)", async () => {
      const sentinel = makeSentinel({
        status: "watching",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      await kv.set(KV.sentinels, sentinel.id, sentinel);

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["sentinels"],
      })) as { checks: DiagnosticCheck[] };

      const check = result.checks.find((c) =>
        c.name.startsWith("expired-sentinel:"),
      );
      expect(check).toBeDefined();
      expect(check!.status).toBe("fail");
      expect(check!.fixable).toBe(true);
    });

    it("sentinel referencing missing action produces warn", async () => {
      const sentinel = makeSentinel({
        linkedActionIds: ["act_nonexistent"],
      });
      await kv.set(KV.sentinels, sentinel.id, sentinel);

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["sentinels"],
      })) as { checks: DiagnosticCheck[] };

      const check = result.checks.find((c) =>
        c.name.startsWith("sentinel-missing-action:"),
      );
      expect(check).toBeDefined();
      expect(check!.status).toBe("warn");
      expect(check!.fixable).toBe(false);
    });

    it("expired active sketch produces fail (fixable)", async () => {
      const sketch = makeSketch({
        status: "active",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      await kv.set(KV.sketches, sketch.id, sketch);

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["sketches"],
      })) as { checks: DiagnosticCheck[] };

      const check = result.checks.find((c) =>
        c.name.startsWith("expired-sketch:"),
      );
      expect(check).toBeDefined();
      expect(check!.status).toBe("fail");
      expect(check!.fixable).toBe(true);
    });

    it("expired signal produces fail (fixable)", async () => {
      const signal = makeSignal({
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      await kv.set(KV.signals, signal.id, signal);

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["signals"],
      })) as { checks: DiagnosticCheck[] };

      const check = result.checks.find((c) =>
        c.name.startsWith("expired-signal:"),
      );
      expect(check).toBeDefined();
      expect(check!.status).toBe("fail");
      expect(check!.fixable).toBe(true);
    });

    it("sessions idle over 24h collapse into one fixable warn", async () => {
      const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      for (let i = 0; i < 5; i++) {
        const session = makeSession({ status: "active", startedAt: stale });
        await kv.set(KV.sessions, session.id, session);
      }

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["sessions"],
      })) as { checks: DiagnosticCheck[] };

      const abandoned = result.checks.filter((c) => c.name.startsWith("abandoned-session"));
      expect(abandoned).toHaveLength(1);
      expect(abandoned[0]!.status).toBe("warn");
      expect(abandoned[0]!.fixable).toBe(true);
      expect(abandoned[0]!.message).toMatch(/^5 sessions/);
    });

    it("long-running session with recent activity is not abandoned", async () => {
      const session = makeSession({
        status: "active",
        startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      });
      await kv.set(KV.sessions, session.id, session);

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["sessions"],
      })) as { checks: DiagnosticCheck[] };

      expect(result.checks.some((c) => c.name === "sessions-ok")).toBe(true);
    });

    it("memory with stale isLatest produces fail (fixable)", async () => {
      const oldMemory = makeMemory({ isLatest: true });
      const newMemory = makeMemory({ supersedes: [oldMemory.id] });
      await kv.set(KV.memories, oldMemory.id, oldMemory);
      await kv.set(KV.memories, newMemory.id, newMemory);

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["memories"],
      })) as { checks: DiagnosticCheck[] };

      const check = result.checks.find((c) =>
        c.name.startsWith("memory-stale-latest:"),
      );
      expect(check).toBeDefined();
      expect(check!.status).toBe("fail");
      expect(check!.fixable).toBe(true);
    });

    it("memory superseding non-existent produces warn", async () => {
      const memory = makeMemory({ supersedes: ["mem_gone"] });
      await kv.set(KV.memories, memory.id, memory);

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["memories"],
      })) as { checks: DiagnosticCheck[] };

      const check = result.checks.find((c) =>
        c.name.startsWith("memory-missing-supersedes:"),
      );
      expect(check).toBeDefined();
      expect(check!.status).toBe("warn");
      expect(check!.fixable).toBe(false);
    });

    it("stale mesh peer produces warn", async () => {
      const peer = makePeer({
        lastSyncAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      });
      await kv.set(KV.mesh, peer.id, peer);

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["mesh"],
      })) as { checks: DiagnosticCheck[] };

      const check = result.checks.find((c) =>
        c.name.startsWith("stale-peer:"),
      );
      expect(check).toBeDefined();
      expect(check!.status).toBe("warn");
      expect(check!.fixable).toBe(false);
    });

    it("error mesh peer produces warn", async () => {
      const peer = makePeer({ status: "error" });
      await kv.set(KV.mesh, peer.id, peer);

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["mesh"],
      })) as { checks: DiagnosticCheck[] };

      const check = result.checks.find((c) =>
        c.name.startsWith("error-peer:"),
      );
      expect(check).toBeDefined();
      expect(check!.status).toBe("warn");
      expect(check!.fixable).toBe(false);
    });

    it("filters by categories", async () => {
      const action = makeAction({ status: "active" });
      await kv.set(KV.actions, action.id, action);

      const signal = makeSignal({
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      await kv.set(KV.signals, signal.id, signal);

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["signals"],
      })) as { checks: DiagnosticCheck[] };

      expect(result.checks.every((c) => c.category === "signals")).toBe(true);
      expect(
        result.checks.some((c) => c.category === "actions"),
      ).toBe(false);
    });
  });

  describe("mem::diagnose injections (#73)", () => {
    function writeRecord(entries: Array<{ at: string; hook: string; reason: string }>) {
      mkdirSync(join(home, ".agentmemory"), { recursive: true });
      writeFileSync(
        join(home, ".agentmemory", "missed-injections.jsonl"),
        entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
    }

    async function injectionChecks() {
      const result = (await sdk.trigger("mem::diagnose", { categories: ["injections"] })) as {
        checks: DiagnosticCheck[];
      };
      return result.checks;
    }

    it("passes when no Missed Injection was recorded", async () => {
      const [check] = await injectionChecks();
      expect(check.name).toBe("injections-ok");
      expect(check.status).toBe("pass");
    });

    it("warns with counts by hook and reason for the last 24h only", async () => {
      const recent = new Date(Date.now() - 60_000).toISOString();
      const stale = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      writeRecord([
        { at: recent, hook: "session-start", reason: "connection" },
        { at: recent, hook: "session-start", reason: "connection" },
        { at: recent, hook: "pre-tool-use", reason: "timeout" },
        { at: stale, hook: "pre-compact", reason: "http_500" },
      ]);
      const [check] = await injectionChecks();
      expect(check.name).toBe("missed-injections");
      expect(check.status).toBe("warn");
      expect(check.message).toBe(
        "3 Missed Injections in the last 24h: session-start/connection 2, pre-tool-use/timeout 1",
      );
    });
  });

  describe("mem::diagnose injection-use (#85)", () => {
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
    const memoryRefs = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        kind: "memory" as const, id: `mem_${i}`, files: [`src/f${i}.ts`],
      }));

    async function seedRecord(
      id: string,
      source: "session-start" | "context" | "enrich",
      sessionId: string,
      injected: Array<{ kind: "observation" | "memory" | "lesson"; id: string; files?: string[] }>,
      at = minutesAgo(90),
    ) {
      await kv.set(KV.injections, id, { id, source, sessionId, injected, tokens: 10, at });
    }

    async function seedTouch(sessionId: string, id: string, files: string[], at = minutesAgo(30)) {
      await kv.set(KV.observations(sessionId), id, {
        id, sessionId, timestamp: at, type: "file_edit", title: "Edit", narrative: "",
        facts: [], concepts: [], files, importance: 5,
      });
    }

    async function useCheck() {
      const result = (await sdk.trigger("mem::diagnose", { categories: ["injection-use"] })) as {
        checks: DiagnosticCheck[];
      };
      expect(result.checks).toHaveLength(1);
      return result.checks[0];
    }

    it("passes with nothing to judge when no Injection carried anything", async () => {
      await seedRecord("r1", "context", "s1", []);
      const check = await useCheck();
      expect(check.name).toBe("injection-use-ok");
      expect(check.status).toBe("pass");
    });

    it("warns with a per-path share, the threshold, and a proxy note when most items went unused", async () => {
      await seedRecord("r1", "session-start", "s1", memoryRefs(10));
      await seedTouch("s1", "obs_1", ["src/f0.ts"]);

      const check = await useCheck();

      expect(check.name).toBe("unused-injections");
      expect(check.status).toBe("warn");
      expect(check.message).toContain("90% of 10 injected items unused");
      expect(check.message).toContain("session-start 90% of 10");
      expect(check.message).toContain("warns above 50%");
      expect(check.message).toContain("This is a proxy");
    });

    it("passes when most injected items were used", async () => {
      const refs = memoryRefs(10);
      await seedRecord("r1", "context", "s1", refs);
      await seedTouch("s1", "obs_1", refs.slice(0, 8).flatMap((r) => r.files));

      const check = await useCheck();

      expect(check.name).toBe("injection-use-ok");
      expect(check.message).toContain("20% of 10 injected items unused");
    });

    it("ignores records older than 24h", async () => {
      await seedRecord("r1", "context", "s1", memoryRefs(10), minutesAgo(25 * 60));
      expect((await useCheck()).name).toBe("injection-use-ok");
    });

    it("gives an Injection an hour to be used before scoring it", async () => {
      await seedRecord("r1", "context", "s1", memoryRefs(10), minutesAgo(5));
      expect((await useCheck()).message).toContain("No scorable injected items");
    });

    it("does not score items that carry no files", async () => {
      const lessons = Array.from({ length: 10 }, (_, i) => ({ kind: "lesson" as const, id: `les_${i}` }));
      await seedRecord("r1", "context", "s1", lessons);
      expect((await useCheck()).message).toContain("No scorable injected items");
    });

    it("tolerates an Observation still awaiting compression", async () => {
      await seedRecord("r1", "context", "s1", memoryRefs(10));
      await kv.set(KV.observations("s1"), "raw_1", {
        id: "raw_1", sessionId: "s1", timestamp: minutesAgo(30), hookType: "post_tool_use",
      });
      expect((await useCheck()).message).toContain("100% of 10 injected items unused");
    });

    it("never lets another Session's Observations mark an item used", async () => {
      const refs = memoryRefs(10);
      await seedRecord("r1", "context", "s1", refs);
      await seedTouch("s2", "obs_other", refs.flatMap((r) => r.files));
      expect((await useCheck()).message).toContain("100% of 10 injected items unused");
    });
  });

  describe("mem::diagnose recall-coverage (#76)", () => {
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

    function mondayWeeksAgo(n: number): string {
      const t = new Date(Date.now() - n * WEEK_MS);
      t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
      return t.toISOString().slice(0, 10);
    }

    async function activeWeeks(project: string, weeksAgo: number[]) {
      await kv.set(KV.projectActivity, project, { project, weeks: weeksAgo.map(mondayWeeksAgo).sort() });
    }

    async function seedMemory(id: string, project: string, weeksOld: number, overrides: Partial<Memory> = {}) {
      const createdAt = new Date(Date.now() - weeksOld * WEEK_MS).toISOString();
      await kv.set(KV.memories, id, {
        id, createdAt, updatedAt: createdAt, type: "fact", title: `title ${id}`, content: "c",
        concepts: [], files: [], sessionIds: [], strength: 1, version: 1, isLatest: true, project,
        ...overrides,
      });
    }

    async function coverageCheck() {
      const result = (await sdk.trigger("mem::diagnose", { categories: ["recall-coverage"] })) as {
        checks: DiagnosticCheck[];
      };
      expect(result.checks).toHaveLength(1);
      return result.checks[0];
    }

    it("warns on a Memory past 4 active weeks that no Recall returned", async () => {
      await activeWeeks("p", [0, 1, 2, 3, 4, 5]);
      await seedMemory("mem_old", "p", 8);
      const check = await coverageCheck();
      expect(check.name).toBe("unrecalled-memories");
      expect(check.status).toBe("warn");
      expect(check.message).toContain("1 Unrecalled Memory");
      expect(check.message).toContain("mem_old");
    });

    it("does not count a Memory some Recall returned", async () => {
      await activeWeeks("p", [0, 1, 2, 3, 4, 5]);
      await seedMemory("mem_old", "p", 8);
      await kv.set(KV.accessLog, "mem_old", { memoryId: "mem_old", count: 1, lastAt: "", recent: [] });
      expect((await coverageCheck()).name).toBe("recall-coverage-ok");
    });

    it("measures the grace period in Project Time, so a paused project reports nothing", async () => {
      await activeWeeks("p", [20, 21]);
      await seedMemory("mem_paused", "p", 26);
      expect((await coverageCheck()).name).toBe("recall-coverage-ok");
    });

    it("does not count a Memory still inside its grace period", async () => {
      await activeWeeks("p", [0, 1, 2]);
      await seedMemory("mem_young", "p", 8);
      expect((await coverageCheck()).status).toBe("pass");
    });

    it("skips superseded Memories", async () => {
      await activeWeeks("p", [0, 1, 2, 3, 4, 5]);
      await seedMemory("mem_old", "p", 8, { isLatest: false });
      expect((await coverageCheck()).status).toBe("pass");
    });

    it("names a bounded sample, not every Unrecalled Memory", async () => {
      await activeWeeks("p", [0, 1, 2, 3, 4, 5]);
      for (let i = 0; i < 12; i++) await seedMemory(`mem_${i}`, "p", 8);
      const check = await coverageCheck();
      expect(check.message).toContain("12 Unrecalled Memories");
      expect(check.message.match(/mem_\d+ \(/g)).toHaveLength(5);
    });
  });

  describe("mem::heal", () => {
    it("unblocks stuck blocked action", async () => {
      const dep = makeAction({ status: "done" });
      const blocked = makeAction({ status: "blocked", title: "Stuck task" });
      const edge = makeEdge({
        sourceActionId: blocked.id,
        targetActionId: dep.id,
        type: "requires",
      });
      await kv.set(KV.actions, dep.id, dep);
      await kv.set(KV.actions, blocked.id, blocked);
      await kv.set(KV.actionEdges, edge.id, edge);

      const result = (await sdk.trigger("mem::heal", {
        categories: ["actions"],
      })) as { success: boolean; fixed: number; details: string[] };

      expect(result.success).toBe(true);
      expect(result.fixed).toBe(1);
      expect(result.details[0]).toContain("Unblocked");

      const updated = await kv.get<Action>(KV.actions, blocked.id);
      expect(updated!.status).toBe("pending");
    });

    it("blocks pending action with unsatisfied deps", async () => {
      const dep = makeAction({ status: "active" });
      const pending = makeAction({
        status: "pending",
        title: "Should be blocked",
      });
      const edge = makeEdge({
        sourceActionId: pending.id,
        targetActionId: dep.id,
        type: "requires",
      });
      await kv.set(KV.actions, dep.id, dep);
      await kv.set(KV.actions, pending.id, pending);
      await kv.set(KV.actionEdges, edge.id, edge);

      const result = (await sdk.trigger("mem::heal", {
        categories: ["actions"],
      })) as { success: boolean; fixed: number; details: string[] };

      expect(result.success).toBe(true);
      expect(result.fixed).toBe(1);
      expect(result.details[0]).toContain("Blocked");

      const updated = await kv.get<Action>(KV.actions, pending.id);
      expect(updated!.status).toBe("blocked");
    });

    it("expires stale lease and resets action", async () => {
      const action = makeAction({
        status: "active",
        assignedTo: "agent-1",
      });
      const lease = makeLease({
        actionId: action.id,
        agentId: "agent-1",
        status: "active",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      await kv.set(KV.actions, action.id, action);
      await kv.set(KV.leases, lease.id, lease);

      const result = (await sdk.trigger("mem::heal", {
        categories: ["leases"],
      })) as { success: boolean; fixed: number; details: string[] };

      expect(result.success).toBe(true);
      expect(result.fixed).toBe(1);
      expect(result.details[0]).toContain("Expired lease");

      const updatedLease = await kv.get<Lease>(KV.leases, lease.id);
      expect(updatedLease!.status).toBe("expired");

      const updatedAction = await kv.get<Action>(KV.actions, action.id);
      expect(updatedAction!.status).toBe("pending");
      expect(updatedAction!.assignedTo).toBeUndefined();
    });

    it("deletes orphaned lease", async () => {
      const lease = makeLease({
        actionId: "act_gone",
        status: "released",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await kv.set(KV.leases, lease.id, lease);

      const result = (await sdk.trigger("mem::heal", {
        categories: ["leases"],
      })) as { success: boolean; fixed: number; details: string[] };

      expect(result.success).toBe(true);
      expect(result.fixed).toBe(1);
      expect(result.details[0]).toContain("Deleted orphaned lease");

      const deleted = await kv.get<Lease>(KV.leases, lease.id);
      expect(deleted).toBeNull();
    });

    it("expires stale sentinel", async () => {
      const sentinel = makeSentinel({
        status: "watching",
        name: "Stale watcher",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      await kv.set(KV.sentinels, sentinel.id, sentinel);

      const result = (await sdk.trigger("mem::heal", {
        categories: ["sentinels"],
      })) as { success: boolean; fixed: number; details: string[] };

      expect(result.success).toBe(true);
      expect(result.fixed).toBe(1);
      expect(result.details[0]).toContain("Expired sentinel");

      const updated = await kv.get<Sentinel>(KV.sentinels, sentinel.id);
      expect(updated!.status).toBe("expired");
    });

    it("closes abandoned session at its last activity without touching live ones", async () => {
      const lastSeen = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
      const abandoned = makeSession({
        status: "active",
        startedAt: new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString(),
        updatedAt: lastSeen,
      });
      const live = makeSession({ status: "active", startedAt: new Date().toISOString() });
      await kv.set(KV.sessions, abandoned.id, abandoned);
      await kv.set(KV.sessions, live.id, live);

      const result = (await sdk.trigger("mem::heal", {
        categories: ["sessions"],
      })) as { success: boolean; fixed: number; details: string[] };

      expect(result.fixed).toBe(1);
      expect(result.details[0]).toContain("Closed abandoned session");
      const closed = await kv.get<Session>(KV.sessions, abandoned.id);
      expect(closed!.status).toBe("abandoned");
      expect(closed!.endedAt).toBe(lastSeen);
      expect((await kv.get<Session>(KV.sessions, live.id))!.status).toBe("active");
    });

    it("dry run reports but does not fix", async () => {
      const dep = makeAction({ status: "done" });
      const blocked = makeAction({ status: "blocked", title: "Stuck task" });
      const edge = makeEdge({
        sourceActionId: blocked.id,
        targetActionId: dep.id,
        type: "requires",
      });
      await kv.set(KV.actions, dep.id, dep);
      await kv.set(KV.actions, blocked.id, blocked);
      await kv.set(KV.actionEdges, edge.id, edge);

      const result = (await sdk.trigger("mem::heal", {
        categories: ["actions"],
        dryRun: true,
      })) as { success: boolean; fixed: number; details: string[] };

      expect(result.success).toBe(true);
      expect(result.fixed).toBe(1);
      expect(result.details[0]).toContain("[dry-run]");

      const unchanged = await kv.get<Action>(KV.actions, blocked.id);
      expect(unchanged!.status).toBe("blocked");
    });
  });

  describe("per-store tally categories (#lesson-visibility)", () => {
    it("lessons category: passes with valid live lessons + ignores tombstoned", async () => {
      await kv.set(KV.lessons, "lsn_live", {
        id: "lsn_live", content: "x", context: "", confidence: 0.8,
        reinforcements: 0, source: "manual", sourceIds: [], tags: [],
        createdAt: "", updatedAt: "", decayRate: 0.05,
      });
      await kv.set(KV.lessons, "lsn_tomb", {
        id: "lsn_tomb", content: "x", context: "", confidence: 0.5,
        reinforcements: 0, source: "manual", sourceIds: [], tags: [],
        createdAt: "", updatedAt: "", decayRate: 0.05, deleted: true,
      });

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["lessons"],
      })) as { checks: DiagnosticCheck[] };

      const ok = result.checks.find((c) => c.name === "lessons-ok");
      expect(ok?.status).toBe("pass");
      expect(ok?.message).toMatch(/All 1 lessons.*1 tombstoned/);
    });

    it("lessons category: warns on out-of-range confidence", async () => {
      await kv.set(KV.lessons, "lsn_bad", {
        id: "lsn_bad", content: "x", context: "", confidence: 1.5,
        reinforcements: 0, source: "manual", sourceIds: [], tags: [],
        createdAt: "", updatedAt: "", decayRate: 0.05,
      });

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["lessons"],
      })) as { checks: DiagnosticCheck[] };

      const warn = result.checks.find((c) => c.name.startsWith("lesson-bad-confidence:"));
      expect(warn?.status).toBe("warn");
    });

    it("summaries category: warns on missing title", async () => {
      await kv.set(KV.summaries, "ses_1", {
        sessionId: "ses_1", project: "p", createdAt: "", title: "",
        narrative: "n", keyDecisions: [], filesModified: [], concepts: [],
        observationCount: 1,
      });

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["summaries"],
      })) as { checks: DiagnosticCheck[] };

      const warn = result.checks.find((c) => c.name.startsWith("summary-missing-title:"));
      expect(warn?.status).toBe("warn");
    });

    it("procedural category: warns on empty steps", async () => {
      await kv.set(KV.procedural, "proc_1", {
        id: "proc_1", name: "noop", steps: [], triggerCondition: "x",
        frequency: 1, sourceSessionIds: [], strength: 0.5,
        createdAt: "", updatedAt: "",
      });

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["procedural"],
      })) as { checks: DiagnosticCheck[] };

      const warn = result.checks.find((c) => c.name.startsWith("procedural-empty-steps:"));
      expect(warn?.status).toBe("warn");
    });

    it("crystals category: warns on empty narrative", async () => {
      await kv.set(KV.crystals, "cry_1", {
        id: "cry_1", narrative: "", keyOutcomes: [], filesAffected: [],
        lessons: [], sourceActionIds: [], createdAt: "",
      });

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["crystals"],
      })) as { checks: DiagnosticCheck[] };

      const warn = result.checks.find((c) => c.name.startsWith("crystal-empty-narrative:"));
      expect(warn?.status).toBe("warn");
    });

    it("insights category: warns on out-of-range confidence", async () => {
      await kv.set(KV.insights, "ins_bad", {
        id: "ins_bad", title: "t", content: "c", confidence: -0.1,
        reinforcements: 0, sourceConceptCluster: [], sourceMemoryIds: [],
        sourceLessonIds: [], sourceCrystalIds: [], tags: [],
        createdAt: "", updatedAt: "", decayRate: 0.05,
      });

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["insights"],
      })) as { checks: DiagnosticCheck[] };

      const warn = result.checks.find((c) => c.name.startsWith("insight-bad-confidence:"));
      expect(warn?.status).toBe("warn");
    });

    it("semantic category: warns on out-of-range confidence", async () => {
      await kv.set(KV.semantic, "sem_bad", {
        id: "sem_bad", fact: "f", confidence: 2.0, sourceSessionIds: [],
        sourceMemoryIds: [], accessCount: 0, lastAccessedAt: "",
        strength: 0, createdAt: "", updatedAt: "",
      });

      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["semantic"],
      })) as { checks: DiagnosticCheck[] };

      const warn = result.checks.find((c) => c.name.startsWith("semantic-bad-confidence:"));
      expect(warn?.status).toBe("warn");
    });

    it("categories filter accepts new categories and skips others", async () => {
      const result = (await sdk.trigger("mem::diagnose", {
        categories: ["lessons", "summaries"],
      })) as { checks: DiagnosticCheck[] };

      expect(result.checks.every((c) => c.category === "lessons" || c.category === "summaries")).toBe(true);
      expect(result.checks.some((c) => c.category === "lessons")).toBe(true);
      expect(result.checks.some((c) => c.category === "summaries")).toBe(true);
    });

    describe("defensive row-shape handling (CodeRabbit #473 review)", () => {
      it("NaN/Infinity confidence on a lesson is flagged as warn, not silently passed", async () => {
        await kv.set(KV.lessons, "lsn_nan", {
          id: "lsn_nan", content: "x", context: "", confidence: NaN,
          reinforcements: 0, source: "manual", sourceIds: [], tags: [],
          createdAt: "", updatedAt: "", decayRate: 0.05,
        });

        const result = (await sdk.trigger("mem::diagnose", {
          categories: ["lessons"],
        })) as { checks: DiagnosticCheck[] };

        const warn = result.checks.find((c) => c.name.startsWith("lesson-bad-confidence:"));
        expect(warn?.status).toBe("warn");
      });

      it("non-string summary title doesn't throw — surfaces as warn", async () => {
        await kv.set(KV.summaries, "ses_bad_title", {
          sessionId: "ses_bad_title",
          project: "p",
          createdAt: "",
          title: null as unknown as string, // simulate corrupted row
          narrative: "n",
          keyDecisions: [],
          filesModified: [],
          concepts: [],
          observationCount: 1,
        });

        // The bug to guard against: the old code called .trim() unconditionally,
        // which throws on null/number, which aborts the whole diagnose run and
        // any later category check never executes. Verify diagnose completes
        // AND surfaces the bad row.
        const result = (await sdk.trigger("mem::diagnose", {
          categories: ["summaries", "lessons"],
        })) as { checks: DiagnosticCheck[]; success?: boolean };

        expect(result.success).toBe(true);
        const warn = result.checks.find((c) => c.name.startsWith("summary-missing-title:"));
        expect(warn?.status).toBe("warn");
        // Later category still ran:
        expect(result.checks.some((c) => c.category === "lessons")).toBe(true);
      });

      it("non-string crystal narrative doesn't throw — surfaces as warn", async () => {
        await kv.set(KV.crystals, "cry_bad", {
          id: "cry_bad",
          narrative: undefined as unknown as string,
          keyOutcomes: [],
          filesAffected: [],
          lessons: [],
          sourceActionIds: [],
          createdAt: "",
        });

        const result = (await sdk.trigger("mem::diagnose", {
          categories: ["crystals"],
        })) as { checks: DiagnosticCheck[]; success?: boolean };

        expect(result.success).toBe(true);
        const warn = result.checks.find((c) => c.name.startsWith("crystal-empty-narrative:"));
        expect(warn?.status).toBe("warn");
      });

      it("Infinity confidence on insight + semantic both flagged", async () => {
        await kv.set(KV.insights, "ins_inf", {
          id: "ins_inf",
          title: "t",
          content: "c",
          confidence: Infinity,
          reinforcements: 0,
          sourceConceptCluster: [],
          sourceMemoryIds: [],
          sourceLessonIds: [],
          sourceCrystalIds: [],
          tags: [],
          createdAt: "",
          updatedAt: "",
          decayRate: 0.05,
        });
        await kv.set(KV.semantic, "sem_nan", {
          id: "sem_nan",
          fact: "f",
          confidence: NaN,
          sourceSessionIds: [],
          sourceMemoryIds: [],
          accessCount: 0,
          lastAccessedAt: "",
          strength: 0,
          createdAt: "",
          updatedAt: "",
        });

        const result = (await sdk.trigger("mem::diagnose", {
          categories: ["insights", "semantic"],
        })) as { checks: DiagnosticCheck[] };

        expect(result.checks.find((c) => c.name === "insight-bad-confidence:ins_inf")?.status).toBe("warn");
        expect(result.checks.find((c) => c.name === "semantic-bad-confidence:sem_nan")?.status).toBe("warn");
      });
    });
  });
});
