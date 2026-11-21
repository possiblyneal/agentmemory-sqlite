import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createProjectMatcher } from "../src/functions/search.js";
import { KV } from "../src/state/schema.js";
import type { StateKV } from "../src/state/kv.js";

function makeKV(seed: Record<string, Record<string, unknown>>, failScopes: string[] = []) {
  const reads: string[] = [];
  const kv = {
    get: async (scope: string, key: string) => {
      reads.push(scope);
      if (failScopes.includes(scope)) throw new Error("read failed");
      return seed[scope]?.[key] ?? null;
    },
  } as unknown as StateKV;
  return { kv, reads };
}

describe("createProjectMatcher with a Memory", () => {
  it("excludes a non-Global Memory with no project, Session or Summary", async () => {
    const { kv } = makeKV({ [KV.memories]: { mem_a: { id: "mem_a" } } });
    expect(await createProjectMatcher(kv, "alpha")("memory", "mem_a")).toBe(false);
  });

  it("still passes an Observation with no project, Session or Summary", async () => {
    const { kv } = makeKV({});
    expect(await createProjectMatcher(kv, "alpha")("gone", "obs_a")).toBe(true);
  });

  it("passes a Global Memory", async () => {
    const { kv } = makeKV({ [KV.memories]: { mem_g: { id: "mem_g", global: true } } });
    expect(await createProjectMatcher(kv, "alpha")("memory", "mem_g")).toBe(true);
  });

  it("matches an explicit project without reading a Session", async () => {
    const { kv, reads } = makeKV({
      [KV.memories]: { mem_p: { id: "mem_p", project: "alpha" } },
      [KV.sessions]: { memory: { id: "memory", project: "beta" } },
    });
    expect(await createProjectMatcher(kv, "alpha")("memory", "mem_p")).toBe(true);
    expect(reads).not.toContain(KV.sessions);
  });

  it("does not fail when the Session read fails and the Memory names its project", async () => {
    const { kv } = makeKV(
      { [KV.memories]: { mem_p: { id: "mem_p", project: "alpha" } } },
      [KV.sessions],
    );
    expect(await createProjectMatcher(kv, "alpha")("s1", "mem_p")).toBe(true);
  });

  it("retains Session read failures for Observations", async () => {
    const { kv } = makeKV({}, [KV.sessions]);
    await expect(createProjectMatcher(kv, "alpha")("s1", "obs_a")).rejects.toThrow("read failed");
  });

  it("uses a Memory's Session or Summary when its project is absent", async () => {
    const { kv } = makeKV({
      [KV.memories]: { mem_a: { id: "mem_a" } },
      [KV.sessions]: { s1: { project: "beta" } },
      [KV.summaries]: { s2: { project: "alpha" }, s3: { project: "beta" } },
    });
    const matches = createProjectMatcher(kv, "alpha");
    expect(await matches("s1", "mem_a")).toBe(false);
    expect(await matches("s2", "mem_a")).toBe(true);
    expect(await matches("s3", "mem_a")).toBe(false);
  });

  it("rejects an explicit other project even when the Session matches", async () => {
    const { kv, reads } = makeKV({
      [KV.memories]: { mem_b: { project: "beta" } },
      [KV.sessions]: { s1: { project: "alpha" } },
    });
    expect(await createProjectMatcher(kv, "alpha")("s1", "mem_b")).toBe(false);
    expect(reads).not.toContain(KV.sessions);
  });
});
