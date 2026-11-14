import { describe, expect, it } from "vitest";
import {
  EXTERNAL_ARMS,
  externalSessionId,
  itemsBefore,
  parseExternalArm,
  type ExternalCorpus,
  type ExternalItem,
} from "../eval/runner/external-text.js";

const item = (over: Partial<ExternalItem>): ExternalItem => ({
  source: "commits",
  project: "repo",
  id: "a",
  at: "2026-10-01T00:00:00.000Z",
  text: "t",
  files: [],
  ...over,
});

describe("parseExternalArm", () => {
  it("names the 8 arms of none, each source, each pair and all three", () => {
    expect(EXTERNAL_ARMS).toHaveLength(8);
    expect(parseExternalArm("none")).toEqual([]);
    expect(parseExternalArm("prs")).toEqual(["prs"]);
    expect(parseExternalArm("commits+prs+issues")).toEqual(["commits", "prs", "issues"]);
  });

  it("refuses an arm outside the 8, including a reordered pair", () => {
    expect(() => parseExternalArm("prs+commits")).toThrow(/--external-arm/);
    expect(() => parseExternalArm("wiki")).toThrow(/--external-arm/);
  });
});

describe("itemsBefore", () => {
  const corpus: ExternalCorpus = {
    builtAt: "2026-11-13T00:00:00.000Z",
    items: [
      item({ id: "late", at: "2026-10-05T00:00:00.000Z" }),
      item({ id: "early", at: "2026-10-01T00:00:00.000Z" }),
      item({ id: "same-instant", at: "2026-10-03T00:00:00.000Z" }),
      item({ id: "pr", source: "prs", at: "2026-10-02T00:00:00.000Z" }),
      item({ id: "other", project: "elsewhere", at: "2026-10-01T00:00:00.000Z" }),
    ],
  };

  it("returns only the arm's sources of the project, final strictly before the Session, oldest first", () => {
    const got = itemsBefore(corpus, ["commits"], "repo", "2026-10-03T00:00:00.000Z");
    expect(got.map((i) => i.id)).toEqual(["early"]);
    const both = itemsBefore(corpus, ["commits", "prs"], "repo", "2026-10-04T00:00:00.000Z");
    expect(both.map((i) => i.id)).toEqual(["early", "pr", "same-instant"]);
  });

  it("returns nothing for the none arm", () => {
    expect(itemsBefore(corpus, [], "repo", "2027-01-01T00:00:00.000Z")).toEqual([]);
  });
});

describe("externalSessionId", () => {
  it("is one Session per project and source", () => {
    expect(externalSessionId("repo", "issues")).toBe("external-issues-repo");
  });
});
