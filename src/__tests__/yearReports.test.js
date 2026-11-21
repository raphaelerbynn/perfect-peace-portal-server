// B7: whole-year class results and term/year attendance summaries. Pure
// helpers run for real; the services run against mocked models.
jest.mock("../config/database.js", () => ({
  __esModule: true,
  default: { transaction: jest.fn(async (cb) => cb({})), fn: jest.fn((...a) => ({ fn: a })), literal: jest.fn((x) => x), col: jest.fn((x) => x), escape: jest.fn((x) => `'${x}'`) },
}));
jest.mock("../models/index.js", () => {
  const model = () => ({ findAll: jest.fn(async () => []), findOne: jest.fn() });
  return {
    __esModule: true,
    AcademicYear: model(),
    Attendance: model(),
    Class: model(),
    KgAssessment: model(),
    Student: model(),
    StudentMarks: model(),
    StudentResult: model(),
    Subject: model(),
    Term: model(),
    TotalAttendance: model(),
  };
});
jest.mock("../services/attendance.js", () => ({ __esModule: true, assertClassAccess: jest.fn() }));

import { Op } from "sequelize";
import { AcademicYear, Attendance, Class, Student, StudentResult, Term, TotalAttendance } from "../models/index.js";
import { assertClassAccess } from "../services/attendance.js";
import {
  buildAttendanceSummary,
  buildYearResults,
  getClassAttendanceSummary,
  getClassYearResults,
} from "../services/yearReports.js";
import { AppError } from "../utils/errorHandling.js";

const terms = [
  { termId: 11, term: "1", active: false, startDate: "2025-09-08" },
  { termId: 12, term: "2", active: false, startDate: "2026-01-06" },
  { termId: 13, term: "3", active: true, startDate: "2026-04-27" },
];
const klass = { classId: 4, name: "Basic 4", section: "Primary" };
const admin = { category: "Administrator" };

beforeEach(() => {
  jest.clearAllMocks();
  Class.findOne.mockResolvedValue(klass);
  AcademicYear.findOne.mockResolvedValue({ academicYearId: 7, name: "2025/2026" });
  Term.findAll.mockResolvedValue(terms);
  Term.findOne.mockResolvedValue(terms[1]);
  for (const m of [Attendance, Student, StudentResult, TotalAttendance]) m.findAll.mockResolvedValue([]);
  assertClassAccess.mockResolvedValue();
});

describe("buildYearResults", () => {
  const r = (studentResultId, studentId, termId, rawScore, totalRawScore) => ({ studentResultId, studentId, termId, rawScore, totalRawScore });

  it("averages each pupil's terms and ranks the average (1, 1, 3)", () => {
    const rows = buildYearResults({
      terms,
      names: new Map([[1, "Ama"], [2, "Kofi"], [3, "Esi"]]),
      results: [
        r(1, 1, 11, 400, 500), r(2, 1, 12, 450, 500), // 80, 90 -> 85
        r(3, 2, 11, "425.00", "500.00"), r(4, 2, 12, "425", "500"), // 85, 85 -> 85 (DECIMAL strings)
        r(5, 3, 11, 300, 500), // 60
      ],
    });
    expect(rows.map((x) => [x.name, x.average, x.position, x.termsCounted])).toEqual([
      ["Ama", 85, 1, 2],
      ["Kofi", 85, 1, 2],
      ["Esi", 60, 3, 1],
    ]);
    expect(rows[0].terms[12]).toEqual({ rawScore: 450, totalRawScore: 500, percent: 90 });
    expect(rows[0]).toMatchObject({ rawScore: 850, totalRawScore: 1000 });
  });

  it("a pupil with fewer terms is averaged over the terms they have, not marked down", () => {
    const rows = buildYearResults({ terms, results: [r(1, 1, 11, 450, 500), r(2, 2, 11, 400, 500), r(3, 2, 12, 400, 500), r(4, 2, 13, 400, 500)] });
    expect(rows.map((x) => [x.studentId, x.average, x.termsCounted])).toEqual([[1, 90, 1], [2, 80, 3]]);
  });

  it("keeps the newest row when old data has two for a term, ignores other years' terms", () => {
    const rows = buildYearResults({ terms, results: [r(1, 1, 11, 100, 500), r(9, 1, 11, 400, 500), r(10, 1, 99, 0, 500)] });
    expect(rows[0]).toMatchObject({ average: 80, termsCounted: 1 });
  });

  it("no total raw score: no percentage, no position", () => {
    const rows = buildYearResults({ terms, results: [r(1, 1, 11, 0, 0)] });
    expect(rows[0]).toMatchObject({ average: null, position: null });
  });

  it("names the other class a pupil had results in that year", () => {
    const rows = buildYearResults({ klass, terms, results: [r(1, 1, 12, 400, 500)], elsewhere: [{ studentId: 1, class: " Basic 3 " }, { studentId: 1, class: " BASIC 4" }] });
    expect(rows[0].otherClasses).toEqual(["Basic 3"]);
  });
});

describe("buildAttendanceSummary", () => {
  it("closed terms come from the roll-up, the open term from the register; summed per pupil", () => {
    const rows = buildAttendanceSummary({
      klass,
      terms,
      roster: [1, 2],
      names: new Map([[1, "Ama"], [2, "Kofi"]]),
      totals: [
        { totalAttendanceId: 1, studentId: 1, termId: 11, present: 50, sick: 2, attendance: 60 },
        { totalAttendanceId: 2, studentId: 1, termId: 12, present: "55", sick: "0", attendance: "58" },
      ],
      live: [
        { studentId: 1, termId: 13, class: "Basic 4", present: "20", sick: "1", absent: "2", total: "23" },
        { studentId: 2, termId: 13, class: "Basic 4", present: 10, sick: 0, absent: 0, total: 10 },
      ],
    });
    expect(rows[0]).toMatchObject({ name: "Ama", present: 125, sick: 3, absent: 13, total: 141 });
    expect(rows[0].terms[11]).toEqual({ present: 50, sick: 2, absent: 8, total: 60 });
    expect(rows[1]).toMatchObject({ name: "Kofi", present: 10, total: 10, terms: { 13: expect.any(Object) } });
  });

  it("a pupil who moved class mid-term: both registers count, the other class is named", () => {
    const rows = buildAttendanceSummary({
      klass,
      terms,
      roster: [1],
      totals: [],
      live: [
        { studentId: 1, termId: 13, class: "Basic 3", present: 5, sick: 0, absent: 1, total: 6 },
        { studentId: 1, termId: 13, class: " basic 4", present: 7, sick: 0, absent: 0, total: 7 },
      ],
    });
    expect(rows[0]).toMatchObject({ present: 12, absent: 1, total: 13, otherClasses: ["Basic 3"] });
  });

  it("the roll-up wins over any register rows left for that term", () => {
    const rows = buildAttendanceSummary({
      klass,
      terms,
      roster: [1],
      totals: [{ totalAttendanceId: 1, studentId: 1, termId: 13, present: 3, sick: 0, attendance: 3 }],
      live: [{ studentId: 1, termId: 13, class: "Basic 4", present: 9, sick: 0, absent: 0, total: 9 }],
    });
    expect(rows[0].total).toBe(3);
  });

  it("a pupil on the roster with nothing marked shows zeros", () => {
    const rows = buildAttendanceSummary({ klass, terms, roster: [5], totals: [], live: [] });
    expect(rows[0]).toMatchObject({ studentId: 5, present: 0, sick: 0, absent: 0, total: 0, terms: {} });
  });
});

describe("getClassYearResults", () => {
  it("reads this class's results in the year's terms, scoped by assertClassAccess", async () => {
    StudentResult.findAll
      .mockResolvedValueOnce([{ studentResultId: 1, studentId: 1, termId: 11, rawScore: 400, totalRawScore: 500 }])
      .mockResolvedValueOnce([]);
    Student.findAll.mockResolvedValue([{ studentId: 1, fName: "Ama", lName: "Mensah" }]);
    const out = await getClassYearResults({ classId: "4", academicYearId: "7" }, admin);
    expect(assertClassAccess).toHaveBeenCalledWith(admin, "Basic 4");
    expect(StudentResult.findAll.mock.calls[0][0].where).toEqual({ class: "Basic 4", termId: { [Op.in]: [11, 12, 13] } });
    expect(Term.findAll.mock.calls[0][0].where).toEqual({ academicYearId: 7 });
    expect(out).toMatchObject({ kind: "year", academicYear: { name: "2025/2026" }, class: { name: "Basic 4" } });
    expect(out.terms.map((t) => t.name)).toEqual(["Term 1", "Term 2", "Term 3"]);
    expect(out.students[0]).toMatchObject({ name: "Ama Mensah", average: 80, position: 1 });
  });

  it("a Class Teacher asking for another class is refused (403)", async () => {
    assertClassAccess.mockRejectedValue(new AppError("nope", 403));
    await expect(getClassYearResults({ classId: 4, academicYearId: 7 }, { category: "Class Teacher" })).rejects.toMatchObject({ statusCode: 403 });
    expect(StudentResult.findAll).not.toHaveBeenCalled();
  });

  it("KG classes, a missing year or class are refused", async () => {
    Class.findOne.mockResolvedValueOnce({ ...klass, section: "KG" });
    await expect(getClassYearResults({ classId: 4, academicYearId: 7 }, admin)).rejects.toMatchObject({ statusCode: 400 });
    await expect(getClassYearResults({ classId: 4 }, admin)).rejects.toMatchObject({ statusCode: 400 });
    await expect(getClassYearResults({ academicYearId: 7 }, admin)).rejects.toMatchObject({ statusCode: 400 });
    Class.findOne.mockResolvedValueOnce(null);
    await expect(getClassYearResults({ classId: 9, academicYearId: 7 }, admin)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("a year with no terms gives an empty list", async () => {
    Term.findAll.mockResolvedValue([]);
    const out = await getClassYearResults({ classId: 4, academicYearId: 7 }, admin);
    expect(out.students).toEqual([]);
    expect(StudentResult.findAll).not.toHaveBeenCalled();
  });
});

describe("getClassAttendanceSummary", () => {
  it("needs exactly one of a term or a year", async () => {
    await expect(getClassAttendanceSummary({ classId: 4 }, admin)).rejects.toMatchObject({ statusCode: 400 });
    await expect(getClassAttendanceSummary({ classId: 4, termId: 12, academicYearId: 7 }, admin)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("past term: roster from the results and register filed under the class, not today's pupils", async () => {
    Term.findOne.mockResolvedValue({ ...terms[1], academicYearId: 7 }); // closed
    StudentResult.findAll.mockResolvedValueOnce([{ studentId: 1 }]).mockResolvedValueOnce([]);
    TotalAttendance.findAll.mockResolvedValue([{ totalAttendanceId: 1, studentId: 1, termId: 12, present: 50, sick: 1, attendance: 55 }]);
    Student.findAll.mockResolvedValue([{ studentId: 1, fName: "Ama" }]);
    const out = await getClassAttendanceSummary({ classId: 4, termId: 12 }, admin);
    expect(out).toMatchObject({ kind: "term", academicYear: { name: "2025/2026" } });
    expect(out.students).toEqual([expect.objectContaining({ studentId: 1, name: "Ama", present: 50, absent: 4, total: 55 })]);
    // Only the name lookup: no current-roster query for a closed term.
    expect(Student.findAll).toHaveBeenCalledTimes(1);
    expect(Student.findAll.mock.calls[0][0].where).toEqual({ studentId: { [Op.in]: [1] } });
  });

  it("whole year including the open term: current pupils join, other classes are named", async () => {
    Attendance.findAll.mockResolvedValue([
      { studentId: 2, termId: 13, class: "BASIC 4 ", present: "3", sick: "0", absent: "1", total: "4" },
      { studentId: 8, termId: 13, class: "Basic 1", present: 9, sick: 0, absent: 0, total: 9 }, // another class's pupil
    ]);
    StudentResult.findAll
      .mockResolvedValueOnce([{ studentId: 1 }]) // results under Basic 4
      .mockResolvedValueOnce([{ studentId: 1, class: "Basic 3" }]); // elsewhere
    Student.findAll.mockResolvedValueOnce([{ studentId: 3, fName: "Yaw" }]) // current pupils
      .mockResolvedValueOnce([{ studentId: 1, fName: "Ama" }, { studentId: 2, fName: "Kofi" }]);
    const out = await getClassAttendanceSummary({ classId: 4, academicYearId: 7 }, admin);
    expect(out.students.map((s) => s.studentId).sort()).toEqual([1, 2, 3]);
    expect(out.students.find((s) => s.studentId === 1).otherClasses).toEqual(["Basic 3"]);
    expect(out.students.find((s) => s.studentId === 2)).toMatchObject({ present: 3, absent: 1, total: 4 });
    // The register query trims the CHAR(10) status.
    const attrs = JSON.stringify(Attendance.findAll.mock.calls[0][0].attributes);
    expect(attrs).toMatch(/TRIM\(status\) = 'Present'/);
  });

  it("a Class Teacher asking for another class is refused (403)", async () => {
    assertClassAccess.mockRejectedValue(new AppError("nope", 403));
    await expect(getClassAttendanceSummary({ classId: 4, termId: 12 }, { category: "Class Teacher" })).rejects.toMatchObject({ statusCode: 403 });
    expect(Attendance.findAll).not.toHaveBeenCalled();
  });
});
