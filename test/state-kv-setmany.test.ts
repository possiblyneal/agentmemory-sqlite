import { describe, it, expect } from "vitest";

import { StateKV } from "../src/state/kv.js";

function fakeSdk() {
  const calls: Array<{ function_id: string; payload: any }> = [];
  return {
    calls,
    trigger: async (req: { function_id: string; payload: any }) => {
      calls.push(req);
      return req.function_id === "state::set-many" ? req.payload.entries.length : req.payload.value;
    },
  };
}

const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ key: "k" + i, value: i }));

describe("StateKV.setMany", () => {
  it("sends state::set-many in chunks of 100, awaited in order", async () => {
    const sdk = fakeSdk();
    const n = await new StateKV(sdk as never).setMany("s", entries(250));
    expect(n).toBe(250);
    expect(sdk.calls.map((c) => c.function_id)).toEqual(["state::set-many", "state::set-many", "state::set-many"]);
    expect(sdk.calls.map((c) => c.payload.entries.length)).toEqual([100, 100, 50]);
    expect(sdk.calls[2].payload).toEqual({ scope: "s", entries: entries(250).slice(200) });
  });

  it("an empty batch sends nothing", async () => {
    const sdk = fakeSdk();
    expect(await new StateKV(sdk as never).setMany("s", [])).toBe(0);
    expect(sdk.calls).toEqual([]);
  });
});
