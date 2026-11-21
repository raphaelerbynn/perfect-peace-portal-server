// B6: the office's class score sheet (Upload scores). Models and the shared
// write are mocked; the row checks run for real (teacherTools.js).
jest.mock("../models/index.js", () => ({
  __esModule: true,
  Class: { findOne: jest.fn(), findAll: jest.fn() },
  Subject: { findOne: jest.fn() },
  Student: { findAll: jest.fn() },
  StudentMarks: { findAll: jest.fn() },
  KgAssessment: {},
  Attendance: {},
  TeachingAssignment: {},
  Teacher: {},
}));
jest.mock("../config/database.js", () => ({ __esModule: true, default: { transaction: jest.fn(async (cb) => cb({})) } }));
jest.mock("../services/results.js", () => ({ __esModule: true, saveClassSubjectScores: jest.fn() }));
jest.mock("../services/term.js", () => ({ __esModule: true, requireActiveTerm: jest.fn(), getTerm: jest.fn() }));
jest.mock("../services/attendance.js", () => ({
  __esModule: true,
  VALID_STATUSES: [],
  markClassAttendance: jest.fn(),
  assertClassAccess: jest.fn(),
  assertClassWrite: jest.fn(),
}));
jest.mock("../services/grading.js", () => ({
  __esModule: true,
  bandsForSection: async () => ({ name: "Primary (standard)", bands: [{ grade: null, remark: "Fail", minScore: 0, maxScore: 100 }] }),
}));

import { Class, Student, StudentMarks, Subject } from "../models/index.js";
import { saveClassSubjectScores } from "../services/results.js";
import { requireActiveTerm } from "../services/term.js";
import { assertClassAccess, assertClassWrite } from "../services/attendance.js";
import { getOfficeSheet, saveOfficeSheet } from "../services/scoreSheet.js";
import { AppError } from "../utils/errorHandling.js";

const admin = { category: "Administrator", username: "admin" };
const ct = { category: "Class Teacher", username: "ama", teacherId: 10 };
const TERM = { termId: 5, term: "1", active: true };
const MATHS = { subjectId: 100, name: "Maths", classTotalMarks: 30, examTotalMarks: 70, classPercentage: 30, examPercentage: 70 };
const classes = { 1: { classId: 1, name: "Basic 4", section: "Upper Primary", teacherId: 10 }, 3: { classId: 3, name: "KG 1", section: "KG" } };

beforeEach(() => {
  jest.resetAllMocks();
  Class.findOne.mockImplementation(async ({ where }) => classes[where.classId] || null);
  Subject.findOne.mockResolvedValue(MATHS);
  requireActiveTerm.mockResolvedValue(TERM);
  Student.findAll.mockResolvedValue([
    { studentId: 1, fName: "Ama", lName: "Boateng" },
    { studentId: 2, fName: "Kofi", lName: "Mensah" },
  ]);
  StudentMarks.findAll.mockResolvedValue([{ studentId: 2, classScore: "20.5", examScore: "50", totalScore: "70.5", remarks: "Very Good", grade: null }]);
  saveClassSubjectScores.mockResolvedValue({ saved: 1, skipped: 1 });
});

it("reads the sheet: roster with index numbers, existing marks, the subject's maximums and the class's bands", async () => {
  const sheet = await getOfficeSheet(admin, { classId: 1, subjectId: 100 });
  expect(sheet.subject).toMatchObject({ classTotalMarks: 30, examTotalMarks: 70, configured: true });
  expect(sheet.term).toEqual({ termId: 5, term: "1" });
  expect(sheet.grading.name).toBe("Primary (standard)");
  expect(sheet.students).toEqual([
    expect.objectContaining({ studentId: 1, indexNo: "STU/1", name: "Ama Boateng", classScore: null, examScore: null }),
    expect.objectContaining({ studentId: 2, indexNo: "STU/2", classScore: 20.5, examScore: 50, totalScore: 70.5, remarks: "Very Good" }),
  ]);
});

it("saves the whole sheet through the shared one-transaction write; blank rows go through as blanks (skipped there)", async () => {
  const out = await saveOfficeSheet(admin, {
    classId: 1,
    subjectId: 100,
    scores: [
      { studentId: 1, classScore: "0", examScore: "70" },
      { studentId: 2, classScore: "", examScore: null },
    ],
  });
  expect(saveClassSubjectScores).toHaveBeenCalledWith({
    className: "Basic 4",
    subjectId: 100,
    term: "1",
    termId: 5,
    scores: [
      { studentId: 1, classScore: "0", examScore: "70" },
      { studentId: 2, classScore: "", examScore: null },
    ],
    enteredBy: "admin",
    enteredByTeacherId: null,
  });
  expect(out).toMatchObject({ saved: 1, skipped: 1, sheet: expect.any(Object) });
});

it.each([
  [{ studentId: 1, classScore: "31", examScore: "1" }, /class score can't be more than 30/],
  [{ studentId: 1, classScore: "1", examScore: "70.01" }, /exam score can't be more than 70/],
  [{ studentId: 1, classScore: "5", examScore: "" }, /Enter both/],
  [{ studentId: 1, classScore: "abc", examScore: "5" }, /numbers with at most 2 decimal/],
  [{ studentId: 1, classScore: "7.125", examScore: "5" }, /numbers with at most 2 decimal/],
  [{ studentId: 99, classScore: "1", examScore: "1" }, /not in this class/],
])("refuses the whole sheet for a bad row %p, saving nothing", async (row, msg) => {
  await expect(saveOfficeSheet(admin, { classId: 1, subjectId: 100, scores: [{ studentId: 2, classScore: 1, examScore: 1 }, row] })).rejects.toThrow(msg);
  expect(saveClassSubjectScores).not.toHaveBeenCalled();
});

it("refuses a pupil listed twice", async () => {
  await expect(
    saveOfficeSheet(admin, { classId: 1, subjectId: 100, scores: [{ studentId: 1, classScore: 1, examScore: 1 }, { studentId: 1, classScore: 2, examScore: 2 }] })
  ).rejects.toThrow(/twice/);
});

it("KG classes are separate (400); an unconfigured subject is 409; no open term is 409", async () => {
  await expect(getOfficeSheet(admin, { classId: 3, subjectId: 100 })).rejects.toMatchObject({ statusCode: 400 });
  Subject.findOne.mockResolvedValue({ ...MATHS, classTotalMarks: null });
  await expect(saveOfficeSheet(admin, { classId: 1, subjectId: 100, scores: [{ studentId: 1, classScore: 1, examScore: 1 }] })).rejects.toMatchObject({ statusCode: 409 });
  requireActiveTerm.mockRejectedValue(new AppError("No term is open. Open a term in Settings first.", 409));
  await expect(getOfficeSheet(admin, { classId: 1, subjectId: 100 })).rejects.toMatchObject({ statusCode: 409 });
});

it("Class Teachers: own class only (403), and the single-result write guard runs too", async () => {
  assertClassAccess.mockRejectedValue(new AppError("nope", 403));
  await expect(getOfficeSheet(ct, { classId: 1, subjectId: 100 })).rejects.toThrow("You can only enter scores for your own class.");
  assertClassAccess.mockResolvedValue(undefined);
  await saveOfficeSheet(ct, { classId: 1, subjectId: 100, scores: [{ studentId: 1, classScore: 1, examScore: 1 }] });
  expect(assertClassWrite).toHaveBeenCalledWith(ct, "Basic 4", [1], 5);
  expect(saveClassSubjectScores).toHaveBeenCalledWith(expect.objectContaining({ enteredBy: "ama" }));
});

it("an empty list is refused", async () => {
  await expect(saveOfficeSheet(admin, { classId: 1, subjectId: 100, scores: [] })).rejects.toMatchObject({ statusCode: 400 });
});

describe("stale writes (review B6): each row may carry the scores the page showed", () => {
  // Run the save's checkBefore the way saveClassSubjectScores does.
  const tx = { LOCK: { UPDATE: "UPDATE" } };
  beforeEach(() => {
    saveClassSubjectScores.mockImplementation(async ({ checkBefore, scores }) => {
      if (checkBefore) await checkBefore(tx);
      return { saved: scores.length, skipped: 0 };
    });
  });

  it("saves when every saved mark is still what the page showed (blank = no mark yet)", async () => {
    const out = await saveOfficeSheet(admin, {
      classId: 1,
      subjectId: 100,
      scores: [
        { studentId: 1, classScore: 1, examScore: 1, previous: { classScore: null, examScore: null } },
        { studentId: 2, classScore: 25, examScore: 60, previous: { classScore: 20.5, examScore: 50 } },
      ],
    });
    expect(out.saved).toBe(2);
    expect(StudentMarks.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { class: "Basic 4", termId: 5, subjectId: 100, studentId: [1, 2] },
        transaction: tx,
        lock: "UPDATE",
      })
    );
    // `previous` isn't passed on to the write.
    expect(saveClassSubjectScores.mock.calls[0][0].scores[1]).toEqual({ studentId: 2, classScore: 25, examScore: 60 });
  });

  it("409 naming the pupils whose mark changed since; nothing saved", async () => {
    const write = jest.fn();
    saveClassSubjectScores.mockImplementation(async ({ checkBefore }) => {
      await checkBefore(tx);
      write();
    });
    const err = await saveOfficeSheet(admin, {
      classId: 1,
      subjectId: 100,
      scores: [
        { studentId: 1, classScore: 1, examScore: 1, previous: { classScore: 3, examScore: 4 } }, // has no mark now
        { studentId: 2, classScore: 25, examScore: 60, previous: { classScore: 20, examScore: 50 } }, // now 20.5
      ],
    }).catch((e) => e);
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/Ama Boateng, Kofi Mensah changed since/);
    expect(write).not.toHaveBeenCalled();
  });

  it("rows without `previous` are not checked (older pages)", async () => {
    await saveOfficeSheet(admin, { classId: 1, subjectId: 100, scores: [{ studentId: 2, classScore: 1, examScore: 1 }] });
    expect(StudentMarks.findAll.mock.calls.filter(([o]) => o.transaction)).toEqual([]); // only the refresh read
  });
});

it("a failed refresh after the commit still reports the save (sheet: null), not an error", async () => {
  StudentMarks.findAll.mockRejectedValue(new Error("connection reset"));
  const out = await saveOfficeSheet(admin, { classId: 1, subjectId: 100, scores: [{ studentId: 1, classScore: 1, examScore: 1 }] });
  expect(out).toEqual({ saved: 1, skipped: 1, sheet: null });
});
