// Feature #10 (Fees): owing is recomputed from source rows and CLAMPED at 0,
// and a payment that exceeds the outstanding balance is rejected (400).
// Models are mocked so no DB is required.

jest.mock("../config/database.js", () => ({
  __esModule: true,
  // transaction(cb) just runs the callback with a dummy tx object.
  default: { transaction: jest.fn(async (cb) => cb({})) },
}));

jest.mock("../models/index.js", () => ({
  __esModule: true,
  ClassFee: { findAll: jest.fn() },
  StudentFee: { findAll: jest.fn() },
  Fee: { findAll: jest.fn(), create: jest.fn(), findOne: jest.fn() },
  FeeCheck: { findOne: jest.fn() },
  Student: { findOne: jest.fn(), update: jest.fn() },
}));

import { recomputeStudentOwing, createFee } from "../services/fee.js";
import { ClassFee, StudentFee, Fee, Student } from "../models/index.js";

const billed = (classAmts, studentAmts) => {
  ClassFee.findAll.mockResolvedValue(classAmts.map((amount) => ({ amount })));
  StudentFee.findAll.mockResolvedValue(studentAmts.map((amount) => ({ amount })));
};
const paid = (amts) => Fee.findAll.mockResolvedValue(amts.map((p) => ({ paid: p })));

describe("recomputeStudentOwing", () => {
  it("computes owing = billed − paid and writes feesPaid/feesOwing", async () => {
    Student.findOne.mockResolvedValue({ studentId: 1, classId: 10 });
    billed([300], [100]); // billed = 400
    paid([150, 50]); // paid = 200
    Student.update.mockResolvedValue([1]);

    const result = await recomputeStudentOwing(1);
    expect(result).toEqual({ billed: 400, paid: 200, owing: 200 });
    expect(Student.update).toHaveBeenCalledWith(
      { feesPaid: 200, feesOwing: 200 },
      expect.objectContaining({ where: { studentId: 1 } })
    );
  });

  it("clamps owing at 0 when the student has over-paid (no negative balance)", async () => {
    Student.findOne.mockResolvedValue({ studentId: 2, classId: 10 });
    billed([300], []); // billed = 300
    paid([500]); // paid = 500 (over-collection)
    Student.update.mockResolvedValue([1]);

    const result = await recomputeStudentOwing(2);
    expect(result.owing).toBe(0); // clamped, not -200
    expect(result.paid).toBe(500); // true total paid still visible
  });

  it("returns null when the student does not exist", async () => {
    Student.findOne.mockResolvedValue(null);
    expect(await recomputeStudentOwing(404)).toBeNull();
  });
});

describe("createFee overpayment guard", () => {
  beforeEach(() => {
    // Student exists for both the existence check and the recompute read.
    Student.findOne.mockResolvedValue({ studentId: 1, classId: 10 });
    Student.update.mockResolvedValue([1]);
  });

  it("rejects a payment larger than the outstanding balance with 400", async () => {
    billed([300], []); // billed 300
    paid([100]); // paid 100 => owing 200
    await expect(
      createFee({ studentId: 1, currentPaid: 250 })
    ).rejects.toEqual(expect.objectContaining({ statusCode: 400 }));
    expect(Fee.create).not.toHaveBeenCalled();
  });

  it("rejects a non-positive / NaN payment amount with 400", async () => {
    await expect(
      createFee({ studentId: 1, currentPaid: -5 })
    ).rejects.toEqual(expect.objectContaining({ statusCode: 400 }));
    await expect(
      createFee({ studentId: 1, currentPaid: "abc" })
    ).rejects.toEqual(expect.objectContaining({ statusCode: 400 }));
  });

  it("accepts a payment within the balance and persists it", async () => {
    billed([300], []); // billed 300
    paid([100]); // paid 100 => owing 200
    Fee.create.mockResolvedValue({ toJSON: () => ({ id: 99, paid: 150 }) });

    const result = await createFee({ studentId: 1, currentPaid: 150 });
    expect(Fee.create).toHaveBeenCalled();
    // owing surfaced from the post-payment recompute (still 200 here because the
    // mocked Fee.findAll is static, but the field must be present for the SMS).
    expect(result).toHaveProperty("owing");
    expect(result).toHaveProperty("feesPaid");
  });
});
