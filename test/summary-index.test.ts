import { describe, it, expect, beforeEach } from "vitest";
import { SearchIndex } from "../src/state/search-index.js";
import { summaryIndexId, summaryToIndexDoc } from "../src/state/summary-index.js";
import type { CompressedObservation, SessionSummary } from "../src/types.js";

function summary(sessionId: string, keyDecisions: string[], extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId,
    project: "shipctl",
    createdAt: "2026-10-01T10:00:00.000Z",
    title: "Release tooling work",
    narrative: "Worked on the release tooling for the staging pipeline.",
    keyDecisions,
    filesModified: [],
    concepts: [],
    observationCount: 3,
    ...extra,
  };
}

function observation(id: string, sessionId: string, narrative: string): CompressedObservation {
  return {
    id,
    sessionId,
    timestamp: "2026-10-01T10:00:00.000Z",
    type: "file_edit",
    title: "Edit config loader",
    facts: [],
    narrative,
    concepts: [],
    files: [],
    importance: 5,
  };
}

const docOf = (s: SessionSummary) => summaryToIndexDoc(s)!;
const ids = (index: SearchIndex, q: string) => index.search(q).map((r) => r.obsId);

describe("Session Summary decisions in the search index", () => {
  let index: SearchIndex;

  beforeEach(() => {
    index = new SearchIndex();
    index.add(observation("obs_1", "ses_a", "Edited the config loader to read environment variables"));
    index.add(observation("obs_2", "ses_b", "Edited the config loader to read environment variables"));
  });

  it("reaches a Session through a decision that shares no words with its Observations", () => {
    index.add(
      docOf(summary("ses_a", ["Rollbacks always restore the previous tarball before notifying anyone"])),
      "summary",
    );
    expect(ids(index, "rollbacks restore previous tarball")).toEqual([summaryIndexId("ses_a")]);
    expect(index.search("rollbacks restore previous tarball")[0].sessionId).toBe("ses_a");
  });

  it("replaces the document when a Summary is rewritten, leaving no stale hit", () => {
    index.add(docOf(summary("ses_a", ["Rollbacks restore the previous tarball"])), "summary");
    index.add(docOf(summary("ses_a", ["Deploys require a signed manifest"])), "summary");
    expect(ids(index, "rollbacks restore previous tarball")).toEqual([]);
    expect(ids(index, "deploys signed manifest")).toEqual([summaryIndexId("ses_a")]);
  });

  it("leaves no hit once the Summary document is removed", () => {
    index.add(docOf(summary("ses_a", ["Rollbacks restore the previous tarball"])), "summary");
    index.remove(summaryIndexId("ses_a"));
    expect(ids(index, "rollbacks restore previous tarball")).toEqual([]);
  });

  it("stays out of Observation-layer and Memory-layer searches", () => {
    index.add(docOf(summary("ses_a", ["Rollbacks restore the previous tarball"])), "summary");
    expect(index.search("rollbacks tarball", 20, "observation")).toEqual([]);
    expect(index.search("rollbacks tarball", 20, "memory")).toEqual([]);
  });
});
