import { sessionText, type Adapter, type RankedDoc, type Session } from "../types.js";

interface GrepState {
  sessions: Session[];
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

export const grepAdapter: Adapter<GrepState> = {
  name: "grep",
  paths: ["search"],
  async init(sessions) {
    return { sessions };
  },
  async query(q, state, k) {
    const terms = tokenize(q.question ?? "");
    const scored: RankedDoc[] = [];
    for (const s of state.sessions) {
      if (q.project && s.project !== q.project) continue;
      const body = sessionText(s).toLowerCase();
      let hits = 0;
      for (const t of terms) {
        if (body.includes(t)) hits += 1;
      }
      if (hits > 0) {
        scored.push({ sessionId: s.id, score: hits });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return { ranked: scored.slice(0, k) };
  },
};
