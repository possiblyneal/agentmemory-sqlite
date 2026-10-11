import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { registerActionsFunction } from "../src/functions/actions.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const SECRET = "limit-test-secret";

describe("GET /agentmemory/actions limit", () => {
  let sdk: ReturnType<typeof mockSdk>;

  beforeEach(async () => {
    sdk = mockSdk();
    const kv = mockKV();
    registerActionsFunction(sdk as never, kv as never);
    registerApiTriggers(sdk as never, kv as never, SECRET);
    for (let i = 0; i < 130; i++) {
      await sdk.trigger("mem::action-create", { title: `action ${i}` });
    }
  });

  const list = (query: Record<string, string>) =>
    sdk.fns.get("api::action-list")!({
      headers: { authorization: `Bearer ${SECRET}` },
      query_params: query,
    }) as Promise<{ status_code: number; body: { actions: unknown[]; total: number } }>;

  it("returns up to the requested limit and reports the total", async () => {
    const res = await list({ limit: "120" });
    expect(res.status_code).toBe(200);
    expect(res.body.actions).toHaveLength(120);
    expect(res.body.total).toBe(130);
  });

  it("keeps the default page of 50 without a limit", async () => {
    const res = await list({});
    expect(res.body.actions).toHaveLength(50);
    expect(res.body.total).toBe(130);
  });

  it("rejects a non-positive limit", async () => {
    const res = await list({ limit: "0" });
    expect(res.status_code).toBe(400);
  });
});
