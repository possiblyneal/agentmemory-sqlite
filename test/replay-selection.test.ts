import { describe, expect, it } from "vitest";
import { selectionOf, selectionWarning } from "../eval/runner/replay-selection.js";

describe("replay selection fingerprint", () => {
  it("counts the Sessions and ignores their order", () => {
    const a = selectionOf(["s1", "s2", "s3"]);
    expect(a.sessions).toBe(3);
    expect(selectionOf(["s3", "s1", "s2"])).toEqual(a);
  });

  it("changes when a Session is added or removed", () => {
    const base = selectionOf(["s1", "s2"]);
    expect(selectionOf(["s1", "s2", "s3"]).fingerprint).not.toBe(base.fingerprint);
    expect(selectionOf(["s1"]).fingerprint).not.toBe(base.fingerprint);
    expect(selectionOf(["s1", "s3"]).fingerprint).not.toBe(base.fingerprint);
  });

  it("does not confuse ids that concatenate alike", () => {
    expect(selectionOf(["ab", "c"]).fingerprint).not.toBe(selectionOf(["a", "bc"]).fingerprint);
  });
});

describe("replay selection warning", () => {
  const a = selectionOf(["s1", "s2"]);
  const b = selectionOf(["s1", "s2", "s3"]);

  it("is silent when both runs scored the same Sessions", () => {
    expect(selectionWarning(a, selectionOf(["s2", "s1"]))).toBeUndefined();
  });

  it("warns that different corpora were compared, with both counts", () => {
    const warning = selectionWarning(a, b);
    expect(warning).toMatch(/different corpora/);
    expect(warning).toContain("2");
    expect(warning).toContain("3");
  });

  it("warns when a run records no selection", () => {
    expect(selectionWarning(undefined, a)).toMatch(/different corpora/);
    expect(selectionWarning(a, undefined)).toMatch(/different corpora/);
  });
});
