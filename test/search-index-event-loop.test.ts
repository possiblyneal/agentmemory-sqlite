import { describe, it, expect } from "vitest";
import { SearchIndex } from "../src/state/search-index.js";
import type { CompressedObservation } from "../src/types.js";

function doc(id: string, narrative: string): CompressedObservation {
  return {
    id,
    sessionId: "ses_1",
    timestamp: "2026-11-11T12:00:00.000Z",
    type: "decision",
    title: id,
    facts: [],
    narrative,
    concepts: [],
    files: [],
    importance: 5,
  };
}

const ids = (idx: SearchIndex, q: string) => idx.search(q, 50).map((h) => h.obsId);

describe("SearchIndex vocabulary under live writes", () => {
  // A live daemon indexes Observations between searches. Each search after a
  // write re-sorted the whole vocabulary (~477k terms on the Operator's store),
  // holding the event loop for seconds (#371).
  it("searches after each write without paying for the whole vocabulary", () => {
    const idx = new SearchIndex();
    for (let d = 0; d < 2_000; d++) {
      const words = Array.from({ length: 200 }, (_, w) => `tok${d}x${w}q`);
      idx.add(doc(`obs_${d}`, words.join(" ")));
    }
    idx.search("tok1x1", 10);

    const time = (write: boolean): number => {
      const start = performance.now();
      for (let i = 0; i < 20; i++) {
        if (write) idx.add(doc(`obs_live_${i}`, `livewrite${i} entry`));
        idx.search(`livewrite${i}`, 50);
      }
      return performance.now() - start;
    };
    const readOnly = time(false);
    const withWrites = time(true);
    expect(ids(idx, "livewrite19")).toEqual(["obs_live_19"]);
    // A vocabulary re-sort per search made the writing loop ~100x the
    // read-only one; the margin absorbs a loaded CI machine.
    expect(withWrites).toBeLessThan(10 * readOnly + 200);
  }, 30_000);

  it("returns the head of the full ranking for a small limit, ties in index order", () => {
    const idx = new SearchIndex();
    for (let d = 0; d < 3_000; d++) {
      idx.add(doc(`obs_${d}`, `alpha beta gamma delta epsilon note${d % 50} item${d}`));
    }
    const query = "alpha beta gamma delta epsilon note7";
    const full = idx.search(query, 3_000);
    expect(full.length).toBeGreaterThan(300);
    for (const limit of [1, 7, 60, 300]) {
      expect(idx.search(query, limit)).toEqual(full.slice(0, limit));
    }
  });

  it("expands a prefix to a term first indexed after an earlier search", () => {
    const idx = new SearchIndex();
    idx.add(doc("obs_a", "kubelet notes"));
    expect(ids(idx, "kube")).toEqual(["obs_a"]);

    idx.add(doc("obs_b", "kubeconfig rollback"));
    expect(ids(idx, "kube").sort()).toEqual(["obs_a", "obs_b"]);
  });

  it("stops expanding a prefix to a term once its last document is removed", () => {
    const idx = new SearchIndex();
    idx.add(doc("obs_a", "kubelet notes"));
    idx.add(doc("obs_b", "kubeconfig rollback"));
    expect(ids(idx, "kube").sort()).toEqual(["obs_a", "obs_b"]);

    idx.remove("obs_b");
    expect(ids(idx, "kube")).toEqual(["obs_a"]);
  });

  it("expands prefixes in an index restored from another or from its serialized form", () => {
    const source = new SearchIndex();
    source.add(doc("obs_a", "kubelet notes"));

    const restored = new SearchIndex();
    restored.restoreFrom(source);
    expect(ids(restored, "kube")).toEqual(["obs_a"]);
    expect(ids(SearchIndex.deserialize(source.serialize()), "kube")).toEqual(["obs_a"]);
  });
});

describe("SearchIndex.searchCooperatively", () => {
  // Scoring a prompt over the Operator's store is 75-300 ms of posting lists;
  // run in one go it held /livez that long (#371).
  function bigIndex(): SearchIndex {
    const idx = new SearchIndex();
    for (let d = 0; d < 3_000; d++) {
      idx.add(doc(`obs_${d}`, `alpha beta gamma delta epsilon note${d % 50} item${d}`));
    }
    return idx;
  }
  const query = "alpha beta gamma delta epsilon note7";

  it("ranks exactly as search does", async () => {
    const idx = bigIndex();
    expect(await idx.searchCooperatively(query, 40, undefined, 0)).toEqual(idx.search(query, 40));
  });

  it("lets queued I/O run between query terms once its slice is spent", async () => {
    const idx = bigIndex();
    let turns = 0;
    let ticking = true;
    const tick = () => {
      if (!ticking) return;
      turns++;
      setImmediate(tick);
    };
    setImmediate(tick);
    await idx.searchCooperatively(query, 40, undefined, 0);
    ticking = false;
    expect(turns).toBeGreaterThanOrEqual(5);
  });

  it("leaves out a document removed while it yielded", async () => {
    const idx = bigIndex();
    const pending = idx.searchCooperatively(query, 3_000, undefined, 0);
    idx.remove("obs_7");
    const ids = (await pending).map((h) => h.obsId);
    expect(ids).not.toContain("obs_7");
    expect(ids).toContain("obs_57");
  });

  // One term of a 20,000-document posting list, or one short prefix expanding
  // to terms that hold as many, was a single uninterrupted loop of up to
  // 400 ms on the live store.
  it("lets queued I/O run inside one term's posting list", async () => {
    const idx = new SearchIndex();
    for (let d = 0; d < 20_000; d++) idx.add(doc(`obs_${d}`, `common${d % 3 === 0 ? "" : "x"} filler${d}`));
    let turns = 0;
    let ticking = true;
    const tick = () => {
      if (!ticking) return;
      turns++;
      setImmediate(tick);
    };
    setImmediate(tick);
    await idx.searchCooperatively("common", 10, undefined, 0);
    await idx.searchCooperatively("comm", 10, undefined, 0);
    ticking = false;
    // Two searches over ~20,000 postings each, 2,048 documents a step, plus
    // one step per term: well above what one yield per term would give.
    expect(turns).toBeGreaterThanOrEqual(15);
  });

  it("survives a prefix term whose last document is removed while it yielded", async () => {
    const idx = new SearchIndex();
    for (let d = 0; d < 5_000; d++) idx.add(doc(`obs_${d}`, `kubelet${d % 2 ? "" : "x"} notes`));
    idx.add(doc("obs_rare", "kubezzz solo"));
    const pending = idx.searchCooperatively("kube", 10_000, undefined, 0);
    idx.remove("obs_rare");
    const ids = (await pending).map((h) => h.obsId);
    expect(ids).not.toContain("obs_rare");
    expect(ids.length).toBeGreaterThan(0);
  });
});

describe("SearchIndex ranking head", () => {
  it("returns the head of the full ranking, ties in index order, for any limit and layer", () => {
    const idx = new SearchIndex();
    for (let d = 0; d < 400; d++) {
      // Few distinct lengths and terms, so many documents tie on score.
      idx.add(doc(`obs_${d}`, `alpha beta ${d % 4 === 0 ? "gamma" : "delta"} ${"pad ".repeat(d % 3)}`), d % 5 === 0 ? "memory" : "observation");
    }
    for (const layer of [undefined, "memory", "observation"] as const) {
      const full = idx.search("alpha gamma", 10_000, layer);
      expect(full.length).toBeGreaterThan(50);
      for (const limit of [1, 2, 9, 50, 399, 10_000]) {
        expect(idx.search("alpha gamma", limit, layer)).toEqual(full.slice(0, limit));
      }
    }
  });
});
