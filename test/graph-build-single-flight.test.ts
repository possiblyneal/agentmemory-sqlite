import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";

const SECRET = "graph-build-secret";
const auth = { authorization: `Bearer ${SECRET}` };

function mockKV(observationsPerSession: number, sessions = 2) {
  const sessionRows = Array.from({ length: sessions }, (_, i) => ({ id: `s${i}` }));
  const obs = Array.from({ length: observationsPerSession }, (_, i) => ({ id: `o${i}`, title: `t${i}` }));
  return {
    get: async () => null,
    set: async <T>(_s: string, _k: string, d: T) => d,
    delete: async () => {},
    list: async (scope: string) => (scope === "mem:sessions" ? sessionRows : obs),
  };
}

function setup(observationsPerSession: number, extract: () => Promise<unknown>) {
  const fns = new Map<string, Function>();
  const sdk = {
    registerFunction: (id: string, h: Function) => void fns.set(id, h),
    registerTrigger: () => {},
    trigger: async (input: { function_id: string; payload?: unknown }) =>
      fns.get(input.function_id)?.(input.payload),
  };
  const extractFn = vi.fn(extract);
  fns.set("mem::graph-extract", extractFn);
  registerApiTriggers(sdk as never, mockKV(observationsPerSession) as never, SECRET);
  return { build: fns.get("api::graph-build")!, cancel: fns.get("api::graph-build-cancel")!, extractFn };
}

describe("api::graph-build", () => {
  let release: () => void;
  let gate: Promise<unknown>;
  beforeEach(() => {
    gate = new Promise<void>((r) => (release = r)).then(() => ({ success: true, nodesAdded: 1, edgesAdded: 0 }));
  });

  it("refuses a second build with 409 and progress while one replays", async () => {
    const { build, extractFn } = setup(1, () => gate);
    const first = build({ headers: auth, body: {} });
    await vi.waitFor(() => expect(extractFn).toHaveBeenCalledTimes(1));
    const second = await build({ headers: auth, body: {} });
    expect(second.status_code).toBe(409);
    expect(second.body.progress).toMatchObject({ running: true });
    expect(extractFn).toHaveBeenCalledTimes(1);
    release();
    const done = await first;
    expect(done.status_code).toBe(200);
    expect(extractFn).toHaveBeenCalledTimes(2);
    const again = await build({ headers: auth, body: {} });
    expect(again.status_code).toBe(200);
  });

  it("dryRun reports the observation count without extracting", async () => {
    const { build, extractFn } = setup(3, async () => ({ success: true }));
    const res = await build({ headers: auth, body: { dryRun: true } });
    expect(res.status_code).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, observations: 6, sessions: 2 });
    expect(extractFn).not.toHaveBeenCalled();
  });

  it("issues no further batches once the caller disconnects", async () => {
    const ac = new AbortController();
    const { build, extractFn } = setup(4, async () => {
      ac.abort();
      return { success: true };
    });
    const res = await build({ headers: auth, body: { batchSize: 1 }, signal: ac.signal });
    expect(extractFn).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ cancelled: true });
  });

  it("stops issuing batches after the cancel endpoint is called", async () => {
    let cancelled = false;
    const h = setup(4, async () => {
      if (!cancelled) {
        cancelled = true;
        const c = await h.cancel({ headers: auth, body: {} });
        expect(c.body).toMatchObject({ cancelled: true });
      }
      return { success: true };
    });
    const res = await h.build({ headers: auth, body: { batchSize: 1 } });
    expect(h.extractFn).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ cancelled: true });
  });

  it("cancel with nothing running reports cancelled false", async () => {
    const { cancel } = setup(1, async () => ({ success: true }));
    const res = await cancel({ headers: auth, body: {} });
    expect(res.body).toMatchObject({ cancelled: false });
  });
});
