// Close term (Part A = the old system's behaviour): after Term 3 results, every
// pupil with a "promoted to" class moves up, all in one transaction with the
// term closing. Each moved pupil starts a new fee period (migration 008): what
// is still owed carries over and the new class's bill is added.
jest.mock("../config/database.js", () => ({ __esModule: true, default: { transaction: jest.fn() } }));
jest.mock("../models/index.js", () => ({
  __esModule: true,
  Term: { findOne: jest.fn(), update: jest.fn() },
  StudentResult: { findAll: jest.fn() },
  KgAssessment: { findAll: jest.fn() },
  Student: { update: jest.fn(), findOne: jest.fn() },
  Class: {},
  ClassFee: {},
  Parent: {},
  StudentFee: {},
  Teacher: {},
}));
jest.mock("../services/classes.js", () => ({ __esModule: true, getClassIdByName: jest.fn() }));
jest.mock("../services/fee.js", () => ({ __esModule: true, startFeePeriod: jest.fn(), recomputeStudentOwing: jest.fn() }));

import sequelize from "../config/database.js";
import { KgAssessment, Student, StudentResult, Term } from "../models/index.js";
import { getClassIdByName } from "../services/classes.js";
import { recomputeStudentOwing, startFeePeriod } from "../services/fee.js";
import { promoteStudents } from "../services/test.js";
import { inactivateTerms } from "../services/term.js";

const T = { id: "tx" };
let calls;
let pupils; // studentId -> current class name

beforeEach(() => {
  jest.resetAllMocks();
  calls = [];
  sequelize.transaction.mockImplementation(async (cb) => cb(T));
  T.LOCK = { UPDATE: "UPDATE" };
  Term.findOne.mockResolvedValue({ termId: 9, term: "3", active: true });
  StudentResult.findAll.mockResolvedValue([
    { studentId: 1, promotedTo: "Basic 5", class: "Basic 4" },
    { studentId: 2, promotedTo: null, class: "Basic 4" }, // no decision: stays
    { studentId: 3, promotedTo: "No Such Class", class: "Basic 4" }, // unknown class: skipped
  ]);
  KgAssessment.findAll.mockResolvedValue([{ studentId: 7, promoted: "KG 2", class: "KG 1" }]);
  pupils = { 1: "Basic 4", 2: "Basic 4", 3: "Basic 4", 7: "KG 1" };
  Student.findOne.mockImplementation(async ({ where }) =>
    pupils[where.studentId] ? { studentId: where.studentId, class: pupils[where.studentId], isDeleted: false } : null
  );
  getClassIdByName.mockImplementation(async (name) => ({ "Basic 5": 15, "KG 2": 22 })[name] ?? null);
  startFeePeriod.mockImplementation(async (id) => calls.push(`period ${id}`));
  Student.update.mockImplementation(async (patch, { where }) => {
    pupils[where.studentId] = patch.class;
    calls.push(`move ${where.studentId} -> ${patch.classId}`);
  });
  recomputeStudentOwing.mockImplementation(async (id) => calls.push(`recompute ${id}`));
  Term.update.mockImplementation(async () => calls.push("close term"));
});

it("promotes from the Term 3 results, then closes the term, in one transaction", async () => {
  Term.findOne.mockImplementation(async (opts) => {
    calls.push(`claim term (lock ${opts.lock})`);
    return { termId: 9, term: "3", active: true };
  });
  const out = await inactivateTerms();
  expect(out).toEqual({ message: "Term closed and students promoted successfully" });
  expect(sequelize.transaction).toHaveBeenCalledTimes(1);
  expect(calls).toEqual([
    "claim term (lock UPDATE)",
    "period 1", "move 1 -> 15", "recompute 1",
    "period 7", "move 7 -> 22", "recompute 7",
    "close term",
  ]);
  expect(Term.update).toHaveBeenCalledWith({ active: false }, { where: {}, transaction: T });
});

it("starts the new fee period BEFORE moving the pupil (arrears from the old class)", async () => {
  await promoteStudents(T);
  expect(startFeePeriod).toHaveBeenCalledWith(1, { transaction: T });
  expect(calls.indexOf("period 1")).toBeLessThan(calls.indexOf("move 1 -> 15"));
});

it("a failure leaves the term open (the transaction rolls back)", async () => {
  Student.update.mockRejectedValueOnce(new Error("db down"));
  await expect(inactivateTerms()).rejects.toThrow("db down");
  expect(Term.update).not.toHaveBeenCalled();
});

it("no open term (e.g. a second Close term at the same moment): 409, nothing moves", async () => {
  Term.findOne.mockResolvedValue(null);
  await expect(inactivateTerms()).rejects.toMatchObject({ statusCode: 409 });
  expect(Student.update).not.toHaveBeenCalled();
});

it("closing again never promotes, or bills, a pupil twice", async () => {
  await promoteStudents(T, { termId: 9 });
  calls = [];
  await promoteStudents(T, { termId: 9 }); // pupils are now in Basic 5 / KG 2
  expect(calls).toEqual([]);
});

it("a pupil with two decisions (class corrected mid-term, or a KG row too) moves once, by the class they are in", async () => {
  StudentResult.findAll.mockResolvedValue([
    { studentId: 1, promotedTo: "Basic 5", class: "Basic 4" },
    { studentId: 1, promotedTo: "Basic 6", class: "Basic 5" },
  ]);
  KgAssessment.findAll.mockResolvedValue([{ studentId: 1, promoted: "KG 2", class: "KG 1" }]);
  getClassIdByName.mockImplementation(async (name) => ({ "Basic 5": 15, "Basic 6": 16, "KG 2": 22 })[name] ?? null);
  await promoteStudents(T, { termId: 9 });
  expect(calls).toEqual(["period 1", "move 1 -> 15", "recompute 1"]);
});

it("archived pupils are not moved", async () => {
  Student.findOne.mockImplementation(async ({ where }) => ({ studentId: where.studentId, class: "Basic 4", isDeleted: true }));
  await promoteStudents(T, { termId: 9 });
  expect(Student.update).not.toHaveBeenCalled();
});
