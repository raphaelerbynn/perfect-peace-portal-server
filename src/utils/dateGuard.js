// AI-8: the date/time guard for AI-drafted notices.
//
// A notice that invents a date or a start time goes to every parent at once,
// so every date, time, weekday and year the draft states must be one the
// office typed in the key facts. Lenient about the way it is written
// ("Friday 14th November" = "14/11" = "November 14"; "3:30pm" = "15:30" =
// "3.30 pm"), strict about the substance (14 vs 15 November, 3pm vs 4pm, a
// weekday that isn't the weekday of that date).
//
//   ungroundedSpecifics(draftText, keyFacts, { now }) -> ["Friday 14th November", "9am"]
//
// Numeric dates are read day first (14/11 = 14 November), as written in Ghana.
// A date with no year is taken as this year's, or next year's when it is more
// than 60 days in the past (a notice is about something coming up).

const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
  july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};
const WEEKDAYS = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const FULL_WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const WD_RE = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join("|");
const ORD = "(?:st|nd|rd|th)?";
const YEAR = "(\\d{4})";

// Each pattern is tried in this order; a span that matched is blanked so a
// later, looser pattern can't read the same text again.
const DATE_PATTERNS = [
  // 14-16 November (2026): a range gives both days
  { re: new RegExp(`\\b(\\d{1,2})${ORD}\\s*(?:-|to|and|&)\\s*(\\d{1,2})${ORD}\\s+(?:of\\s+)?(${MONTH_RE})\\.?(?:\\s*,?\\s*${YEAR})?\\b`, "gi"),
    read: (m) => [{ d: +m[1], mo: MONTHS[m[3].toLowerCase()], y: m[4] && +m[4] }, { d: +m[2], mo: MONTHS[m[3].toLowerCase()], y: m[4] && +m[4] }] },
  // (Friday,) (the) 14th (of) November(,) (2026)
  { re: new RegExp(`\\b(?:(${WD_RE})\\.?,?\\s+)?(?:the\\s+)?(\\d{1,2})${ORD}\\s+(?:of\\s+)?(${MONTH_RE})\\.?(?:\\s*,?\\s*${YEAR})?\\b`, "gi"),
    read: (m) => [{ wd: m[1], d: +m[2], mo: MONTHS[m[3].toLowerCase()], y: m[4] && +m[4] }] },
  // (Friday,) November 14(th)(,) (2026)
  { re: new RegExp(`\\b(?:(${WD_RE})\\.?,?\\s+)?(${MONTH_RE})\\.?\\s+(?:the\\s+)?(\\d{1,2})${ORD}\\b(?:\\s*,?\\s*${YEAR}\\b)?`, "gi"),
    read: (m) => [{ wd: m[1], d: +m[3], mo: MONTHS[m[2].toLowerCase()], y: m[4] && +m[4] }] },
  // 2026-11-14
  { re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, read: (m) => [{ d: +m[3], mo: +m[2], y: +m[1] }] },
  // (Fri) 14/11(/2026), 14-11-2026, 14.11.2026
  { re: new RegExp(`\\b(?:(${WD_RE})\\.?,?\\s+)?(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2,4}))?\\b`, "gi"),
    numeric: true,
    read: (m) => [{ wd: m[1], d: +m[2], mo: +m[3], y: m[4] && fullYear(m[4]) }] },
  { re: new RegExp(`\\b(?:(${WD_RE})\\.?,?\\s+)?(\\d{1,2})[-.](\\d{1,2})[-.](\\d{2,4})\\b`, "gi"),
    numeric: true,
    read: (m) => [{ wd: m[1], d: +m[2], mo: +m[3], y: fullYear(m[4]) }] },
];

const fullYear = (s) => (s.length === 2 ? 2000 + Number(s) : Number(s));

// Times. Each gives the minutes after midnight it could mean (3:30 with no
// am/pm could be 03:30 or 15:30).
const TIME_PATTERNS = [
  // 8am - 2pm, 8-10am, 10:00 to 12:30 pm: handled by the single patterns below
  // 3:30pm, 3.30 p.m., 8am, 8 o'clock
  { re: /\b(\d{1,2})(?:\s*[:.]\s*(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/gi,
    read: (m) => withMeridiem(+m[1], m[2] ? +m[2] : 0, m[3]) },
  { re: /\b(\d{1,2})\s*o'?\s?clock\b/gi, read: (m) => bare(+m[1], 0) },
  // 15:30, 9.00, 10h30
  { re: /\b(\d{1,2})\s*(?::|h)\s*(\d{2})\b/gi, read: (m) => bare(+m[1], +m[2]) },
  { re: /\b(\d{1,2})\.(\d{2})\b(?!\.\d)/g, read: (m) => bare(+m[1], +m[2]) },
  { re: /\b(noon|midday|midnight)\b/gi, read: (m) => [m[1].toLowerCase() === "midnight" ? 0 : 720] },
];

const withMeridiem = (h, min, mer) => {
  if (h < 1 || h > 12 || min > 59) return null;
  const pm = /^p/i.test(mer);
  return [((h % 12) + (pm ? 12 : 0)) * 60 + min];
};
const bare = (h, min) => {
  if (h > 23 || min > 59) return null;
  if (h >= 1 && h <= 11) return [h * 60 + min, (h + 12) * 60 + min];
  return [h * 60 + min];
};

// "GH₵ 5.50", "GHS 3.20", "5.50 cedis": money, not a time.
const isMoney = (text, index, length) =>
  /(gh[₵sc¢]?|₵|¢|\$)\s*$/i.test(text.slice(Math.max(0, index - 5), index)) ||
  /^\s*(cedis?|pesewas?|ghs)\b/i.test(text.slice(index + length, index + length + 8));

// Ordinals that aren't dates: "2nd term", "3rd position", "1st class".
const NOT_A_DAY = /^\s*(term|class|grade|year|place|position|floor|time|prize|edition|anniversary|birthday|round|week|stage|basic|form|primary|jhs|kg|half)\b/i;

const blank = (text, index, length) => text.slice(0, index) + " ".repeat(length) + text.slice(index + length);

const validDate = (d, mo) => mo >= 1 && mo <= 12 && d >= 1 && d <= 31;

/** Every date / time / weekday / year in a text, with the raw words. */
export const extractSpecifics = (input) => {
  let text = String(input || "");
  const out = { dates: [], times: [], weekdays: [], ordinals: [], years: [], invalid: [], numbers: new Set() };
  for (const n of text.match(/\d+/g) || []) out.numbers.add(String(Number(n)));

  for (const { re, read, numeric } of DATE_PATTERNS) {
    re.lastIndex = 0;
    const source = text;
    for (const m of source.matchAll(re)) {
      const found = read(m).filter((x) => validDate(x.d, x.mo));
      if (!found.length) {
        // 11/14 read day first is no date at all: still not something to print.
        if (numeric) {
          out.invalid.push(m[0].trim());
          text = blank(text, m.index, m[0].length);
        }
        continue;
      }
      for (const x of found) {
        out.dates.push({ day: x.d, month: x.mo, year: x.y || null, weekday: x.wd ? WEEKDAYS[x.wd.toLowerCase()] : null, raw: m[0].trim() });
      }
      text = blank(text, m.index, m[0].length);
    }
  }
  for (const { re, read } of TIME_PATTERNS) {
    re.lastIndex = 0;
    const source = text;
    for (const m of source.matchAll(re)) {
      if (isMoney(source, m.index, m[0].length)) continue;
      const minutes = read(m);
      if (!minutes) continue;
      // "4pm." at the end of a sentence: the full stop isn't part of the time.
      const raw = m[0].trim().replace(/^(\d[^.]*[ap]m)\.$/i, "$1");
      out.times.push({ minutes, raw });
      text = blank(text, m.index, m[0].length);
    }
  }
  for (const m of text.matchAll(/\b(\d{1,2})(st|nd|rd|th)\b/gi)) {
    if (NOT_A_DAY.test(text.slice(m.index + m[0].length))) continue;
    if (+m[1] >= 1 && +m[1] <= 31) out.ordinals.push({ day: +m[1], raw: m[0] });
  }
  // Weekdays standing alone: full names only ("sat the exam" is not Saturday).
  for (const m of text.matchAll(new RegExp(`\\b(${FULL_WEEKDAYS.join("|")})\\b`, "gi"))) {
    out.weekdays.push({ weekday: WEEKDAYS[m[1].toLowerCase()], raw: m[0] });
  }
  for (const m of text.matchAll(/\b(19\d{2}|20\d{2})\b/g)) out.years.push({ year: +m[1], raw: m[0] });
  return out;
};

/** The year a date with no year most likely means. */
export const resolveYear = (day, month, now = new Date()) => {
  const y = now.getUTCFullYear();
  const thisYear = Date.UTC(y, month - 1, day);
  return thisYear < now.getTime() - 60 * 86400000 ? y + 1 : y;
};
const weekdayOf = (day, month, year) => new Date(Date.UTC(year, month - 1, day)).getUTCDay();

/**
 * The dates, times, weekdays and years in `draft` that the key facts don't
 * give. An empty list means the draft is grounded.
 */
export const ungroundedSpecifics = (draft, keyFacts = [], { now = new Date() } = {}) => {
  const facts = extractSpecifics((Array.isArray(keyFacts) ? keyFacts : [keyFacts]).join("\n"));
  const got = extractSpecifics(draft);

  const factWeekdays = new Set([
    ...facts.weekdays.map((w) => w.weekday),
    ...facts.dates.filter((d) => d.weekday !== null).map((d) => d.weekday),
  ]);
  // A weekday is also given when it is the real weekday of a date in the facts.
  for (const d of facts.dates) factWeekdays.add(weekdayOf(d.day, d.month, d.year || resolveYear(d.day, d.month, now)));
  const factMinutes = new Set(facts.times.flatMap((t) => t.minutes));
  const factYears = new Set([...facts.years.map((y) => y.year), ...facts.dates.filter((d) => d.year).map((d) => d.year)]);
  const factDays = new Set([...facts.dates.map((d) => d.day), ...facts.ordinals.map((o) => o.day)]);

  const flagged = [];
  const flag = (raw) => {
    if (!flagged.some((f) => f.toLowerCase() === raw.toLowerCase())) flagged.push(raw);
  };

  for (const d of got.dates) {
    const match = facts.dates.find((f) => f.day === d.day && f.month === d.month && (!d.year || !f.year || f.year === d.year));
    if (!match) {
      flag(d.raw);
      continue;
    }
    if (d.year && !match.year && !factYears.has(d.year)) {
      flag(d.raw);
      continue;
    }
    if (d.weekday !== null) {
      const year = d.year || match.year || resolveYear(d.day, d.month, now);
      const stated = match.weekday !== null && match.weekday === d.weekday;
      if (!stated && weekdayOf(d.day, d.month, year) !== d.weekday) flag(d.raw);
    }
  }
  for (const raw of got.invalid) flag(raw);
  for (const t of got.times) if (!t.minutes.some((m) => factMinutes.has(m))) flag(t.raw);
  for (const w of got.weekdays) if (!factWeekdays.has(w.weekday)) flag(w.raw);
  for (const o of got.ordinals) if (!factDays.has(o.day) && !facts.numbers.has(String(o.day))) flag(o.raw);
  for (const y of got.years) if (!factYears.has(y.year) && !facts.numbers.has(String(y.year))) flag(y.raw);
  return flagged;
};
