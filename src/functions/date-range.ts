export type DateRange = { after?: number; before?: number };

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
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid date bound");
  return parsed;
}

export function parseDateRange(input: { after?: unknown; before?: unknown }): DateRange {
  const after = instant(input.after);
  const before = instant(input.before);
  if (after !== undefined && before !== undefined && after > before) throw new Error("after must not be later than before");
  return { after, before };
}

export function withinDateRange(timestamp: unknown, range: DateRange): boolean {
  if (range.after === undefined && range.before === undefined) return true;
  const time = typeof timestamp === "string" ? Date.parse(timestamp) : typeof timestamp === "number" ? timestamp : NaN;
  return Number.isFinite(time) && (range.after === undefined || time >= range.after) && (range.before === undefined || time < range.before);
}
