import { describe, it, expect } from "vitest";
import { capBehindNewer } from "../src/functions/recency-cap.js";

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
