export type DateRange = { after?: number; before?: number; afterFraction?: string; beforeFraction?: string };

const EXACT_FRACTION = /^(\d{4}-\d{2}-\d{2}[Tt ]\d{1,2}:\d{2}:\d{2}\.)(\d+)(Z|[+-]\d{2}:\d{2})(?![\s\S])/;

function fraction(value: string): string {
  const digits = EXACT_FRACTION.exec(value)?.[2] ?? "";
  let end = digits.length;
  while (end > 3 && digits[end - 1] === "0") end--;
  return digits.slice(3, end);
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return parsed;
  const match = EXACT_FRACTION.exec(value);
  return match ? Date.parse(`${match[1]}${match[2]!.slice(0, 3)}${match[3]}`) : parsed;
}

function instant(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Date bounds must be ISO-8601 instants with an explicit offset");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) throw new Error("Date bounds must be ISO-8601 instants with an explicit offset");
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const calendar = new Date(0);
  calendar.setUTCFullYear(y, m, 0);
  const days = calendar.getUTCDate();
  if (m < 1 || m > 12 || d < 1 || d > days || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59) {
    throw new Error("Invalid date bound");
  }
  const parsed = parseTimestamp(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid date bound");
  return parsed;
}

function compare(a: number, af: string, b: number, bf: string): number {
  return a === b ? (af < bf ? -1 : af > bf ? 1 : 0) : a < b ? -1 : 1;
}

export function compareTimestamps(a: string, b: string): number {
  return compare(parseTimestamp(a), fraction(a), parseTimestamp(b), fraction(b));
}

export function parseDateRange(input: { after?: unknown; before?: unknown }): DateRange {
  const after = instant(input.after);
  const before = instant(input.before);
  const afterFraction = typeof input.after === "string" ? fraction(input.after) : "";
  const beforeFraction = typeof input.before === "string" ? fraction(input.before) : "";
  if (after !== undefined && before !== undefined && compare(after, afterFraction, before, beforeFraction) > 0) throw new Error("after must not be later than before");
  return { after, before, afterFraction, beforeFraction };
}

export function withinDateRange(timestamp: unknown, range: DateRange): boolean {
  if (range.after === undefined && range.before === undefined) return true;
  const time = typeof timestamp === "string" ? parseTimestamp(timestamp) : typeof timestamp === "number" ? timestamp : NaN;
  const remainder = typeof timestamp === "string" ? fraction(timestamp) : "";
  return Number.isFinite(time) && (range.after === undefined || compare(time, remainder, range.after, range.afterFraction ?? "") >= 0) && (range.before === undefined || compare(time, remainder, range.before, range.beforeFraction ?? "") < 0);
}
