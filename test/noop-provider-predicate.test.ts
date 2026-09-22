import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/schema.js", () => ({
  KV: {
    sessions: "sessions",
    summaries: "summaries",
    observations: (sessionId: string) => `obs:${sessionId}`,
    audit: "audit",
  },
}));

vi.mock("../src/eval/schemas.js", () => ({ SummaryOutputSchema: {} }));
vi.mock("../src/eval/validator.js", () => ({
  validateOutput: () => ({ valid: true, result: { errors: [] } }),
}));
vi.mock("../src/eval/quality.js", () => ({ scoreSummary: () => 100 }));
vi.mock("../src/functions/audit.js", () => ({ safeAudit: vi.fn() }));

import { isNoopProvider, NoopProvider } from "../src/providers/noop.js";
import { ResilientProvider } from "../src/providers/resilient.js";
import { registerSummarizeFunction } from "../src/functions/summarize.js";
import type { MemoryProvider, Session, CompressedObservation } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async () => {},
    list: async <T>(scope: string): Promise<T[]> =>
      Array.from(store.get(scope)?.values() ?? []) as T[],
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    functions,
    registerFunction: (id: string, handler: Function) => {
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async () => ({}),
  };
}

function namedProvider(name: string) {
  const calls: string[] = [];
  const provider: MemoryProvider & { calls: string[] } = {
    name,
    calls,
    compress: async () => {
      calls.push("compress");
      return "";
    },
    summarize: async () => {
      calls.push("summarize");
      return "";
    },
  };
  return provider;
}

describe("isNoopProvider", () => {
  it("matches the bare no-op provider", () => {
    expect(isNoopProvider(new NoopProvider())).toBe(true);
  });

  it("matches the no-op provider inside the resilient wrapper", () => {
    expect(isNoopProvider(new ResilientProvider(new NoopProvider()))).toBe(true);
    expect(isNoopProvider(namedProvider("resilient(noop)"))).toBe(true);
  });

  it("rejects real providers and chains that merely contain a no-op", () => {
    expect(isNoopProvider(namedProvider("resilient(openai)"))).toBe(false);
    expect(isNoopProvider(namedProvider("resilient(fallback(noop -> agent-sdk))"))).toBe(false);
    expect(isNoopProvider(namedProvider("noopish"))).toBe(false);
  });
});

describe("mem::summarize with a wrapped no-op provider", () => {
  it("returns no_provider without calling the provider", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const sessionId = "ses_keyless";
    const session: Session = {
      id: sessionId,
      project: "p",
      cwd: "/tmp",
      startedAt: new Date().toISOString(),
      status: "completed",
      observationCount: 1,
    };
    await kv.set("sessions", sessionId, session);
    const obs: CompressedObservation = {
      id: "obs_0",
      sessionId,
      timestamp: new Date().toISOString(),
      type: "conversation",
      title: "obs 0",
      facts: [],
      narrative: "n",
      concepts: [],
      files: [],
      importance: 5,
    };
    await kv.set(`obs:${sessionId}`, obs.id, obs);

    const provider = namedProvider("resilient(noop)");
    registerSummarizeFunction(sdk as any, kv as any, provider);
    const result = await sdk.functions.get("mem::summarize")!({ sessionId });

    expect(result).toMatchObject({ success: false, error: "no_provider" });
    expect(provider.calls).toEqual([]);
  });
});
