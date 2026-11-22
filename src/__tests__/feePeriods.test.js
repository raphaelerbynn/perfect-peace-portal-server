// Fee periods (migration 008): balances carry over from the live system.
// In-memory pupil / fees / payments; the transaction mock just runs the callback.
jest.mock("../config/database.js", () => ({ __esModule: true, default: { transaction: jest.fn(), query: jest.fn() } }));
jest.mock("../models/index.js", () => ({
  __esModule: true,
  Class: { findOne: jest.fn() },
  ClassFee: { findAll: jest.fn() },
  StudentFee: { findAll: jest.fn() },
  Fee: { findAll: jest.fn(), findOne: jest.fn(), destroy: jest.fn(), create: jest.fn() },
  FeeCheck: { findAll: jest.fn() },
  Student: { findOne: jest.fn(), update: jest.fn() },
}));

import sequelize from "../config/database.js";
import { ClassFee, Fee, Student, StudentFee } from "../models/index.js";
import { recomputeStudentOwing, removeFee, startFeePeriod } from "../services/fee.js";

let pupil;
let classFees; // classId -> [amount]
let payments; // [{ feeId, studentId, paid }]

beforeEach(() => {
  jest.resetAllMocks();
  // Go-live: live said Kwame owes 400 and has paid 500 this year; his class bill is 900;
  // the last payment on the live system had fee_id 10.
  pupil = { studentId: 1, classId: 1, feesOwing: 400, feesPaid: 500, feesOpeningBalance: 400, feesBillAtStart: 900, feesPaidAtStart: 500, feesPeriodAfterFeeId: 10 };
  classFees = { 1: [900], 2: [1200] };
  payments = [
    { feeId: 3, studentId: 1, paid: 300 }, // live years ago
    { feeId: 9, studentId: 1, paid: 500 }, // live this year
  ];
  sequelize.transaction.mockImplementation(async (cb) => cb({ LOCK: { UPDATE: "UPDATE" } }));
  sequelize.query.mockImplementation(async () => [[{ maxId: Math.max(0, ...payments.map((p) => p.feeId)) }]]);
  Student.findOne.mockImplementation(async () => ({ ...pupil }));
  Student.update.mockImplementation(async (patch) => Object.assign(pupil, patch));
  ClassFee.findAll.mockImplementation(async ({ where }) => (classFees[where.classId] || []).map((amount) => ({ amount })));
  StudentFee.findAll.mockResolvedValue([]);
  Fee.findAll.mockImplementation(async ({ where }) => {
    const after = Object.getOwnPropertySymbols(where.feeId).map((s) => where.feeId[s])[0];
    return payments.filter((p) => p.studentId === where.studentId && p.feeId > after);
  });
  Fee.findOne.mockImplementation(async ({ where }) => payments.find((p) => p.feeId === Number(where.feeId)) || null);
  Fee.destroy.mockImplementation(async ({ where }) => {
    const before = payments.length;
    payments = payments.filter((x) => x.feeId !== Number(where.feeId));
    return before - payments.length;
  });
});

it("go-live changes nobody's balance (old payments are NOT credited again)", async () => {
  expect(await recomputeStudentOwing(1)).toEqual({ billed: 900, paid: 500, owing: 400 });
  // (the old formula gave 900 - (300 + 500) = 100)
});

it("a new payment lowers the balance; paid keeps the live figure plus new payments", async () => {
  payments.push({ feeId: 11, studentId: 1, paid: 150 });
  expect(await recomputeStudentOwing(1)).toEqual({ billed: 900, paid: 650, owing: 250 });
});

it("a fee added to the class after go-live is added to what is owed", async () => {
  classFees[1].push(100);
  expect((await recomputeStudentOwing(1)).owing).toBe(500);
});

it("correcting the pupil's class swaps the old bill for the new one (same period)", async () => {
  pupil.classId = 2; // 1200 instead of 900
  expect((await recomputeStudentOwing(1)).owing).toBe(700);
});

it("deleting a payment made before go-live puts it back on the balance", async () => {
  await removeFee(9);
  expect(pupil).toMatchObject({ feesOpeningBalance: 900, feesPaidAtStart: 0, feesOwing: 900, feesPaid: 0 });
});

it("deleting a new payment takes it out of the period's payments", async () => {
  payments.push({ feeId: 11, studentId: 1, paid: 150 });
  await recomputeStudentOwing(1);
  await removeFee(11);
  expect(pupil).toMatchObject({ feesOpeningBalance: 400, feesOwing: 400, feesPaid: 500 });
});

it("promotion starts a new period: arrears carry over, then the new class's bill is added, paid restarts", async () => {
  const out = await startFeePeriod(1);
  expect(out).toEqual({ arrears: 400, afterFeeId: 9 });
  expect(pupil).toMatchObject({ feesOpeningBalance: 400, feesBillAtStart: 0, feesPaidAtStart: 0, feesPeriodAfterFeeId: 9 });
  pupil.classId = 2; // moved up
  expect(await recomputeStudentOwing(1)).toEqual({ billed: 1200, paid: 0, owing: 1600 });
  // a payment in the new year
  payments.push({ feeId: 12, studentId: 1, paid: 600 });
  expect(await recomputeStudentOwing(1)).toEqual({ billed: 1200, paid: 600, owing: 1000 });
});

it("a new pupil (no period set up) is simply bill - payments", async () => {
  pupil = { studentId: 1, classId: 1, feesOpeningBalance: 0, feesBillAtStart: 0, feesPaidAtStart: 0, feesPeriodAfterFeeId: 0 };
  payments = [{ feeId: 20, studentId: 1, paid: 200 }];
  expect(await recomputeStudentOwing(1)).toEqual({ billed: 900, paid: 200, owing: 700 });
});

it("a pupil in credit at go-live keeps the credit, and it comes off next year's bill", async () => {
  // Live data: a pupil 938 in credit (overpaid). A recompute must not wipe it.
  Object.assign(pupil, { feesOwing: -938, feesPaid: 1732, feesOpeningBalance: -938, feesBillAtStart: 900, feesPaidAtStart: 1732 });
  expect((await recomputeStudentOwing(1)).owing).toBe(-938);
  // Promotion: the credit carries over as a negative opening balance.
  await startFeePeriod(1);
  pupil.classId = 2; // GH₵1200 class
  expect((await recomputeStudentOwing(1)).owing).toBe(262);
});

it("deleting a payment that doesn't exist is a 404 and changes nothing", async () => {
  await expect(removeFee(99)).rejects.toMatchObject({ statusCode: 404 });
  await expect(removeFee("abc")).rejects.toMatchObject({ statusCode: 404 });
  expect(Fee.destroy).not.toHaveBeenCalled();
});

it("deleting the same old payment twice (double click) puts it back on the balance only once", async () => {
  Fee.findOne.mockResolvedValue({ feeId: 9, studentId: 1, paid: 500 }); // both requests read it
  await removeFee(9);
  await expect(removeFee(9)).rejects.toMatchObject({ statusCode: 404 }); // the second deletes nothing
  expect(pupil).toMatchObject({ feesOpeningBalance: 900, feesOwing: 900 });
});
