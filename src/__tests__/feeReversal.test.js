// B13: receipts + payment reversal. Models mocked, no DB.
jest.mock("../config/database.js", () => ({
  __esModule: true,
  default: { transaction: jest.fn(async (cb) => cb({})) },
}));

jest.mock("../models/index.js", () => ({
  __esModule: true,
  ClassFee: { findAll: jest.fn() },
  StudentFee: { findAll: jest.fn() },
  Fee: { findAll: jest.fn(), create: jest.fn(), findOne: jest.fn(), update: jest.fn() },
  FeeCheck: { findOne: jest.fn() },
  Term: { findOne: jest.fn(async () => ({ termId: 15, term: "1" })) },
  Class: { findOne: jest.fn() },
  Student: { findOne: jest.fn(), update: jest.fn() },
}));

import { createFee, getLastFee, getOneFee, recomputeStudentOwing, reverseFee } from "../services/fee.js";
import { ClassFee, Class, Fee, Student, StudentFee, Term } from "../models/index.js";
import sequelize from "../config/database.js";

const payment = (over = {}) => ({
  feeId: 7, studentId: 1, paid: "200", receiptNo: "PPS-2026-000007", reversedAt: null, ...over,
});

beforeEach(() => {
  jest.resetAllMocks();
  sequelize.transaction.mockImplementation(async (cb) => cb({}));
  Student.findOne.mockResolvedValue({ studentId: 1, classId: 10 });
  ClassFee.findAll.mockResolvedValue([{ amount: 900 }]);
  StudentFee.findAll.mockResolvedValue([]);
  Fee.findAll.mockResolvedValue([{ paid: 500 }]);
  Student.update.mockResolvedValue([1]);
});

describe("recomputeStudentOwing", () => {
  it("only sums payments that are not reversed", async () => {
    await recomputeStudentOwing(1);
    expect(Fee.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ studentId: 1, reversedAt: null }) })
    );
  });
});

describe("reverseFee", () => {
  it.each([undefined, "", "   ", "oops"])("rejects a missing/too-short reason (%p) with 400", async (reason) => {
    await expect(reverseFee(7, { reason })).rejects.toMatchObject({ statusCode: 400 });
    expect(Fee.update).not.toHaveBeenCalled();
  });

  it("rejects a reason over 500 characters", async () => {
    await expect(reverseFee(7, { reason: "x".repeat(501) })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("404 for an unknown payment", async () => {
    Fee.findOne.mockResolvedValue(null);
    await expect(reverseFee(99, { reason: "Wrong student" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("409 when the payment is already reversed", async () => {
    Fee.findOne.mockResolvedValue(payment({ reversedAt: new Date() }));
    await expect(reverseFee(7, { reason: "Wrong student" })).rejects.toMatchObject({ statusCode: 409 });
    expect(Fee.update).not.toHaveBeenCalled();
  });

  it("409 when someone else reverses it between the read and the update (atomic claim)", async () => {
    Fee.findOne.mockResolvedValue(payment());
    Fee.update.mockResolvedValue([0]);
    await expect(reverseFee(7, { reason: "Wrong student" })).rejects.toMatchObject({ statusCode: 409 });
    expect(Student.update).not.toHaveBeenCalled(); // balance untouched
  });

  it("marks the row reversed (never deletes it), records who and why, and recomputes the balance", async () => {
    Fee.findOne
      .mockResolvedValueOnce(payment())
      .mockResolvedValueOnce(payment({ reversedAt: new Date(), reversedBy: "admin", reversalReason: "Wrong student" }));
    Fee.update.mockResolvedValue([1]);
    Fee.findAll.mockResolvedValue([]); // the only payment is now reversed

    const result = await reverseFee(7, { reason: "  Wrong student  ", reversedBy: "admin" });

    expect(Fee.update).toHaveBeenCalledWith(
      expect.objectContaining({ reversedBy: "admin", reversalReason: "Wrong student", reversedAt: expect.any(Date) }),
      expect.objectContaining({ where: { feeId: 7, reversedAt: null } })
    );
    expect(Student.update).toHaveBeenCalledWith(
      { feesPaid: 0, feesOwing: 900 },
      expect.objectContaining({ where: { studentId: 1 } })
    );
    expect(result).toMatchObject({ receiptNo: "PPS-2026-000007", reversedBy: "admin", owing: 900 });
  });
});

describe("createFee", () => {
  it("records who took the payment and never sets the receipt number itself", async () => {
    Fee.findAll.mockResolvedValue([]); // owing 900
    Fee.create.mockResolvedValue({ toJSON: () => ({ feeId: 8, receiptNo: "PPS-2026-000008", paid: 100 }) });

    Term.findOne.mockResolvedValue({ termId: 15, term: "1" });
    const result = await createFee({ studentId: 1, currentPaid: 100 }, { recordedBy: "accountant1" });

    const [values] = Fee.create.mock.calls[0];
    expect(values.recordedBy).toBe("accountant1");
    expect(values.termId).toBe(15); // counts toward the open term (Fees page totals by term)
    expect(values.term).toBe("1");
    expect(values).not.toHaveProperty("receiptNo");
    expect(result.receiptNo).toBe("PPS-2026-000008");
  });
});

describe("getOneFee (receipt)", () => {
  it("returns the payment with student name, index number and class name", async () => {
    Fee.findOne.mockResolvedValue({ ...payment(), classId: 10 });
    Student.findOne.mockResolvedValue({ studentId: 1, fName: "Kwame", mName: null, lName: "Boateng", class: "JHS 1", feesOwing: "400" });
    Class.findOne.mockResolvedValue({ classId: 10, name: "JHS 1" });

    const r = await getOneFee(7);
    expect(r).toMatchObject({ receiptNo: "PPS-2026-000007", studentName: "Kwame Boateng", indexNumber: "STU/1", className: "JHS 1", currentOwing: 400 });
  });

  it("404 for an unknown payment", async () => {
    Fee.findOne.mockResolvedValue(null);
    await expect(getOneFee(1)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("getLastFee (portal 'last payment')", () => {
  it("ignores reversed payments", async () => {
    Fee.findAll.mockResolvedValue([]);
    await getLastFee(1);
    expect(Fee.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { studentId: 1, reversedAt: null } }));
  });
});

describe("getFeesData (admin list)", () => {
  it("returns each payment with the payer's name and class, flattened", async () => {
    const { getFeesData } = require("../services/fee.js");
    Fee.findAll.mockResolvedValue([
      { feeId: 1, paid: "50", student: { fName: "Ama", mName: null, lName: "Owusu" }, class: { name: "KG 1" } },
      { feeId: 2, paid: "60", student: null, class: null },
    ]);
    const rows = await getFeesData({ all: "true" });
    expect(rows).toEqual([
      { feeId: 1, paid: "50", studentName: "Ama Owusu", className: "KG 1" },
      { feeId: 2, paid: "60", studentName: null, className: null },
    ]);
  });
});

// Full-test review findings.
describe("review fixes", () => {
  it("reversal locks the pupil before recomputing (no lost concurrent payment)", async () => {
    sequelize.transaction.mockImplementation(async (cb) => cb({ LOCK: { UPDATE: "UPDATE" } }));
    Fee.findOne.mockResolvedValueOnce(payment()).mockResolvedValueOnce(payment({ reversedAt: new Date() }));
    Fee.update.mockResolvedValue([1]);
    await reverseFee(7, { reason: "Wrong pupil" });
    expect(Student.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { studentId: 1 }, lock: "UPDATE" }));
    const lockOrder = Student.findOne.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(Fee.update.mock.invocationCallOrder[0]);
  });

  it.each(["abc", "7; drop", "", null])("a non-numeric payment id is a 404, not a database error (%p)", async (id) => {
    await expect(reverseFee(id, { reason: "Wrong pupil" })).rejects.toMatchObject({ statusCode: 404 });
    await expect(getOneFee(id)).rejects.toMatchObject({ statusCode: 404 });
    expect(Fee.findOne).not.toHaveBeenCalled();
  });

  it("takes pesewas (migration 012): GH₵ 149.50 is stored as 149.5, not rounded", async () => {
    Fee.create.mockImplementation(async (row) => row);
    const out = await createFee({ studentId: 1, currentPaid: "149.50" });
    expect(Fee.create.mock.calls[0][0]).toMatchObject({ paid: 149.5, remaining: 250.5 });
    expect(out.paid).toBe(149.5);
  });

  it("refuses a third decimal place instead of letting the database round it", async () => {
    await expect(createFee({ studentId: 1, currentPaid: 149.555 })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("2 decimal places"),
    });
    expect(Fee.create).not.toHaveBeenCalled();
  });

  it("balances add up to the pesewa (no 0.1 + 0.2 drift)", async () => {
    ClassFee.findAll.mockResolvedValue([{ amount: 0.1 }, { amount: 0.2 }]);
    Fee.findAll.mockResolvedValue([]);
    await expect(recomputeStudentOwing(1)).resolves.toMatchObject({ billed: 0.3, owing: 0.3 });
  });
});
