import { describe, it, expect, vi } from "vitest";
import { parseDateRange } from "../src/functions/date-range.js";
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

  it("matches a zoned date query to both spellings of a bounded stored instant", async () => {
    const index = new SearchIndex();
    const query = "2026-01-01T00:30:00Z";
    index.add(shipped("explicit", query));
    index.add(shipped("legacy", "2026-01-01T00:30:00"));
    const range = parseDateRange({ after: "2026-01-01T00:00:00Z", before: "2026-01-01T01:00:00Z" });
    const hits = await index.searchCooperatively(query, 20, undefined, 0, range);
    expect(hits.map((hit) => hit.obsId).sort()).toEqual(["explicit", "legacy"]);
    expect(hits[0].score).toBe(hits[1].score);
  });

  it("uses normalized date postings and corpus-wide frequencies only with bounds", async () => {
    const index = new SearchIndex();
    const control = new SearchIndex();
    const legacy = "2026-01-01T00:30:00";
    const explicit = `${legacy}Z`;
    const outOfRange = "2026-01-01T00:29:00Z";
    const formerDay = new Date(2026, 0, 1, 12).toISOString();
    const range = parseDateRange({ after: "2026-01-01T00:30:00.0001Z", before: "2026-01-02T00:30:00Z" });
    for (const idx of [index, control]) {
      idx.add(shipped("legacy", `${legacy}.0002${idx === control ? "Z" : ""}`));
      idx.add(shipped("out-of-range", outOfRange));
      idx.add(shipped("former-day", formerDay));
    }
    for (const query of [explicit, "2026-01-01", "December 2025", "December 31st", `shipp ${explicit}`]) {
      const unbounded = index.search(query);
      expect(await index.searchCooperatively(query, 20, undefined, 0)).toEqual(unbounded);
      expect(await index.searchCooperatively(query, 20, undefined, 0, parseDateRange({}))).toEqual(unbounded);
      const expected = control.search(query).filter((hit) => hit.obsId !== "out-of-range");
      expect(await index.searchCooperatively(query, 20, undefined, 0, range)).toEqual(expected);
    }
    expect(ids(index, "2026-01-01")).toContain("legacy");
  });

  it("maintains bounded date postings through copy, deserialization, removal and replacement", async () => {
    const source = new SearchIndex();
    const query = "2026-01-01T00:30:00Z";
    const range = parseDateRange({ after: "2026-01-01T00:00:00Z", before: "2026-01-02T00:00:00Z" });
    const stored = "2026-01-01t0:30:00.0001Z";
    source.add(shipped("legacy", stored));
    expect(source.search(query)).toEqual([]);
    const copy = new SearchIndex();
    copy.restoreFrom(source);
    const roundTrip = SearchIndex.deserialize(source.serialize());
    const boundedIds = async (index: SearchIndex) =>
      (await index.searchCooperatively(query, 20, undefined, 0, range)).map((hit) => hit.obsId);
    for (const index of [source, copy, roundTrip]) {
      expect(await boundedIds(index)).toEqual(["legacy"]);
      index.remove("legacy");
      index.add(shipped("elsewhere", "2026-01-03T12:00:00Z"));
      expect(await boundedIds(index)).toEqual([]);
      index.add(shipped("legacy", stored));
      index.add(shipped("legacy", query));
      expect(await index.searchCooperatively(query, 20, undefined, 0, range)).toEqual(index.search(query));
      index.clear();
      index.add(shipped("elsewhere", "2026-01-03T12:00:00Z"));
      expect(await boundedIds(index)).toEqual([]);
    }
  });

  const explicit = "2026-01-01T00:30:00Z";
  const addedOnly = "2026-01-01t0:30:00Z";
  const dateQuery = dateTermsForQuery(explicit)[0].slice("@date:".length);
  const bounds = parseDateRange({ after: "2026-01-01T00:00:00Z" });

  it.each(["2026-01-01T00:30:00", addedOnly])("keeps the first tied date hit at limit 1 for %s", async (spelling) => {
    const index = new SearchIndex();
    index.add(shipped("first", spelling));
    index.add(shipped("second", explicit));
    const control = new SearchIndex();
    control.add(shipped("first", explicit));
    control.add(shipped("second", explicit));
    const expected = control.search(dateQuery, 1);
    expect(expected.map(({ obsId }) => obsId)).toEqual(["first"]);
    const copy = new SearchIndex();
    copy.restoreFrom(index);
    for (const candidate of [index, copy, SearchIndex.deserialize(index.serialize())]) {
      expect(await candidate.searchCooperatively(dateQuery, 1, undefined, 0, bounds)).toEqual(expected);
    }
  });

  async function mutateInsideDatePostings(index: SearchIndex, mutate: () => void) {
    vi.useFakeTimers({ toFake: ["setImmediate"] });
    try {
      const pending = index.searchCooperatively(dateQuery, 2049, undefined, 0, bounds);
      // Advance through the distinct unmatched numeric terms before the date term.
      for (const _ of new Set(dateQuery.split("-"))) {
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersToNextTimer();
        await Promise.resolve();
      }
      expect(vi.getTimerCount()).toBe(1);
      mutate();
      const [hits] = await Promise.all([pending, vi.runAllTimersAsync()]);
      return hits;
    } finally {
      vi.useRealTimers();
    }
  }

  it("scores an already visited date hit once when replacement moves it to added postings", async () => {
    const index = new SearchIndex();
    for (let i = 0; i < 2048; i++) index.add(shipped(`obs_${i}`, explicit));
    index.add(shipped("added", addedOnly));
    const hits = await mutateInsideDatePostings(index, () => index.add(shipped("obs_0", addedOnly)));
    const expected = await index.searchCooperatively(dateQuery, 2049, undefined, 0, bounds);
    expect(hits).toHaveLength(2049);
    expect(hits.find(({ obsId }) => obsId === "obs_0")).toEqual(expected.find(({ obsId }) => obsId === "obs_0"));
  });

  it.each(["remove", "replace"])("skips the suspended date posting on %s", async (action) => {
    const index = new SearchIndex();
    for (let i = 0; i < 2048; i++) index.add(shipped(`obs_${i}`, addedOnly));
    const hits = await mutateInsideDatePostings(index, () => {
      if (action === "remove") index.remove("obs_2047");
      else index.add(shipped("obs_2047", explicit));
    });
    expect(hits).toHaveLength(2047);
    expect(hits.some(({ obsId }) => obsId === "obs_2047")).toBe(false);
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
