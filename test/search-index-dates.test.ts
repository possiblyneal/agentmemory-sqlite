import { describe, it, expect } from "vitest";
import { SearchIndex } from "../src/state/search-index.js";
import { dateTermsForQuery } from "../src/state/date-terms.js";
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

  it("dates a record by the Operator's local calendar day", () => {
    const index = new SearchIndex();
    index.add(shipped("late_evening", new Date(2026, 3, 8, 23, 30).toISOString()));
    expect(ids(index, "2026-04-08")).toEqual(["late_evening"]);
  });

  it("uses at most five of a query's dates", () => {
    const index = new SearchIndex();
    const days = Array.from({ length: 10 }, (_, i) => `2026-04-${String(i + 10)}`);
    for (const day of days) index.add(shipped(day, `${day}T12:00:00.000Z`));
    expect(ids(index, days.join(" "))).toHaveLength(5);
  });
});

describe("dateTermsForQuery", () => {
  it.each([
    "options 1 and 2 may conflict",
    "we may 3 times retry",
    "version 1.2 dec 5 hex",
    "edit docs/benchmarks/2026-10-18-sdebench.md",
    "open 2026-10-18-sdebench.md",
  ])("finds no date in %s", (q) => {
    expect(dateTermsForQuery(q)).toEqual([]);
  });

  it.each([
    ["shipped may 2nd", "@md:05-02"],
    ["shipped on may 2", "@md:05-02"],
    ["shipped dec 5 2025", "@date:2025-12-05"],
    ["shipped 2nd of may", "@md:05-02"],
    ["failed at 2026-04-08T10:00:00Z", "@date:2026-04-08"],
  ])("reads %s as %s", (q, expected) => {
    expect(dateTermsForQuery(q)).toEqual([expected]);
  });

  it("reads a zoned timestamp as its local calendar day", () => {
    const lateEvening = new Date(2026, 3, 8, 22, 0).toISOString();
    expect(dateTermsForQuery(`failed at ${lateEvening}`)).toEqual(["@date:2026-04-08"]);
  });

  it("gives a day-month-year phrase only its day", () => {
    expect(dateTermsForQuery("8 April 2026")).toEqual(["@date:2026-04-08"]);
    expect(dateTermsForQuery("April 8th 2026")).toEqual(["@date:2026-04-08"]);
  });
});
