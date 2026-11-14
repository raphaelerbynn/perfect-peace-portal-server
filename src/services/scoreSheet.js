import { StudentMarks, Subject } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { assertClassAccess, assertClassWrite } from "./attendance.js";
import { bandsForSection } from "./grading.js";
import { saveClassSubjectScores } from "./results.js";
import { requireActiveTerm } from "./term.js";
import { isKgSection, loadClass } from "./teacherScope.js";
import { assertMatchesRoster, classRoster, subjectView, validateScoreRows } from "./teacherTools.js";

// ---------------------------------------------------------------------------
// B6: the office's score sheet for one subject in one class (the admin
// "Upload scores" page reads it, fills it from an Excel file, and saves it).
// Same rules and write path as the teacher's sheet (B2):
//   - the open term only (the roster is today's pupils, so a closed term's
//     class may have had other pupils), *(default)*
//   - every row is one of the class's pupils, at most once,
//   - scores: numbers with up to 2 decimals, 0 to the subject's maximum,
//     both or neither; a row with both blank is skipped (never deletes),
//   - the whole sheet saves in ONE transaction (saveClassSubjectScores), the
//     server computes totals and stamps grade + remark (B8),
//   - KG / nursery classes are separate (Enter nursery result) *(default)*,
//   - Class Teachers: their own class only,
//   - a row may carry `previous: { classScore, examScore }` (what the page
//     showed when it was filled); if the saved mark is no longer that, the
//     whole sheet is refused (409) naming those pupils, so a score changed
//     since (e.g. by the teacher in the portal) is never overwritten.
// ---------------------------------------------------------------------------

const termView = (t) => ({ termId: t.termId, term: t.term });
const n = (v) => (v == null ? null : Number(v));
const blankScore = (v) => v == null || String(v).trim() === "";
const sameScore = (a, b) => (blankScore(a) ? blankScore(b) : !blankScore(b) && Number(a) === Number(b));

/** Pupils whose saved mark is no longer the `previous` their row was based on. */
export const staleRows = (scores, marks, roster) => {
  const byStudent = new Map(marks.map((m) => [Number(m.studentId), m]));
  const names = new Map(roster.map((s) => [Number(s.studentId), s.name]));
  return scores
    .filter((row) => row.previous && typeof row.previous === "object")
    .filter((row) => {
      const m = byStudent.get(Number(row.studentId));
      return !sameScore(row.previous.classScore, m?.classScore) || !sameScore(row.previous.examScore, m?.examScore);
    })
    .map((row) => names.get(Number(row.studentId)) || `STU/${row.studentId}`);
};

const sheetContext = async (user, { classId, subjectId }) => {
  const klass = await loadClass(classId);
  if (user?.category !== "Administrator") {
    try {
      await assertClassAccess(user, klass.name);
    } catch {
      throw new AppError("You can only enter scores for your own class.", 403);
    }
  }
  if (isKgSection(klass.section)) {
    throw new AppError("KG / nursery classes are scored in Student reports → Enter nursery result.", 400);
  }
  const subject = subjectId ? await Subject.findOne({ where: { subjectId, isDeleted: false }, raw: true }) : null;
  if (!subject) throw new AppError("Subject not found", 404);
  const term = await requireActiveTerm();
  return { klass, subject, term };
};

export const getOfficeSheet = async (user, query) => {
  const { klass, subject, term } = await sheetContext(user, query);
  const roster = await classRoster(klass);
  const marks = await StudentMarks.findAll({
    where: { class: klass.name, termId: term.termId, subjectId: subject.subjectId },
    raw: true,
  });
  const grading = await bandsForSection(klass.section);
  const byStudent = new Map(marks.map((m) => [Number(m.studentId), m]));
  return {
    class: { classId: klass.classId, name: klass.name, section: klass.section ?? null },
    subject: subjectView(subject),
    term: termView(term),
    grading: { name: grading.name, bands: grading.bands },
    students: roster.map((s) => {
      const m = byStudent.get(s.studentId);
      return {
        studentId: s.studentId,
        indexNo: `STU/${s.studentId}`,
        name: s.name,
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

export const saveOfficeSheet = async (user, { classId, subjectId, scores }) => {
  if (!Array.isArray(scores) || scores.length === 0) throw new AppError("scores must be a non-empty list", 400);
  if (scores.length > 500) throw new AppError("Too many rows for one class", 400);
  const { klass, subject, term } = await sheetContext(user, { classId, subjectId });
  const view = subjectView(subject);
  if (!view.configured) {
    throw new AppError(`"${subject.name}" has no class/exam totals yet. Set them under Subjects first.`, 409);
  }
  const roster = await classRoster(klass);
  assertMatchesRoster(roster, scores.map((s) => s.studentId), { requireAll: false });
  validateScoreRows(scores, view, roster);
  // Class Teachers: own pupils, open term (same guard as single-result entry).
  await assertClassWrite(user, klass.name, scores.map((s) => s.studentId), term.termId);

  const checked = scores.filter((s) => s.previous && typeof s.previous === "object");
  const checkBefore = checked.length
    ? async (t) => {
        const marks = await StudentMarks.findAll({
          where: {
            class: klass.name,
            termId: term.termId,
            subjectId: subject.subjectId,
            studentId: checked.map((s) => Number(s.studentId)),
          },
          attributes: ["studentId", "classScore", "examScore"],
          // Locked in pupil-id order, the order every score save writes in.
          order: [["studentId", "ASC"]],
          raw: true,
          transaction: t,
          ...(t?.LOCK?.UPDATE && { lock: t.LOCK.UPDATE }),
        });
        const stale = staleRows(checked, marks, roster);
        if (stale.length) {
          const list = stale.length > 5 ? `${stale.slice(0, 5).join(", ")} and ${stale.length - 5} more` : stale.join(", ");
          throw new AppError(
            `Nothing was saved: the scores of ${list} changed since this sheet was opened. Reload the sheet and upload the file again.`,
            409
          );
        }
      }
    : null;

  const result = await saveClassSubjectScores({
    className: klass.name,
    subjectId: subject.subjectId,
    term: term.term,
    termId: term.termId,
    scores: scores.map((s) => ({ studentId: Number(s.studentId), classScore: s.classScore, examScore: s.examScore })),
    enteredBy: user?.username ?? null,
    enteredByTeacherId: null,
    ...(checkBefore && { checkBefore }),
  });
  // Committed. A failed refresh must not read as a failed save: the page
  // gets `sheet: null` and reloads it.
  let sheet = null;
  try {
    sheet = await getOfficeSheet(user, { classId, subjectId });
  } catch {
    sheet = null;
  }
  return { ...result, sheet };
};
