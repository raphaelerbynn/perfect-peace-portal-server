// B2: teacher portal register + score sheet. Models and the shared write
// services are mocked; the scope rule runs for real (teacherScope.js).
jest.mock("../models/index.js", () => ({
  __esModule: true,
  TeachingAssignment: { findAll: jest.fn() },
  Class: { findAll: jest.fn(), findOne: jest.fn() },
  Subject: { findAll: jest.fn(), findOne: jest.fn() },
  Teacher: { findOne: jest.fn() },
  Student: { findAll: jest.fn() },
  Attendance: { findAll: jest.fn(), count: jest.fn() },
  StudentMarks: { findAll: jest.fn() },
  KgAssessment: { findAll: jest.fn(), findOne: jest.fn(), update: jest.fn(), create: jest.fn() },
}));
jest.mock("../config/database.js", () => ({ __esModule: true, default: { transaction: jest.fn(async (cb) => cb({})) } }));
jest.mock("../services/attendance.js", () => ({
  __esModule: true,
  VALID_STATUSES: ["Present", "Sick", "Absent"],
  markClassAttendance: jest.fn(),
}));
jest.mock("../services/results.js", () => ({ __esModule: true, saveClassSubjectScores: jest.fn() }));
jest.mock("../services/term.js", () => ({ __esModule: true, requireActiveTerm: jest.fn() }));
// B8: the sheet carries the class's bands (grading service tested on its own).
jest.mock("../services/grading.js", () => {
  const actual = jest.requireActual("../services/grading.js");
  return {
    ...actual,
    bandsForSection: async (section) =>
      section === "JHS" ? { name: "JHS", bands: actual.DEFAULT_JHS_BANDS } : { name: "Built-in", bands: actual.DEFAULT_PRIMARY_BANDS },
  };
});

import { Attendance, Class, KgAssessment, Student, StudentMarks, Subject, Teacher, TeachingAssignment } from "../models/index.js";
import sequelize from "../config/database.js";
import { markClassAttendance } from "../services/attendance.js";
import { saveClassSubjectScores } from "../services/results.js";
import { requireActiveTerm } from "../services/term.js";
import { getMyClasses, getScores, saveRegister, saveScores } from "../services/teacherTools.js";
import { AppError } from "../utils/errorHandling.js";

// Term 5 runs 2026-09-01 .. 2026-12-18. JHS 1 (1): class teacher Ama (10),
// Maths (100) assigned to Kofi (11). JHS 2 (2): Science (101) assigned to Esi (12).
const TERM = { termId: 5, term: "1", startDate: "2026-09-01", endDate: "2026-12-18", active: true };
const classes = {
  1: { classId: 1, name: "JHS 1", section: "JHS", teacherId: 10 },
  2: { classId: 2, name: "JHS 2", section: "JHS", teacherId: 11 },
  3: { classId: 3, name: "KG 1", section: "KG", teacherId: 10 },
};
const teachers = { 10: { teacherId: 10, fName: "Ama", lName: "Owusu" }, 11: { teacherId: 11, fName: "Kofi", lName: "Mensah" } };
const assignments = [
  { teacherId: 11, termId: 5, classId: 1, subjectId: 100 },
  { teacherId: 12, termId: 5, classId: 2, subjectId: 101 },
];
const MATHS = { subjectId: 100, name: "Maths", classTotalMarks: "30", examTotalMarks: "70", classPercentage: "30", examPercentage: "70" };
const SCIENCE = { ...MATHS, subjectId: 101, name: "Science" };
const roster = [
  { studentId: 1, fName: "Abena", lName: "Boateng" },
  { studentId: 2, fName: "Yaw", lName: "Asare" },
];

const whereOk = (row, where) =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object") {
      return Object.getOwnPropertySymbols(v).every((sym) =>
        sym.toString().includes("ne") ? row[k] !== v[sym] : v[sym].includes(row[k])
      );
    }
    return row[k] === v;
  });

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers().setSystemTime(new Date("2026-11-06T09:00:00Z")); // a Friday
  requireActiveTerm.mockResolvedValue(TERM);
  Teacher.findOne.mockImplementation(async ({ where }) => teachers[where.teacherId] || null);
  Class.findOne.mockImplementation(async ({ where }) => classes[where.classId] || null);
  Class.findAll.mockImplementation(async ({ where }) =>
    Object.values(classes).filter((c) => whereOk({ ...c, isDeleted: false }, where))
  );
  TeachingAssignment.findAll.mockImplementation(async ({ where }) => assignments.filter((a) => whereOk(a, where)));
  Subject.findOne.mockImplementation(async ({ where }) => [MATHS, SCIENCE].find((s) => s.subjectId === Number(where.subjectId)) || null);
  Subject.findAll.mockResolvedValue([MATHS, SCIENCE]);
  Student.findAll.mockResolvedValue(roster);
  Attendance.findAll.mockResolvedValue([]);
  Attendance.count.mockResolvedValue(0);
  StudentMarks.findAll.mockResolvedValue([]);
  markClassAttendance.mockResolvedValue([]);
  saveClassSubjectScores.mockResolvedValue({ saved: 2, skipped: 0 });
});
afterEach(() => jest.useRealTimers());

const allPresent = [
  { studentId: 1, status: "Present" },
  { studentId: 2, status: "Absent" },
];

describe("register", () => {
  it("the class teacher saves it; who took it is recorded from the token", async () => {
    const out = await saveRegister(10, { classId: 1, date: "2026-11-05", marks: allPresent });
    expect(markClassAttendance).toHaveBeenCalledWith({
      className: "JHS 1",
      dateMarked: "2026-11-05",
      studentAttendance: allPresent,
      enteredBy: "Ama Owusu",
      enteredByTeacherId: 10,
    });
    expect(out.studentAttendance).toEqual(allPresent);
  });

  it("a subject teacher of the class can't take it (403)", async () => {
    await expect(saveRegister(11, { classId: 1, date: "2026-11-05", marks: allPresent })).rejects.toMatchObject({ statusCode: 403 });
    expect(markClassAttendance).not.toHaveBeenCalled();
  });

  it.each([
    ["outside the term", "2026-12-20", /outside the current term/],
    ["in the future", "2026-11-09", /future date/],
    ["not a date", "05/11/2026", /YYYY-MM-DD/],
  ])("refuses a date %s (400)", async (_label, date, msg) => {
    await expect(saveRegister(10, { classId: 1, date, marks: allPresent })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(msg) });
  });

  it("refuses a register that leaves out a pupil, or names someone from another class", async () => {
    await expect(saveRegister(10, { classId: 1, date: "2026-11-05", marks: [allPresent[0]] })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/every pupil/),
    });
    await expect(
      saveRegister(10, { classId: 1, date: "2026-11-05", marks: [...allPresent, { studentId: 99, status: "Present" }] })
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/not in this class/) });
  });

  it("refuses an unknown status", async () => {
    await expect(
      saveRegister(10, { classId: 1, date: "2026-11-05", marks: [{ studentId: 1, status: "Late" }, allPresent[1]] })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("no open term = 409 from requireActiveTerm", async () => {
    requireActiveTerm.mockRejectedValue(new AppError("No term is open", 409));
    await expect(saveRegister(10, { classId: 1, date: "2026-11-05", marks: allPresent })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("score sheet", () => {
  const sheet = [
    { studentId: 1, classScore: 25, examScore: 0 }, // 0 is a valid score
    { studentId: 2, classScore: "", examScore: "" }, // skipped
  ];

  it("the assigned subject teacher saves; the server records who", async () => {
    const out = await saveScores(11, { classId: 1, subjectId: 100, scores: sheet });
    expect(saveClassSubjectScores).toHaveBeenCalledWith(
      expect.objectContaining({
        className: "JHS 1",
        subjectId: 100,
        term: "1",
        termId: 5,
        enteredBy: "Kofi Mensah",
        enteredByTeacherId: 11,
      })
    );
    expect(out.saved).toBe(2);
    expect(out.sheet.students).toHaveLength(2);
  });

  it("a JHS 1 Maths teacher can't write JHS 2 Science (403)", async () => {
    await expect(saveScores(11, { classId: 2, subjectId: 101, scores: sheet })).rejects.toMatchObject({ statusCode: 403 });
    expect(saveClassSubjectScores).not.toHaveBeenCalled();
  });

  it("class-teacher fallback: Kofi may score JHS 2 Maths (nobody assigned)", async () => {
    await expect(saveScores(11, { classId: 2, subjectId: 100, scores: sheet })).resolves.toMatchObject({ saved: 2 });
  });

  it("names the pupil when a row is half filled or over the maximum", async () => {
    await expect(
      saveScores(11, { classId: 1, subjectId: 100, scores: [{ studentId: 2, classScore: 10, examScore: "" }] })
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Yaw Asare/) });
    await expect(
      saveScores(11, { classId: 1, subjectId: 100, scores: [{ studentId: 1, classScore: 31, examScore: 50 }] })
    ).rejects.toMatchObject({ statusCode: 400, message: "Abena Boateng's class score can't be more than 30." });
  });

  it("refuses a subject the office hasn't configured (409)", async () => {
    Subject.findOne.mockResolvedValue({ ...MATHS, examTotalMarks: null });
    await expect(saveScores(11, { classId: 1, subjectId: 100, scores: sheet })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("KG classes don't have subject sheets", async () => {
    await expect(getScores(10, { classId: 3, subjectId: 100 })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("shows existing marks and who entered them", async () => {
    StudentMarks.findAll.mockResolvedValue([
      { studentId: 1, classScore: "20", examScore: "50", totalScore: "70", remarks: "Very Good", enteredBy: "admin" },
    ]);
    const out = await getScores(11, { classId: 1, subjectId: "100" });
    expect(out.subject).toMatchObject({ name: "Maths", classTotalMarks: 30, configured: true });
    expect(out.students[0]).toMatchObject({ name: "Abena Boateng", classScore: 20, totalScore: 70, enteredBy: "admin" });
    expect(out.students[1]).toMatchObject({ name: "Yaw Asare", classScore: null });
  });
});

describe("my classes", () => {
  it("shows today's register state and missing scores per subject", async () => {
    Attendance.count.mockResolvedValue(0);
    StudentMarks.findAll.mockResolvedValue([{ subjectId: 100, studentId: 1 }]);
    const out = await getMyClasses(11);
    expect(out.term).toMatchObject({ termId: 5 });
    const jhs1 = out.classes.find((c) => c.name === "JHS 1");
    expect(jhs1).toMatchObject({ pupils: 2, takesRegister: false });
    expect(jhs1.subjects).toEqual([{ subjectId: 100, name: "Maths", scored: 1, missing: 1 }]);
  });

  it("no open term: empty list instead of an error", async () => {
    requireActiveTerm.mockRejectedValue(new AppError("No term is open", 409));
    await expect(getMyClasses(11)).resolves.toMatchObject({ term: null, classes: [] });
  });
});

it.each([["7.125", "50"], ["1e1", "50"], ["-3", "50"], ["7,5", "50"], ["7.", "50"]])("refuses score %s (numbers with up to 2 decimal places only)", async (cs, es) => {
  const { saveScores } = require("../services/teacherTools.js");
  await expect(saveScores(11, { classId: 1, subjectId: 100, scores: [{ studentId: 1, classScore: cs, examScore: es }] })).rejects.toMatchObject({
    statusCode: 400,
    message: expect.stringContaining("2 decimal places"),
  });
});

it("takes decimal scores: 7.5 and 48.25 (migration 012)", async () => {
  const { saveScores } = require("../services/teacherTools.js");
  await expect(
    saveScores(11, { classId: 1, subjectId: 100, scores: [{ studentId: 1, classScore: "7.5", examScore: " 48.25 " }] })
  ).resolves.toMatchObject({ saved: expect.any(Number) });
});

describe("KG / nursery scores (learning areas)", () => {
  beforeEach(() => {
    sequelize.transaction.mockImplementation(async (cb) => cb({}));
    KgAssessment.findAll.mockResolvedValue([{ studentId: 1, classScore: 80, examScore: 70.5, totalScore: 75.25 }]);
  });

  it("the class teacher opens a learning area sheet with existing KG scores", async () => {
    const out = await getScores(10, { classId: 3, subjectId: "kg-2" });
    expect(out.subject).toMatchObject({ subjectId: "kg-2", name: "Numeracy", classTotalMarks: 100, examTotalMarks: 100, classPercentage: 50, examPercentage: 50, configured: true });
    expect(KgAssessment.findAll.mock.calls[0][0].where).toMatchObject({ class: "KG 1", termId: 5, category: "ACADEMIC PROGRESS/EXAMINATION SCORES", assessment: "Numeracy" });
    expect(out.students[0]).toMatchObject({ classScore: 80, examScore: 70.5, totalScore: 75.25 });
  });

  it("saves to the KG report records: 50% class + 50% exam, decimals kept", async () => {
    KgAssessment.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ kgAssessmentId: 9 });
    const out = await saveScores(10, {
      classId: 3,
      subjectId: "kg-2",
      scores: [
        { studentId: 1, classScore: "80", examScore: "70.5" },
        { studentId: 2, classScore: "60", examScore: "45" },
      ],
    });
    expect(out.saved).toBe(2);
    expect(KgAssessment.create.mock.calls[0][0]).toMatchObject({
      studentId: 1, class: "KG 1", termId: 5, category: "ACADEMIC PROGRESS/EXAMINATION SCORES", assessment: "Numeracy",
      classScore: 80, examScore: 70.5, classScorePercentage: 40, examScorePercentage: 35.25, totalScore: 75.25,
    });
    expect(KgAssessment.update.mock.calls[0][1].where).toEqual({ kgAssessmentId: 9 });
    expect(saveClassSubjectScores).not.toHaveBeenCalled();
  });

  it("refuses a score over 100, and a teacher who isn't the class teacher (403)", async () => {
    await expect(saveScores(10, { classId: 3, subjectId: "kg-1", scores: [{ studentId: 1, classScore: "101", examScore: "50" }] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(getScores(11, { classId: 3, subjectId: "kg-1" })).rejects.toMatchObject({ statusCode: 403 });
  });

  it("a learning area id on a primary/JHS class is refused (400)", async () => {
    await expect(getScores(10, { classId: 1, subjectId: "kg-1" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("my classes shows KG learning-area progress", async () => {
    Attendance.count.mockResolvedValue(0);
    StudentMarks.findAll.mockResolvedValue([]);
    KgAssessment.findAll.mockResolvedValue([{ assessment: "Numeracy", studentId: 1 }]);
    const out = await getMyClasses(10);
    const kg = out.classes.find((c) => c.name === "KG 1");
    expect(kg.subjects.find((s) => s.name === "Numeracy")).toMatchObject({ subjectId: "kg-2", scored: 1, missing: 1 });
  });
});

it("B8: the score sheet carries the class's grade bands for the live remark preview", async () => {
  const sheet = await getScores(11, { classId: 1, subjectId: 100 });
  expect(sheet.grading.bands.map((b) => b.grade)).toEqual(["9", "8", "7", "6", "5", "4", "3", "2", "1"]);
});

describe("B6: rows checked against the saved scores (teacher Excel upload)", () => {
  const tx = { LOCK: { UPDATE: "UPDATE" } };
  // Run the save's checkBefore the way saveClassSubjectScores does.
  beforeEach(() => {
    saveClassSubjectScores.mockImplementation(async ({ checkBefore, scores }) => {
      if (checkBefore) await checkBefore(tx);
      return { saved: scores.length, skipped: 0 };
    });
  });
  const row = (previous) => ({ studentId: 1, classScore: "25", examScore: "60", previous });

  it("saves when the saved scores are still what the upload compared against", async () => {
    StudentMarks.findAll.mockResolvedValue([{ studentId: 1, classScore: "20", examScore: "50" }]);
    await expect(
      saveScores(11, { classId: 1, subjectId: 100, scores: [row({ classScore: 20, examScore: 50 })] })
    ).resolves.toMatchObject({ saved: 1 });
    // The check reads (and locks) only the checked pupils, inside the save's transaction.
    const check = StudentMarks.findAll.mock.calls[0][0];
    expect(check).toMatchObject({ where: { class: "JHS 1", termId: 5, subjectId: 100, studentId: [1] }, transaction: tx, lock: "UPDATE" });
  });

  it("a blank previous matches a pupil with no mark yet", async () => {
    StudentMarks.findAll.mockResolvedValue([]);
    await expect(
      saveScores(11, { classId: 1, subjectId: 100, scores: [row({ classScore: null, examScore: null })] })
    ).resolves.toMatchObject({ saved: 1 });
  });

  it("refuses the whole save (409) naming the pupil when a score changed meanwhile", async () => {
    StudentMarks.findAll.mockResolvedValue([{ studentId: 1, classScore: "22", examScore: "50" }]);
    await expect(
      saveScores(11, { classId: 1, subjectId: 100, scores: [row({ classScore: 20, examScore: 50 })] })
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/Abena Boateng/) });
  });

  it("rows without previous (the typed sheet) skip the check", async () => {
    await saveScores(11, { classId: 1, subjectId: 100, scores: [{ studentId: 1, classScore: "25", examScore: "60" }] });
    expect(saveClassSubjectScores.mock.calls[0][0].checkBefore).toBeNull();
  });

  it("KG learning areas: same check on the KG report records; stale = nothing written", async () => {
    sequelize.transaction.mockImplementation(async (cb) => cb(tx));
    KgAssessment.findAll.mockResolvedValue([{ studentId: 1, classScore: 70, examScore: 50 }]);
    await expect(
      saveScores(10, { classId: 3, subjectId: "kg-2", scores: [row({ classScore: 60, examScore: 50 })] })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(KgAssessment.findAll.mock.calls[0][0]).toMatchObject({
      where: { class: "KG 1", termId: 5, category: "ACADEMIC PROGRESS/EXAMINATION SCORES", assessment: "Numeracy", studentId: [1] },
      transaction: tx,
    });
    expect(KgAssessment.create).not.toHaveBeenCalled();
    expect(KgAssessment.update).not.toHaveBeenCalled();

    KgAssessment.findOne.mockResolvedValue(null);
    await expect(
      saveScores(10, { classId: 3, subjectId: "kg-2", scores: [row({ classScore: 70, examScore: 50 })] })
    ).resolves.toMatchObject({ saved: 1 });
    expect(KgAssessment.create).toHaveBeenCalledTimes(1);
  });
});
