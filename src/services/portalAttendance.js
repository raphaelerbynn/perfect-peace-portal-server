import { Attendance, Term } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";

// Portal Attendance page: a pupil's own daily register per term. Parents see
// it by signing in with their child's STU/ login (no separate parent login).

const dateOnly = (d) => {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10);
};

// Terms for the picker: newest first, undated old terms last.
export const portalTerms = async () => {
  const terms = await Term.findAll({ attributes: ["termId", "term", "startDate", "endDate", "active"], raw: true });
  return terms
    .map((t) => ({ termId: t.termId, term: t.term, startDate: dateOnly(t.startDate), endDate: dateOnly(t.endDate), active: Boolean(t.active) }))
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
  const count = (s) => days.filter((d) => d.status.toLowerCase() === s).length;
  const present = count("present");
  const absent = count("absent");
  const sick = count("sick");
  return {
    term: { termId: term.termId, term: term.term, startDate: dateOnly(term.startDate), endDate: dateOnly(term.endDate) },
    present,
    absent,
    sick,
    other: days.length - present - absent - sick,
    total: days.length,
    days,
  };
};
