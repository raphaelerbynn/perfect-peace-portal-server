// B12 per-year fee option (client 2026-11-17, migration 048): a class fee item
// entered per YEAR is billed across the year's terms. In-memory tables
// (testSupport/fakeTable); the real fee.js / termBilling.js / classes.js run.
jest.mock("../config/database.js", () => ({
  __esModule: true,
  default: { transaction: jest.fn(), query: jest.fn() },
}));
jest.mock("../models/index.js", () => {
  const m = () => ({ findAll: jest.fn(), findOne: jest.fn(), create: jest.fn(), update: jest.fn(), destroy: jest.fn(), count: jest.fn() });
  return {
    __esModule: true,
    AcademicYear: m(),
    Class: m(),
    ClassFee: m(),
    DiscountType: m(),
    Fee: m(),
    FeeCheck: m(),
    Parent: m(),
    Student: m(),
    StudentDiscount: m(),
    StudentFee: m(),
    StudentPromotion: m(),
    StudentTermBill: m(),
    Invoice: m(),
    InvoiceLine: m(),
    CreditNote: m(),
    Teacher: m(),
    TeachingAssignment: m(),
    Term: m(),
  };
});

import sequelize from "../config/database.js";
import * as models from "../models/index.js";
import { fakeTable } from "../testSupport/fakeTable.js";
import { createFee, recomputeStudentOwing, startFeePeriod } from "../services/fee.js";
import { billClassForTerm, previewTermBilling, tieAdmissionToOpenTerm } from "../services/termBilling.js";
import { editClassFee, createClassFee } from "../services/classes.js";
import { getStatement } from "../services/feeStatement.js";
import { invoiceLines } from "../services/invoices.js";
import {
  applyPupilShares,
  annotateClassFeeList,
  classFeeItem,
  cedis,
  splitYearly,
  termPosition,
  yearlyLabel,
} from "../services/classFeeShare.js";

const { ClassFee, Student, StudentTermBill, Term } = models;
const T = { LOCK: { UPDATE: "UPDATE" } };
let db;

// 2026/2027: Term 1 (termId 2) is open and billed; Term 2 (3) and Term 3 (4)
// to come. BASIC 1: Tuition is per YEAR (GH₵ 1,000), Feeding per term (200).
const seed = () => {
  db = {
    terms: [
      { termId: 1, term: "3", startDate: "2026-04-27", endDate: "2026-07-24", active: false, academicYearId: 1 },
      { termId: 2, term: "1", startDate: "2026-09-07", endDate: "2026-12-17", active: true, academicYearId: 2 },
      { termId: 3, term: "2", startDate: "2027-01-11", endDate: "2027-04-01", active: false, academicYearId: 2 },
      { termId: 4, term: "3", startDate: "2027-04-26", endDate: "2027-07-23", active: false, academicYearId: 2 },
    ],
    classes: [
      { classId: 1, name: "BASIC 1", isAlumni: false, isDeleted: false },
      { classId: 2, name: "BASIC 2", isAlumni: false, isDeleted: false },
    ],
    classFees: [
      // Term 1 was billed its share (333) of the yearly 1000.
      { classFeeId: 1, classId: 1, name: "Tuition", amount: "1000.00", period: "YEAR", termAmounts: { 2: { period: "YEAR", amount: 333, yearly: 1000, no: 1, of: 3 } } },
      { classFeeId: 2, classId: 1, name: "Feeding", amount: "200.00", period: "TERM", termAmounts: {} },
      { classFeeId: 3, classId: 2, name: "Tuition", amount: "900.00", period: "TERM", termAmounts: {} },
    ],
    studentFees: [],
    // Ama owes her whole Term 1 bill (333 + 200); Kofi is 600 in credit.
    students: [pupil(1, "Ama", 533), pupil(2, "Kofi", -600)],
    fees: [{ feeId: 10, studentId: 1, paid: "1.00", reversedAt: null }],
    types: [
      { discountTypeId: 1, name: "Staff child", kind: "PERCENT", value: "50.00", appliesTo: "Tuition", isActive: true },
      { discountTypeId: 2, name: "Sibling", kind: "FIXED", value: "100.00", appliesTo: null, isActive: true },
    ],
    given: [],
    bills: [],
    promotions: [],
    years: [{ academicYearId: 2, name: "2026/2027" }],
  };
  fakeTable(models.AcademicYear, db.years, "academicYearId");
  fakeTable(Term, db.terms, "termId");
  fakeTable(models.Class, db.classes, "classId");
  fakeTable(ClassFee, db.classFees, "classFeeId");
  fakeTable(models.StudentFee, db.studentFees, "studentFeeId");
  fakeTable(Student, db.students, "studentId");
  fakeTable(models.Fee, db.fees, "feeId");
  fakeTable(models.DiscountType, db.types, "discountTypeId");
  fakeTable(models.StudentDiscount, db.given, "studentDiscountId");
  fakeTable(StudentTermBill, db.bills, "studentTermBillId");
  fakeTable(models.Invoice, [], "invoiceId");
  fakeTable(models.CreditNote, [], "creditNoteId");
  fakeTable(models.StudentPromotion, db.promotions, "studentPromotionId");
};
function pupil(studentId, fName, owing) {
  return {
    studentId, fName, lName: "Mensah", classId: 1, isDeleted: false,
    feesOwing: owing, feesPaid: 0, feesOpeningBalance: owing, feesBillAtStart: 533, feesPaidAtStart: 0,
    feesPeriodAfterFeeId: 10, feesPeriodStartedAt: "2026-09-20T10:00:00Z", feesPeriodTermId: 2,
  };
}
const S = (id) => db.students.find((s) => s.studentId === id);
const fee = (id) => db.classFees.find((f) => f.classFeeId === id);
const setToday = (d) => jest.setSystemTime(new Date(`${d}T09:00:00Z`));
const open = (termId) => db.terms.forEach((t) => (t.active = t.termId === termId));
const confirm = async (termId, classId = 1) => {
  const p = await previewTermBilling(termId, { classId });
  return billClassForTerm({ termId, classId, expectedCount: p.expectedCount, expectedTotal: p.expectedTotal }, { billedBy: "bursar" });
};
// Term 2 is open; Term 3 is the next term to start.
const moveToTerm2 = () => {
  setToday("2027-02-01");
  open(3);
};

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"], now: new Date("2026-11-13T09:00:00Z") });
});
afterAll(() => jest.useRealTimers());

beforeEach(() => {
  jest.clearAllMocks();
  setToday("2026-11-13");
  seed();
  sequelize.transaction.mockImplementation(async (cb) => cb(T));
  sequelize.query.mockImplementation(async () => [[{ maxId: Math.max(0, ...db.fees.map((f) => f.feeId)) }]]);
});

// ---------------------------------------------------------------------------------
describe("splitting a yearly amount", () => {
  it("equal whole-cedi shares, the remainder on the last term; the year adds up exactly", () => {
    expect(splitYearly(1000, 3)).toEqual([333, 333, 334]);
    expect(splitYearly(1500, 3)).toEqual([500, 500, 500]);
    expect(splitYearly(100, 3)).toEqual([33, 33, 34]);
    expect(splitYearly("1000.50", 3)).toEqual([333, 333, 334.5]);
    expect(splitYearly(1001, 2)).toEqual([500, 501]);
    expect(splitYearly(1000, 4)).toEqual([250, 250, 250, 250]);
    for (const [a, n] of [[1000, 3], [77, 3], [1234.56, 3], [5, 4], [2, 3]]) {
      const parts = splitYearly(a, n);
      expect(parts).toHaveLength(n);
      expect(Math.round(parts.reduce((x, y) => x + y, 0) * 100)).toBe(Math.round(a * 100));
      parts.slice(0, -1).forEach((p) => expect(Number.isInteger(p)).toBe(true));
    }
  });

  it("which share a term gets: its number; 3 terms assumed until the year has 3", () => {
    expect(termPosition(db.terms[2], db.terms)).toEqual({ n: 3, index: 1, no: 2, assumed: false });
    // Only Term 1 recorded yet: 3 assumed.
    expect(termPosition(db.terms[1], [db.terms[1]])).toMatchObject({ n: 3, index: 0, assumed: true });
    // A four-term year.
    const four = [...db.terms, { termId: 9, term: "4", startDate: "2027-08-01", academicYearId: 2 }];
    expect(termPosition(four[4], four)).toMatchObject({ n: 4, index: 3, assumed: false });
    // No usable number: by date within the year.
    const odd = db.terms.map((t) => ({ ...t, term: "x" }));
    expect(termPosition(odd[3], odd)).toMatchObject({ index: 2 });
    // A period no term has claimed yet: the first share.
    expect(termPosition(null)).toMatchObject({ n: 3, index: 0, untied: true });
  });

  it("labels the line in plain words", () => {
    expect(yearlyLabel("Tuition", 1500, 2)).toBe("Tuition (yearly GH₵ 1,500 — Term 2 share)");
    expect(yearlyLabel("Tuition", 1000.5, null)).toBe("Tuition (yearly GH₵ 1,000.50 — one term's share)");
    expect(cedis(1234567)).toBe("1,234,567");
    expect(classFeeItem(fee(1), db.terms[3], db.terms)).toMatchObject({ name: "Tuition", amount: 334, period: "YEAR", yearly: 1000, shareNo: 3, label: "Tuition (yearly GH₵ 1,000 — Term 3 share)" });
    // TERM items keep their exact old shape.
    expect(classFeeItem(fee(2), db.terms[3], db.terms)).toEqual({ name: "Feeding", amount: 200, source: "CLASS" });
  });
});

// ---------------------------------------------------------------------------------
describe("billing the terms of a year", () => {
  it("each term bills its share; over the year Tuition comes to exactly 1000", async () => {
    // Recompute on Term 1: the frozen 333 + 200, nothing moves.
    await recomputeStudentOwing(1, { transaction: T });
    expect(S(1).feesOwing).toBe(533);

    const p = await previewTermBilling(3, { classId: 1 });
    expect(p).toMatchObject({ toBill: 2, billTotal: 1066, arrearsTotal: -67 });
    expect(p.rows[0].items[0]).toMatchObject({ amount: 333, label: "Tuition (yearly GH₵ 1,000 — Term 2 share)" });
    await confirm(3);
    expect(S(1).feesOwing).toBe(1066);
    expect(fee(1).termAmounts["3"]).toMatchObject({ period: "YEAR", amount: 333, no: 2, of: 3 });
    expect(db.bills[0].items[0]).toMatchObject({ name: "Tuition", amount: 333, period: "YEAR", yearly: 1000, shareNo: 2 });

    moveToTerm2();
    await confirm(4);
    expect(S(1).feesOwing).toBe(1600); // 533 + 533 + 534: Tuition 333 + 333 + 334 = 1000
    expect(db.bills.filter((b) => b.studentId === 1).map((b) => b.items[0].amount)).toEqual([333, 334]);
  });

  it("billing the same term again never bills a yearly share twice", async () => {
    await confirm(3);
    const before = JSON.stringify(fee(1).termAmounts);
    const again = await confirm(3);
    expect(again).toMatchObject({ billed: 0, adopted: 0 });
    expect(S(1).feesOwing).toBe(1066);
    expect(db.bills).toHaveLength(2);
    expect(JSON.stringify(fee(1).termAmounts)).toBe(before);
  });

  it("credit carries in and stays negative (never clamped)", async () => {
    await confirm(3);
    expect(S(2).feesOwing).toBe(-67); // -600 + 533
    expect(db.bills[1]).toMatchObject({ arrears: -600, bill: 533 });
    // Payments still can't take the balance below 0 by overpaying, but the credit is kept.
    await recomputeStudentOwing(2, { transaction: T });
    expect(S(2).feesOwing).toBe(-67);
  });

  it("discounts work on the yearly share exactly as on a term amount", async () => {
    db.given.push({ studentDiscountId: 1, studentId: 1, discountTypeId: 1, fromTermId: 3, toTermId: null, source: "MANUAL" });
    db.given.push({ studentDiscountId: 2, studentId: 2, discountTypeId: 2, fromTermId: 3, toTermId: null, source: "MANUAL" });
    const out = await confirm(3);
    expect(db.bills[0]).toMatchObject({ bill: 533, discount: 166.5, discounts: [{ name: "Staff child", amount: 166.5 }] }); // 50% of 333
    expect(db.bills[1]).toMatchObject({ discount: 100 });
    expect(S(1).feesOwing).toBe(899.5); // 533 + 533 - 166.5
    expect(S(2).feesOwing).toBe(-167);
    expect(out.total).toBe(732.5);
  });

  it("payments on a yearly share work as on any bill", async () => {
    await confirm(3);
    const f = await createFee({ studentId: 1, classId: 1, currentPaid: 66 });
    expect(f.owing).toBe(1000);
  });

  it("the statement and the invoice show the yearly line in plain words", async () => {
    await confirm(3);
    const st = await getStatement(1);
    const cur = st.periods[st.periods.length - 1];
    expect(cur.items[0]).toMatchObject({ amount: 333, label: "Tuition (yearly GH₵ 1,000 — Term 2 share)" });
    expect(st.owing).toBe(1066);
    const inv = invoiceLines({ arrears: 533, items: cur.items, discountLines: [] });
    expect(inv.lines.map((l) => l.description)).toEqual(["Balance brought forward", "Tuition (yearly GH₵ 1,000 — Term 2 share)", "Feeding"]);
    expect(inv.total).toBe(1066);
  });
});

// ---------------------------------------------------------------------------------
describe("changing an item mid-year: only terms not billed yet change", () => {
  it("a new yearly amount: the billed term keeps its share, later terms use the new amount", async () => {
    await confirm(3); // Term 2 billed at 333
    const out = await editClassFee({ name: "Tuition", amount: 1200 }, 1);
    expect(out.keptTerms.map((k) => k.termId)).toEqual([3]);
    expect(S(1).feesOwing).toBe(1066); // nothing re-billed
    expect(fee(1).termAmounts["3"].amount).toBe(333);
    moveToTerm2();
    const p = await previewTermBilling(4, { classId: 1 });
    expect(p.rows[0].items[0]).toMatchObject({ amount: 400, label: "Tuition (yearly GH₵ 1,200 — Term 3 share)" });
    await confirm(4);
    expect(S(1).feesOwing).toBe(1666); // 1066 + 400 + 200
  });

  it("per term -> per year: the billed term keeps its term amount", async () => {
    await confirm(3); // Feeding 200 on Term 2
    await editClassFee({ name: "Feeding", amount: 900, period: "YEAR" }, 2);
    expect(fee(2)).toMatchObject({ period: "YEAR" });
    expect(fee(2).termAmounts["3"]).toEqual({ period: "TERM", amount: 200 });
    expect(S(1).feesOwing).toBe(1066);
    moveToTerm2();
    await confirm(4);
    expect(db.bills.filter((b) => b.studentId === 1 && b.termId === 4)[0].items[1]).toMatchObject({ name: "Feeding", amount: 300, period: "YEAR" });
    expect(S(1).feesOwing).toBe(1066 + 334 + 300);
  });

  it("per year -> per term: the billed term keeps its share", async () => {
    await confirm(3);
    await editClassFee({ name: "Tuition", amount: 400, period: "TERM" }, 1);
    expect(S(1).feesOwing).toBe(1066);
    moveToTerm2();
    await confirm(4);
    expect(db.bills.filter((b) => b.termId === 4)[0].items[0]).toEqual({ name: "Tuition", amount: 400, source: "CLASS" });
    expect(S(1).feesOwing).toBe(1066 + 600);
  });

  it("an edit with no period sent keeps the item's choice (older screens)", async () => {
    await editClassFee({ name: "Tuition", amount: 1000 }, 1);
    expect(fee(1).period).toBe("YEAR");
    await expect(editClassFee({ name: "Tuition", amount: 1000, period: "MONTH" }, 1)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("a per-term item edited as per-term works exactly as before (current term changes)", async () => {
    await editClassFee({ name: "Feeding", amount: 250 }, 2);
    expect(fee(2).termAmounts).toEqual({});
    expect(S(1).feesOwing).toBe(583);
  });

  it("a new yearly item: on the current term's bill at that term's share, kept there", async () => {
    await createClassFee({ classId: 1, name: "Books", amount: 300, period: "YEAR" });
    const books = db.classFees.find((f) => f.name === "Books");
    expect(books.termAmounts["2"]).toMatchObject({ period: "YEAR", amount: 100, no: 1 });
    expect(S(1).feesOwing).toBe(633);
  });
});

// ---------------------------------------------------------------------------------
describe("promotion, adoption and admissions", () => {
  it("an unclaimed period carries the first share; the term that adopts it bills its own share", async () => {
    // Ama promoted into BASIC 1 for 2026/27 with an untied period.
    S(1).feesPeriodTermId = null;
    S(1).feesBillAtStart = 0;
    S(1).feesOpeningBalance = 0;
    await recomputeStudentOwing(1, { transaction: T });
    expect(S(1).feesOwing).toBe(533); // first share 333 + 200
    S(2).feesPeriodTermId = 3; // Kofi was billed Term 2 (so Term 3 bills him NEW)
    // Term 3 adopts it: 334 is Term 3's share, so the projected balance is 1 more.
    moveToTerm2();
    const p = await previewTermBilling(4, { classId: 1 });
    const ama = p.rows.find((r) => r.studentId === 1);
    expect(ama).toMatchObject({ action: "ADOPT", projected: 534 });
    await billClassForTerm({ termId: 4, classId: 1, expectedCount: p.expectedCount, expectedTotal: p.expectedTotal });
    expect(S(1).feesOwing).toBe(534);
  });

  it("promotion out of a yearly class: arrears carried, the new class's bill added", async () => {
    await startFeePeriod(1, { transaction: T });
    S(1).classId = 2;
    await recomputeStudentOwing(1, { transaction: T });
    expect(S(1).feesOwing).toBe(533 + 900);
  });

  it("a new admission in the open term is billed that term's share", async () => {
    db.students.push({ ...pupil(5, "Esi", 0), feesOpeningBalance: 0, feesBillAtStart: 0, feesPeriodTermId: null, feesPeriodAfterFeeId: 10 });
    await tieAdmissionToOpenTerm(5, { transaction: T });
    expect(S(5).feesOwing).toBe(533);
    expect(db.bills[0].items[0]).toMatchObject({ amount: 333, shareNo: 1 });
  });
});

// ---------------------------------------------------------------------------------
describe("what the screens read", () => {
  it("pupil fee lists show the term share, labelled; the stored amounts are not sent", async () => {
    const pupils = [{ studentId: 1, feesPeriodTermId: 3, class_: { classFee: db.classFees.filter((f) => f.classId === 1).map((f) => ({ ...f })) } }];
    await applyPupilShares(pupils);
    const [tuition, feeding] = pupils[0].class_.classFee;
    expect(tuition).toMatchObject({ amount: 333, period: "YEAR", yearlyAmount: 1000, label: "Tuition (yearly GH₵ 1,000 — Term 2 share)" });
    expect(tuition.termAmounts).toBeUndefined();
    expect(feeding).toMatchObject({ amount: 200, period: "TERM" });
  });

  it("the class fee list previews the open term's share and lists billed terms", async () => {
    const rows = await annotateClassFeeList(db.classFees.filter((f) => f.classId === 1).map((f) => ({ ...f })));
    expect(rows[0]).toMatchObject({ period: "YEAR", termShare: 333, shareTermId: 2, split: [333, 333, 334], assumedTerms: false });
    expect(rows[0].billedTerms).toEqual([{ termId: 2, term: "1", academicYearId: 2, period: "YEAR", amount: 333 }]);
    expect(rows[1]).toMatchObject({ period: "TERM", termShare: 200, split: null });
  });

  it("TERM-only lists are returned untouched, with no extra query", async () => {
    const rows = [{ classFeeId: 3, name: "Tuition", amount: "900.00", period: "TERM", termAmounts: {} }];
    Term.findAll.mockClear();
    expect(await annotateClassFeeList(rows)).toBe(rows);
    expect(Term.findAll).not.toHaveBeenCalled();
  });
});
