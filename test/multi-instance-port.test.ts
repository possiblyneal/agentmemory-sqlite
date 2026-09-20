import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config";

const PORT_ENVS = [
  "III_REST_PORT",
  "III_STREAM_PORT",
  "III_STREAMS_PORT",
] as const;

describe("multi-instance port auto-derive (#750)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of PORT_ENVS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of PORT_ENVS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  it("default REST anchor yields the canonical 3111/3112 pair", () => {
    const cfg = loadConfig();
    expect(cfg.restPort).toBe(3111);
    expect(cfg.streamsPort).toBe(3112);
  });

  it("relocating REST drags streams with it", () => {
    process.env["III_REST_PORT"] = "3211";
    const cfg = loadConfig();
    expect(cfg.restPort).toBe(3211);
    expect(cfg.streamsPort).toBe(3212);
  });

  it("instance N=2 block (3311) lands on 3312", () => {
    process.env["III_REST_PORT"] = "3311";
    const cfg = loadConfig();
    expect(cfg.restPort).toBe(3311);
    expect(cfg.streamsPort).toBe(3312);
  });

  it("explicit III_STREAM_PORT pins streams without affecting REST", () => {
    process.env["III_REST_PORT"] = "3211";
    process.env["III_STREAM_PORT"] = "9999";
    const cfg = loadConfig();
    expect(cfg.restPort).toBe(3211);
    expect(cfg.streamsPort).toBe(9999);
  });

  it("legacy III_STREAMS_PORT still honored", () => {
    process.env["III_STREAMS_PORT"] = "9000";
    const cfg = loadConfig();
    expect(cfg.streamsPort).toBe(9000);
  });
});
