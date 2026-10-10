import { questionPath, type Adapter, type Session } from "../types.js";

interface RandomState {
  sessions: Session[];
}

function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The floor every path must beat: k sessions drawn without regard to the
// question, seeded by question id so two runs score identically.
export const randomAdapter: Adapter<RandomState> = {
  name: "random",
  paths: ["search", "session-start", "prompt-submit"],
  async init(sessions) {
    return { sessions };
  },
  async query(q, state, k) {
    const next = mulberry32(seedFrom(`${questionPath(q)}:${q.id}`));
    const pool = state.sessions.map((s) => s.id);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return { ranked: pool.slice(0, k).map((sessionId, i) => ({ sessionId, score: k - i })) };
  },
};
