// B18: adding / editing a pupil with an admission number (services/test.js).
jest.mock("../config/database.js", () => ({
  __esModule: true,
  default: { transaction: jest.fn(async (fn) => fn({ id: "tx" })), query: jest.fn() },
}));
jest.mock("../models/index.js", () => ({
  __esModule: true,
  Class: { findOne: jest.fn(), findAll: jest.fn() },
  ClassFee: {},
  Parent: { create: jest.fn(), update: jest.fn() },
  StudentFee: {},
  Student: { findOne: jest.fn(), create: jest.fn(), update: jest.fn() },
  Teacher: {},
}));
jest.mock("../services/fee.js", () => ({ __esModule: true, recomputeStudentOwing: jest.fn() }));
jest.mock("../services/termBilling.js", () => ({ __esModule: true, tieAdmissionToOpenTerm: jest.fn() }));
jest.mock("../services/school.js", () => ({ __esModule: true, getSchoolSettings: jest.fn() }));
jest.mock("../services/admission.js", () => {
  const actual = jest.requireActual("../services/admission.js");
  return { __esModule: true, ...actual, resolveNewAdmissionNo: jest.fn(), assertAdmissionNoFree: jest.fn() };
});

import { Class, Parent, Student } from "../models/index.js";
import { getSchoolSettings } from "../services/school.js";
import { assertAdmissionNoFree, resolveNewAdmissionNo } from "../services/admission.js";
import { createStudent, editStudent } from "../services/test.js";
import { AppError } from "../utils/errorHandling.js";

const body = { fName: "Kofi", lName: "Asante", dob: "2018-03-02", gender: "Male", class: "Basic 1" };

beforeEach(() => {
  getSchoolSettings.mockResolvedValue({ admissionFormat: "PPS/{YYYY}/{0000}" });
  Class.findOne.mockResolvedValue({ classId: 1 });
  Class.findAll.mockResolvedValue([{ dataValues: { classId: 1 } }]);
  Student.findOne.mockResolvedValue(null);
  Parent.create.mockResolvedValue({ dataValues: { parentId: 5 } });
  Student.create.mockImplementation(async (v) => ({ dataValues: { studentId: 9, ...v } }));
});

describe("createStudent", () => {
  it("takes the next number from the school's format inside the same transaction", async () => {
    resolveNewAdmissionNo.mockResolvedValue("PPS/2026/0001");
    await createStudent({ ...body, admissionNo: "" });
    expect(resolveNewAdmissionNo).toHaveBeenCalledWith("", { format: "PPS/{YYYY}/{0000}", transaction: { id: "tx" } });
    expect(Student.create.mock.calls[0][0]).toMatchObject({ admissionNo: "PPS/2026/0001" });
  });

  it("a clash stops the pupil being created (409)", async () => {
    resolveNewAdmissionNo.mockRejectedValue(new AppError("Admission number X is already used", 409));
    await expect(createStudent({ ...body, admissionNo: "X" })).rejects.toMatchObject({ statusCode: 409 });
    expect(Student.create).not.toHaveBeenCalled();
    expect(Parent.create).not.toHaveBeenCalled();
  });
});

describe("editStudent", () => {
  beforeEach(() => Student.findOne.mockResolvedValue({ studentId: 9, classId: 1, parentId: 5, admissionNo: "PPS/2026/0001" }));

  it("blank keeps the number (old forms don't send it)", async () => {
    await editStudent({ ...body }, 9);
    expect(Student.update.mock.calls[0][0].admissionNo).toBeUndefined();
    expect(assertAdmissionNoFree).not.toHaveBeenCalled();
  });

  // Decision (B18 review): a number can be changed but never removed, so it is
  // never handed out twice. The edit form says "Leave blank to keep <number>".
  it.each([["empty", ""], ["spaces", "   "], ["null", null]])("an %s admission number keeps the current one", async (_l, v) => {
    await editStudent({ ...body, admissionNo: v }, 9);
    expect(Student.update.mock.calls[0][0]).not.toHaveProperty("admissionNo");
    expect(assertAdmissionNoFree).not.toHaveBeenCalled();
  });

  it("a new number is checked against other pupils, then saved", async () => {
    await editStudent({ ...body, admissionNo: " PPS/OLD/12 " }, 9);
    expect(assertAdmissionNoFree).toHaveBeenCalledWith("PPS/OLD/12", { exceptStudentId: 9 });
    expect(Student.update.mock.calls[0][0].admissionNo).toBe("PPS/OLD/12");
  });

  it("same number, different case: no clash check", async () => {
    await editStudent({ ...body, admissionNo: "pps/2026/0001" }, 9);
    expect(assertAdmissionNoFree).not.toHaveBeenCalled();
  });

  it("taken by someone else: 409, nothing written", async () => {
    assertAdmissionNoFree.mockRejectedValue(new AppError("taken", 409));
    await expect(editStudent({ ...body, admissionNo: "PPS/2026/0002" }, 9)).rejects.toMatchObject({ statusCode: 409 });
    expect(Student.update).not.toHaveBeenCalled();
  });
});
