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

// "options 1 and 2 may conflict", "1.2 dec 5": these also read as words, so
// they count as a month only beside an ordinal, a year, or after "on".
const READS_AS_WORD = new Set([
  "may", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

const MONTH = `(${Object.keys(MONTHS).join("|")})`;
const ORDINAL = "(st|nd|rd|th)?";
const ISO_DATE =
  /(?<![\w/])(\d{4})-(\d{2})-(\d{2})(t\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2}))?(?=t\d|[^\w-]|$)/g;
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

const term = {
  date: (year: number, month: number, day: number) => `@date:${year}-${pad(month)}-${pad(day)}`,
  month: (year: number, month: number) => `@month:${year}-${pad(month)}`,
  monthDay: (month: number, day: number) => `@md:${pad(month)}-${pad(day)}`,
};

function isRealDay(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

// Local calendar fields: the daemon runs on the Operator's machine, and the
// Operator names days by their own clock.
export function dateTermsForTimestamp(timestamp: string | undefined): string[] {
  const time = timestamp ? new Date(timestamp) : null;
  if (!time || Number.isNaN(time.getTime())) return [];
  const [year, month, day] = [time.getFullYear(), time.getMonth() + 1, time.getDate()];
  if (year < 1000 || year > 9999) return [];
  return [term.date(year, month, day), term.month(year, month), term.monthDay(month, day)];
}

export function dateTermsForQuery(query: string): string[] {
  const text = query.toLowerCase();
  const terms = new Set<string>();

  const addDay = (month: number, day: number, year?: number) => {
    if (!isRealDay(year ?? 2000, month, day)) return;
    terms.add(year === undefined ? term.monthDay(month, day) : term.date(year, month, day));
  };
  const statedAsDate = (mon: string, ordinal: string | undefined, year: string | undefined, at: number) =>
    !READS_AS_WORD.has(mon) || ordinal !== undefined || year !== undefined || /\bon\s+$/.test(text.slice(0, at));

  for (const [match, y, m, d, zonedTime] of text.matchAll(ISO_DATE)) {
    if (!zonedTime) {
      addDay(Number(m), Number(d), Number(y));
      continue;
    }
    const [localDay] = dateTermsForTimestamp(match.toUpperCase());
    if (localDay) terms.add(localDay);
  }
  for (const { 1: mon, 2: d, 3: ord, 4: y, index } of text.matchAll(MONTH_DAY)) {
    if (statedAsDate(mon, ord, y, index)) addDay(MONTHS[mon], Number(d), y ? Number(y) : undefined);
  }
  for (const { 1: d, 2: ord, 3: mon, 4: y, index } of text.matchAll(DAY_MONTH)) {
    if (statedAsDate(mon, ord, y, index)) addDay(MONTHS[mon], Number(d), y ? Number(y) : undefined);
  }
  const withoutDays = text.replace(MONTH_DAY, " ").replace(DAY_MONTH, " ");
  for (const [, mon, y] of withoutDays.matchAll(MONTH_YEAR)) terms.add(term.month(Number(y), MONTHS[mon]));

  return [...terms];
}
