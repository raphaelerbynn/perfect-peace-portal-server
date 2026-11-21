// B2: saveClassSubjectScores (results service), one subject for a whole class.
jest.mock("../config/database.js", () => ({
  __esModule: true,
  default: { transaction: jest.fn(async (cb) => cb({})) },
}));
jest.mock("../models/index.js", () => ({
  __esModule: true,
  KgAssessment: {},
  Student: { count: jest.fn(), findOne: jest.fn() },
  StudentMarks: { findOne: jest.fn(), create: jest.fn(), update: jest.fn(), findByPk: jest.fn(), findAll: jest.fn() },
  StudentResult: { findOne: jest.fn(), create: jest.fn() },
  Subject: { findOne: jest.fn(), findAll: jest.fn() },
}));
jest.mock("../services/term.js", () => ({ __esModule: true, getTerm: jest.fn() }));
// B8: grade with the built-in bands (the grading service has its own tests).
jest.mock("../services/grading.js", () => {
  const actual = jest.requireActual("../services/grading.js");
  return { ...actual, makeGrader: () => async (score) => actual.resolveGrade(score, actual.DEFAULT_PRIMARY_BANDS) };
});

import sequelize from "../config/database.js";
import { StudentMarks, StudentResult, Student, Subject } from "../models/index.js";
import { saveClassSubjectScores } from "../services/results.js";

const MATHS = { subjectId: 100, name: "Maths", classTotalMarks: 30, examTotalMarks: 70, classPercentage: 30, examPercentage: 70, passMarks: 40 };

beforeEach(() => {
  jest.resetAllMocks();
  sequelize.transaction.mockImplementation(async (cb) => cb({}));
  Subject.findOne.mockResolvedValue(MATHS);
  Subject.findAll.mockResolvedValue([MATHS]);
  StudentMarks.findOne.mockResolvedValue(null);
  StudentMarks.create.mockImplementation(async (row) => row);
  StudentMarks.findAll.mockResolvedValue([{ subjectId: 100, totalScore: 70 }]);
  Student.count.mockResolvedValue(30);
  StudentResult.findOne.mockResolvedValue(null);
  StudentResult.create.mockResolvedValue({});
});

it("saves entered rows in one transaction, skips blank ones, records who", async () => {
  const out = await saveClassSubjectScores({
    className: "JHS 1",
    subjectId: 100,
    term: "1",
    termId: 5,
    scores: [
      { studentId: 1, classScore: 30, examScore: 0 },
      { studentId: 2, classScore: "", examScore: null },
    ],
    enteredBy: "Kofi Mensah",
    enteredByTeacherId: 11,
  });
  expect(out).toEqual({ saved: 1, skipped: 1 });
  expect(sequelize.transaction).toHaveBeenCalledTimes(1);
  expect(StudentMarks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      studentId: 1,
      subjectId: 100,
      class: "JHS 1",
      termId: 5,
      classScore: 30,
      examScore: 0, // 0 is a score
      totalScore: 30,
      enteredBy: "Kofi Mensah",
      enteredByTeacherId: 11,
    }),
    expect.anything()
  );
  expect(StudentResult.create).toHaveBeenCalledTimes(1); // aggregate recomputed for pupil 1 only
});

it("refuses when no term is open", async () => {
  await expect(saveClassSubjectScores({ className: "JHS 1", subjectId: 100, scores: [] })).rejects.toMatchObject({ statusCode: 409 });
});

it("locks each pupil before totalling, in pupil-id order (concurrent sheets can't drop a subject or deadlock)", async () => {
  sequelize.transaction.mockImplementation(async (cb) => cb({ LOCK: { UPDATE: "UPDATE" } }));
  await saveClassSubjectScores({
    className: "JHS 1", subjectId: 100, term: "1", termId: 5, enteredBy: "t",
    scores: [{ studentId: 9, classScore: 20, examScore: 50 }, { studentId: 2, classScore: 20, examScore: 50 }],
  });
  const locked = Student.findOne.mock.calls.filter(([o]) => o.lock === "UPDATE").map(([o]) => o.where.studentId);
  expect(locked).toEqual([2, 9]);
});

it("checkBefore (B6 office sheet) runs first in the same transaction; if it refuses, nothing is written", async () => {
  const tx = { LOCK: { UPDATE: "UPDATE" } };
  sequelize.transaction.mockImplementation(async (cb) => cb(tx));
  const checkBefore = jest.fn(async () => {
    throw Object.assign(new Error("stale"), { statusCode: 409 });
  });
  await expect(
    saveClassSubjectScores({
      className: "JHS 1", subjectId: 100, term: "1", termId: 5, enteredBy: "t", checkBefore,
      scores: [{ studentId: 1, classScore: 20, examScore: 50 }],
    })
  ).rejects.toThrow("stale");
  expect(checkBefore).toHaveBeenCalledWith(tx);
  expect(StudentMarks.create).not.toHaveBeenCalled();
  expect(StudentMarks.update).not.toHaveBeenCalled();
});
