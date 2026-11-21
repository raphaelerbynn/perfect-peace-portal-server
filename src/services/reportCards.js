import { Op } from "sequelize";
import {
  Attendance,
  Class,
  KgAssessment,
  Student,
  StudentMarks,
  StudentResult,
  Subject,
  Term,
  TotalAttendance,
} from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { assertClassAccess } from "./attendance.js";
import { isKgSection } from "./teacherScope.js";

// ---------------------------------------------------------------------------
// B4: report cards for a whole class. Ported from SchoolPro's
// ReportCardService (grades/report-card.service.ts): a completeness check
// before printing, and competition ranking (1, 1, 3) for positions.
//
// PP keeps no report-card snapshot: a card is the pupil's StudentResult +
// StudentMarks (or KgAssessment rows for KG) for the term, read in a few
// batched queries for the whole class (not one request per pupil).
// ---------------------------------------------------------------------------

const toInt = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(`${name} is required`, 400);
  return n;
};
const fullName = (s) => [s.fName, s.mName, s.lName].filter(Boolean).join(" ");
const byName = (a, b) => a.name.localeCompare(b.name);

/**
 * Competition ranking: equal scores share a place and the next place is
 * skipped (90, 90, 80 -> 1, 1, 3). Returns a Map key -> position.
 * Rows without a numeric score get no position.
 */
export const competitionRank = (rows, keyOf, scoreOf) => {
  const scored = rows
    .filter((r) => scoreOf(r) !== null && scoreOf(r) !== undefined && scoreOf(r) !== "")
    .map((r) => ({ key: keyOf(r), score: Number(scoreOf(r)) }))
    .filter((r) => Number.isFinite(r.score))
    .sort((a, b) => b.score - a.score);
  const out = new Map();
  scored.forEach((r, i) => {
    out.set(r.key, i > 0 && r.score === scored[i - 1].score ? out.get(scored[i - 1].key) : i + 1);
  });
  return out;
};

/** "1ST", "2ND", "11TH", "22ND"... as on the paper card. */
export const ordinal = (n) => {
  if (!Number.isFinite(Number(n)) || !n) return null;
  const v = Number(n);
  const teen = v % 100 >= 11 && v % 100 <= 13;
  const suffix = teen ? "TH" : { 1: "ST", 2: "ND", 3: "RD" }[v % 10] || "TH";
  return `${v}${suffix}`;
};

/** Observation fields the class teacher fills in, shown on the card. */
const TEACHER_FIELDS = [
  ["conduct", "conduct"],
  ["attitude", "attitude"],
  ["interest", "interest"],
  ["teacherRemarks", "class teacher's remarks"],
];

const loadClassAndTerm = async (classId, termId, user) => {
  const klass = await Class.findOne({ where: { classId: toInt(classId, "classId") }, raw: true });
  if (!klass) throw new AppError("Class not found", 404);
  // A Class Teacher office login sees only their own class (as with results).
  try {
    await assertClassAccess(user, klass.name);
  } catch (e) {
    throw new AppError("You can only see report cards for your own class", e.statusCode || 403);
  }
  const term = await Term.findOne({ where: { termId: toInt(termId, "termId") }, raw: true });
  if (!term) throw new AppError("Term not found", 404);
  return { klass, term };
};

/**
 * Everything recorded for one class in one term, plus who should have a card.
 * Roster: in the open term, the class's current pupils plus anyone with
 * results there; in a past term, only pupils with results (the class has
 * since been promoted, so today's pupils aren't the ones who sat that term).
 */
const loadClassTerm = async (klass, term) => {
  const where = { class: klass.name, termId: term.termId };
  const kg = isKgSection(klass.section);
  const [results, marks, kgRows] = await Promise.all([
    kg ? [] : StudentResult.findAll({ where, raw: true }),
    kg ? [] : StudentMarks.findAll({ where, raw: true }),
    kg ? KgAssessment.findAll({ where, raw: true, order: [["kgAssessmentId", "ASC"]] }) : [],
  ]);

  const withData = new Set([...results, ...marks, ...kgRows].map((r) => Number(r.studentId)));
  const current = term.active
    ? await Student.findAll({
        where: { isDeleted: false, [Op.or]: [{ classId: klass.classId }, { classId: null, class: klass.name }] },
        attributes: ["studentId", "fName", "mName", "lName", "gender"],
        raw: true,
      })
    : [];
  const currentIds = new Set(current.map((s) => Number(s.studentId)));
  const others = [...withData].filter((id) => !currentIds.has(id));
  const extra = others.length
    ? await Student.findAll({
        where: { studentId: { [Op.in]: others } },
        attributes: ["studentId", "fName", "mName", "lName", "gender"],
        raw: true,
      })
    : [];
  const roster = [...current, ...extra]
    .map((s) => ({ studentId: Number(s.studentId), name: fullName(s), gender: s.gender }))
    .sort(byName);

  return { kg, results, marks, kgRows, roster };
};

const subjectsList = async () =>
  (
    await Subject.findAll({
      where: { isDeleted: false },
      attributes: ["subjectId", "name", "classPercentage", "examPercentage"],
      raw: true,
    })
  )
    .map((s) => ({ ...s, subjectId: Number(s.subjectId) }))
    .sort(byName);

/**
 * Pure: what's missing before the class's cards can be printed.
 * - A subject with marks for SOME pupils is "incomplete" (names listed).
 * - A subject with no marks at all is "not started": maybe this class doesn't
 *   take it (Subject is school-wide), so it's a warning, not a blocker.
 * - A pupil with no result row, or empty teacher fields, is listed.
 */
export const assessCompleteness = ({ kg, roster, subjects, results, marks, kgRows }) => {
  const nameOf = new Map(roster.map((s) => [s.studentId, s.name]));
  const resultOf = new Map(results.map((r) => [Number(r.studentId), r]));

  if (kg) {
    const withRows = new Set(kgRows.map((r) => Number(r.studentId)));
    const missing = roster.filter((s) => !withRows.has(s.studentId));
    return {
      kind: "kg",
      subjects: [],
      students: roster.map((s) => ({
        ...s,
        hasResult: withRows.has(s.studentId),
        missingSubjects: [],
        missingFields: [],
      })),
      missingResults: missing,
      complete: roster.length > 0 && missing.length === 0,
    };
  }

  const markedBy = new Map(); // subjectId -> Set(studentId)
  for (const m of marks) {
    const sid = Number(m.subjectId);
    if (!markedBy.has(sid)) markedBy.set(sid, new Set());
    markedBy.get(sid).add(Number(m.studentId));
  }
  const subjectRows = subjects.map((s) => {
    const done = markedBy.get(s.subjectId) || new Set();
    const missing = roster.filter((p) => !done.has(p.studentId));
    const recorded = roster.length - missing.length;
    return {
      subjectId: s.subjectId,
      name: s.name,
      recorded,
      expected: roster.length,
      state: recorded === 0 ? "not_started" : missing.length ? "incomplete" : "complete",
      missingStudents: recorded === 0 ? [] : missing,
    };
  });
  const started = subjectRows.filter((s) => s.state !== "not_started");

  const students = roster.map((p) => {
    const r = resultOf.get(p.studentId);
    return {
      ...p,
      hasResult: Boolean(r),
      missingSubjects: started.filter((s) => s.missingStudents.some((m) => m.studentId === p.studentId)).map((s) => s.name),
      missingFields: r ? TEACHER_FIELDS.filter(([k]) => !String(r[k] ?? "").trim()).map(([, label]) => label) : [],
    };
  });
  const missingResults = students.filter((s) => !s.hasResult).map(({ studentId }) => ({ studentId, name: nameOf.get(studentId) }));

  return {
    kind: "subjects",
    subjects: subjectRows,
    students,
    missingResults,
    complete:
      roster.length > 0 &&
      started.length > 0 &&
      started.every((s) => s.state === "complete") &&
      missingResults.length === 0 &&
      students.every((s) => s.missingFields.length === 0),
  };
};

const termOut = (t) => ({
  termId: t.termId, term: t.term, startDate: t.startDate, endDate: t.endDate, active: Boolean(t.active),
  nextTermBegins: t.nextTermBegins ?? null, // A5a
});
const classOut = (c, kg) => ({ classId: c.classId, name: c.name, section: c.section, isKg: kg });

export const getCompleteness = async ({ classId, termId }, user) => {
  const { klass, term } = await loadClassAndTerm(classId, termId, user);
  const data = await loadClassTerm(klass, term);
  const subjects = data.kg ? [] : await subjectsList();
  return {
    class: classOut(klass, data.kg),
    term: termOut(term),
    roll: data.roster.length,
    ...assessCompleteness({ ...data, subjects }),
  };
};

/**
 * Attendance per pupil for the term: the closed-term totals if the term has
 * been rolled up, otherwise counted live from the daily register.
 */
const attendanceFor = async (studentIds, termId) => {
  if (!studentIds.length) return new Map();
  const totals = await TotalAttendance.findAll({
    where: { termId, studentId: { [Op.in]: studentIds } },
    raw: true,
    order: [["totalAttendanceId", "DESC"]],
  });
  const out = new Map();
  for (const t of totals) {
    const id = Number(t.studentId);
    if (!out.has(id)) {
      out.set(id, { present: Number(t.present) || 0, sick: Number(t.sick) || 0, attendance: Number(t.attendance) || 0 });
    }
  }
  const live = studentIds.filter((id) => !out.has(id));
  if (live.length) {
    const rows = await Attendance.findAll({
      where: { termId, studentId: { [Op.in]: live } },
      attributes: ["studentId", "status"],
      raw: true,
    });
    for (const r of rows) {
      const id = Number(r.studentId);
      const a = out.get(id) || { present: 0, sick: 0, attendance: 0 };
      a.attendance += 1;
      const status = String(r.status ?? "").trim(); // CHAR(10): space-padded
      if (status === "Present") a.present += 1;
      if (status === "Sick") a.sick += 1;
      out.set(id, a);
    }
  }
  return out;
};

/**
 * Pure: one card per pupil. Positions use competition ranking over pupils who
 * have a result row (class position) or a mark (subject position).
 */
export const buildCards = ({ kg, roster, subjects, results, marks, kgRows, attendance }) => {
  const resultOf = new Map(results.map((r) => [Number(r.studentId), r]));
  const classPos = competitionRank(results, (r) => Number(r.studentId), (r) => r.rawScore);

  const subjectPos = new Map(); // subjectId -> Map(studentId -> pos)
  for (const s of subjects) {
    const rows = marks.filter((m) => Number(m.subjectId) === s.subjectId);
    subjectPos.set(s.subjectId, competitionRank(rows, (m) => Number(m.studentId), (m) => m.totalScore));
  }

  return roster.map((p) => {
    const r = resultOf.get(p.studentId) || null;
    const att = attendance.get(p.studentId) || null;
    const base = { studentId: p.studentId, name: p.name, attendance: att };
    if (kg) {
      const rows = kgRows.filter((k) => Number(k.studentId) === p.studentId);
      return { ...base, hasResult: rows.length > 0, promotedTo: rows.find((k) => k.promoted)?.promoted ?? null, kg: rows };
    }
    const own = marks.filter((m) => Number(m.studentId) === p.studentId);
    const markRows = own.map((m) => ({
      subjectId: Number(m.subjectId),
      classScorePercentage: m.classScorePercentage,
      examScorePercentage: m.examScorePercentage,
      totalScore: m.totalScore,
      remarks: m.remarks,
      grade: m.grade ?? null, // B8: stamped at save (JHS 1–9)
      subjectPosition: subjectPos.get(Number(m.subjectId))?.get(p.studentId) ?? null,
    }));
    const total = own.reduce((sum, m) => sum + (Number(m.totalScore) || 0), 0);
    return {
      ...base,
      hasResult: Boolean(r),
      position: classPos.get(p.studentId) ?? null,
      rawScore: r ? Number(r.rawScore) : own.length ? Math.round(total * 100) / 100 : null,
      totalRawScore: r ? Number(r.totalRawScore) : own.length ? own.length * 100 : null,
      promotedTo: r?.promotedTo ?? null,
      resultStatus: r?.resultStatus ?? null,
      conduct: r?.conduct ?? null,
      attitude: r?.attitude ?? null,
      interest: r?.interest ?? null,
      teacherRemarks: r?.teacherRemarks ?? null,
      marks: markRows,
    };
  });
};

export const getClassReportCards = async ({ classId, termId }, user) => {
  const { klass, term } = await loadClassAndTerm(classId, termId, user);
  const data = await loadClassTerm(klass, term);
  const subjects = data.kg ? [] : await subjectsList();
  const attendance = await attendanceFor(data.roster.map((s) => s.studentId), term.termId);
  return {
    class: classOut(klass, data.kg),
    term: termOut(term),
    roll: data.roster.length,
    subjects: subjects.map(({ subjectId, name }) => ({ subjectId, name })),
    cards: buildCards({ ...data, subjects, attendance }),
  };
};
