import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { Session, SessionSummary } from "../types.js";

const DEFAULT_PAGE_LIMIT = 100;
const SUMMARY_BATCH = 10;

export type Page = { limit: number | "all"; offset: number };

export function parsePage(query: Record<string, unknown> | undefined): Page {
  const rawLimit = query?.["limit"];
  const rawOffset = query?.["offset"];
  const parsedLimit = typeof rawLimit === "string" ? Number(rawLimit) : Number.NaN;
  const parsedOffset = typeof rawOffset === "string" ? Number(rawOffset) : Number.NaN;
  const limit =
    rawLimit === "all"
      ? "all"
      : Number.isInteger(parsedLimit) && parsedLimit > 0
        ? parsedLimit
        : DEFAULT_PAGE_LIMIT;
  const offset =
    Number.isInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
  return { limit, offset };
}

export function takePage<T>(rows: T[], page: Page): T[] {
  return page.limit === "all"
    ? rows.slice(page.offset)
    : rows.slice(page.offset, page.offset + page.limit);
}

export async function listSessionsPage(
  kv: StateKV,
  page: Page,
  agentId?: string,
) {
  const sessions = await kv.list<Session>(KV.sessions);
  const filtered = (
    agentId ? sessions.filter((s) => s.agentId === agentId) : sessions
  ).sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  const paged = takePage(filtered, page);
  // Bounded fan-out: each kv.get is a full engine invocation, so
  // Promise.all over hundreds of sessions saturates the invocation
  // pool. Batch in chunks (parallel within a chunk, sequential across
  // chunks); the summaries array stays index-aligned with `paged`.
  const summaries: Array<SessionSummary | null> = [];
  for (let batch = 0; batch < paged.length; batch += SUMMARY_BATCH) {
    const chunk = paged.slice(batch, batch + SUMMARY_BATCH);
    const results = await Promise.all(
      chunk.map((s) =>
        kv.get<SessionSummary>(KV.summaries, s.id).catch(() => null),
      ),
    );
    summaries.push(...results);
  }
  const withSummary = paged.map((s, i) =>
    summaries[i] ? { ...s, summary: summaries[i] } : s,
  );
  return { sessions: withSummary, total: filtered.length, ...page };
}
