import { describe, it, expect } from "vitest";
import { capBehindNewer, RESTATEMENT_OVERLAP } from "../src/functions/recency-cap.js";
import { jaccardOverlap, jaccardText } from "../src/state/schema.js";

type Item = { id: string; text: string; at: number; score: number };

function capped(older: string, newer: string): boolean {
  const items: Item[] = [
    { id: "old", text: older, at: 1, score: 10 },
    { id: "new", text: newer, at: 2, score: 5 },
  ];
  capBehindNewer(items, (i) => i.text, (i) => i.at);
  return items[0].score < 10;
}

describe("capBehindNewer", () => {
  it("caps an older record whose words are half of the newer one's", () => {
    expect(capped("alpha bravo", "alpha bravo charlie delta")).toBe(true);
    expect(capped("alpha bravo charlie delta", "alpha bravo")).toBe(true);
  });

  it("leaves a record whose words are under half of the other's", () => {
    expect(capped("alpha", "alpha bravo charlie")).toBe(false);
    expect(capped("alpha bravo charlie", "alpha")).toBe(false);
  });

  it("still caps an exact restatement too short to have words", () => {
    expect(capped("ok", "ok")).toBe(true);
  });
});

describe("capBehindNewer against the pairwise definition", () => {
  function pairwise(scored: Item[]): void {
    const byRecency = [...scored].sort((a, b) => b.at - a.at).map((item) => ({ item, text: jaccardText(item.text) }));
    for (let i = 1; i < byRecency.length; i++) {
      for (let j = 0; j < i; j++) {
        if (byRecency[j].item.at === byRecency[i].item.at) continue;
        if (jaccardOverlap(byRecency[j].text, byRecency[i].text) < RESTATEMENT_OVERLAP) continue;
        byRecency[i].item.score = Math.min(byRecency[i].item.score, byRecency[j].item.score * 0.99);
      }
    }
  }

  it("caps exactly the pairs the pairwise scan caps, cascades and empty texts included", () => {
    const vocabulary = Array.from({ length: 24 }, (_, i) => `word${String.fromCharCode(97 + i)}${i}`);
    let seed = 42;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let round = 0; round < 40; round++) {
      const items: Item[] = Array.from({ length: 60 }, (_, i) => {
        const size = Math.floor(rand() * 9);
        const words = Array.from({ length: size }, () => vocabulary[Math.floor(rand() * (6 + (i % 3) * 6))]);
        return { id: `i${i}`, text: size === 0 && rand() < 0.5 ? "ok" : words.join(" "), at: Math.floor(rand() * 30), score: 1 + rand() * 9 };
      });
      const expected = items.map((i) => ({ ...i }));
      pairwise(expected);
      capBehindNewer(items, (i) => i.text, (i) => i.at);
      expect(items.map((i) => i.score)).toEqual(expected.map((i) => i.score));
    }
  });
});
