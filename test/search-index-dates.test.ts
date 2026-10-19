import { describe, it, expect } from "vitest";
import { SearchIndex } from "../src/state/search-index.js";
import type { CompressedObservation } from "../src/types.js";

function shipped(id: string, timestamp: string): CompressedObservation {
  return {
    id,
    sessionId: "ses_1",
    timestamp,
    type: "file_edit",
    title: "Shipped release notes",
    facts: [],
    narrative: "Shipped the release notes",
    concepts: [],
    files: [],
    importance: 5,
  };
}

function dated(): SearchIndex {
  const index = new SearchIndex();
  index.add(shipped("other_day", "2026-04-09T10:00:00.000Z"));
  index.add(shipped("same_day", "2026-04-08T10:00:00.000Z"));
  index.add(shipped("other_year", "2025-04-08T10:00:00.000Z"));
  index.add(shipped("other_month", "2026-05-20T10:00:00.000Z"));
  return index;
}

const ids = (index: SearchIndex, q: string) =>
  index.search(q).map((r) => r.obsId);

describe("SearchIndex record dates", () => {
  it.each([
    "shipped April 8th 2026",
    "shipped 8 April 2026",
    "shipped apr 8, 2026",
    "shipped 2026-04-08",
  ])("ranks the record of that day first for %s", (q) => {
    expect(ids(dated(), q)[0]).toBe("same_day");
  });

  it("matches a day of the month in any year when no year is given", () => {
    const top = ids(dated(), "shipped 8 April").slice(0, 2);
    expect(top.sort()).toEqual(["other_year", "same_day"]);
  });

  it("matches a month and year", () => {
    const top = ids(dated(), "shipped april 2026").slice(0, 2);
    expect(top.sort()).toEqual(["other_day", "same_day"]);
  });

  it("finds a record by a date-only query", () => {
    expect(ids(dated(), "2026-04-08")).toEqual(["same_day"]);
  });

  it("does not treat a bare month word or number as a date", () => {
    const index = dated();
    expect(ids(index, "may")).toEqual([]);
    expect(ids(index, "shipped 8")).toEqual(ids(index, "shipped"));
    expect(ids(index, "shipped march")).toEqual(ids(index, "shipped"));
  });

  it("rejects an impossible date", () => {
    const index = dated();
    expect(ids(index, "2026-02-30")).toEqual([]);
    expect(ids(index, "shipped 31 April 2026")).toEqual(ids(index, "shipped"));
  });

  it("scores a query with no date exactly as an index without dates", () => {
    const undated = new SearchIndex();
    const withDates = new SearchIndex();
    for (const id of ["a", "b"]) {
      withDates.add(shipped(id, "2026-04-08T10:00:00.000Z"));
      undated.add(shipped(id, ""));
    }
    expect(withDates.search("shipped release")).toEqual(
      undated.search("shipped release"),
    );
  });

  it("gives a record with an invalid timestamp no date terms", () => {
    const index = new SearchIndex();
    index.add(shipped("bad", "yesterday"));
    expect(ids(index, "2026-04-08")).toEqual([]);
  });
});
