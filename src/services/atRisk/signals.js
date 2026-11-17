// AI-4: who is at risk, and why. Pure functions, no database (ported from
// SchoolPro's improvement.types.ts watchlist maths, reduced to one school and
// Perfect Peace's tables). The arithmetic decides who is on the list and in
// what order; the AI (service.js) only words a short note about it.
//
// A pupil is on the watchlist when at least one REASON fires:
//   LOW_ATTENDANCE        attendance this term below the line (90%, the
//                         briefing's chronic-absence line), once enough days
//                         are marked (10)
//   CONSECUTIVE_ABSENCES  away (absent or sick) on the last N marked days in a
//                         row (3), open term only
//   SCORE_DROP            average subject score down N points (5) on the
//                         previous term, both terms with at least 3 subjects
//   FAILING_SUBJECTS      N or more subjects (2) below the pass mark (the B8
//                         scale's pass band for the class's section; 50 when
//                         no scale is set up)
//   OWING                 fees owing at or over the line (the briefing's
//                         owing line, GH₵ 100 = the portal lockout), open term
// KG / nursery classes have no subject scores: attendance and fees only.
//
// Each reason carries a plain statement and its figures; the risk score is
// the sum of the reasons' weights (SchoolPro's weights, plus our two extra
// reasons) and only orders the list and sets the level.
import { formatGhs } from "../../utils/money.js";
import { DEFAULT_THRESHOLDS as BRIEFING } from "../briefing/signals.js";

export const REASON_KINDS = Object.freeze(["CONSECUTIVE_ABSENCES", "LOW_ATTENDANCE", "FAILING_SUBJECTS", "SCORE_DROP", "OWING"]);
export const LEVELS = Object.freeze(["HIGH", "MEDIUM", "LOW"]);

export const DEFAULT_THRESHOLDS = Object.freeze({
  // Attendance below this share of marked days present (percent) ...
  attendanceLine: Math.round((1 - BRIEFING.chronicAbsenceRate) * 100),
  // ... once at least this many days are marked this term.
  attendanceMinDays: BRIEFING.chronicAbsenceMinDays,
  // Marked days away in a row, up to the latest register.
  consecutiveAbsenceDays: 3,
  // Points the average subject score must fall on the previous term ...
  scoreDropPoints: 5,
  // ... with at least this many subjects scored in BOTH terms.
  minSubjectsForAverage: 3,
  // Subjects below the pass mark before it is "failing several".
  failingSubjectsMin: 2,
  // Pass mark when the school has no B8 grading scale set up.
  defaultPassMark: 50,
  owingThresholdGhs: BRIEFING.owingThresholdGhs,
});

// The risk score (SchoolPro: 3 per mark of average lost, 2 per attendance
// point under the line, 4 per subject below pass; ours: 3 per day away in a
// row, 4 for fees owing). Weights are policy, not measurement.
export const WEIGHTS = Object.freeze({
  perPointOfAverageLost: 3,
  perPointBelowAttendanceLine: 2,
  perSubjectBelowPass: 4,
  perDayAwayInARow: 3,
  owing: 4,
});

// Level: HIGH at 24+ or three reasons, MEDIUM at 12+ or two reasons, else LOW.
export const LEVEL_LINES = Object.freeze({ high: 24, medium: 12 });

export const round1 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : 0);
const int = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const trimmed = (s) => String(s ?? "").trim();

/** Present over marked as a 1-dp percentage; null when nothing was marked. */
export const attendanceRate = (present, marked) => (int(marked) > 0 ? round1((int(present) / int(marked)) * 100) : null);

/**
 * B8: the pass mark for a class from its grading bands = the start of the
 * lowest band whose remark is not a fail. null when the bands don't say (no
 * fail band, or no bands), so the caller uses the default (50).
 */
export const passMarkFromBands = (bands) => {
  const sorted = (Array.isArray(bands) ? bands : [])
    .map((b) => ({ min: Number(b.minScore), remark: trimmed(b.remark) }))
    .filter((b) => Number.isFinite(b.min))
    .sort((a, b) => a.min - b.min);
  if (!sorted.length || !/fail/i.test(sorted[0].remark)) return null;
  const pass = sorted.find((b) => !/fail/i.test(b.remark));
  return pass && pass.min > 0 ? pass.min : null;
};

/** Marked days away in a row, newest first. statuses: newest first, CHAR-padded is fine. */
export const daysAwayInARow = (statuses) => {
  let n = 0;
  for (const s of statuses || []) {
    if (trimmed(s.status ?? s) === "Present") break;
    n += 1;
  }
  return n;
};

/** One subject list -> { subjects, average, below: [{ name, score }] } (worst first). */
export const summariseMarks = (marks, passMark) => {
  const rows = (marks || []).filter((m) => m && m.score !== null && m.score !== undefined && Number.isFinite(Number(m.score)));
  if (!rows.length) return { subjects: 0, average: null, below: [] };
  const average = round1(rows.reduce((t, m) => t + Number(m.score), 0) / rows.length);
  const below = rows
    .filter((m) => Number(m.score) < passMark)
    .map((m) => ({ name: trimmed(m.subjectName) || "A subject", score: round1(m.score) }))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return { subjects: rows.length, average, below };
};

// ------------------------------------------------------------------ the reasons
const reasonLowAttendance = ({ attendance }, t) => {
  const marked = int(attendance?.marked);
  if (marked < t.attendanceMinDays) return null;
  const present = int(attendance.present);
  const rate = attendanceRate(present, marked);
  if (rate === null || rate >= t.attendanceLine) return null;
  const below = round1(t.attendanceLine - rate);
  return {
    kind: "LOW_ATTENDANCE",
    label: "Low attendance",
    statement: `Present on ${present} of ${marked} marked days this term, ${rate}%, below the ${t.attendanceLine}% line.`,
    points: below * WEIGHTS.perPointBelowAttendanceLine,
    figures: [
      { label: "Attendance this term", value: rate, unit: "percent" },
      { label: "Days present", value: present, unit: "days" },
      { label: "Days marked", value: marked, unit: "days" },
      { label: "Attendance line", value: t.attendanceLine, unit: "percent" },
    ],
  };
};

const reasonConsecutive = ({ recent, openTerm }, t) => {
  if (!openTerm) return null;
  const days = daysAwayInARow(recent);
  if (days < t.consecutiveAbsenceDays) return null;
  const latest = recent?.[0]?.date ? String(recent[0].date).slice(0, 10) : null;
  return {
    kind: "CONSECUTIVE_ABSENCES",
    label: "Away several days in a row",
    statement: `Away on the last ${days} marked days in a row${latest ? ` (latest register ${latest})` : ""}.`,
    points: days * WEIGHTS.perDayAwayInARow,
    figures: [
      { label: "Days away in a row", value: days, unit: "days" },
      ...(latest ? [{ label: "Latest register", value: latest, unit: "date" }] : []),
      { label: "Line", value: t.consecutiveAbsenceDays, unit: "days" },
    ],
  };
};

const reasonScoreDrop = ({ isKg, current, previous, previousTermLabel }, t) => {
  if (isKg || !previous) return null;
  if (current.subjects < t.minSubjectsForAverage || int(previous.subjects) < t.minSubjectsForAverage) return null;
  if (current.average === null || previous.average === null || previous.average === undefined) return null;
  const before = round1(previous.average);
  const drop = round1(before - current.average);
  if (drop < t.scoreDropPoints) return null;
  const when = previousTermLabel ? ` (${previousTermLabel})` : "";
  return {
    kind: "SCORE_DROP",
    label: "Scores dropped",
    statement: `Average score fell from ${before} last term${when} to ${current.average} this term, down ${drop} points.`,
    points: drop * WEIGHTS.perPointOfAverageLost,
    figures: [
      { label: "Average this term", value: current.average, unit: "score" },
      { label: "Average last term", value: before, unit: "score" },
      { label: "Fall", value: drop, unit: "points" },
      ...(previousTermLabel ? [{ label: "Last term", value: previousTermLabel, unit: "term" }] : []),
    ],
  };
};

const reasonFailing = ({ isKg, current, passMark }, t) => {
  if (isKg) return null;
  const n = current.below.length;
  if (n < t.failingSubjectsMin) return null;
  const worst = current.below.slice(0, 3);
  const named = worst.map((s) => `${s.name} (${s.score})`).join(", ");
  return {
    kind: "FAILING_SUBJECTS",
    label: "Failing several subjects",
    statement: `${n} of ${plural(current.subjects, "subject")} below the pass mark of ${passMark} this term. Lowest: ${named}.`,
    points: n * WEIGHTS.perSubjectBelowPass,
    figures: [
      { label: "Subjects below the pass mark", value: n, unit: "count" },
      { label: "Subjects scored", value: current.subjects, unit: "count" },
      { label: "Pass mark", value: passMark, unit: "score" },
      ...worst.map((s) => ({ label: s.name, value: s.score, unit: "score" })),
    ],
  };
};

const reasonOwing = ({ owing, openTerm }, t) => {
  if (!openTerm) return null;
  const amount = Number(owing);
  if (!Number.isFinite(amount) || amount < t.owingThresholdGhs || amount <= 0) return null;
  return {
    kind: "OWING",
    label: "Fees owing",
    statement: `Owes ${formatGhs(amount)} in fees, at or over the ${formatGhs(t.owingThresholdGhs)} line.`,
    points: WEIGHTS.owing,
    figures: [
      { label: "Fees owing", value: amount, unit: "currency" },
      { label: "Owing line", value: t.owingThresholdGhs, unit: "currency" },
    ],
  };
};

// What to do first when the AI hasn't written a note (or can't). No figures.
export const FIRST_ACTION = Object.freeze({
  CONSECUTIVE_ABSENCES: "Call the family today to find out why the pupil has been away.",
  LOW_ATTENDANCE: "Speak with the family about the days missed this term.",
  FAILING_SUBJECTS: "Speak with the subject teachers about the weakest subjects and agree some extra help.",
  SCORE_DROP: "Go through this term's scores against last term's, subject by subject, with the class teacher.",
  OWING: "Ask the bursar to contact the family about the balance.",
});

export const levelFor = (score, reasonCount) => {
  if (score >= LEVEL_LINES.high || reasonCount >= 3) return "HIGH";
  if (score >= LEVEL_LINES.medium || reasonCount >= 2) return "MEDIUM";
  return "LOW";
};

/**
 * One pupil's assessment, or null when no reason fires.
 * input: {
 *   isKg, openTerm, owing,
 *   attendance: { marked, present },          this term (roll-up or registers)
 *   recent: [{ date, status }],               newest first, this term's registers
 *   marks: [{ subjectName, score }],          this term, one per subject
 *   previous: { subjects, average } | null,   last term (null: none / new pupil)
 *   previousTermLabel, passMark (null -> default)
 * }
 */
export const assessPupil = (input, thresholds = DEFAULT_THRESHOLDS) => {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const passMark = Number.isFinite(Number(input.passMark)) && input.passMark !== null ? Number(input.passMark) : t.defaultPassMark;
  const current = input.isKg ? { subjects: 0, average: null, below: [] } : summariseMarks(input.marks, passMark);
  const ctx = { ...input, current, passMark };
  const reasons = [reasonConsecutive(ctx, t), reasonLowAttendance(ctx, t), reasonFailing(ctx, t), reasonScoreDrop(ctx, t), reasonOwing(ctx, t)].filter(Boolean);
  if (!reasons.length) return null;
  const riskScore = Math.round(reasons.reduce((s, r) => s + r.points, 0));
  return {
    reasons: reasons.map(({ points, ...r }) => ({ ...r, points: Math.round(points) })),
    riskScore,
    level: levelFor(riskScore, reasons.length),
    firstAction: FIRST_ACTION[reasons[0].kind],
    average: current.average,
    subjects: current.subjects,
  };
};

/** Most at risk first; ties by number of reasons, then name, then id (a total order). */
export const orderWatchlist = (entries) =>
  [...entries].sort(
    (a, b) =>
      b.riskScore - a.riskScore ||
      b.reasons.length - a.reasons.length ||
      String(a.name).localeCompare(String(b.name)) ||
      Number(a.studentId) - Number(b.studentId)
  );

/**
 * A short hash of a pupil's reasons and figures. An AI note is shown only
 * while this matches, so a note never describes last week's figures.
 * FNV-1a 32 bit, as SchoolPro's watchlistFingerprint.
 */
export const fingerprintOf = (reasons) => {
  const material = (reasons || []).map((r) => `${r.kind}:${(r.figures || []).map((f) => `${f.label}=${f.value}`).join(",")}`).join(";");
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

/**
 * A dismissed / handled mark set for some reasons still holds unless a NEW
 * reason has appeared since (then the pupil is back on the open list).
 */
export const effectiveStatus = (row, reasons) => {
  if (!row?.status) return { state: "OPEN", reopened: false };
  const had = new Set(Array.isArray(row.statusKinds) ? row.statusKinds : []);
  const fresh = (reasons || []).map((r) => r.kind).filter((k) => !had.has(k));
  if (row.status === "DISMISSED" && fresh.length) return { state: "OPEN", reopened: true, newKinds: fresh };
  return { state: row.status, reopened: false };
};
