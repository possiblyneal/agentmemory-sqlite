import { describe, it, expect } from "vitest";

import {
  checkPayloadSize,
  isOversizedPayload,
  MAX_PAYLOAD_BYTES,
} from "../src/state/payload-bound.js";

// The bound exists to turn an out-of-memory crash inside JSON.stringify into
// an answer the client can act on, so the refusal has to carry the narrowing
// hint and the payload has to be measured without ever throwing.
describe("payload bound", () => {
  it("passes a payload under the bound", () => {
    expect(checkPayloadSize({ sessions: [] }, "narrow the range")).toBeNull();
  });

  it("passes a payload exactly at the bound", () => {
    const payload = "x".repeat(8);
    expect(checkPayloadSize(payload, "narrow the range", 10)).toBeNull();
  });

  it("refuses a payload over the bound, naming the size and the way out", () => {
    const result = checkPayloadSize({ big: "x".repeat(64) }, "use ?since", 32);

    expect(result).toMatchObject({ success: false, oversized: true, limitBytes: 32 });
    expect(result?.bytes).toBeGreaterThan(32);
    expect(result?.error).toContain("use ?since");
    expect(result?.error).toContain("MiB response limit");
  });

  it("refuses a payload that cannot be serialized to be measured", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    const result = checkPayloadSize(circular, "use ?since");

    expect(result).toMatchObject({ oversized: true, bytes: null });
    expect(result?.error).toContain("too large to serialize");
  });

  it("tells a refusal apart from a successful export", () => {
    expect(isOversizedPayload(checkPayloadSize("x".repeat(64), "hint", 8))).toBe(true);
    expect(isOversizedPayload({ sessions: [], memories: [] })).toBe(false);
    expect(isOversizedPayload(null)).toBe(false);
  });

  it("bounds the default far above a reasonable response", () => {
    expect(MAX_PAYLOAD_BYTES).toBe(256 * 1024 * 1024);
  });
});
