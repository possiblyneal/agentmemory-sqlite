import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// #781: concurrent siblings on the agent-sdk provider used to bail out
// empty because the recursion guard mutated process.env synchronously
// before the first await. With the guard scoped to AsyncLocalStorage,
// each sibling runs in its own context and receives the real SDK result.

// vi.mock is hoisted above module-scope `const`/`let`, so the factory's
// closure can't safely reference non-hoisted bindings. Use vi.hoisted to
// declare the mock's mutable state alongside the mock itself.
const state = vi.hoisted(() => ({
  queryCalls: [] as Array<{ systemPrompt: string; userPrompt: string }>,
  mockResult: "<result>ok</result>" as
    | string
    | ((systemPrompt: string, userPrompt: string) => string),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({
    prompt,
    options,
  }: {
    prompt: string;
    options: { systemPrompt: string };
  }) => {
    state.queryCalls.push({ systemPrompt: options.systemPrompt, userPrompt: prompt });
    async function* gen() {
      const value =
        typeof state.mockResult === "function"
          ? await state.mockResult(options.systemPrompt, prompt)
          : state.mockResult;
      yield { type: "result", result: value } as { type: "result"; result: string };
    }
    return gen();
  },
}));

import { AgentSDKProvider } from "../src/providers/agent-sdk.js";

describe("AgentSDKProvider recursion guard (#781)", () => {
  beforeEach(() => {
    state.queryCalls.length = 0;
    state.mockResult = "<result>ok</result>";
    delete process.env.AGENTMEMORY_SDK_CHILD;
  });

  afterEach(() => {
    delete process.env.AGENTMEMORY_SDK_CHILD;
  });

  it("concurrent summarize calls each return the SDK result (no empty siblings)", async () => {
    const provider = new AgentSDKProvider();

    const results = await Promise.all([
      provider.summarize("sys", "chunk 1"),
      provider.summarize("sys", "chunk 2"),
      provider.summarize("sys", "chunk 3"),
      provider.summarize("sys", "chunk 4"),
    ]);

    expect(results).toEqual([
      "<result>ok</result>",
      "<result>ok</result>",
      "<result>ok</result>",
      "<result>ok</result>",
    ]);
    expect(state.queryCalls.length).toBe(4);
    expect(state.queryCalls.map((c) => c.userPrompt)).toEqual([
      "chunk 1",
      "chunk 2",
      "chunk 3",
      "chunk 4",
    ]);
  });

  it("compress and summarize share the same guard scope without interfering", async () => {
    const provider = new AgentSDKProvider();

    const [a, b, c] = await Promise.all([
      provider.summarize("sys", "s1"),
      provider.compress("sys", "c1"),
      provider.summarize("sys", "s2"),
    ]);

    expect(a).toBe("<result>ok</result>");
    expect(b).toBe("<result>ok</result>");
    expect(c).toBe("<result>ok</result>");
    expect(state.queryCalls.length).toBe(3);
  });

  it("sets AGENTMEMORY_SDK_CHILD=1 while inside the SDK call (so spawned subprocesses inherit it)", async () => {
    const provider = new AgentSDKProvider();
    let observedEnv: string | undefined;

    state.mockResult = (sysPrompt, _userPrompt) => {
      observedEnv = process.env.AGENTMEMORY_SDK_CHILD;
      return `<result>${sysPrompt}</result>`;
    };

    expect(process.env.AGENTMEMORY_SDK_CHILD).toBeUndefined();
    await provider.summarize("sys", "user");
    expect(observedEnv).toBe("1");
    expect(process.env.AGENTMEMORY_SDK_CHILD).toBeUndefined();
  });

  it("restores AGENTMEMORY_SDK_CHILD to its prior value after the call", async () => {
    const provider = new AgentSDKProvider();
    process.env.AGENTMEMORY_SDK_CHILD = "prev-value";

    await provider.summarize("sys", "user");

    expect(process.env.AGENTMEMORY_SDK_CHILD).toBe("prev-value");
  });

  it("keeps AGENTMEMORY_SDK_CHILD=1 for the full overlap of concurrent calls", async () => {
    const provider = new AgentSDKProvider();
    // Allow the calls to overlap: each call records the env value it
    // saw, then a tick later records it again. With a refcounted guard
    // both observations on both calls should see "1"; with the old
    // per-call snapshot one call's restore would null the env while
    // the sibling is still mid-flight.
    const observations: Array<{ id: string; phase: string; env: string | undefined }> = [];

    state.mockResult = async (sysPrompt, _user) => {
      observations.push({ id: sysPrompt, phase: "enter", env: process.env.AGENTMEMORY_SDK_CHILD });
      await new Promise((resolve) => setTimeout(resolve, 5));
      observations.push({ id: sysPrompt, phase: "exit", env: process.env.AGENTMEMORY_SDK_CHILD });
      return `<result>${sysPrompt}</result>`;
    };

    await Promise.all([
      provider.summarize("a", "x"),
      provider.summarize("b", "y"),
      provider.summarize("c", "z"),
    ]);

    expect(observations.length).toBe(6);
    for (const o of observations) {
      expect(o.env).toBe("1");
    }
    expect(process.env.AGENTMEMORY_SDK_CHILD).toBeUndefined();
  });

  it("genuine re-entry (an inner call inside the same async tree) still degrades to empty", async () => {
    const provider = new AgentSDKProvider();
    let innerResult = "not-set";

    state.mockResult = async (_sys, _user) => {
      // Simulate the SDK callback re-entering the provider while the
      // outer call is still active. The ALS frame is active here, so
      // the inner call must return "" to break the recursion.
      innerResult = await provider.summarize("sys-inner", "user-inner");
      return "<result>outer</result>";
    };

    const outer = await provider.summarize("sys", "user");
    expect(outer).toBe("<result>outer</result>");
    expect(innerResult).toBe("");
  });
});

describe("AgentSDKProvider concurrency cap", () => {
  // Every query spawns a ~190MB `claude` child, and nothing above this
  // provider bounds the arrival rate: one broker outage turned every
  // in-flight observation into a child that then ignored SIGTERM.
  beforeEach(() => {
    state.queryCalls.length = 0;
    state.mockResult = "<result>ok</result>";
    delete process.env.AGENTMEMORY_AGENT_SDK_MAX_CONCURRENCY;
    delete process.env.AGENTMEMORY_LLM_TIMEOUT_MS;
  });

  afterEach(() => {
    delete process.env.AGENTMEMORY_AGENT_SDK_MAX_CONCURRENCY;
    delete process.env.AGENTMEMORY_LLM_TIMEOUT_MS;
  });

  it("never runs more children at once than the cap allows", async () => {
    process.env.AGENTMEMORY_AGENT_SDK_MAX_CONCURRENCY = "2";
    const provider = new AgentSDKProvider();
    let live = 0;
    let peak = 0;

    state.mockResult = async (sysPrompt, _user) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 5));
      live--;
      return `<result>${sysPrompt}</result>`;
    };

    const results = await Promise.all(
      ["a", "b", "c", "d", "e", "f"].map((id) => provider.summarize(id, "x")),
    );

    expect(peak).toBe(2);
    // Queued callers are served, not dropped: the chunked-summarize
    // fan-out must still get every chunk back or the skip-ratio bailout
    // throws away the whole summary.
    expect(results).toEqual(
      ["a", "b", "c", "d", "e", "f"].map((id) => `<result>${id}</result>`),
    );
  });

  it("gives up waiting rather than queueing forever behind a wedged child", async () => {
    process.env.AGENTMEMORY_AGENT_SDK_MAX_CONCURRENCY = "1";
    process.env.AGENTMEMORY_LLM_TIMEOUT_MS = "20";
    const provider = new AgentSDKProvider();

    let releaseWedged: () => void = () => {};
    const wedged = new Promise<void>((resolve) => {
      releaseWedged = resolve;
    });
    state.mockResult = async (sysPrompt, _user) => {
      if (sysPrompt === "wedged") await wedged;
      return `<result>${sysPrompt}</result>`;
    };

    const first = provider.summarize("wedged", "x");
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(await provider.summarize("queued", "y")).toBe("");

    releaseWedged();
    expect(await first).toBe("<result>wedged</result>");
    expect(state.queryCalls.length).toBe(1);
  });

  it("releases the slot when the SDK call throws", async () => {
    process.env.AGENTMEMORY_AGENT_SDK_MAX_CONCURRENCY = "1";
    process.env.AGENTMEMORY_LLM_TIMEOUT_MS = "20";
    const provider = new AgentSDKProvider();

    state.mockResult = () => {
      throw new Error("sdk exploded");
    };
    await expect(provider.summarize("boom", "x")).rejects.toThrow("sdk exploded");

    state.mockResult = "<result>after</result>";
    expect(await provider.summarize("sys", "x")).toBe("<result>after</result>");
  });
});
