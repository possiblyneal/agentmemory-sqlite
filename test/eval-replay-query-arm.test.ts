import { describe, expect, it } from "vitest";
import { composeQuery, extractReplyTerms, queryCap, type QueryContext } from "../eval/runner/replay-query-arm.js";

const ctx = (over: Partial<QueryContext> = {}): QueryContext => ({
  prompt: "continue",
  reply: "",
  prevPrompt: "",
  ...over,
});

describe("queryCap", () => {
  it("is N when the scale is 0 and shrinks by K per prompt char otherwise, never below 0", () => {
    expect(queryCap("continue", 1000, 0)).toBe(1000);
    expect(queryCap("continue", 1000, 10)).toBe(920);
    expect(queryCap("x".repeat(200), 1000, 10)).toBe(0);
  });
});

describe("composeQuery", () => {
  const reply = "Alpha opening. Middle part.\n\nFinal paragraph here.";

  it("control returns the prompt untouched", () => {
    expect(composeQuery("control", ctx({ reply }), 1000, 0)).toBe("continue");
  });

  it("reply-tail appends the last N chars of the reply", () => {
    expect(composeQuery("reply-tail", ctx({ reply }), 10, 0)).toBe("continue\nraph here.");
  });

  it("reply-head appends the first N chars of the reply", () => {
    expect(composeQuery("reply-head", ctx({ reply }), 5, 0)).toBe("continue\nAlpha");
  });

  it("returns the prompt alone when there is no reply or the cap is 0", () => {
    expect(composeQuery("reply-tail", ctx(), 100, 0)).toBe("continue");
    expect(composeQuery("reply-tail", ctx({ reply }), 100, 1000)).toBe("continue");
  });

  it("reply-last appends the final paragraph, capped at N", () => {
    expect(composeQuery("reply-last", ctx({ reply }), 1000, 0)).toBe("continue\nFinal paragraph here.");
    expect(composeQuery("reply-last", ctx({ reply }), 5, 0)).toBe("continue\nFinal");
  });

  it("reply-last appends only the final question when the reply ends with one", () => {
    const asks = "Done with the parser. Want me to also wire the CLI flag?";
    expect(composeQuery("reply-last", ctx({ reply: asks }), 1000, 0)).toBe("continue\nWant me to also wire the CLI flag?");
  });

  it("prev-prompt appends the previous Operator prompt, capped at N", () => {
    expect(composeQuery("prev-prompt", ctx({ prevPrompt: "fix the cart total" }), 1000, 0)).toBe("continue\nfix the cart total");
    expect(composeQuery("prev-prompt", ctx({ prevPrompt: "fix the cart total" }), 7, 0)).toBe("continue\nfix the");
  });

  it("reply-terms appends the reply's extracted terms, whole terms only, within N", () => {
    const r = "Edited src/cart.ts and calcTotal, see #12.";
    expect(composeQuery("reply-terms", ctx({ reply: r }), 1000, 0)).toBe("continue\nsrc/cart.ts calcTotal #12");
    expect(composeQuery("reply-terms", ctx({ reply: r }), 20, 0)).toBe("continue\nsrc/cart.ts");
  });
});

describe("extractReplyTerms", () => {
  it("finds paths, camelCase, snake_case, dotted, :: names and issue refs, deduped in order", () => {
    const text = [
      "I changed eval/runner/replay.ts and mem::prompt-context.",
      "parseTranscript calls build_index; see config.maxPrompts and #310 (also #310).",
      "Plain words like the and then are ignored, e.g. this.",
    ].join(" ");
    expect(extractReplyTerms(text)).toEqual([
      "eval/runner/replay.ts",
      "mem::prompt-context",
      "parseTranscript",
      "build_index",
      "config.maxPrompts",
      "#310",
    ]);
  });
});
