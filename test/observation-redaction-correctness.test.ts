import { describe, it, expect, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { redactObservationLiterals } from "../src/functions/privacy.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("observation literal redaction correctness", () => {
  it("does not join surviving text into another literal", () => {
    const result = redactObservationLiterals("AB AEB", ["E", "AB"]) as string;
    expect(result).not.toContain("AB");
    expect(result).not.toContain("E");
  });

  it("retains colliding keys without quadratic suffix growth", () => {
    const input = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [i.toString(2).padStart(8, "0"), i]));
    const output = redactObservationLiterals(input, ["0", "1"]) as Record<string, number>;
    expect(Object.values(output).sort((a, b) => a - b)).toEqual(Object.values(input).sort((a, b) => a - b));
    expect(Math.max(...Object.keys(output).map((key) => key.length))).toBeLessThan(32);
    expect(Object.keys(output).every((key) => !/[01]/.test(key))).toBe(true);
  });

  it("keeps a nested image when a redacted image path cannot be saved", async () => {
    await mkdir("tmp", { recursive: true });
    const home = await mkdtemp(resolve("tmp/redaction-home-"));
    const file = join(home, "rules.json");
    const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==";
    await writeFile(file, JSON.stringify(["image_path"]));
    vi.stubEnv("HOME", home);
    vi.stubEnv("AGENTMEMORY_OBSERVATION_REDACTION_FILE", file);
    vi.stubEnv("AGENTMEMORY_AUTO_COMPRESS", "false");
    vi.resetModules();
    try {
      const imageStore = await import("../src/utils/image-store.js");
      expect(imageStore.IMAGES_DIR.startsWith(`${home}/`)).toBe(true);
      const { registerObserveFunction: register } = await import("../src/functions/observe.js");
      const kv = mockKV();
      const sdk = mockSdk({ looseTrigger: true });
      register(sdk as never, kv as never);
      await sdk.trigger("mem::observe", {
        sessionId: "image-fallback", hookType: "post_tool_use", timestamp: "2026-11-22T10:00:00Z",
        data: { image_path: "/not-an-encoded-image", nested: { screenshot: image } },
      });
      const [row] = [...kv.store.get(KV.observations("image-fallback"))!.values()] as Array<{ imageData?: string }>;
      expect(row.imageData?.startsWith(`${home}/`)).toBe(true);
      expect(await readFile(row.imageData!)).toEqual(Buffer.from(image, "base64"));
      await writeFile(file, JSON.stringify(["unrelated-secret"]));
      await sdk.trigger("mem::observe", {
        sessionId: "image-fallback", hookType: "post_tool_use", timestamp: "2026-11-22T10:01:00Z",
        data: { image_path: "/not-an-encoded-image", nested: { screenshot: image } },
      });
      const rows = [...kv.store.get(KV.observations("image-fallback"))!.values()] as Array<{ imageData?: string }>;
      expect(await readFile(rows[1].imageData!)).toEqual(Buffer.from(image, "base64"));
      await writeFile(file, JSON.stringify(["REDACTED"]));
      await sdk.trigger("mem::observe", {
        sessionId: "malformed-image", hookType: "post_tool_use", timestamp: "2026-11-22T10:02:00Z",
        data: { tool_output: image + "REDACTED" },
      });
      const [malformed] = [...kv.store.get(KV.observations("malformed-image"))!.values()] as Array<{ imageData?: string }>;
      expect(malformed.imageData).toBeUndefined();
      vi.stubEnv("AGENTMEMORY_OBSERVATION_REDACTION_FILE", undefined);
      await sdk.trigger("mem::observe", {
        sessionId: "legacy-image-path", hookType: "post_tool_use", timestamp: "2026-11-22T10:03:00Z",
        data: { image_path: "/not-an-encoded-image", nested: { screenshot: image } },
      });
      const [legacy] = [...kv.store.get(KV.observations("legacy-image-path"))!.values()] as Array<{ imageData?: string }>;
      expect(legacy.imageData).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("chooses the error after redaction empties tool output", async () => {
    await mkdir("tmp", { recursive: true });
    const home = await mkdtemp(resolve("tmp/redaction-home-"));
    const file = join(home, "rules.json");
    await writeFile(file, JSON.stringify(["E"]));
    vi.stubEnv("HOME", home);
    vi.stubEnv("AGENTMEMORY_OBSERVATION_REDACTION_FILE", file);
    vi.stubEnv("AGENTMEMORY_AUTO_COMPRESS", "false");
    try {
      const kv = mockKV();
      const sdk = mockSdk({ looseTrigger: true });
      registerObserveFunction(sdk as never, kv as never);
      await sdk.trigger("mem::observe", {
        sessionId: "error-fallback", hookType: "post_tool_failure", timestamp: "2026-11-22T10:00:00Z",
        data: { tool_name: "Bash", tool_output: "E", error: "fallback E message" },
      });
      const [row] = [...kv.store.get(KV.observations("error-fallback"))!.values()] as Array<{ narrative: string }>;
      expect(row.narrative).toContain("fallback  message");
      expect(row.narrative).not.toContain("E");
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("extracts canonical fields before redacting structural keys and rejects malformed images", async () => {
    await mkdir("tmp", { recursive: true });
    const file = `tmp/redaction-correctness-${process.pid}.json`;
    await writeFile(file, JSON.stringify(["prompt", "SYNTHETIC-LABEL"]));
    const previous = process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE;
    process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE = file;
    try {
      const kv = mockKV();
      const sdk = mockSdk({ looseTrigger: true });
      registerObserveFunction(sdk as never, kv as never);
      const payload = { sessionId: "redaction", hookType: "prompt_submit", timestamp: "2026-11-22T10:00:00Z", data: { prompt: "Discuss the miniature orchard" } };
      await sdk.trigger("mem::observe", payload);
      const rows = [...kv.store.get(KV.observations("redaction"))!.values()] as Array<Record<string, unknown>>;
      expect(JSON.stringify(rows[0])).toContain("Discuss the miniature orchard");
      expect(rows[0].title).toContain("Discuss the miniature orchard");
      await sdk.trigger("mem::observe", { ...payload, hookType: "post_tool_use", data: "data:image/png;base64,SYNTHETIC-LABEL was printed as text" });
      const imageRows = [...kv.store.get(KV.observations("redaction"))!.values()] as Array<Record<string, unknown>>;
      expect(imageRows[1].imageData).toBeUndefined();
      expect(imageRows[1].modality).not.toBe("image");
      expect(JSON.stringify(imageRows[1])).not.toContain("SYNTHETIC-LABEL");
      await sdk.trigger("mem::observe", {
        ...payload, hookType: "post_tool_use",
        data: { tool_name: "Read", agent_id: "SYNTHETIC-LABEL-id", agent_type: "reader" },
      });
      const attributedRows = [...kv.store.get(KV.observations("redaction"))!.values()] as Array<Record<string, unknown>>;
      expect(attributedRows[2].executionAgentId).toBeUndefined();
      expect(attributedRows[2].executionAgentType).toBe("reader");
      expect(JSON.stringify(attributedRows[2])).not.toContain("SYNTHETIC-LABEL");
    } finally {
      if (previous === undefined) delete process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE;
      else process.env.AGENTMEMORY_OBSERVATION_REDACTION_FILE = previous;
      await unlink(file);
    }
  });
});
