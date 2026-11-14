// B12: per-term billing, arrears carried forward, discounts, statements.
// In-memory tables (testSupport/fakeTable); the real fee.js / feeBill.js run.
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
    Term: m(),
  };
});

import sequelize from "../config/database.js";
import * as models from "../models/index.js";
import { fakeTable } from "../testSupport/fakeTable.js";
import { createFee, recomputeStudentOwing, reverseFee, startFeePeriod } from "../services/fee.js";
import { computeDiscounts, discountCoversTerm } from "../services/feeBill.js";
import { assertBillableTerm, billClassForTerm, classifyPupil, previewTermBilling, termsSkipped, tieAdmissionToOpenTerm } from "../services/termBilling.js";
import {
  addStudentDiscount,
  deleteDiscountType,
  endStudentDiscount,
  groupSiblings,
  phoneKey,
  listStudentDiscounts,
  removeStudentDiscount,
  updateDiscountType,
  validateDiscountType,
} from "../services/discounts.js";
import { getStatement, paymentsBetween } from "../services/feeStatement.js";

const { Class, ClassFee, DiscountType, Fee, Student, StudentDiscount, StudentFee, StudentPromotion, StudentTermBill, Term } = models;
const T = { LOCK: { UPDATE: "UPDATE" } };
let db;

// Term 1 2026/27 is open; Term 2 hasn't started. Go-live tied everyone to Term 1 (migration 030).
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
      { classId: 9, name: "ALUMNI", isAlumni: true, isDeleted: false },
    ],
    classFees: [
      { classFeeId: 1, classId: 1, name: "Tuition", amount: "800.00" },
      { classFeeId: 2, classId: 1, name: "Feeding", amount: "200.00" },
      { classFeeId: 3, classId: 2, name: "Tuition", amount: "900.00" },
    ],
    studentFees: [],
    // live at go-live: Ama owes 400 of her 1000 bill; Kofi is 50 in credit; Yaw has no class (legacy)
    students: [
      pupil(1, "Ama", 1, { owing: 400, paid: 600 }),
      pupil(2, "Kofi", 1, { owing: -50, paid: 1050 }),
      pupil(3, "Yaw", null, { owing: 120, paid: 0 }),
      pupil(4, "Esi", 9, { owing: 30, paid: 0 }),
    ],
    fees: [{ feeId: 10, studentId: 1, paid: "600.00", reversedAt: null }],
    types: [
      { discountTypeId: 1, name: "Staff child", kind: "PERCENT", value: "50.00", appliesTo: "Tuition", isActive: true },
      { discountTypeId: 2, name: "Sibling", kind: "FIXED", value: "100.00", appliesTo: null, isActive: true },
      { discountTypeId: 3, name: "Old bursary", kind: "FIXED", value: "10.00", appliesTo: null, isActive: false },
    ],
    given: [],
    bills: [],
    promotions: [],
    years: [
      { academicYearId: 1, name: "2025/2026" },
      { academicYearId: 2, name: "2026/2027" },
    ],
  };
  fakeTable(models.AcademicYear, db.years, "academicYearId");
  fakeTable(Term, db.terms, "termId");
  fakeTable(Class, db.classes, "classId");
  fakeTable(ClassFee, db.classFees, "classFeeId");
  fakeTable(StudentFee, db.studentFees, "studentFeeId");
  fakeTable(Student, db.students, "studentId");
  fakeTable(Fee, db.fees, "feeId");
  fakeTable(DiscountType, db.types, "discountTypeId");
  fakeTable(StudentDiscount, db.given, "studentDiscountId");
  fakeTable(StudentTermBill, db.bills, "studentTermBillId");
  fakeTable(models.Invoice, [], "invoiceId");
  fakeTable(models.CreditNote, [], "creditNoteId");
  fakeTable(StudentPromotion, db.promotions, "studentPromotionId");
};
function pupil(studentId, fName, classId, { owing, paid }) {
  const bill = classId === 1 ? 1000 : 0;
  return {
    studentId, fName, lName: "Mensah", classId, isDeleted: false,
    feesOwing: owing, feesPaid: paid, feesOpeningBalance: owing, feesBillAtStart: bill, feesPaidAtStart: paid,
    feesPeriodAfterFeeId: 10, feesPeriodStartedAt: "2026-09-20T10:00:00Z", feesPeriodTermId: 2,
  };
}
const S = (id) => db.students.find((s) => s.studentId === id);

// "Today" is fixed so "Term 2 hasn't started yet" stays true.
beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"], now: new Date("2026-11-13T09:00:00Z") });
});
afterAll(() => jest.useRealTimers());

beforeEach(() => {
  jest.clearAllMocks();
  seed();
  sequelize.transaction.mockImplementation(async (cb) => cb(T));
  sequelize.query.mockImplementation(async () => [[{ maxId: Math.max(0, ...db.fees.map((f) => f.feeId)) }]]);
});

// ---------------------------------------------------------------------------------
describe("discount maths", () => {
  const items = [{ name: "Tuition", amount: 800 }, { name: "Feeding", amount: 200 }];
  it("percent off the items it applies to; fixed off everything", () => {
    expect(computeDiscounts(items, [{ name: "Staff", kind: "PERCENT", value: 50, appliesTo: "tuition " }])).toMatchObject({ gross: 1000, discount: 400, net: 600 });
    expect(computeDiscounts(items, [{ name: "Sib", kind: "FIXED", value: 150 }])).toMatchObject({ discount: 150, net: 850 });
  });
  it("stacking: percent always on the full amount; together never below 0", () => {
    const r = computeDiscounts(items, [
      { name: "A", kind: "PERCENT", value: 60 },
      { name: "B", kind: "PERCENT", value: 60 },
    ]);
    expect(r).toMatchObject({ discount: 1000, net: 0 });
    expect(r.lines).toEqual([{ name: "A", amount: 600 }, { name: "B", amount: 400 }]);
  });
  it("fixed is capped at its items; an item the pupil doesn't have gives 0", () => {
    expect(computeDiscounts(items, [{ name: "F", kind: "FIXED", value: 500, appliesTo: "Feeding" }]).discount).toBe(200);
    expect(computeDiscounts(items, [{ name: "Bus", kind: "FIXED", value: 50, appliesTo: "Bus" }]).discount).toBe(0);
  });
  it("rounds to the pesewa (half up)", () => {
    expect(computeDiscounts([{ name: "T", amount: 0.1 }], [{ name: "P", kind: "PERCENT", value: 5 }]).discount).toBe(0.01);
    expect(computeDiscounts([{ name: "T", amount: "333.33" }], [{ name: "P", kind: "PERCENT", value: 10 }]).net).toBe(300);
  });
  it("term range: from a term onward, or up to an end term", () => {
    const terms = new Map(db.terms.map((t) => [t.termId, t]));
    expect(discountCoversTerm({ fromTermId: 2, toTermId: null }, terms.get(4), terms)).toBe(true);
    expect(discountCoversTerm({ fromTermId: 2, toTermId: 3 }, terms.get(4), terms)).toBe(false);
    expect(discountCoversTerm({ fromTermId: 3, toTermId: null }, terms.get(2), terms)).toBe(false);
  });
});

describe("discount types", () => {
  it("validates", () => {
    expect(validateDiscountType({ name: "Staff child", kind: "percent", value: "50" })).toMatchObject({ kind: "PERCENT", value: 50, appliesTo: null });
    expect(() => validateDiscountType({ name: "X1", kind: "PERCENT", value: 101 })).toThrow(/100%/);
    expect(() => validateDiscountType({ name: "X1", kind: "FIXED", value: 0 })).toThrow(/more than 0/);
    expect(() => validateDiscountType({ name: "X1", kind: "FIXED", value: 1.005 })).toThrow(/2 decimal/);
    expect(() => validateDiscountType({ name: "X1", kind: "HALF", value: 1 })).toThrow(/percentage or a fixed/);
  });
  it("the amount can't change once pupils have it (no silent re-pricing); the name can", async () => {
    db.given.push({ studentDiscountId: 1, studentId: 1, discountTypeId: 2, fromTermId: 2, toTermId: null });
    await expect(updateDiscountType(2, { value: 150 })).rejects.toMatchObject({ statusCode: 409 });
    await updateDiscountType(2, { name: "Sibling (2nd child)" });
    expect(db.types[1].name).toBe("Sibling (2nd child)");
    await expect(deleteDiscountType(2)).rejects.toMatchObject({ statusCode: 409 });
    await deleteDiscountType(1);
    expect(db.types.map((t) => t.discountTypeId)).toEqual([2, 3]);
  });
});

describe("giving a pupil a discount", () => {
  it("from the open term: the balance drops at once, in the same transaction", async () => {
    const out = await addStudentDiscount({ studentId: 1, discountTypeId: 1 }, { createdBy: "bursar" });
    expect(out).toMatchObject({ fromTermId: 2, toTermId: null, source: "MANUAL", createdBy: "bursar", owing: 0 }); // 400 - 50% of 800
    expect(S(1).feesOwing).toBe(0);
  });
  it("a discount bigger than what is owed leaves a credit (never clamped)", async () => {
    S(1).feesOpeningBalance = 100;
    S(1).feesOwing = 100;
    const out = await addStudentDiscount({ studentId: 1, discountTypeId: 1 });
    expect(out.owing).toBe(-300);
  });
  it("refuses a switched-off type, an overlapping repeat, and a missing pupil", async () => {
    await expect(addStudentDiscount({ studentId: 1, discountTypeId: 3 })).rejects.toMatchObject({ statusCode: 400 });
    await addStudentDiscount({ studentId: 1, discountTypeId: 2 });
    await expect(addStudentDiscount({ studentId: 1, discountTypeId: 2, fromTermId: 3 })).rejects.toMatchObject({ statusCode: 409 });
    await expect(addStudentDiscount({ studentId: 99, discountTypeId: 2 })).rejects.toMatchObject({ statusCode: 404 });
  });
  it("a discount for a later term doesn't change today's balance", async () => {
    await addStudentDiscount({ studentId: 1, discountTypeId: 2, fromTermId: 3 });
    expect(S(1).feesOwing).toBe(400);
  });
  it("ending / removing it puts the balance back; removal refused once it is on an earlier term's bill", async () => {
    const d = await addStudentDiscount({ studentId: 1, discountTypeId: 2 });
    expect(S(1).feesOwing).toBe(300);
    await endStudentDiscount(d.studentDiscountId, { toTermId: 1 }).catch((e) => expect(e.statusCode).toBe(400)); // before its start
    await removeStudentDiscount(d.studentDiscountId);
    expect(S(1).feesOwing).toBe(400);

    const d2 = await addStudentDiscount({ studentId: 1, discountTypeId: 2 });
    db.bills.push({ studentTermBillId: 1, studentId: 1, termId: 2 });
    S(1).feesPeriodTermId = 3; // Term 2 is now the current period; Term 1's bill is history
    await expect(removeStudentDiscount(d2.studentDiscountId)).rejects.toMatchObject({ statusCode: 409 });
    await endStudentDiscount(d2.studentDiscountId, { toTermId: 2 });
    expect(db.given[0].toTermId).toBe(2);
  });
});

it("a pupil's discounts are listed with their terms and years", async () => {
  await addStudentDiscount({ studentId: 1, discountTypeId: 1, toTermId: 3, reason: "Teacher's child" });
  const [d] = await listStudentDiscounts(1);
  expect(d).toMatchObject({ name: "Staff child", kind: "PERCENT", value: 50, appliesTo: "Tuition", reason: "Teacher's child" });
  expect(d.fromTerm).toMatchObject({ termId: 2, academicYearName: "2026/2027" });
  expect(d.toTerm).toMatchObject({ termId: 3 });
});

describe("siblings (suggested, the office confirms)", () => {
  it("phone numbers in any format match", () => {
    expect(phoneKey("024 412 3456")).toBe("244123456");
    expect(phoneKey("+233244123456")).toBe("244123456");
    expect(phoneKey("12")).toBeNull();
  });
  it("same parent or same phone = one family; eldest pays in full, the rest are suggested", () => {
    const parents = [
      { parentId: 1, fName: "Akua", contact: "0244123456" },
      { parentId: 2, fName: "Kwesi", contact: "+233 24 412 3456" }, // same phone, second record
      { parentId: 3, fName: "Abena", contact: "0201111111" },
    ];
    const pupils = [
      { studentId: 5, parentId: 1, dob: "2016-01-01" },
      { studentId: 6, parentId: 2, dob: "2014-05-05" },
      { studentId: 7, parentId: 1, dob: null },
      { studentId: 8, parentId: 3, dob: "2015-01-01" }, // only child
    ];
    const fams = groupSiblings(pupils, parents);
    expect(fams).toHaveLength(1);
    expect(fams[0].children.map((c) => c.studentId)).toEqual([6, 5, 7]);
    expect(fams[0].suggestedStudentIds).toEqual([5, 7]);
  });
});

// ---------------------------------------------------------------------------------
describe("who gets billed", () => {
  const T2 = { termId: 3, startDate: "2027-01-11" };
  it("classifies each pupil", () => {
    expect(classifyPupil({ classId: null }, T2, null, null)).toEqual({ action: "SKIP", reason: "NO_CLASS" });
    expect(classifyPupil({ classId: 9 }, T2, null, { isAlumni: true })).toEqual({ action: "SKIP", reason: "ALUMNI" });
    expect(classifyPupil({ classId: 1, feesPeriodTermId: 3 }, T2, null, {})).toEqual({ action: "SKIP", reason: "ALREADY_BILLED" });
    expect(classifyPupil({ classId: 1, feesPeriodTermId: null }, T2, null, {}, { billedForT: true })).toEqual({ action: "SKIP", reason: "ALREADY_BILLED" });
    expect(classifyPupil({ classId: 1, feesPeriodTermId: 4 }, T2, { termId: 4, startDate: "2027-04-26" }, {})).toEqual({ action: "SKIP", reason: "LATER_TERM" });
    expect(classifyPupil({ classId: 1, feesPeriodTermId: 2 }, T2, { termId: 2, startDate: "2026-09-07" }, {})).toEqual({ action: "NEW" });
    // Untied: adopted whenever the period began (also after T started) ...
    expect(classifyPupil({ classId: 1, feesPeriodTermId: null, feesPeriodStartedAt: "2026-08-01T09:00:00Z" }, T2, null, {})).toEqual({ action: "ADOPT" });
    expect(classifyPupil({ classId: 1, feesPeriodTermId: null, feesPeriodStartedAt: "2027-02-01T09:00:00Z" }, T2, null, {})).toEqual({ action: "ADOPT" });
    // ... but never by the term the pupil was promoted on (or an earlier one).
    const promo = { termId: 3, startDate: "2027-01-11" };
    expect(classifyPupil({ classId: 1, feesPeriodTermId: null }, T2, null, {}, { anchorTerm: promo })).toEqual({ action: "SKIP", reason: "PROMOTED_FOR_NEXT_TERM" });
    expect(classifyPupil({ classId: 1, feesPeriodTermId: null }, { termId: 4, startDate: "2027-04-26" }, null, {}, { anchorTerm: promo })).toEqual({ action: "ADOPT" });
  });
  it("only the open term or the NEXT term to start can be billed", () => {
    const terms = db.terms;
    expect(() => assertBillableTerm({ termId: 2, startDate: "2026-09-07", active: true }, { terms, today: "2026-11-13" })).not.toThrow();
    expect(() => assertBillableTerm(terms[2], { terms, today: "2026-11-13" })).not.toThrow();
    expect(() => assertBillableTerm(terms[3], { terms, today: "2026-11-13" })).toThrow(/next term to start, Term 2 \(starts 2027-01-11\)/);
    expect(() => assertBillableTerm({ termId: 1, startDate: "2026-04-27", active: false }, { terms, today: "2026-11-13" })).toThrow(/open term/);
    expect(() => assertBillableTerm({ termId: 5, startDate: null }, { terms, today: "2026-11-13" })).toThrow(/no dates/);
  });
  it("terms a NEW bill would skip", () => {
    expect(termsSkipped(db.terms[1], db.terms[3], db.terms).map((t) => t.termId)).toEqual([3]);
    expect(termsSkipped(db.terms[1], db.terms[2], db.terms)).toEqual([]);
    expect(termsSkipped({ termId: 7, startDate: null }, db.terms[3], db.terms)).toEqual([]);
  });
});

const confirm = async (termId, classId) => {
  const p = await previewTermBilling(termId, { classId });
  return billClassForTerm({ termId, classId, expectedCount: p.expectedCount, expectedTotal: p.expectedTotal }, { billedBy: "bursar" });
};

describe("billing a term", () => {
  it("go-live: billing the current term changes nobody's balance", async () => {
    const before = db.students.map((s) => s.feesOwing);
    const p = await previewTermBilling(2, { classId: 1 });
    expect(p).toMatchObject({ expectedCount: 0, skipped: { ALREADY_BILLED: 2 } });
    const out = await billClassForTerm({ termId: 2, classId: 1, expectedCount: 0, expectedTotal: 0 });
    expect(out).toMatchObject({ billed: 0, adopted: 0 });
    expect(db.students.map((s) => s.feesOwing)).toEqual(before);
    expect(db.bills).toHaveLength(0);
  });

  it("next term: what is owed is carried in as arrears, then the term's bill is added; credit carries too", async () => {
    const p = await previewTermBilling(3, { classId: 1 });
    expect(p).toMatchObject({ toBill: 2, arrearsTotal: 350, billTotal: 2000, expectedTotal: 2350 });
    const out = await confirm(3, 1);
    expect(out).toMatchObject({ billed: 2, adopted: 0, total: 2350 });
    expect(S(1)).toMatchObject({ feesOwing: 1400, feesOpeningBalance: 400, feesBillAtStart: 0, feesPaidAtStart: 0, feesPeriodTermId: 3, feesPeriodAfterFeeId: 10 });
    expect(S(2)).toMatchObject({ feesOwing: 950, feesOpeningBalance: -50 }); // credit kept, not clamped
    expect(db.bills.map((b) => [b.studentId, b.termId, b.kind, b.arrears, b.bill, b.discount])).toEqual([
      [1, 3, "NEW", 400, 1000, 0],
      [2, 3, "NEW", -50, 1000, 0],
    ]);
  });

  it("pupils with no class, and alumni, are never billed", async () => {
    const all = await previewTermBilling(3);
    expect(all.noClassPupils).toBe(1);
    expect(all.classes.find((c) => c.classId === 9)).toMatchObject({ expectedCount: 0, skipped: { ALUMNI: 1 } });
  });

  it("is idempotent: billing again bills nobody", async () => {
    await confirm(3, 1);
    const again = await confirm(3, 1);
    expect(again).toMatchObject({ billed: 0, adopted: 0 });
    expect(S(1).feesOwing).toBe(1400);
    expect(db.bills).toHaveLength(2);
  });

  it("refuses (409) when the figures changed since the preview, and bills nobody", async () => {
    const p = await previewTermBilling(3, { classId: 1 });
    db.fees.push({ feeId: 11, studentId: 1, paid: "100.00", reversedAt: null });
    await recomputeStudentOwing(1, { transaction: T }); // a payment comes in
    await expect(
      billClassForTerm({ termId: 3, classId: 1, expectedCount: p.expectedCount, expectedTotal: p.expectedTotal })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(db.bills).toHaveLength(0);
    expect(S(1).feesPeriodTermId).toBe(2);
  });

  it("needs the preview's figures; a past term can't be billed", async () => {
    await expect(billClassForTerm({ termId: 3, classId: 1 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(billClassForTerm({ termId: 1, classId: 1, expectedCount: 0, expectedTotal: 0 })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("discounts for the term come off the new bill", async () => {
    db.given.push({ studentDiscountId: 1, studentId: 1, discountTypeId: 1, fromTermId: 3, toTermId: null, source: "MANUAL" });
    const out = await confirm(3, 1);
    expect(out.total).toBe(1950); // Ama 400 + 1000 - 400, Kofi -50 + 1000
    expect(db.bills[0]).toMatchObject({ discount: 400, discounts: [{ name: "Staff child", amount: 400 }] });
  });

  it("after promotion: the next term ADOPTS the period promotion started (no second bill)", async () => {
    // Promotion (end of Term 3) moved Ama to BASIC 2: arrears 400 carried, BASIC 2's 900 added.
    S(1).feesPeriodTermId = 1;
    await startFeePeriod(1, { transaction: T, unlessBilledAfter: "2026-04-27" });
    S(1).classId = 2;
    await recomputeStudentOwing(1, { transaction: T });
    expect(S(1)).toMatchObject({ feesOwing: 1300, feesPeriodTermId: null });
    S(1).feesPeriodStartedAt = "2026-08-01T00:00:00Z";
    await confirm(3, 2);
    expect(S(1)).toMatchObject({ feesOwing: 1300, feesPeriodTermId: 3 });
    expect(db.bills[0]).toMatchObject({ kind: "ADOPTED", arrears: 400, bill: 900 });
  });

  it("promotion accepted AFTER the next term was billed doesn't start a second period", async () => {
    await confirm(3, 1);
    const out = await startFeePeriod(1, { transaction: T, unlessBilledAfter: "2026-09-07" }); // promotion for Term 1 2026/27
    expect(out).toEqual({ arrears: null, skipped: true });
    expect(S(1)).toMatchObject({ feesPeriodTermId: 3, feesOwing: 1400 });
  });

  it("payments and reversals after billing keep working on the new period", async () => {
    await confirm(3, 1);
    const f = await createFee({ studentId: 1, classId: 1, currentPaid: 400 });
    expect(f.owing).toBe(1000);
    db.fees.find((x) => x.feeId === f.feeId).receiptNo = "PPS-1";
    await reverseFee(f.feeId, { reason: "Wrong pupil" });
    expect(S(1).feesOwing).toBe(1400);
  });
});

describe("statement", () => {
  it("payments land in the period they were made in", () => {
    const pays = [{ feeId: 5 }, { feeId: 11 }, { feeId: 20 }];
    expect(paymentsBetween(pays, 10, 15).map((p) => p.feeId)).toEqual([11]);
    expect(paymentsBetween(pays, 10, null).map((p) => p.feeId)).toEqual([11, 20]);
  });

  it("term by term: arrears in, items, discounts, payments (reversed listed, not counted), balance = owing", async () => {
    // Term 1 2026/27: an earlier bill row; payments 11 (kept) and 12 (reversed); then Term 2 billed.
    // Ama owed 400 of the 1000 bill at go-live: -600 before it.
    db.bills.push({ studentTermBillId: 1, studentId: 1, termId: 2, kind: "ADOPTED", arrears: "-600.00", bill: "1000.00", discount: "0.00", items: [], discounts: [], afterFeeId: 10 });
    db.fees.push({ feeId: 11, studentId: 1, paid: "500.00", reversedAt: null, receiptNo: "PPS-11" });
    db.fees.push({ feeId: 12, studentId: 1, paid: "50.00", reversedAt: "2026-10-01", receiptNo: "PPS-12" });
    await confirm(3, 1);
    db.fees.push({ feeId: 13, studentId: 1, paid: "200.00", reversedAt: null, receiptNo: "PPS-13" });
    await recomputeStudentOwing(1, { transaction: T });

    const st = await getStatement(1);
    expect(st.periods).toHaveLength(2);
    expect(st.periods[0]).toMatchObject({ termId: 2, arrears: -600, bill: 1000, paid: 500, adjustment: 0, balance: -100 });
    expect(st.periods[0].payments.map((p) => [p.receiptNo, p.reversed])).toEqual([["PPS-11", false], ["PPS-12", true]]);
    expect(st.periods[1]).toMatchObject({ termId: 3, label: "Term 2 · 2026/2027", current: true, arrears: -100, bill: 1000, paid: 200, balance: 700 });
    expect(st.owing).toBe(700);
  });
});

// ---------------------------------------------------------------------------------
// B12 review: every term is billed exactly once per pupil, over whole years.
// Ama is in BASIC 1 (1000 a term), tied to Term 1 2026/27 (termId 2) owing 400.
// Promotion at the end of Term 3 2026/27 (termId 4) moves her to BASIC 2 (900).
// Terms 5 and 6 are Term 1 and Term 2 of 2027/28. No payments, so at the end she
// must owe 400 + 1000 (T2) + 1000 (T3) + 900 (T1 27/28) + 900 (T2 27/28) = 4200.
describe("billed exactly once per term (sequences)", () => {
  const setToday = (d) => jest.setSystemTime(new Date(`${d}T09:00:00Z`));
  const open = (termId) => db.terms.forEach((t) => (t.active = t.termId === termId));
  const billAll = async (termId) => {
    for (const c of [1, 2]) await confirm(termId, c);
  };
  const promote = async (studentId, promoTermId, toClassId) => {
    // What acceptPromotion does for a first decision (services/promotion.js).
    db.promotions.push({ studentPromotionId: db.promotions.length + 1, studentId, termId: promoTermId, outcome: "PROMOTED" });
    const promoTerm = db.terms.find((t) => t.termId === promoTermId);
    await startFeePeriod(studentId, { transaction: T, unlessBilledAfter: promoTerm.startDate });
    S(studentId).classId = toClassId;
    await recomputeStudentOwing(studentId, { transaction: T });
  };
  const billedTerms = (sid) => db.bills.filter((b) => b.studentId === sid).map((b) => b.termId).sort((a, b) => a - b);

  beforeEach(async () => {
    db.terms.push(
      { termId: 5, term: "1", startDate: "2027-09-06", endDate: "2027-12-16", active: false, academicYearId: 3 },
      { termId: 6, term: "2", startDate: "2028-01-10", endDate: "2028-04-01", active: false, academicYearId: 3 }
    );
    db.students.splice(1); // just Ama
    await billAll(3); // Term 2 2026/27, billed in Term 1
    setToday("2027-02-01");
    open(3);
    await billAll(4);
    setToday("2027-05-01");
    open(4);
    setToday("2027-07-30");
    open(null); // Term 3 closed: the holiday
    expect(S(1).feesOwing).toBe(2400);
  });
  afterEach(() => setToday("2026-11-13"));

  const finish = async () => {
    // Term 2 2027/28: billed in Term 1 2027/28.
    setToday("2027-11-01");
    open(5);
    await billAll(6);
    await billAll(6); // idempotent
    expect(billedTerms(1)).toEqual([3, 4, 5, 6]);
    expect(S(1).feesOwing).toBe(4200);
  };

  it("promoted BEFORE the next term opens: that term adopts, the one after bills NEW", async () => {
    await promote(1, 4, 2);
    expect(S(1)).toMatchObject({ feesOwing: 3300, feesPeriodTermId: null });
    await billAll(5); // in the holiday
    expect(db.bills.find((b) => b.termId === 5)).toMatchObject({ kind: "ADOPTED", arrears: 2400, bill: 900 });
    await finish();
  });

  it("promoted AFTER the next term opened, before it was billed: it still adopts (was skipped, then the next term adopted: one bill lost)", async () => {
    setToday("2027-09-10");
    open(5);
    await promote(1, 4, 2);
    await billAll(5);
    expect(db.bills.find((b) => b.termId === 5)).toMatchObject({ kind: "ADOPTED", arrears: 2400, bill: 900 });
    expect(S(1)).toMatchObject({ feesOwing: 3300, feesPeriodTermId: 5 });
    await finish();
  });

  it("promoted AFTER the next term was billed: no new period, the class bill is swapped", async () => {
    await billAll(5); // still in BASIC 1: 1000
    expect(S(1).feesOwing).toBe(3400);
    await promote(1, 4, 2);
    expect(S(1)).toMatchObject({ feesOwing: 3300, feesPeriodTermId: 5 });
    await finish();
  });

  it("the promotion term opened again and billed: promoted pupils are skipped (their bill is for the next term)", async () => {
    await promote(1, 4, 2);
    setToday("2027-07-31");
    open(4);
    expect(await previewTermBilling(4, { classId: 2 })).toMatchObject({ expectedCount: 0, skipped: { ALREADY_BILLED: 1 } });
    // Even with no bill row for Term 3 (tied to it at go-live by migration 030):
    db.bills.splice(db.bills.findIndex((b) => b.termId === 4), 1);
    expect(await previewTermBilling(4, { classId: 2 })).toMatchObject({ expectedCount: 0, skipped: { PROMOTED_FOR_NEXT_TERM: 1 } });
    db.bills.push({ studentTermBillId: 99, studentId: 1, termId: 4, kind: "NEW", arrears: 0, bill: 1000, discount: 0, afterFeeId: 10 });
    open(null);
    await billAll(5);
    await finish();
  });

  it("old-system periods left untied by migration 030 (go-live after the next term started): adopted, then NEW", async () => {
    // The old system promoted on Term 3 (termId 4); go-live after Term 1 2027/28 began.
    db.bills.splice(0);
    db.terms.find((t) => t.termId === 4).promotedByOldSystem = true;
    Object.assign(S(1), {
      classId: 2, feesOwing: 3300, feesOpeningBalance: 3300, feesBillAtStart: 900, feesPaidAtStart: 0,
      feesPeriodTermId: null, feesPeriodStartedAt: "2027-09-10T09:00:00Z", feesPeriodAfterFeeId: 10,
    });
    setToday("2027-09-10");
    open(5);
    await billAll(5);
    // Arrears = what was owed before the bill already on the period.
    expect(db.bills[0]).toMatchObject({ termId: 5, kind: "ADOPTED", arrears: 2400, bill: 900 });
    expect(S(1).feesOwing).toBe(3300);
    setToday("2027-11-01");
    await billAll(6);
    expect(S(1).feesOwing).toBe(4200);
    expect(billedTerms(1)).toEqual([5, 6]);

    // Statement: each row = arrears + bill - discounts - payments = carried forward; ends on feesOwing.
    const st = await getStatement(1);
    expect(st.periods.map((p) => [p.termId, p.arrears, p.bill, p.adjustment, p.balance])).toEqual([
      [5, 2400, 900, 0, 3300],
      [6, 3300, 900, 0, 4200],
    ]);
    expect(st.owing).toBe(4200);
  });

  it("a later term can't be billed while the term before it was never billed (409, nothing billed)", async () => {
    // Holiday: Term 1 2027/28 (5) is next; Term 2 (6) can't jump the queue.
    await expect(billClassForTerm({ termId: 6, classId: 1, expectedCount: 1, expectedTotal: 3400 })).rejects.toMatchObject({ statusCode: 409 });
    // Term 5 opened but never billed; in Term 5, Term 6 is next to start: refused for Ama.
    setToday("2027-11-01");
    open(5);
    const p = await previewTermBilling(6, { classId: 1 });
    expect(p.blocked).toMatchObject({ termId: 5, pupils: 1 });
    await expect(billClassForTerm({ termId: 6, classId: 1, expectedCount: p.expectedCount, expectedTotal: p.expectedTotal })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/Term 1 \(starts 2027-09-06\) was never billed for 1 pupil in BASIC 1 \(Ama Mensah\)/),
    });
    expect(billedTerms(1)).toEqual([3, 4]);
    const all = await previewTermBilling(6);
    expect(all.blocked).toEqual([expect.objectContaining({ classId: 1, termId: 5 })]);
  });
});

describe("new admissions (createStudent)", () => {
  const admit = (id, classId = 1) => {
    db.students.push({
      studentId: id, fName: "Abena", lName: "Owusu", classId, isDeleted: false, feesOwing: null, feesPaid: 0,
      feesOpeningBalance: 0, feesBillAtStart: 0, feesPaidAtStart: 0, feesPeriodAfterFeeId: 0, feesPeriodStartedAt: null, feesPeriodTermId: null,
    });
  };

  it("mid-term: tied to the open term (ADOPTED bill), the next term bills them NEW", async () => {
    admit(7);
    await tieAdmissionToOpenTerm(7, { transaction: T });
    expect(S(7)).toMatchObject({ feesOwing: 1000, feesPeriodTermId: 2 });
    expect(S(7).feesPeriodStartedAt).toBeInstanceOf(Date);
    expect(db.bills).toEqual([expect.objectContaining({ studentId: 7, termId: 2, kind: "ADOPTED", arrears: 0, bill: 1000, discount: 0, afterFeeId: 0 })]);
    // Billing the open term again: already billed.
    expect((await previewTermBilling(2, { classId: 1 })).rows.find((r) => r.studentId === 7)).toMatchObject({ action: "SKIP", reason: "ALREADY_BILLED" });
    await confirm(3, 1);
    expect(S(7).feesOwing).toBe(2000);
  });

  it("a discount given right after admission applies at once", async () => {
    admit(7);
    await tieAdmissionToOpenTerm(7, { transaction: T });
    const out = await addStudentDiscount({ studentId: 7, discountTypeId: 1 });
    expect(out.owing).toBe(600);
  });

  it("no term open: untied, the next term billed adopts the admission bill", async () => {
    db.terms.forEach((t) => (t.active = false));
    admit(7);
    await tieAdmissionToOpenTerm(7, { transaction: T });
    expect(S(7)).toMatchObject({ feesOwing: 1000, feesPeriodTermId: null });
    expect(db.bills).toHaveLength(0);
    const p = await previewTermBilling(3, { classId: 1 });
    expect(p.rows.find((r) => r.studentId === 7)).toMatchObject({ action: "ADOPT", arrears: 0 });
  });
});

describe("B12 review: discounts and the preview", () => {
  it("ending a discount can't stretch it over another row of the same discount (409)", async () => {
    const a = await addStudentDiscount({ studentId: 1, discountTypeId: 2, fromTermId: 2, toTermId: 2 });
    await addStudentDiscount({ studentId: 1, discountTypeId: 2, fromTermId: 4 });
    await expect(endStudentDiscount(a.studentDiscountId, { toTermId: 4 })).rejects.toMatchObject({ statusCode: 409 });
    await endStudentDiscount(a.studentDiscountId, { toTermId: 3 }); // up to the other one: fine
    expect(db.given.find((g) => g.studentDiscountId === a.studentDiscountId).toTermId).toBe(3);
  });

  it("stacked discounts on one item never spill onto other items", () => {
    const items = [{ name: "Tuition", amount: 500 }, { name: "Feeding", amount: 300 }];
    const r = computeDiscounts(items, [
      { name: "A", kind: "PERCENT", value: 100, appliesTo: "Tuition" },
      { name: "B", kind: "FIXED", value: 400, appliesTo: "Tuition" },
    ]);
    expect(r).toMatchObject({ discount: 500, net: 300 });
    expect(r.lines).toEqual([{ name: "A", amount: 500 }, { name: "B", amount: 0 }]);
    // A discount on everything, then one on Tuition: capped at what is left of Tuition.
    const r2 = computeDiscounts(items, [
      { name: "All", kind: "FIXED", value: 400 },
      { name: "T", kind: "PERCENT", value: 100, appliesTo: "Tuition" },
    ]);
    expect(r2).toMatchObject({ discount: 650, net: 150 }); // 400 = 250 Tuition + 150 Feeding; then Tuition's 250
  });

  it("pupils left in a deleted class are reported, not silently left out", async () => {
    db.classes.push({ classId: 5, name: "OLD JHS", isAlumni: false, isDeleted: true });
    S(1).classId = 5;
    const all = await previewTermBilling(3);
    expect(all).toMatchObject({ noClassPupils: 1, deletedClassPupils: 1, deletedClasses: [{ classId: 5, name: "OLD JHS", pupils: 1 }] });
  });
});
