// B11: academic reports. Pure shaping runs for real; the services run against
// mocked models and a mocked sequelize.query (the SQL itself is checked on a
// real Postgres, see the B11 notes).
jest.mock("../config/database.js", () => ({
  __esModule: true,
  default: {
    query: jest.fn(async () => []),
    QueryTypes: { SELECT: "SELECT" },
    transaction: jest.fn(async (cb) => cb({})),
    fn: jest.fn((...a) => ({ fn: a })),
    literal: jest.fn((x) => x),
    col: jest.fn((x) => x),
    escape: jest.fn((x) => `'${x}'`),
  },
}));
jest.mock("../models/index.js", () => {
  const model = () => ({ findAll: jest.fn(async () => []), findOne: jest.fn() });
  return {
    __esModule: true,
    AcademicYear: model(),
    Class: model(),
    Student: model(),
    Subject: model(),
    Term: model(),
  };
});
jest.mock("../services/attendance.js", () => ({ __esModule: true, assertClassAccess: jest.fn() }));
jest.mock("../services/promotion.js", () => ({
  __esModule: true,
  getRules: jest.fn(async () => ({ defaultPassMark: null, fallbackPassMark: 40, classRules: [] })),
  resolvePassMark: jest.requireActual("../services/promotion.js").resolvePassMark,
}));
jest.mock("../services/grading.js", () => {
  const actual = jest.requireActual("../services/grading.js");
  return { __esModule: true, ...actual, listScales: jest.fn(async () => []) };
});
jest.mock("../services/yearReports.js", () => ({
  __esModule: true,
  getClassAttendanceSummary: jest.fn(async () => ({ students: [] })),
}));

import sequelize from "../config/database.js";
import { AcademicYear, Class, Student, Subject, Term } from "../models/index.js";
import { assertClassAccess } from "../services/attendance.js";
import { getRules } from "../services/promotion.js";
import { DEFAULT_JHS_BANDS, DEFAULT_PRIMARY_BANDS } from "../services/grading.js";
import { getClassAttendanceSummary } from "../services/yearReports.js";
import {
  buildClassReport,
  buildGradeDistribution,
  buildTermDetail,
  buildTermsOverview,
  classIndex,
  classKey,
  getClassTermReport,
  getTermReport,
  getTermsOverview,
  passMarksByKey,
  rate,
} from "../services/academicReports.js";
import { AppError } from "../utils/errorHandling.js";

beforeEach(() => jest.clearAllMocks());

const terms = [
  { termId: 12, term: "2", startDate: "2026-01-06", active: false, academicYearId: 3 },
  { termId: 11, term: "1", startDate: "2025-09-08", active: false, academicYearId: 3 },
  { termId: 13, term: "3", startDate: "2026-04-27", active: true, academicYearId: 3 },
];
const classes = [
  { classId: 1, name: "Basic 1", section: "Primary", isDeleted: false },
  { classId: 2, name: "Basic 2", section: "Primary", isDeleted: false },
  { classId: 3, name: "JHS 1", section: "JHS", isDeleted: false },
  { classId: 4, name: "KG 1", section: "KG", isDeleted: false },
  { classId: 9, name: "Basic 1", section: "Primary", isDeleted: true },
];

describe("rate / classKey", () => {
  it("is null with nothing to divide by, 1 dp otherwise", () => {
    expect(rate(0, 0)).toBeNull();
    expect(rate(5, null)).toBeNull();
    expect(rate(2, 3)).toBe(66.7);
    expect(rate(8, 10)).toBe(80);
  });
  it("matches class names trimmed, ignoring case and doubled spaces", () => {
    expect(classKey(" NURSERY  2 ")).toBe("nursery 2");
  });
  it("prefers a live class over a removed one with the same name", () => {
    expect(classIndex(classes).get("basic 1").classId).toBe(1);
  });
});

describe("passMarksByKey", () => {
  it("lists only class rules; the school default (or 40) is the fallback", () => {
    expect(passMarksByKey({ defaultPassMark: null, classRules: [] }, classes)).toEqual({ list: [], fallback: 40 });
    const r = passMarksByKey({ defaultPassMark: 45, classRules: [{ classId: 3, passMark: 50 }] }, classes);
    expect(r).toEqual({ list: [{ k: "jhs 1", m: 50 }], fallback: 45 });
  });
});

describe("buildTermsOverview", () => {
  it("lists every term oldest first, with null (not 0) where there is no data", () => {
    const rows = buildTermsOverview({
      terms,
      years: new Map([[3, "2025/2026"]]),
      results: [
        { termId: 11, classKey: "basic 1", pupils: 10, scored: 10, sumPct: 600, passed: 7 },
        { termId: 11, classKey: "jhs 1", pupils: 30, scored: 29, sumPct: 1450, passed: 20 },
      ],
      attendance: [
        { termId: 11, classKey: "basic 1", present: 540, days: 600 },
        { termId: 12, classKey: null, present: 90, days: 100 },
      ],
      pupils: [{ termId: 11, pupils: 41 }, { termId: 12, pupils: 5 }],
    });
    expect(rows.map((r) => r.termId)).toEqual([11, 12, 13]);
    // Over pupils, not a mean of class means: (600 + 1450) / 39.
    expect(rows[0]).toMatchObject({ name: "Term 1", pupils: 41, pupilsWithResults: 40, averageScore: 52.6, passRate: 69.2, attendanceRate: 90, daysMarked: 600 });
    expect(rows[0].academicYear).toEqual({ academicYearId: 3, name: "2025/2026" });
    expect(rows[1]).toMatchObject({ averageScore: null, passRate: null, attendanceRate: 90 });
    expect(rows[2]).toMatchObject({ pupils: 0, averageScore: null, passRate: null, attendanceRate: null, active: true });
  });
  it("puts terms without a start date last", () => {
    const rows = buildTermsOverview({ terms: [{ termId: 5, term: "1" }, { termId: 6, term: "2", startDate: "2020-01-01" }] });
    expect(rows.map((r) => r.termId)).toEqual([6, 5]);
  });
});

describe("buildGradeDistribution", () => {
  const scales = [
    { name: "JHS (BECE)", isDefault: false, sections: ["JHS"], bands: DEFAULT_JHS_BANDS },
    { name: "Primary", isDefault: true, sections: [], bands: DEFAULT_PRIMARY_BANDS },
  ];
  const idx = classIndex(classes);
  it("buckets per scale, best first, keeps empty buckets and puts strays last", () => {
    const out = buildGradeDistribution({
      classesByKey: idx,
      scales,
      grades: [
        { classKey: "jhs 1", grade: "1", remark: "Excellent", count: 2 },
        { classKey: "jhs 1", grade: "9", remark: "Fail", count: 1 },
        { classKey: "jhs 1", grade: "", remark: "", count: 1 },
        { classKey: "basic 1", grade: "", remark: "Pass", count: 4 },
        { classKey: "basic 2", grade: "", remark: "Pass", count: 1 },
        { classKey: "basic 2", grade: "", remark: "", noScore: true, count: 2 },
        { classKey: "kg 1", grade: "", remark: "Good", count: 9 },
      ],
    });
    const jhs = out.find((g) => g.scale === "JHS (BECE)");
    expect(jhs.buckets.map((b) => b.label)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "Ungraded"]);
    expect(jhs.buckets.map((b) => b.count)).toEqual([2, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
    expect(jhs.total).toBe(4);
    expect(jhs.buckets[0]).toMatchObject({ remark: "Excellent", share: 50 });
    const primary = out.find((g) => g.scale === "Primary");
    expect(primary.classes).toEqual(["Basic 1", "Basic 2"]);
    expect(primary.buckets.map((b) => b.label)).toEqual(["Excellent", "Very Good", "Good", "Credit", "Pass", "Fail", "No score"]);
    expect(primary.buckets.find((b) => b.label === "Pass").count).toBe(5);
    // KG is not graded.
    expect(out).toHaveLength(2);
  });
  it("uses the built-in bands when the school has no scale", () => {
    const out = buildGradeDistribution({ classesByKey: idx, scales: [], grades: [{ classKey: "basic 1", grade: "", remark: "Fail", count: 1 }] });
    expect(out[0].scale).toBe("Built-in");
    expect(out[0].buckets).toHaveLength(6);
  });
});

describe("buildTermDetail", () => {
  const term = terms[2];
  const base = {
    term,
    classes,
    rules: { defaultPassMark: null, classRules: [{ classId: 3, passMark: 50 }] },
    results: [
      { termId: 13, classKey: "basic 1", className: "Basic 1", pupils: 10, scored: 10, sumPct: 700, passed: 9 },
      { termId: 13, classKey: "basic 2", className: "Basic 2", pupils: 10, scored: 10, sumPct: 500, passed: 5 },
      { termId: 13, classKey: "jhs 1", className: "JHS 1", pupils: 20, scored: 20, sumPct: 1100, passed: 12 },
      { termId: 13, classKey: "old class", className: "Old Class", pupils: 2, scored: 2, sumPct: 100, passed: 1 },
    ],
    attendance: [
      { termId: 13, classKey: "basic 1", present: 45, days: 50 },
      { termId: 13, classKey: "kg 1", present: 30, days: 40 },
      { termId: 13, classKey: null, present: 8, days: 10 },
    ],
    pupils: [{ termId: 13, pupils: 55 }],
    roster: [
      { classKey: "basic 1", roll: 12, kgPupils: 0 },
      { classKey: "basic 2", roll: 10, kgPupils: 0 },
      { classKey: "jhs 1", roll: 20, kgPupils: 0 },
      { classKey: "kg 1", roll: 8, kgPupils: 6 },
    ],
    subjectRows: [
      { classKey: "basic 1", subjectId: 1, marks: 10, scored: 10, sumScore: 650, passed: 9 },
      { classKey: "basic 1", subjectId: 2, marks: 12, scored: 12, sumScore: 720, passed: 12 },
      { classKey: "basic 2", subjectId: 1, marks: 10, scored: 10, sumScore: 450, passed: 4 },
      { classKey: "basic 2", subjectId: 7, marks: 0, scored: 0, sumScore: 0, passed: 0 },
    ],
    subjects: [{ subjectId: 1, name: "Maths" }, { subjectId: 2, name: "English" }],
    promotions: [
      { classKey: "basic 1", outcome: "PROMOTED", count: 9 },
      { classKey: "basic 1", outcome: "REPEATED", count: 1 },
    ],
  };

  it("one row per class with data, KG without scores, removed classes kept by name", () => {
    const out = buildTermDetail(base);
    expect(out.classes.map((c) => c.name)).toEqual(["Basic 1", "Basic 2", "JHS 1", "KG 1", "Old Class"]);
    const b1 = out.classes.find((c) => c.name === "Basic 1");
    expect(b1).toMatchObject({ classId: 1, averageScore: 70, passRate: 90, attendanceRate: 90, roll: 12, passMark: 40, promotion: { PROMOTED: 9, REPEATED: 1 } });
    expect(out.classes.find((c) => c.name === "JHS 1").passMark).toBe(50);
    const kg = out.classes.find((c) => c.name === "KG 1");
    expect(kg).toMatchObject({ isKg: true, averageScore: null, passRate: null, attendanceRate: 75, pupilsWithResults: 6 });
    expect(kg.completeness.percent).toBe(75);
    expect(out.classes.find((c) => c.name === "Old Class")).toMatchObject({ classId: null, removed: true });
    expect(out.unclassifiedAttendance).toMatchObject({ daysMarked: 10, attendanceRate: 80 });
  });

  it("results-entry completeness counts only subjects the class has started", () => {
    const out = buildTermDetail(base);
    const b1 = out.classes.find((c) => c.name === "Basic 1").completeness;
    expect(b1).toMatchObject({ subjectsStarted: 2, marksRecorded: 22, marksExpected: 24, percent: 91.7 });
    const b2 = out.classes.find((c) => c.name === "Basic 2").completeness;
    expect(b2).toMatchObject({ subjectsStarted: 1, marksExpected: 10, percent: 100 });
    // A class with results but no marks this term (JHS 1 here) has nothing expected: null.
    expect(out.classes.find((c) => c.name === "JHS 1").completeness.percent).toBeNull();
    expect(out.totals.completeness).toBe(rate(32, 34));
  });

  it("ranks classes by average (top and bottom don't overlap)", () => {
    const out = buildTermDetail(base);
    expect(out.ranking.top.map((c) => c.name)).toEqual(["Basic 1", "JHS 1", "Basic 2"]);
    expect(out.ranking.bottom.map((c) => c.name)).toEqual(["Old Class"]);
    expect(out.classes.find((c) => c.name === "Basic 2").rank).toBe(3);
  });

  it("subject averages and pass rates school-wide; a removed subject is named so", () => {
    const out = buildTermDetail(base);
    expect(out.subjects).toEqual([
      { subjectId: 2, name: "English", classes: 1, marks: 12, average: 60, passRate: 100 },
      { subjectId: 1, name: "Maths", classes: 2, marks: 20, average: 55, passRate: 65 },
      { subjectId: 7, name: "Subject no longer listed", classes: 1, marks: 0, average: null, passRate: null },
    ]);
  });

  it("promotion: counts per outcome; pending only once deciding has started", () => {
    const out = buildTermDetail(base);
    expect(out.promotion).toEqual({ PROMOTED: 9, REPEATED: 1, GRADUATED: 0, decided: 10, pending: 42 + 6 - 10 });
    expect(buildTermDetail({ ...base, promotions: [] }).promotion).toMatchObject({ decided: 0, pending: null });
  });

  it("totals over the whole term", () => {
    const out = buildTermDetail(base);
    expect(out.totals).toMatchObject({ pupils: 55, pupilsWithResults: 42, averageScore: 57.1, passRate: 64.3, attendanceRate: 83, classes: 5 });
  });

  it("an empty term: nothing ranked, nulls everywhere", () => {
    const out = buildTermDetail({ term, classes });
    expect(out.classes).toEqual([]);
    expect(out.ranking).toEqual({ top: [], bottom: [] });
    expect(out.totals).toMatchObject({ averageScore: null, passRate: null, attendanceRate: null, completeness: null });
    expect(out.gradeDistribution).toEqual([]);
  });
});

describe("buildClassReport", () => {
  const names = new Map([[1, "Ama"], [2, "Kofi"], [3, "Yaw"], [4, "Esi"]]);
  it("pupils by position, subjects with those below the pass mark (lowest first)", () => {
    const out = buildClassReport({
      passMark: 50,
      names,
      results: [
        { studentId: 1, rawScore: 160, totalRawScore: 200 },
        { studentId: 2, rawScore: 90, totalRawScore: 200 },
        { studentId: 3, rawScore: 160, totalRawScore: 200 },
        { studentId: 4, rawScore: null, totalRawScore: null },
      ],
      marks: [
        { studentId: 1, subjectId: 1, totalScore: 80 },
        { studentId: 2, subjectId: 1, totalScore: 30, grade: "9", remarks: "Fail" },
        { studentId: 3, subjectId: 1, totalScore: 45 },
        { studentId: 1, subjectId: 2, totalScore: 50 },
        { studentId: 2, subjectId: 2, totalScore: null },
      ],
      subjects: [{ subjectId: 1, name: "Maths", passMarks: 0 }, { subjectId: 2, name: "English", passMarks: 60 }],
      attendance: [{ studentId: 1, present: 9, total: 10 }, { studentId: 2, present: 5, total: 10 }],
    });
    expect(out.pupils.map((p) => [p.name, p.position, p.score, p.passed])).toEqual([
      ["Ama", 1, 80, true],
      ["Yaw", 1, 80, true],
      ["Kofi", 3, 45, false],
      ["Esi", null, null, null],
    ]);
    expect(out.pupils[0]).toMatchObject({ attendanceRate: 90, daysMarked: 10 });
    expect(out.pupils[1]).toMatchObject({ attendanceRate: null, daysMarked: null });
    const maths = out.subjects.find((s) => s.name === "Maths");
    expect(maths).toMatchObject({ passMark: 50, marks: 3, average: 51.7, passRate: 33.3 });
    expect(maths.below.map((b) => [b.name, b.score])).toEqual([["Kofi", 30], ["Yaw", 45]]);
    expect(maths.below[0]).toMatchObject({ grade: "9", remark: "Fail" });
    // The subject's own pass mark wins; an empty mark is not counted.
    const english = out.subjects.find((s) => s.name === "English");
    expect(english).toMatchObject({ passMark: 60, marks: 2, average: 50, passRate: 0 });
    expect(out.totals).toMatchObject({ pupils: 4, averageScore: 68.3, passRate: 66.7, attendanceRate: 70, daysMarked: 20 });
  });
});

describe("services", () => {
  const queriesBy = (rows) => (sql) => {
    for (const [needle, out] of rows) if (sql.includes(needle)) return Promise.resolve(out);
    return Promise.resolve([]);
  };

  it("terms overview: every term, the pass marks passed to SQL as JSON", async () => {
    Term.findAll.mockResolvedValue(terms);
    AcademicYear.findAll.mockResolvedValue([{ academicYearId: 3, name: "2025/2026" }]);
    Class.findAll.mockResolvedValue(classes);
    getRules.mockResolvedValue({ defaultPassMark: 45, classRules: [{ classId: 1, passMark: 55 }] });
    sequelize.query.mockImplementation(queriesBy([["Student_result\"\n  WHERE", [{ termId: 11, classKey: "basic 1", pupils: 2, scored: 2, sumPct: 120, passed: 1 }]]]));
    const out = await getTermsOverview();
    expect(out.terms.map((t) => t.termId)).toEqual([11, 12, 13]);
    expect(out.terms[0]).toMatchObject({ averageScore: 60, passRate: 50 });
    const first = sequelize.query.mock.calls[0][1];
    expect(first.type).toBe("SELECT");
    expect(first.replacements).toEqual({ termId: null, marks: JSON.stringify([{ k: "basic 1", m: 55 }]), defaultMark: 45 });
  });

  it("term report: 404 for an unknown term, 400 for a bad id", async () => {
    Term.findOne.mockResolvedValue(null);
    await expect(getTermReport(77)).rejects.toMatchObject({ statusCode: 404 });
    await expect(getTermReport("abc")).rejects.toBeInstanceOf(AppError);
  });

  it("term report: every query is for that term only", async () => {
    Term.findOne.mockResolvedValue(terms[2]);
    Class.findAll.mockResolvedValue(classes);
    sequelize.query.mockResolvedValue([]);
    const out = await getTermReport(13);
    expect(out.term.termId).toBe(13);
    for (const [, opts] of sequelize.query.mock.calls) expect(opts.replacements.termId).toBe(13);
    const roster = sequelize.query.mock.calls.find(([sql]) => sql.includes('"roll"'));
    expect(roster[1].replacements.active).toBe(true);
  });

  it("class drill-down: a Class Teacher of another class is refused", async () => {
    Class.findOne.mockResolvedValue({ classId: 2, name: "Basic 2", section: "Primary" });
    assertClassAccess.mockRejectedValueOnce(new AppError("nope", 403));
    await expect(getClassTermReport({ termId: 13, classId: 2 }, { category: "Class Teacher", teacherId: 5 })).rejects.toMatchObject({
      statusCode: 403,
      message: "You can only see reports for your own class",
    });
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  it("class drill-down: 404 for an unknown class", async () => {
    Class.findOne.mockResolvedValue(null);
    await expect(getClassTermReport({ termId: 13, classId: 99 }, { category: "Administrator" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("class drill-down: scores, the B7 attendance summary and names", async () => {
    Class.findOne.mockResolvedValue({ classId: 1, name: " Basic 1", section: "Primary" });
    Term.findOne.mockResolvedValue(terms[2]);
    getRules.mockResolvedValue({ defaultPassMark: null, classRules: [] });
    sequelize.query.mockImplementation(
      queriesBy([
        ["Student_result", [{ studentId: 1, rawScore: 30, totalRawScore: 100 }]],
        ["Student_marks", [{ studentId: 1, subjectId: 1, totalScore: 30 }]],
      ])
    );
    Subject.findAll.mockResolvedValue([{ subjectId: 1, name: "Maths", passMarks: null }]);
    getClassAttendanceSummary.mockResolvedValue({ students: [{ studentId: 2, name: "Kofi", present: 4, total: 5 }] });
    Student.findAll.mockResolvedValue([{ studentId: 1, fName: "Ama", lName: "Owusu" }]);
    const user = { category: "Class Teacher", teacherId: 5 };
    const out = await getClassTermReport({ termId: "13", classId: "1" }, user);
    expect(assertClassAccess).toHaveBeenCalledWith(user, " Basic 1");
    expect(getClassAttendanceSummary).toHaveBeenCalledWith({ classId: 1, termId: 13 }, user);
    expect(sequelize.query.mock.calls[0][1].replacements).toEqual({ termId: 13, key: "basic 1" });
    expect(out.passMark).toBe(40);
    expect(out.pupils.map((p) => [p.name, p.score])).toEqual([["Ama Owusu", 30], ["Kofi", null]]);
    expect(out.subjects[0].below.map((b) => b.name)).toEqual(["Ama Owusu"]);
  });

  it("class drill-down for KG: attendance only, no score queries", async () => {
    Class.findOne.mockResolvedValue({ classId: 4, name: "KG 1", section: "KG" });
    Term.findOne.mockResolvedValue(terms[2]);
    getClassAttendanceSummary.mockResolvedValue({ students: [{ studentId: 2, name: "Kofi", present: 4, total: 5 }] });
    const out = await getClassTermReport({ termId: 13, classId: 4 }, { category: "Administrator" });
    expect(sequelize.query).not.toHaveBeenCalled();
    expect(out.class.isKg).toBe(true);
    expect(out.pupils).toHaveLength(1);
    expect(out.totals.attendanceRate).toBe(80);
  });
});
