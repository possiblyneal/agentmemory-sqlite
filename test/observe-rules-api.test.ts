import { afterEach, describe, expect, it, vi } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";
import { OBSERVATION_RULES_ERROR } from "../src/functions/privacy.js";
import { captureTimes, resetCaptureForTests } from "../src/telemetry/capture.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const body = { hookType: "prompt_submit", sessionId: "s", project: "synthetic", cwd: "/synthetic", timestamp: "2026-11-22T10:00:00Z" };

afterEach(() => {
  vi.unstubAllEnvs();
  resetCaptureForTests();
});

describe("observation rules API", () => {
  it("stores a valid request with valid rules", async () => {
    vi.stubEnv("AGENTMEMORY_OBSERVATION_REDACTION_FILE", undefined);
    const sdk = mockSdk();
    sdk.registerFunction("mem::observe", async () => ({ id: "synthetic" }));
    registerApiTriggers(sdk as never, mockKV() as never);
    expect(await sdk.fns.get("api::observe")!({ body })).toEqual({ status_code: 201, body: { id: "synthetic" } });
    expect(captureTimes()).toEqual({ lastArrivalAt: expect.any(String), lastStoredAt: null, oldestPendingAt: null });
  });

  it("records and settles a valid request rejected by invalid rules", async () => {
    vi.stubEnv("AGENTMEMORY_OBSERVATION_REDACTION_FILE", "");
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never);
    const result = await sdk.fns.get("api::observe")!({ body });
    expect(result).toEqual({ status_code: 503, body: { error: OBSERVATION_RULES_ERROR } });
    expect(captureTimes()).toEqual({ lastArrivalAt: expect.any(String), lastStoredAt: null, oldestPendingAt: null });
  });
  it("returns 503 and settles capture when rules become invalid after preflight", async () => {
    vi.stubEnv("AGENTMEMORY_OBSERVATION_REDACTION_FILE", undefined);
    const sdk = mockSdk();
    sdk.registerFunction("mem::observe", async () => { throw new Error(OBSERVATION_RULES_ERROR); });
    registerApiTriggers(sdk as never, mockKV() as never);
    const result = await sdk.fns.get("api::observe")!({ body });
    expect(result).toEqual({ status_code: 503, body: { error: OBSERVATION_RULES_ERROR } });
    expect(captureTimes()).toEqual({ lastArrivalAt: expect.any(String), lastStoredAt: null, oldestPendingAt: null });
  });
});
