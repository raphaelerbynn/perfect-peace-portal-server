import { AcademicYear, Attendance, Term } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";

// Portal Attendance page: a pupil's own daily register per term. Parents see
// it by signing in with their child's STU/ login (no separate parent login).

const dateOnly = (d) => {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10);
};

// B7: academicYearId -> "2026/2027" for the given terms (old terms have none).
const yearNames = async (terms) => {
  const ids = [...new Set(terms.map((t) => t.academicYearId).filter((id) => id != null))];
  if (!ids.length) return new Map();
  const years = await AcademicYear.findAll({ where: { academicYearId: ids }, attributes: ["academicYearId", "name"], raw: true });
  return new Map(years.map((y) => [y.academicYearId, y.name]));
};

// Terms for the picker: newest first, undated old terms last. Each carries its
// academic year's name ("Term 1 · 2026/2027"), or null.
export const portalTerms = async () => {
  const terms = await Term.findAll({ attributes: ["termId", "term", "startDate", "endDate", "active", "academicYearId"], raw: true });
  const names = await yearNames(terms);
  return terms
    .map((t) => ({
      termId: t.termId,
      term: t.term,
      startDate: dateOnly(t.startDate),
      endDate: dateOnly(t.endDate),
      active: Boolean(t.active),
      academicYear: names.get(t.academicYearId) ?? null,
    }))
    .sort((a, b) => String(b.startDate ?? "").localeCompare(String(a.startDate ?? "")) || b.termId - a.termId);
};

// The pupil's register for a term (default: the open term). status is
// CHAR(10) in Postgres, so values are trimmed.
export const pupilAttendance = async (studentId, termId) => {
  let term;
  if (termId != null && String(termId) !== "") {
    const tid = Number(termId);
    if (!Number.isInteger(tid) || tid <= 0) throw new AppError("Choose a term.", 400);
    term = await Term.findOne({ where: { termId: tid }, raw: true });
    if (!term) throw new AppError("Term not found.", 404);
  } else {
    term = await Term.findOne({ where: { active: true }, raw: true });
  }
  if (!term) return { term: null, present: 0, absent: 0, sick: 0, other: 0, total: 0, days: [] };

  const rows = await Attendance.findAll({
    where: { studentId: Number(studentId), termId: term.termId },
    attributes: ["dateMarked", "status"],
    order: [["dateMarked", "DESC"]],
    raw: true,
  });
  const days = rows.map((r) => ({ date: dateOnly(r.dateMarked), status: String(r.status ?? "").trim() }));
  const academicYear = (await yearNames([term])).get(term.academicYearId) ?? null;
  const count = (s) => days.filter((d) => d.status.toLowerCase() === s).length;
  const present = count("present");
  const absent = count("absent");
  const sick = count("sick");
  return {
    term: { termId: term.termId, term: term.term, startDate: dateOnly(term.startDate), endDate: dateOnly(term.endDate), academicYear },
    present,
    absent,
    sick,
    other: days.length - present - absent - sick,
    total: days.length,
    days,
  };
};
