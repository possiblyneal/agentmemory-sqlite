import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureTransformers } from "../src/providers/transformers-env.js";

type Transformers = Parameters<typeof configureTransformers>[0];

function fakeTransformers(): { module: Transformers; env: Record<string, unknown> } {
  const env: Record<string, unknown> = {};
  return { module: { env } as unknown as Transformers, env };
}

describe("configureTransformers", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("sets the cache dir and HF mirror once from env", () => {
    vi.stubEnv("AGENTMEMORY_MODEL_CACHE_DIR", "/cache/models");
    vi.stubEnv("HF_ENDPOINT", "https://hf-mirror.example");
    const { module, env } = fakeTransformers();
    configureTransformers(module);
    expect(env["cacheDir"]).toBe("/cache/models");
    expect(env["remoteHost"]).toBe("https://hf-mirror.example/");

    vi.stubEnv("AGENTMEMORY_MODEL_CACHE_DIR", "/elsewhere");
    configureTransformers(module);
    expect(env["cacheDir"]).toBe("/cache/models");
  });

  it("keeps a mirror that already ends in a slash", () => {
    vi.stubEnv("HF_ENDPOINT", "https://hf-mirror.example/");
    const { module, env } = fakeTransformers();
    configureTransformers(module);
    expect(env["remoteHost"]).toBe("https://hf-mirror.example/");
  });

  it("leaves remoteHost alone when no mirror is set", () => {
    vi.stubEnv("HF_ENDPOINT", "");
    const { module, env } = fakeTransformers();
    configureTransformers(module);
    expect(env).not.toHaveProperty("remoteHost");
  });

  it("defaults the cache dir under the data dir", () => {
    vi.stubEnv("AGENTMEMORY_MODEL_CACHE_DIR", "");
    vi.stubEnv("XENOVA_CACHE_HOME", "");
    vi.stubEnv("AGENTMEMORY_DATA_DIR", "/data");
    const { module, env } = fakeTransformers();
    configureTransformers(module);
    expect(env["cacheDir"]).toBe("/data/models");
  });

  it("tolerates a module without env", () => {
    const module = {} as Transformers;
    expect(configureTransformers(module)).toBe(module);
  });
});

describe("local embedding worker", () => {
  it("configures transformers through the shared helper", () => {
    const source = readFileSync(
      new URL("../src/providers/embedding/local-worker.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("configureTransformers(");
    expect(source).not.toMatch(/env\.(cacheDir|remoteHost)\s*=/);
  });
});
