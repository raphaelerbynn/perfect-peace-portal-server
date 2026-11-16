// AI-5: the arithmetic behind the Monday briefing, and the check that keeps
// the AI honest. Pure functions, no database (ported from SchoolPro's
// briefing.types.ts, reduced to Perfect Peace's tables).
//
// A signal is one thing worth a head teacher's attention, measured here and
// never by the model:
//   { key, kind, subject, statement, severity (0..100), figures: [{ label, value, unit }] }
// `key` names the condition, not the occurrence. Keys measured against a
// rolling window carry the window's first day (fresh every briefing); keys
// measured against a term carry the term, so the same news is said once
// (see recentKeys in service.js).
//
// The model only ranks and words these. unsupportedFigures() rejects any
// number in its text that wasn't supplied, and the briefing falls back to the
// computed statements below.
import { formatGhs } from "../../utils/money.js";

export const SIGNAL_KINDS = Object.freeze([
  "ATTENDANCE_DIP",
  "CHRONIC_ABSENCE",
  "COLLECTION_DROP",
  "OWING",
  "RESULTS_GAPS",
  "STAFF_ABSENCE",
  "UNMARKED_REGISTERS",
]);

// The lines each signal must cross. owingThresholdGhs comes from the
// briefing settings (default GH₵ 100, the portal's owing lockout).
export const DEFAULT_THRESHOLDS = Object.freeze({
  baselineWeeks: 4,
  // Percentage points a class's attendance must fall below its own recent rate.
  attendanceDropPoints: 5,
  // Fewer marks than this in either window and a rate is not a rate.
  attendanceMinRecords: 20,
  // Share of marked days away (absent or sick) that makes a pupil chronically absent ...
  chronicAbsenceRate: 0.1,
  // ... once at least this many days have been marked this term.
  chronicAbsenceMinDays: 10,
  // The week's fee takings must fall by this share of a normal week.
  collectionDropShare: 0.4,
  // Registers missed across the school before it is worth saying.
  unmarkedRegistersMin: 3,
  // Days one member of staff is marked absent in the week to be named.
  staffAbsenceDays: 2,
  // Results gaps are only news this close to the end of term (days).
  resultsWindowDays: 21,
  owingThresholdGhs: 100,
});

// Most signals put in front of the model, and most items it may write.
export const MAX_SIGNALS = 12;
export const MAX_ITEMS = 6;

/** One decimal place, everywhere. */
export const round1 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : 0);
export const round0 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
const int = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);

/** Present over marked, as a percentage (1 dp); null when nothing was marked. */
export const attendanceRate = (present, marked) => (int(marked) > 0 ? round1((int(present) / int(marked)) * 100) : null);

/** How far past the line, on 0..100, so the shortlist can be ordered without a model. */
export const severityFrom = (excess, threshold, ceiling = 3) => {
  if (threshold <= 0) return excess > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((excess / threshold / ceiling) * 100)));
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cedis = (v) => formatGhs(round0(v));

// ------------------------------------------------------------------ attendance dip
/**
 * A class whose attendance in the last 7 days is well below its own rate over
 * the weeks before (this term only, so a new term has no baseline yet and is
 * quiet). Row: { classId, className, weekMarked, weekPresent, baselineMarked, baselinePresent }.
 */
export const attendanceDipSignal = (row, window, t = DEFAULT_THRESHOLDS) => {
  const weekMarked = int(row.weekMarked);
  const baselineMarked = int(row.baselineMarked);
  if (weekMarked < t.attendanceMinRecords || baselineMarked < t.attendanceMinRecords) return null;
  const week = attendanceRate(row.weekPresent, weekMarked);
  const baseline = attendanceRate(row.baselinePresent, baselineMarked);
  if (week === null || baseline === null) return null;
  const drop = round1(baseline - week);
  if (drop < t.attendanceDropPoints) return null;
  return {
    key: `attendance-dip:${row.classId}:${window.weekStart}`,
    kind: "ATTENDANCE_DIP",
    subject: String(row.className || "A class").trim(),
    statement: `${String(row.className).trim()} attendance was ${week}% in the last 7 days, against ${baseline}% over the weeks before, a fall of ${drop} points.`,
    severity: severityFrom(drop - t.attendanceDropPoints, t.attendanceDropPoints),
    figures: [
      { label: "Attendance, last 7 days", value: week, unit: "percent" },
      { label: "Attendance, weeks before", value: baseline, unit: "percent" },
      { label: "Fall", value: drop, unit: "points" },
      { label: "Register marks, last 7 days", value: weekMarked, unit: "count" },
    ],
  };
};

// ------------------------------------------------------------------ chronic absence
/**
 * A pupil who crossed the chronic absence line during the last 7 days: away
 * (absent or sick) on at least 10% of the days marked this term, with at least
 * 10 days marked, and not over the line before the window began. The crossing,
 * not the state: forty names every week helps nobody.
 * Row: { studentId, name, className, markedToDate, missedToDate, markedBefore, missedBefore }.
 */
export const chronicAbsenceSignal = (row, termId, t = DEFAULT_THRESHOLDS) => {
  const marked = int(row.markedToDate);
  const missed = int(row.missedToDate);
  if (marked < t.chronicAbsenceMinDays) return null;
  const rateNow = missed / marked;
  if (rateNow < t.chronicAbsenceRate) return null;
  const markedBefore = int(row.markedBefore);
  const wasOver = markedBefore >= t.chronicAbsenceMinDays && int(row.missedBefore) / markedBefore >= t.chronicAbsenceRate;
  if (wasOver) return null;
  const percent = round1(rateNow * 100);
  const line = round1(t.chronicAbsenceRate * 100);
  const name = String(row.name || "A pupil").trim();
  const where = row.className ? ` (${String(row.className).trim()})` : "";
  return {
    key: `chronic-absence:${row.studentId}:${termId}`,
    kind: "CHRONIC_ABSENCE",
    subject: name,
    statement: `${name}${where} has been away on ${missed} of ${marked} marked days this term, ${percent}%, crossing the ${line}% chronic absence line in the last 7 days.`,
    severity: severityFrom(percent - line, line, 2),
    figures: [
      { label: "Days away this term", value: missed, unit: "days" },
      { label: "Days marked this term", value: marked, unit: "days" },
      { label: "Share away", value: percent, unit: "percent" },
      { label: "Chronic absence line", value: line, unit: "percent" },
    ],
  };
};

// Above this many crossings in one briefing they become one signal, so a bad
// week of absences doesn't push everything else off the shortlist.
export const CHRONIC_GROUP_OVER = 3;

/**
 * Many crossings -> one signal naming up to 8 pupils, worst first. Carries the
 * pupils' own keys (memberKeys) so they are not repeated in later briefings.
 */
export const groupChronicSignals = (signals, termId, date) => {
  const chronic = signals.filter((s) => s.kind === "CHRONIC_ABSENCE" && !s.memberKeys);
  if (chronic.length <= CHRONIC_GROUP_OVER) return signals;
  const worst = [...chronic].sort((a, b) => b.severity - a.severity || a.subject.localeCompare(b.subject));
  const named = worst.slice(0, 8).map((s) => `${s.subject} (${s.figures.find((f) => f.unit === "percent")?.value}%)`);
  const more = chronic.length - named.length;
  const group = {
    key: `chronic-absence-group:${termId}:${date}`,
    kind: "CHRONIC_ABSENCE",
    subject: `${chronic.length} pupils now chronically absent`,
    statement: `${chronic.length} pupils crossed the ${chronic[0].figures.find((f) => f.label === "Chronic absence line")?.value}% chronic absence line in the last 7 days: ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`,
    severity: Math.min(100, Math.max(...chronic.map((s) => s.severity)) + 10),
    figures: [
      { label: "Pupils who crossed the line", value: chronic.length, unit: "students" },
      ...worst.slice(0, 8).map((s) => ({ label: `${s.subject}, share away`, value: s.figures.find((f) => f.unit === "percent")?.value, unit: "percent" })),
    ],
    memberKeys: chronic.map((s) => s.key),
  };
  return rankSignals([...signals.filter((s) => !chronic.includes(s)), group]);
};

// ------------------------------------------------------------------ fee collection
/** Median of numbers (0 for none). Robust against one start-of-term rush week. */
export const median = (values) => {
  const v = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

/**
 * Fees taken in the last 7 days against a normal week (the median of the 4
 * weeks before). Rows: [{ bucket: 0..4, total, payments }] where 0 = the last
 * 7 days and 1..4 the weeks before (a week with no payments has no row).
 * No signal without a baseline (nothing to fall from) or in the holidays.
 */
export const collectionDropSignal = (rows, window, t = DEFAULT_THRESHOLDS) => {
  const byBucket = new Map((rows || []).map((r) => [Number(r.bucket), r]));
  const weeks = Array.from({ length: t.baselineWeeks }, (_, i) => Number(byBucket.get(i + 1)?.total || 0));
  const normalWeek = round0(median(weeks));
  if (normalWeek <= 0) return null;
  const week = round0(byBucket.get(0)?.total || 0);
  const payments = int(byBucket.get(0)?.payments);
  const share = week / normalWeek;
  if (share > 1 - t.collectionDropShare) return null;
  const fall = round1((1 - share) * 100);
  return {
    key: `collection-drop:${window.weekStart}`,
    kind: "COLLECTION_DROP",
    subject: "Fee payments, last 7 days",
    statement: `Fee payments in the last 7 days came to ${cedis(week)} from ${plural(payments, "payment")}, ${fall}% below a normal week of ${cedis(normalWeek)} (the middle of the ${t.baselineWeeks} weeks before).`,
    severity: severityFrom(fall - t.collectionDropShare * 100, t.collectionDropShare * 100, 2),
    figures: [
      { label: "Taken, last 7 days", value: week, unit: "currency" },
      { label: "Normal week", value: normalWeek, unit: "currency" },
      { label: "Fall", value: fall, unit: "percent" },
      { label: "Payments recorded", value: payments, unit: "count" },
    ],
  };
};

// ------------------------------------------------------------------ owing
/**
 * Pupils owing the line or more (default GH₵ 100, the portal lockout).
 * Row: { count, total, onRoll, byClass: [{ className, count }] }.
 * Keyed on the term and a band of 10 pupils, so it is said once and again
 * only when the number moves by a band.
 */
export const owingSignal = (row, termId, t = DEFAULT_THRESHOLDS) => {
  const count = int(row?.count);
  if (count <= 0) return null;
  const total = round0(row.total);
  const onRoll = int(row.onRoll);
  const share = onRoll > 0 ? round1((count / onRoll) * 100) : null;
  const line = round0(t.owingThresholdGhs);
  const worst = (row.byClass || []).slice(0, 3).map((c) => ({ className: String(c.className || "No class").trim(), count: int(c.count) }));
  const most = worst.length ? ` Most in ${worst.map((c) => `${c.className} (${c.count})`).join(", ")}.` : "";
  return {
    key: `owing:${termId ?? "none"}:${line}:${Math.floor(count / 10)}`,
    kind: "OWING",
    subject: `Pupils owing ${cedis(line)} or more`,
    statement: `${plural(count, "pupil")} owe ${cedis(line)} or more, ${cedis(total)} in all${share !== null ? `, ${share}% of the ${onRoll} on roll` : ""}.${most}`,
    severity: share !== null ? Math.min(100, round0(share * 2)) : 50,
    figures: [
      { label: "Pupils owing", value: count, unit: "students" },
      { label: "Owing line", value: line, unit: "currency" },
      { label: "Total owed by them", value: total, unit: "currency" },
      ...(share !== null ? [{ label: "Share of pupils on roll", value: share, unit: "percent" }, { label: "Pupils on roll", value: onRoll, unit: "students" }] : []),
      ...worst.map((c) => ({ label: `${c.className} pupils owing`, value: c.count, unit: "students" })),
    ],
  };
};

// ------------------------------------------------------------------ results gaps
/**
 * Score sheets still missing pupils' scores, only in the last weeks of term
 * (daysToEnd <= resultsWindowDays, or past the end date while the term is
 * still open). Rows: findMissingScores() [{ className, subjectName, missing, expected }].
 * Keyed on the briefing date: near the deadline it is worth repeating.
 */
export const resultsGapsSignal = (rows, ctx, t = DEFAULT_THRESHOLDS) => {
  if (ctx.daysToEnd === null || ctx.daysToEnd === undefined || ctx.daysToEnd > t.resultsWindowDays) return null;
  const gaps = (rows || []).filter((r) => int(r.missing) > 0);
  if (!gaps.length) return null;
  const missing = gaps.reduce((n, r) => n + int(r.missing), 0);
  const worst = [...gaps].sort((a, b) => int(b.missing) - int(a.missing)).slice(0, 5);
  const named = worst.map((r) => `${String(r.subjectName).trim()} in ${String(r.className).trim()} (${int(r.missing)} of ${int(r.expected)})`).join(", ");
  const when = ctx.daysToEnd >= 0 ? `${plural(ctx.daysToEnd, "day")} before ${ctx.termLabel} ends` : `and ${ctx.termLabel} has passed its end date`;
  return {
    key: `results-gaps:${ctx.termId}:${ctx.date}`,
    kind: "RESULTS_GAPS",
    subject: `Scores still missing, ${ctx.termLabel}`,
    statement: `${plural(missing, "pupil score")} ${missing === 1 ? "is" : "are"} still missing across ${plural(gaps.length, "score sheet")}, ${when}. Most missing: ${named}.`,
    severity: severityFrom(t.resultsWindowDays - Math.max(0, ctx.daysToEnd), t.resultsWindowDays, 1),
    figures: [
      { label: "Scores missing", value: missing, unit: "count" },
      { label: "Score sheets with gaps", value: gaps.length, unit: "count" },
      ...(ctx.daysToEnd >= 0 ? [{ label: "Days to the end of term", value: ctx.daysToEnd, unit: "days" }] : []),
      ...worst.map((r) => ({ label: `${String(r.subjectName).trim()} in ${String(r.className).trim()} missing`, value: int(r.missing), unit: "count" })),
    ],
  };
};

// ------------------------------------------------------------------ staff absence (B9)
/**
 * A member of staff marked ABSENT on several days in the last 7 days. Sick,
 * leave and permission are recorded and expected, so they are not counted.
 * Row: { teacherId, name, weekAbsences }.
 */
export const staffAbsenceSignal = (row, window, t = DEFAULT_THRESHOLDS) => {
  const days = int(row.weekAbsences);
  if (days < t.staffAbsenceDays) return null;
  const name = String(row.name || "A member of staff").trim();
  return {
    key: `staff-absence:${row.teacherId}:${window.weekStart}`,
    kind: "STAFF_ABSENCE",
    subject: name,
    statement: `${name} was marked absent on ${plural(days, "day")} in the last 7 days. Sick days, leave and permission are not counted.`,
    severity: severityFrom(days - t.staffAbsenceDays + 1, t.staffAbsenceDays, 2),
    figures: [
      { label: "Days absent, last 7 days", value: days, unit: "days" },
      { label: "Line", value: t.staffAbsenceDays, unit: "days" },
    ],
  };
};

// ------------------------------------------------------------------ unmarked registers
/**
 * Registers never taken. A school day is a weekday on which some class marked
 * a register (so a holiday blames nobody); every class with pupils owes one on
 * each. One signal for the school, the worst classes named inside it.
 * Rows: [{ classId, className, missed }].
 */
export const unmarkedRegistersSignal = (rows, schoolDays, window, t = DEFAULT_THRESHOLDS) => {
  const offenders = (rows || []).filter((r) => int(r.missed) > 0);
  const total = offenders.reduce((n, r) => n + int(r.missed), 0);
  if (!int(schoolDays) || total < t.unmarkedRegistersMin) return null;
  const worst = [...offenders].sort((a, b) => int(b.missed) - int(a.missed)).slice(0, 5);
  const named = worst.map((r) => `${String(r.className).trim()} (${int(r.missed)})`).join(", ");
  return {
    key: `unmarked-registers:${window.weekStart}`,
    kind: "UNMARKED_REGISTERS",
    subject: "Unmarked registers",
    statement: `${plural(total, "register")} went unmarked across ${plural(offenders.length, "class", "classes")} over ${plural(int(schoolDays), "school day")} in the last 7 days. Most missed: ${named}.`,
    severity: severityFrom(total - t.unmarkedRegistersMin, t.unmarkedRegistersMin, 4),
    figures: [
      { label: "Registers unmarked", value: total, unit: "registers" },
      { label: "Classes affected", value: offenders.length, unit: "count" },
      { label: "School days", value: int(schoolDays), unit: "days" },
      ...worst.map((r) => ({ label: `${String(r.className).trim()} unmarked`, value: int(r.missed), unit: "registers" })),
    ],
  };
};

/** Most severe first; ties by kind then key, so the order is stable. */
export const rankSignals = (signals) =>
  [...signals].sort((a, b) => b.severity - a.severity || SIGNAL_KINDS.indexOf(a.kind) - SIGNAL_KINDS.indexOf(b.kind) || a.key.localeCompare(b.key));

// ------------------------------------------------------------------ the plain briefing (no AI)
// What each item says to do when the AI isn't used (over the cap, off, or its
// answer was rejected). No figures, so nothing here can be wrong.
export const PLAIN_NEXT_STEP = Object.freeze({
  ATTENDANCE_DIP: "Ask the class teacher why attendance fell and follow up with the families of the pupils who were away.",
  CHRONIC_ABSENCE: "Ask the class teacher to call the family this week.",
  COLLECTION_DROP: "Check with the bursar that payments are being recorded, and remind families with balances.",
  OWING: "Ask the bursar for the owing list and send fee reminders to those families.",
  RESULTS_GAPS: "Remind the teachers to enter the missing scores before the end of term.",
  STAFF_ABSENCE: "Speak with the member of staff and check that their lessons were covered.",
  UNMARKED_REGISTERS: "Remind the class teachers to mark the register every morning.",
});

export const plainItems = (signals) =>
  signals.map((s) => ({
    signalKey: s.key,
    ...(s.memberKeys ? { memberKeys: s.memberKeys } : {}),
    kind: s.kind,
    headline: s.subject,
    body: s.statement,
    whatToDoNext: PLAIN_NEXT_STEP[s.kind] || "Look into this this week.",
    statement: s.statement,
    figures: s.figures,
  }));

// ------------------------------------------------------------------ the guarantee
/**
 * Every number-shaped token in a piece of text. Greedy on purpose: grouping
 * separators, decimals, currency prefixes and percent signs are pulled in, so
 * the check can't be walked around by writing 12,500 instead of 12500.
 */
export const normaliseFigureToken = (raw) => {
  const cleaned = String(raw).replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return "";
  const [whole, fraction = ""] = cleaned.split(".");
  const w = whole.replace(/^0+(?=\d)/, "");
  const f = fraction.replace(/0+$/, "");
  return f ? `${w}.${f}` : w;
};

export const extractFigureTokens = (text) =>
  (String(text ?? "").match(/\d[\d,\s]*(?:\.\d+)?/g) || []).map(normaliseFigureToken).filter((t) => t.length > 0);

/**
 * Every figure the model was given, as canonical tokens: numbers (as given,
 * rounded to 0 and 1 dp) and the numbers inside strings ("JHS 2", dates).
 */
export const allowedFigureTokens = (supplied) => {
  const tokens = new Set();
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === "number") {
      if (!Number.isFinite(node)) return;
      tokens.add(normaliseFigureToken(String(node)));
      tokens.add(normaliseFigureToken(String(round0(node))));
      tokens.add(normaliseFigureToken(String(round1(node))));
      return;
    }
    if (typeof node === "string") {
      for (const tok of extractFigureTokens(node)) tokens.add(tok);
      return;
    }
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node === "object") Object.values(node).forEach(walk);
  };
  walk(supplied);
  tokens.delete("");
  return tokens;
};

/** The figures in `text` that were never supplied. Empty = every number came from the arithmetic. */
export const unsupportedFigures = (text, allowed) => extractFigureTokens(text).filter((t) => !allowed.has(t));
