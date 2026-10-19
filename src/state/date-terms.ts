// Calendar dates are indexed as terms that ordinary tokenisation can never
// produce (it strips "@" and ":"), so a bare month word or day number in a
// query never matches every record of that month or day.

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sept: 9, sep: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const MONTH = `(${Object.keys(MONTHS).join("|")})`;
const ORDINAL = "(?:st|nd|rd|th)?";
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const MONTH_DAY = new RegExp(
  `\\b${MONTH}\\.?\\s+(\\d{1,2})${ORDINAL}\\b(?:,?\\s+(\\d{4})\\b)?`,
  "g",
);
const DAY_MONTH = new RegExp(
  `\\b(\\d{1,2})${ORDINAL}\\s+(?:of\\s+)?${MONTH}\\b\\.?(?:,?\\s+(\\d{4})\\b)?`,
  "g",
);
const MONTH_YEAR = new RegExp(`\\b${MONTH}\\.?,?\\s+(\\d{4})\\b`, "g");

const pad = (n: number) => String(n).padStart(2, "0");

function isRealDay(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

export function dateTermsForTimestamp(timestamp: string | undefined): string[] {
  const time = timestamp ? new Date(timestamp) : null;
  if (!time || Number.isNaN(time.getTime())) return [];
  const iso = time.toISOString();
  if (!/^\d{4}-/.test(iso)) return [];
  return [`@date:${iso.slice(0, 10)}`, `@month:${iso.slice(0, 7)}`, `@md:${iso.slice(5, 10)}`];
}

export function dateTermsForQuery(query: string): string[] {
  const text = query.toLowerCase();
  const terms = new Set<string>();

  const addDay = (month: number, day: number, year?: number) => {
    if (!isRealDay(year ?? 2000, month, day)) return;
    terms.add(year === undefined ? `@md:${pad(month)}-${pad(day)}` : `@date:${year}-${pad(month)}-${pad(day)}`);
  };

  for (const [, y, m, d] of text.matchAll(ISO_DATE)) addDay(Number(m), Number(d), Number(y));
  for (const [, mon, d, y] of text.matchAll(MONTH_DAY)) {
    addDay(MONTHS[mon], Number(d), y ? Number(y) : undefined);
  }
  for (const [, d, mon, y] of text.matchAll(DAY_MONTH)) {
    addDay(MONTHS[mon], Number(d), y ? Number(y) : undefined);
  }
  for (const [, mon, y] of text.matchAll(MONTH_YEAR)) terms.add(`@month:${y}-${pad(MONTHS[mon])}`);

  return [...terms];
}
