// AI-5: when the briefing is due, in Africa/Accra (GMT all year, no daylight
// saving, but computed through Intl so the server's own zone never matters).
//
// The Administrator picks the weekdays (ISO 1 = Monday .. 7 = Sunday) and a
// time (default Monday 06:00). The timer ticks once a minute; a day is due from
// its time until midnight, so a server that was down (or restarting) at 06:00
// still makes that day's briefing when it comes back. Ai_briefing.run_key
// (the date) is UNIQUE, so a restart or a second instance never makes two.

export const BRIEFING_TZ = "Africa/Accra";
export const DAY_NAMES = Object.freeze(["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: BRIEFING_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

/** { date: "YYYY-MM-DD", isoWeekday: 1..7, time: "HH:MM", minutes } for an instant, in Accra. */
export const accraParts = (instant = new Date()) => {
  const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value]));
  const hour = p.hour === "24" ? "00" : p.hour;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    isoWeekday: WEEKDAY[p.weekday],
    time: `${hour}:${p.minute}`,
    minutes: Number(hour) * 60 + Number(p.minute),
  };
};

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const toMinutes = (hhmm) => (TIME_RE.test(String(hhmm)) ? Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) : null);

/** Days as a clean sorted list of 1..7. */
export const cleanDays = (days) => [...new Set((Array.isArray(days) ? days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b);

/** True when `now` (Accra) is a chosen day at or after the chosen time. */
export const isDue = (now, { days, runTime }) => {
  const p = accraParts(now);
  const at = toMinutes(runTime);
  return at !== null && cleanDays(days).includes(p.isoWeekday) && p.minutes >= at;
};

// ------------------------------------------------------------------ dates as "YYYY-MM-DD"
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const addDays = (date, n) => {
  if (!DATE_RE.test(String(date))) throw new Error(`Not a date: ${date}`);
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
export const daysBetween = (from, to) => {
  const ms = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((ms(to) - ms(from)) / 86400000);
};
/** ISO weekday of a "YYYY-MM-DD" (a civil date, no zone involved). */
export const weekdayOf = (date) => {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};

/** The instant a civil Accra date + "HH:MM" happens. */
export const accraInstant = (date, hhmm) => {
  const guess = new Date(`${date}T${hhmm}:00Z`);
  // Accra is UTC+0; correct by whatever the zone database says, to be safe.
  const p = accraParts(guess);
  const drift = daysBetween(date, p.date) * 1440 + (p.minutes - toMinutes(hhmm));
  return new Date(guess.getTime() - drift * 60000);
};

/**
 * The next time a briefing will be made: today if today is a chosen day whose
 * time hasn't passed (or has passed but today's isn't made yet), else the next
 * chosen day. null when no day is chosen.
 */
export const nextRunAt = (now, { days, runTime }, { doneToday = false } = {}) => {
  const list = cleanDays(days);
  if (!list.length || toMinutes(runTime) === null) return null;
  const today = accraParts(now);
  for (let i = 0; i <= 7; i += 1) {
    const date = addDays(today.date, i);
    if (!list.includes(weekdayOf(date))) continue;
    if (i === 0) {
      if (doneToday) continue;
      if (today.minutes >= toMinutes(runTime)) return now; // due now (catching up)
    }
    return accraInstant(date, runTime);
  }
  return null;
};

/** "Mondays and Thursdays at 06:00" */
export const describeSchedule = ({ days, runTime }) => {
  const list = cleanDays(days);
  if (!list.length) return "Not scheduled (Run now only)";
  const names = list.map((d) => `${DAY_NAMES[d]}s`);
  const joined = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return `${list.length === 7 ? "Every day" : joined} at ${runTime}`;
};
