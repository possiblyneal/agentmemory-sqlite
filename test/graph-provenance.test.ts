import { afterEach, describe, expect, it } from "vitest";
import { capSourceIds } from "../src/functions/graph-provenance.js";

const ENV = "AGENTMEMORY_GRAPH_MAX_SOURCE_IDS";

// #3: provenance is evidence of origin, so the cap has to keep the newest
// evidence. A merge unions the two sides and can reintroduce an id already
// present, which is where deduping from the wrong end loses the wrong ids.
describe("capSourceIds", () => {
  afterEach(() => {
    delete process.env[ENV];
  });

  it("keeps the newest ids when the run is over the cap", () => {
    process.env[ENV] = "3";
    expect(capSourceIds(["a", "b", "c", "d", "e"])).toEqual(["c", "d", "e"]);
  });

  it("leaves a run within the cap untouched, duplicates and all", () => {
    process.env[ENV] = "5";
    expect(capSourceIds(["a", "b", "a"])).toEqual(["b", "a"]);
  });

  it("keeps a re-observed id at its newest position, not its first", () => {
    process.env[ENV] = "2";
    // `a` was seen first and again last. Deduping from the head would pin it
    // to position 0 and then trim it away as stale evidence.
    expect(capSourceIds(["a", "b", "c", "a"])).toEqual(["c", "a"]);
  });

  it("returns an empty run unchanged", () => {
    process.env[ENV] = "3";
    expect(capSourceIds([])).toEqual([]);
  });
});
