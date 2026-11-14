import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { Attendance, Class, Student, StudentResult, Term, TotalAttendance } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { round2 } from "../utils/money.js";
import { assertClassAccess } from "./attendance.js";
import { getYear, termName } from "./academicYear.js";
import { competitionRank } from "./reportCards.js";
import { isKgSection } from "./teacherScope.js";

// ---------------------------------------------------------------------------
// B7: class results and attendance for a whole academic year (and attendance
// for one term, which had no class summary before).
//
// Who is in the list: anyone with results or register marks filed under this
// class in the chosen term(s), plus, while the open term is one of them, the
// class's current pupils (as report cards do). Last year's lists are not
// today's pupils: those have since been promoted.
//
// Pupils who changed class during the year:
//  - Results: only the terms filed under THIS class count (subjects and the
//    class differ elsewhere, so mixing them would make the position unfair).
//    `termsCounted` says how many terms that is; `otherClasses` names the
//    other class(es) they had results in that year.
//  - Attendance belongs to the pupil, so every day they were marked in those
//    terms counts, whichever class's register it was on (`otherClasses` again).
// ---------------------------------------------------------------------------

const toInt = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(`${name} is required`, 400);
  return n;
};
const fullName = (s) => [s.fName, s.mName, s.lName].filter(Boolean).join(" ");
const sameClass = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
const termOut = (t) => ({ termId: Number(t.termId), term: t.term, name: termName(t), active: Boolean(t.active) });

const loadClass = async (classId, user, what) => {
  const klass = await Class.findOne({ where: { classId: toInt(classId, "classId") }, raw: true });
  if (!klass) throw new AppError("Class not found", 404);
  try {
    await assertClassAccess(user, klass.name);
  } catch (e) {
    throw new AppError(`You can only see ${what} for your own class`, e.statusCode || 403);
  }
  return klass;
};

/** The terms a report covers: one term, or every term of a year (oldest first). */
const loadScope = async ({ termId, academicYearId }) => {
  const hasTerm = termId != null && String(termId) !== "";
  const hasYear = academicYearId != null && String(academicYearId) !== "";
  if (hasTerm === hasYear) throw new AppError("Choose a term or a whole year", 400);
  if (hasTerm) {
    const term = await Term.findOne({ where: { termId: toInt(termId, "termId") }, raw: true });
    if (!term) throw new AppError("Term not found", 404);
    return { kind: "term", year: null, terms: [term] };
  }
  const year = await getYear(academicYearId);
  const terms = await Term.findAll({
    where: { academicYearId: year.academicYearId },
    order: [["startDate", "ASC"], ["termId", "ASC"]],
    raw: true,
  });
  return { kind: "year", year, terms };
};

const scopeOut = (scope) => ({
  kind: scope.kind,
  academicYear: scope.year ? { academicYearId: scope.year.academicYearId, name: scope.year.name } : null,
  terms: scope.terms.map(termOut),
});

const currentPupils = (klass) =>
  Student.findAll({
    where: { isDeleted: false, [Op.or]: [{ classId: klass.classId }, { classId: null, class: klass.name }] },
    attributes: ["studentId", "fName", "mName", "lName"],
    raw: true,
  });

const namesFor = async (ids, known = []) => {
  const have = new Map(known.map((s) => [Number(s.studentId), fullName(s)]));
  const missing = ids.filter((id) => !have.has(id));
  if (missing.length) {
    const rows = await Student.findAll({
      where: { studentId: { [Op.in]: missing } },
      attributes: ["studentId", "fName", "mName", "lName"],
      raw: true,
    });
    for (const s of rows) have.set(Number(s.studentId), fullName(s));
  }
  return have;
};

const termPercent = (r) => {
  const total = Number(r?.totalRawScore);
  const raw = Number(r?.rawScore);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(raw)) return null;
  return round2((raw / total) * 100);
};

/**
 * Pure: one row per pupil from their StudentResult rows in the year.
 * `results` are this class's rows; `elsewhere` are the same pupils' rows under
 * other classes that year. The year average is the mean of the terms' scores
 * (each term = raw score / total raw score), so a pupil isn't ranked on terms
 * they had no results for; the position ranks that average (1, 1, 3).
 */
export const buildYearResults = ({ terms, results, elsewhere = [], names = new Map() }) => {
  const termIds = terms.map((t) => Number(t.termId));
  const byPupil = new Map();
  for (const r of results) {
    const sid = Number(r.studentId);
    const tid = Number(r.termId);
    if (!termIds.includes(tid)) continue;
    if (!byPupil.has(sid)) byPupil.set(sid, new Map());
    const prev = byPupil.get(sid).get(tid);
    // Old data can hold two rows for a pupil and term: the newest wins.
    if (!prev || Number(r.studentResultId) > Number(prev.studentResultId)) byPupil.get(sid).set(tid, r);
  }
  const other = new Map();
  for (const r of elsewhere) {
    const sid = Number(r.studentId);
    if (!other.has(sid)) other.set(sid, new Set());
    other.get(sid).add(String(r.class ?? "").trim());
  }

  const rows = [...byPupil.entries()].map(([studentId, perTerm]) => {
    const scores = {};
    let raw = 0;
    let total = 0;
    const pcts = [];
    for (const tid of termIds) {
      const r = perTerm.get(tid);
      if (!r) continue;
      const pct = termPercent(r);
      scores[tid] = { rawScore: r.rawScore == null ? null : Number(r.rawScore), totalRawScore: r.totalRawScore == null ? null : Number(r.totalRawScore), percent: pct };
      raw += Number(r.rawScore) || 0;
      total += Number(r.totalRawScore) || 0;
      if (pct !== null) pcts.push(pct);
    }
    return {
      studentId,
      name: names.get(studentId) || null,
      terms: scores,
      termsCounted: Object.keys(scores).length,
      rawScore: round2(raw),
      totalRawScore: round2(total),
      average: pcts.length ? round2(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null,
      otherClasses: [...(other.get(studentId) || [])].filter(Boolean).sort(),
    };
  });
  const rank = competitionRank(rows, (r) => r.studentId, (r) => r.average);
  return rows
    .map((r) => ({ ...r, position: rank.get(r.studentId) ?? null }))
    .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || String(a.name ?? "").localeCompare(String(b.name ?? "")));
};

/** GET /class-results/year?classId=&academicYearId= */
export const getClassYearResults = async (query = {}, user) => {
  const klass = await loadClass(query.classId, user, "results");
  if (isKgSection(klass.section)) {
    throw new AppError("Whole-year results are for classes with subject scores. KG results are shown term by term.", 400);
  }
  if (query.academicYearId == null || String(query.academicYearId) === "") throw new AppError("Choose a year", 400);
  const scope = await loadScope({ academicYearId: query.academicYearId });
  const termIds = scope.terms.map((t) => Number(t.termId));
  const out = { class: { classId: klass.classId, name: klass.name }, ...scopeOut(scope), students: [] };
  if (!termIds.length) return out;

  const results = await StudentResult.findAll({
    where: { class: klass.name, termId: { [Op.in]: termIds } },
    attributes: ["studentResultId", "studentId", "termId", "rawScore", "totalRawScore"],
    raw: true,
  });
  const ids = [...new Set(results.map((r) => Number(r.studentId)))];
  if (!ids.length) return out;
  const elsewhere = await StudentResult.findAll({
    where: { studentId: { [Op.in]: ids }, termId: { [Op.in]: termIds }, class: { [Op.ne]: klass.name } },
    attributes: ["studentId", "class"],
    raw: true,
  });
  const names = await namesFor(ids);
  out.students = buildYearResults({ terms: scope.terms, results, elsewhere, names });
  return out;
};

const emptyCounts = () => ({ present: 0, sick: 0, absent: 0, total: 0 });

/**
 * Pure: per-pupil attendance over the terms. For each pupil and term the
 * closed-term roll-up (TotalAttendance) is used when there is one, else the
 * daily register still held for that term (the open term). TotalAttendance
 * has no absent column: absent = days marked - present - sick.
 * `live` rows: { studentId, termId, class, present, sick, absent, total }.
 */
export const buildAttendanceSummary = ({ klass, terms, roster, live, totals, names = new Map() }) => {
  const termIds = terms.map((t) => Number(t.termId));
  const totalOf = new Map();
  for (const t of totals) {
    const key = `${Number(t.studentId)}:${Number(t.termId)}`;
    const prev = totalOf.get(key);
    if (!prev || Number(t.totalAttendanceId) > Number(prev.totalAttendanceId)) totalOf.set(key, t);
  }
  const liveOf = new Map();
  const other = new Map();
  for (const r of live) {
    const key = `${Number(r.studentId)}:${Number(r.termId)}`;
    const c = liveOf.get(key) || emptyCounts();
    c.present += Number(r.present) || 0;
    c.sick += Number(r.sick) || 0;
    c.absent += Number(r.absent) || 0;
    c.total += Number(r.total) || 0;
    liveOf.set(key, c);
    if (!sameClass(r.class, klass.name)) {
      const sid = Number(r.studentId);
      if (!other.has(sid)) other.set(sid, new Set());
      other.get(sid).add(String(r.class ?? "").trim());
    }
  }

  return roster
    .map((studentId) => {
      const perTerm = {};
      const sum = emptyCounts();
      for (const tid of termIds) {
        const key = `${studentId}:${tid}`;
        let c = null;
        const rolled = totalOf.get(key);
        if (rolled) {
          const days = Number(rolled.attendance) || 0;
          const present = Number(rolled.present) || 0;
          const sick = Number(rolled.sick) || 0;
          c = { present, sick, absent: Math.max(0, days - present - sick), total: days };
        } else if (liveOf.has(key)) {
          c = liveOf.get(key);
        }
        if (!c) continue;
        perTerm[tid] = c;
        sum.present += c.present;
        sum.sick += c.sick;
        sum.absent += c.absent;
        sum.total += c.total;
      }
      return {
        studentId,
        name: names.get(studentId) || null,
        ...sum,
        terms: perTerm,
        otherClasses: [...(other.get(studentId) || [])].filter(Boolean).sort(),
      };
    })
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")) || a.studentId - b.studentId);
};

/** GET /attendance-summary?classId=&termId=  or  &academicYearId= */
export const getClassAttendanceSummary = async (query = {}, user) => {
  const klass = await loadClass(query.classId, user, "attendance");
  const scope = await loadScope(query);
  const termIds = scope.terms.map((t) => Number(t.termId));
  const out = { class: { classId: klass.classId, name: klass.name }, ...scopeOut(scope), students: [] };
  if (!termIds.length) return out;

  // The registers still held for these terms (closed terms' daily rows are
  // removed at close, after the roll-up). status is CHAR(10): trimmed.
  const count = (s) => [sequelize.fn("SUM", sequelize.literal(`CASE WHEN TRIM(status) = '${s}' THEN 1 ELSE 0 END`)), s.toLowerCase()];
  const liveAll = await Attendance.findAll({
    attributes: ["studentId", "termId", "class", count("Present"), count("Sick"), count("Absent"), [sequelize.fn("COUNT", sequelize.col("status")), "total"]],
    where: { termId: { [Op.in]: termIds } },
    group: ["studentId", "termId", "class"],
    raw: true,
  });
  const results = await StudentResult.findAll({
    where: { class: klass.name, termId: { [Op.in]: termIds } },
    attributes: ["studentId"],
    raw: true,
  });
  const openTerm = scope.terms.some((t) => t.active);
  const current = openTerm ? await currentPupils(klass) : [];

  const roster = [
    ...new Set([
      ...liveAll.filter((r) => sameClass(r.class, klass.name)).map((r) => Number(r.studentId)),
      ...results.map((r) => Number(r.studentId)),
      ...current.map((s) => Number(s.studentId)),
    ]),
  ];
  if (!roster.length) return out;
  const inRoster = new Set(roster);
  const live = liveAll.filter((r) => inRoster.has(Number(r.studentId)));
  const totals = await TotalAttendance.findAll({
    where: { studentId: { [Op.in]: roster }, termId: { [Op.in]: termIds } },
    attributes: ["totalAttendanceId", "studentId", "termId", "present", "sick", "attendance"],
    raw: true,
  });
  // Pupils who changed class: results filed under another class in these terms.
  const elsewhere = await StudentResult.findAll({
    where: { studentId: { [Op.in]: roster }, termId: { [Op.in]: termIds }, class: { [Op.ne]: klass.name } },
    attributes: ["studentId", "class"],
    raw: true,
  });
  const names = await namesFor(roster, current);
  const students = buildAttendanceSummary({ klass, terms: scope.terms, roster, live, totals, names });
  const moved = new Map();
  for (const r of elsewhere) {
    const sid = Number(r.studentId);
    if (!moved.has(sid)) moved.set(sid, new Set());
    moved.get(sid).add(String(r.class ?? "").trim());
  }
  out.students = students.map((s) => ({
    ...s,
    otherClasses: [...new Set([...s.otherClasses, ...(moved.get(s.studentId) || [])])].filter((c) => c && !sameClass(c, klass.name)).sort(),
  }));
  return out;
};
