import { Op } from "sequelize";
import { Attendance, KgAssessment, Student, StudentMarks, Subject } from "../models/index.js";
import sequelize from "../config/database.js";
import { round2 } from "../utils/money.js";
import { AppError } from "../utils/errorHandling.js";
import { markClassAttendance, VALID_STATUSES } from "./attendance.js";
import { saveClassSubjectScores } from "./results.js";
import { bandsForSection } from "./grading.js";
import { requireActiveTerm } from "./term.js";
import {
  assertCanScore,
  assertCanTakeRegister,
  canTakeRegister,
  isKgAreaId,
  isKgSection,
  kgAreaName,
  loadClass,
  loadTeacher,
  scopedClasses,
} from "./teacherScope.js";

// ---------------------------------------------------------------------------
// B2: the teacher portal's register and score sheet. Every call:
//   1. resolves the (not archived) teacher from the STAFF token,
//   2. works in the ACTIVE term only (teachers can't touch closed terms; the
//      office still can from the admin app),
//   3. checks the teacher's scope (services/teacherScope.js),
//   4. checks the pupils sent are exactly the class's pupils.
// Writes reuse the hardened office services, so the rules (atomic register,
// server-computed totals, 0 is a valid score) are the same.
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const fullName = (s) => [s.fName, s.mName, s.lName].filter(Boolean).join(" ");
const termView = (t) => ({ termId: t.termId, term: t.term, startDate: t.startDate, endDate: t.endDate });

// Pupils of a class. Rows are matched on classId, or on the class name for
// legacy rows that only carry the denormalized name.
const classRoster = async (klass) => {
  const rows = await Student.findAll({
    where: {
      isDeleted: false,
      [Op.or]: [{ classId: klass.classId }, { classId: null, class: klass.name }],
    },
    attributes: ["studentId", "fName", "mName", "lName", "gender"],
    order: [["fName", "ASC"], ["lName", "ASC"]],
    raw: true,
  });
  return rows.map((s) => ({ studentId: Number(s.studentId), name: fullName(s), gender: s.gender }));
};

// Every pupil exactly once, nobody from outside the class.
const assertMatchesRoster = (roster, ids, { requireAll }) => {
  const inClass = new Set(roster.map((s) => s.studentId));
  const seen = new Set();
  for (const raw of ids) {
    const id = Number(raw);
    if (!inClass.has(id)) throw new AppError("A pupil in this list is not in this class. Reload and try again.", 400);
    if (seen.has(id)) throw new AppError("A pupil appears twice in this list", 400);
    seen.add(id);
  }
  if (requireAll && seen.size !== inClass.size) {
    throw new AppError("The register must include every pupil in the class. Reload and try again.", 400);
  }
};

const todayIso = () => new Date().toISOString().slice(0, 10); // Ghana is UTC+0
const isWeekend = (iso) => [0, 6].includes(new Date(`${iso}T00:00:00Z`).getUTCDay());

// ---- KG / nursery scores -------------------------------------------------------
// Saved where the office's "Enter nursery result" saves them (KG_assessment,
// Academic Progress section), so the KG report card shows them.
const KG_CATEGORY = "ACADEMIC PROGRESS/EXAMINATION SCORES";
const KG_MAX = 100;
const kgSubject = (id) => ({
  subjectId: id,
  name: kgAreaName(id),
  classTotalMarks: KG_MAX,
  examTotalMarks: KG_MAX,
  classPercentage: 50,
  examPercentage: 50,
  configured: true,
  isKg: true,
});
// Scored rows of a KG class this term, as { subjectId: "kg-n", studentId }.
const kgScoredRows = async (klass, termId) => {
  const rows = await KgAssessment.findAll({
    where: { class: klass.name, termId, category: KG_CATEGORY, classScore: { [Op.ne]: null } },
    attributes: ["assessment", "studentId"],
    raw: true,
  });
  const idOf = new Map(klass.subjects.map((s) => [s.name, s.subjectId]));
  return rows.filter((r) => idOf.has(r.assessment)).map((r) => ({ subjectId: idOf.get(r.assessment), studentId: r.studentId }));
};

// ---- My classes --------------------------------------------------------------

const getMyClasses = async (teacherId) => {
  const teacher = await loadTeacher(teacherId);
  let term = null;
  try {
    term = await requireActiveTerm();
  } catch {
    return { teacher: { teacherId: teacher.teacherId, name: teacher.name }, term: null, today: todayIso(), classes: [] };
  }
  const classes = await scopedClasses(teacher.teacherId, { termId: term.termId });
  const today = todayIso();

  // "My day": has today's register been taken, and how many pupils still have
  // no score per subject.
  const enriched = await Promise.all(
    classes.map(async (c) => {
      const roster = await classRoster(c);
      const [registerRows, marks] = await Promise.all([
        c.takesRegister ? Attendance.count({ where: { class: c.name, dateMarked: today } }) : 0,
        c.isKg && c.subjects.length
          ? kgScoredRows(c, term.termId)
          : c.subjects.length
          ? StudentMarks.findAll({
              where: { class: c.name, termId: term.termId, subjectId: { [Op.in]: c.subjects.map((s) => s.subjectId) } },
              attributes: ["subjectId", "studentId"],
              raw: true,
            })
          : [],
      ]);
      const ids = new Set(roster.map((s) => s.studentId));
      return {
        ...c,
        pupils: roster.length,
        registerTakenToday: registerRows > 0,
        subjects: c.subjects.map((s) => {
          const scored = new Set(
            marks.filter((m) => String(m.subjectId) === String(s.subjectId) && ids.has(Number(m.studentId))).map((m) => Number(m.studentId))
          );
          return { ...s, scored: scored.size, missing: Math.max(0, roster.length - scored.size) };
        }),
      };
    })
  );

  return {
    teacher: { teacherId: teacher.teacherId, name: teacher.name },
    term: termView(term),
    today,
    classes: enriched,
  };
};

// ---- Register ----------------------------------------------------------------

const registerContext = async (teacherId, classId) => {
  const teacher = await loadTeacher(teacherId);
  const term = await requireActiveTerm();
  const klass = await loadClass(classId);
  await assertCanTakeRegister(teacher.teacherId, klass.classId, { termId: term.termId });
  return { teacher, term, klass };
};

const dateChecks = (date, term) => {
  const inTerm = (!term.startDate || date >= term.startDate) && (!term.endDate || date <= term.endDate);
  return { inTerm, isWeekend: isWeekend(date), isFuture: date > todayIso() };
};

const getRegister = async (teacherId, { classId, date }) => {
  const day = date || todayIso();
  if (!DATE_RE.test(day)) throw new AppError("date must be YYYY-MM-DD", 400);
  const { term, klass } = await registerContext(teacherId, classId);
  const [roster, existing] = await Promise.all([
    classRoster(klass),
    Attendance.findAll({ where: { class: klass.name, dateMarked: day }, raw: true }),
  ]);
  const byStudent = new Map(existing.map((a) => [Number(a.studentId), a]));
  const marked = existing.length > 0;
  return {
    class: { classId: klass.classId, name: klass.name },
    term: termView(term),
    date: day,
    today: todayIso(), // the server's day: the phone's clock/timezone may differ
    ...dateChecks(day, term),
    marked,
    markedBy: marked ? existing.find((a) => a.enteredBy)?.enteredBy ?? null : null,
    students: roster.map((s) => ({ ...s, status: byStudent.get(s.studentId)?.status?.trim() ?? null })),
  };
};

const saveRegister = async (teacherId, { classId, date, marks }) => {
  if (!DATE_RE.test(String(date ?? ""))) throw new AppError("date must be YYYY-MM-DD", 400);
  if (!Array.isArray(marks) || marks.length === 0) throw new AppError("marks must be a non-empty list", 400);
  for (const m of marks) {
    if (!VALID_STATUSES.includes(m?.status)) {
      throw new AppError(`Invalid status "${m?.status}". Allowed: ${VALID_STATUSES.join(", ")}`, 400);
    }
  }
  const { teacher, term, klass } = await registerContext(teacherId, classId);
  const { inTerm, isFuture } = dateChecks(date, term);
  if (!inTerm) throw new AppError(`That date is outside the current term (${term.startDate} to ${term.endDate}).`, 400);
  if (isFuture) throw new AppError("You can't take a register for a future date.", 400);

  const roster = await classRoster(klass);
  assertMatchesRoster(roster, marks.map((m) => m.studentId), { requireAll: true });

  const studentAttendance = marks.map((m) => ({ studentId: Number(m.studentId), status: m.status }));
  await markClassAttendance({
    className: klass.name,
    dateMarked: date,
    studentAttendance,
    enteredBy: teacher.name,
    enteredByTeacherId: teacher.teacherId,
  });
  return { studentAttendance, register: await getRegister(teacherId, { classId, date }) };
};

// ---- Scores ------------------------------------------------------------------

const subjectView = (s) => {
  const config = {
    classTotalMarks: s.classTotalMarks == null ? null : Number(s.classTotalMarks),
    examTotalMarks: s.examTotalMarks == null ? null : Number(s.examTotalMarks),
    classPercentage: s.classPercentage == null ? null : Number(s.classPercentage),
    examPercentage: s.examPercentage == null ? null : Number(s.examPercentage),
  };
  const configured =
    Object.values(config).every((v) => Number.isFinite(v)) && config.classTotalMarks > 0 && config.examTotalMarks > 0;
  return { subjectId: Number(s.subjectId), name: s.name, ...config, configured };
};

const scoresContext = async (teacherId, { classId, subjectId }) => {
  const teacher = await loadTeacher(teacherId);
  const term = await requireActiveTerm();
  const klass = await loadClass(classId);
  if (isKgSection(klass.section)) {
    // KG / nursery: the class teacher scores the learning areas.
    if (!kgAreaName(subjectId)) throw new AppError("Pick a learning area (Language/Literacy, Numeracy, …).", 400);
    if (!(await canTakeRegister(teacher.teacherId, klass.classId, { termId: term.termId }))) {
      throw new AppError("Only the class teacher enters this class's KG scores.", 403);
    }
    return { teacher, term, klass, subject: kgSubject(String(subjectId)) };
  }
  if (isKgAreaId(subjectId)) throw new AppError("That learning area is for KG / nursery classes only.", 400);
  const subject = subjectId ? await Subject.findOne({ where: { subjectId, isDeleted: false }, raw: true }) : null;
  if (!subject) throw new AppError("Subject not found", 404);
  await assertCanScore(teacher.teacherId, { termId: term.termId, classId: klass.classId, subjectId: subject.subjectId });
  return { teacher, term, klass, subject };
};

// Row checks with the pupil's name in the message (the shared service would
// reject the whole sheet without saying which row). Both blank = skip.
const blank = (v) => v === "" || v === null || v === undefined;
const validateScoreRows = (scores, subject, roster) => {
  const names = new Map(roster.map((s) => [s.studentId, s.name]));
  for (const row of scores) {
    const who = names.get(Number(row.studentId)) || "a pupil";
    if (blank(row.classScore) && blank(row.examScore)) continue;
    if (blank(row.classScore) || blank(row.examScore)) {
      throw new AppError(`Enter both the class score and the exam score for ${who}, or leave both blank.`, 400);
    }
    // Plain numbers with up to 2 decimal places (7, 7.5, 7.25; stored as
    // NUMERIC(18,2), migration 012). "1e1", "7.125" and "7,5" are refused.
    const isScore = (v) => /^\d+(\.\d{1,2})?$/.test(String(v).trim());
    if (!isScore(row.classScore) || !isScore(row.examScore)) {
      throw new AppError(`Scores for ${who} must be numbers with at most 2 decimal places (e.g. 7.5).`, 400);
    }
    const cs = Number(row.classScore);
    const es = Number(row.examScore);
    if (cs < 0 || es < 0) throw new AppError(`Scores for ${who} can't be negative.`, 400);
    if (cs > subject.classTotalMarks) {
      throw new AppError(`${who}'s class score can't be more than ${subject.classTotalMarks}.`, 400);
    }
    if (es > subject.examTotalMarks) {
      throw new AppError(`${who}'s exam score can't be more than ${subject.examTotalMarks}.`, 400);
    }
  }
};

const getScores = async (teacherId, query) => {
  const { term, klass, subject } = await scoresContext(teacherId, query);
  const [roster, marks] = await Promise.all([
    classRoster(klass),
    subject.isKg
      ? KgAssessment.findAll({
          where: { class: klass.name, termId: term.termId, category: KG_CATEGORY, assessment: subject.name },
          attributes: ["studentId", "classScore", "examScore", "totalScore"],
          raw: true,
        })
      : StudentMarks.findAll({
          where: { class: klass.name, termId: term.termId, subjectId: subject.subjectId },
          raw: true,
        }),
  ]);
  const byStudent = new Map(marks.map((m) => [Number(m.studentId), m]));
  const n = (v) => (v == null ? null : Number(v));
  // B8: the class's grade bands, for the sheet's live remark preview.
  const grading = await bandsForSection(klass.section);
  return {
    class: { classId: klass.classId, name: klass.name },
    subject: subject.isKg ? subject : subjectView(subject),
    term: termView(term),
    grading: { name: grading.name, bands: grading.bands },
    students: roster.map((s) => {
      const m = byStudent.get(s.studentId);
      return {
        ...s,
        classScore: n(m?.classScore),
        examScore: n(m?.examScore),
        totalScore: n(m?.totalScore),
        remarks: m?.remarks ?? null,
        grade: m?.grade ?? null,
        enteredBy: m?.enteredBy ?? null,
      };
    }),
  };
};

// One learning area for the class, in one transaction. Same row key and
// fields as the office's KG result (services/results.js createKGResult):
// (student, term, class, category, assessment); 50% class + 50% exam.
const saveKgScores = async ({ klass, term, area, scores }) =>
  sequelize.transaction(async (t) => {
    let saved = 0;
    for (const row of scores) {
      if (blank(row.classScore) && blank(row.examScore)) continue;
      const cs = round2(row.classScore);
      const es = round2(row.examScore);
      const where = { studentId: Number(row.studentId), class: klass.name, termId: term.termId, category: KG_CATEGORY, assessment: area };
      const values = {
        classScore: cs,
        examScore: es,
        classScorePercentage: round2(cs / 2),
        examScorePercentage: round2(es / 2),
        totalScore: round2(cs / 2 + es / 2),
        term: term.term,
        date: new Date(),
      };
      const existing = await KgAssessment.findOne({ where, transaction: t });
      if (existing) await KgAssessment.update(values, { where: { kgAssessmentId: existing.kgAssessmentId }, transaction: t });
      else await KgAssessment.create({ ...where, ...values }, { transaction: t });
      saved += 1;
    }
    return saved;
  });

const saveScores = async (teacherId, { classId, subjectId, scores }) => {
  if (!Array.isArray(scores) || scores.length === 0) throw new AppError("scores must be a non-empty list", 400);
  const { teacher, term, klass, subject } = await scoresContext(teacherId, { classId, subjectId });
  if (!subjectView(subject).configured) {
    throw new AppError(
      `"${subject.name}" has no class/exam totals yet. Ask the school office to set them under Subjects.`,
      409
    );
  }
  const roster = await classRoster(klass);
  assertMatchesRoster(roster, scores.map((s) => s.studentId), { requireAll: false });
  validateScoreRows(scores, subject.isKg ? subject : subjectView(subject), roster);

  if (subject.isKg) {
    const saved = await saveKgScores({ klass, term, area: subject.name, scores });
    return { saved, sheet: await getScores(teacherId, { classId, subjectId }) };
  }

  const result = await saveClassSubjectScores({
    className: klass.name,
    subjectId: subject.subjectId,
    term: term.term,
    termId: term.termId,
    scores: scores.map((s) => ({ studentId: Number(s.studentId), classScore: s.classScore, examScore: s.examScore })),
    enteredBy: teacher.name,
    enteredByTeacherId: teacher.teacherId,
  });
  return { ...result, sheet: await getScores(teacherId, { classId, subjectId }) };
};

export {
  getMyClasses,
  getRegister,
  saveRegister,
  getScores,
  saveScores,
  classRoster,
  assertMatchesRoster,
  // B6: the office's class score sheet (services/scoreSheet.js) uses the same checks.
  subjectView,
  validateScoreRows,
};
