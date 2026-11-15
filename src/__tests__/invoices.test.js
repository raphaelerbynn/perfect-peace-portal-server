// B14: invoices and credit notes on top of fee periods + term billing.
// In-memory tables (testSupport/fakeTable); the real fee.js, termBilling.js,
// feeStatement.js, invoiceLedger.js and invoices.js run.
jest.mock("../config/database.js", () => ({
  __esModule: true,
  default: { transaction: jest.fn(), query: jest.fn(), literal: (sql) => ({ __literal: sql }), fn: jest.fn(), col: jest.fn() },
}));
jest.mock("../services/notify.js", () => ({ __esModule: true, notifyInvoiceIssued: jest.fn(async () => null) }));
jest.mock("../models/index.js", () => {
  const m = () => ({ findAll: jest.fn(), findOne: jest.fn(), create: jest.fn(), update: jest.fn(), destroy: jest.fn(), count: jest.fn(), findAndCountAll: jest.fn() });
  return {
    __esModule: true,
    AcademicYear: m(),
    Class: m(),
    ClassFee: m(),
    CreditNote: m(),
    DiscountType: m(),
    Fee: m(),
    FeeCheck: m(),
    Invoice: m(),
    InvoiceLine: m(),
    Parent: m(),
    Student: m(),
    StudentDiscount: m(),
    StudentFee: m(),
    StudentPromotion: m(),
    StudentTermBill: m(),
    Term: m(),
  };
});

import sequelize from "../config/database.js";
import * as models from "../models/index.js";
import { fakeTable, matches } from "../testSupport/fakeTable.js";
import { createFee, reverseFee } from "../services/fee.js";
import { billClassForTerm, previewTermBilling } from "../services/termBilling.js";
import { getStatement } from "../services/feeStatement.js";
import { displayStatus, invoiceStatus, isCurrentPeriod, periodEnd } from "../services/invoiceLedger.js";
import {
  bulkGenerate,
  cleanDueDate,
  createCreditNote,
  generateInvoice,
  getInvoice,
  invoiceLines,
  invoicesForPrint,
  issueInvoice,
  listInvoices,
  portalInvoice,
  portalInvoices,
  validateCreditAmount,
  voidCreditNote,
  voidInvoice,
} from "../services/invoices.js";

const { Class, ClassFee, CreditNote, DiscountType, Fee, Invoice, InvoiceLine, Student, StudentDiscount, StudentFee, StudentPromotion, StudentTermBill, Term } = models;
const T = { LOCK: { UPDATE: "UPDATE" } };
let db;
let invoiceSeq;
let cnSeq;

function pupil(studentId, fName, classId, { owing, paid }) {
  const bill = classId === 1 ? 1000 : 0;
  return {
    studentId, fName, lName: "Mensah", classId, isDeleted: false,
    feesOwing: owing, feesPaid: paid, feesOpeningBalance: owing, feesBillAtStart: bill, feesPaidAtStart: paid,
    feesPeriodAfterFeeId: 10, feesPeriodStartedAt: "2026-09-20T10:00:00Z", feesPeriodTermId: 2,
  };
}

// Term 1 2026/27 (id 2) is open; Term 2 (id 3) is next. Go-live tied everyone to it (no bill rows).
const seed = () => {
  db = {
    terms: [
      { termId: 1, term: "3", startDate: "2026-04-27", endDate: "2026-07-24", active: false, academicYearId: 1 },
      { termId: 2, term: "1", startDate: "2026-09-07", endDate: "2026-12-17", active: true, academicYearId: 2 },
      { termId: 3, term: "2", startDate: "2027-01-11", endDate: "2027-04-01", active: false, academicYearId: 2 },
    ],
    classes: [
      { classId: 1, name: "BASIC 1", isAlumni: false, isDeleted: false },
      { classId: 9, name: "ALUMNI", isAlumni: true, isDeleted: false },
    ],
    classFees: [
      { classFeeId: 1, classId: 1, name: "Tuition", amount: "800.00" },
      { classFeeId: 2, classId: 1, name: "Feeding", amount: "200.00" },
    ],
    studentFees: [],
    // Ama owes 400 of her 1000 bill (paid 600 on the old system); Kofi is 50 in credit.
    students: [pupil(1, "Ama", 1, { owing: 400, paid: 600 }), pupil(2, "Kofi", 1, { owing: -50, paid: 1050 }), pupil(4, "Esi", 9, { owing: 30, paid: 0 })],
    fees: [{ feeId: 10, studentId: 1, paid: "600.00", reversedAt: null, receiptNo: "PPS-2026-000010" }],
    types: [],
    given: [],
    bills: [],
    promotions: [],
    years: [{ academicYearId: 2, name: "2026/2027" }],
    invoices: [],
    lines: [],
    credits: [],
  };
  invoiceSeq = 0;
  cnSeq = 0;
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
  fakeTable(StudentPromotion, db.promotions, "studentPromotionId");
  fakeTable(Invoice, db.invoices, "invoiceId");
  fakeTable(InvoiceLine, db.lines, "invoiceLineId");
  fakeTable(CreditNote, db.credits, "creditNoteId");
  // The database's sequences: INV- on issue (a literal in the UPDATE), CN- as a column default.
  const update = Invoice.update.getMockImplementation();
  Invoice.update.mockImplementation(async (patch, opts) => {
    const p = { ...patch };
    if (p.invoiceNo && p.invoiceNo.__literal) p.invoiceNo = `INV-2026-${String(++invoiceSeq).padStart(5, "0")}`;
    return update(p, opts);
  });
  const createCn = CreditNote.create.getMockImplementation();
  CreditNote.create.mockImplementation(async (data, opts) => createCn({ ...data, creditNoteNo: `CN-2026-${String(++cnSeq).padStart(5, "0")}` }, opts));
  for (const model of [Invoice, CreditNote]) {
    const rows = model === Invoice ? db.invoices : db.credits;
    model.findAndCountAll.mockImplementation(async ({ where, limit, offset = 0 } = {}) => {
      const hit = rows.filter((r) => matches(r, where)).sort((a, b) => (b.invoiceId ?? b.creditNoteId) - (a.invoiceId ?? a.creditNoteId));
      return { rows: hit.slice(offset, offset + limit).map((r) => ({ ...r })), count: hit.length };
    });
  }
};

const S = (id) => db.students.find((s) => s.studentId === id);
const pay = (studentId, amount) => createFee({ studentId, classId: 1, currentPaid: amount, datePaid: "2026-11-13" }, { recordedBy: "bursar" });
const billTerm3 = async () => {
  const p = await previewTermBilling(3, { classId: 1 });
  return billClassForTerm({ termId: 3, classId: 1, expectedCount: p.expectedCount, expectedTotal: p.expectedTotal }, { billedBy: "bursar" });
};
const issued = async (studentId = 1, termId = 2) => generateInvoice({ studentId, termId, issue: true, dueDate: "2026-09-21" }, { by: "bursar" });

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

describe("pure rules", () => {
  it("status from the figures (SchoolPro recalculate, plus carried forward)", () => {
    expect(invoiceStatus({ status: "ISSUED", balance: 0, paid: 700, credited: 0, current: true })).toBe("PAID");
    expect(invoiceStatus({ status: "ISSUED", balance: 300, paid: 200, credited: 0, current: true })).toBe("PARTIALLY_PAID");
    expect(invoiceStatus({ status: "PARTIALLY_PAID", balance: 300, paid: 0, credited: 200, current: true })).toBe("PARTIALLY_PAID");
    expect(invoiceStatus({ status: "PAID", balance: 500, paid: 0, credited: 0, current: true })).toBe("ISSUED");
    expect(invoiceStatus({ status: "ISSUED", balance: -50, paid: 0, credited: 0, current: true })).toBe("PAID");
    expect(invoiceStatus({ status: "ISSUED", balance: 300, paid: 0, credited: 0, current: false })).toBe("CARRIED_FORWARD");
    expect(invoiceStatus({ status: "VOID", balance: 300, paid: 0, credited: 0, current: true })).toBe("VOID");
    expect(invoiceStatus({ status: "DRAFT", balance: 0, paid: 500, credited: 0, current: true })).toBe("DRAFT");
  });

  it("OVERDUE is shown for issued invoices past their due date with money owed", () => {
    expect(displayStatus({ status: "ISSUED", dueDate: "2026-11-01", balance: 10 }, "2026-11-13")).toBe("OVERDUE");
    expect(displayStatus({ status: "PARTIALLY_PAID", dueDate: "2026-11-01", balance: 10 }, "2026-11-13")).toBe("OVERDUE");
    expect(displayStatus({ status: "ISSUED", dueDate: "2026-11-13", balance: 10 }, "2026-11-13")).toBe("ISSUED");
    expect(displayStatus({ status: "PAID", dueDate: "2026-11-01", balance: 0 }, "2026-11-13")).toBe("PAID");
    expect(displayStatus({ status: "ISSUED", dueDate: null, balance: 10 }, "2026-11-13")).toBe("ISSUED");
  });

  it("lines: brought forward, items, discounts (negative); total = arrears + items - discounts", () => {
    const t = invoiceLines({ arrears: 250.5, items: [{ name: "Tuition", amount: 800 }, { name: "Feeding", amount: 200 }], discountLines: [{ name: "Sibling", amount: 100 }, { name: "None", amount: 0 }] });
    expect(t.lines.map((l) => [l.kind, l.amount])).toEqual([["ARREARS", 250.5], ["ITEM", 800], ["ITEM", 200], ["DISCOUNT", -100]]);
    expect(t).toMatchObject({ arrears: 250.5, subtotal: 1000, discount: 100, total: 1150.5 });
    expect(invoiceLines({ arrears: -600, items: [{ name: "Tuition", amount: 1000 }] }).lines[0]).toMatchObject({ description: "Credit brought forward (paid earlier)", amount: -600 });
    expect(invoiceLines({ arrears: 0, items: [] }).lines).toEqual([]);
  });

  it("an invoice's period ends where the next one began", () => {
    const pupilNow = { feesPeriodTermId: 3, feesPeriodAfterFeeId: 40 };
    const terms = { 2: { termId: 2, startDate: "2026-09-07" }, 3: { termId: 3, startDate: "2027-01-11" } };
    const bills = [{ termId: 3, afterFeeId: 40, term: terms[3] }];
    expect(periodEnd({ termId: 2, afterFeeId: 10 }, pupilNow, bills, terms[2])).toBe(40);
    expect(periodEnd({ termId: 3, afterFeeId: 40 }, pupilNow, bills, terms[3])).toBeNull();
    // promoted in the holiday: the untied period began at 35
    expect(periodEnd({ termId: 2, afterFeeId: 10 }, { feesPeriodTermId: null, feesPeriodAfterFeeId: 35 }, [], terms[2])).toBe(35);
    expect(isCurrentPeriod({ termId: 3, afterFeeId: 40 }, pupilNow)).toBe(true);
    expect(isCurrentPeriod({ termId: 3, afterFeeId: 39 }, pupilNow)).toBe(false);
  });

  it("validation: amounts, due dates", () => {
    expect(() => validateCreditAmount(0)).toThrow(/more than 0/);
    expect(() => validateCreditAmount(-5)).toThrow(/more than 0/);
    expect(() => validateCreditAmount("abc")).toThrow(/Enter/);
    expect(() => validateCreditAmount(10.005)).toThrow(/2 decimal/);
    expect(validateCreditAmount("99.50")).toBe(99.5);
    expect(cleanDueDate("")).toBeNull();
    expect(cleanDueDate("2027-01-25")).toBe("2027-01-25");
    expect(() => cleanDueDate("2027-02-30")).toThrow(/real date/);
    expect(() => cleanDueDate("soon")).toThrow(/real date/);
  });
});

describe("generate and issue", () => {
  it("a draft copies the current term's live bill; its balance is exactly what the pupil owes", async () => {
    const inv = await generateInvoice({ studentId: 1, termId: 2 }, { by: "bursar" });
    expect(inv).toMatchObject({ status: "DRAFT", invoiceNo: null, arrears: -600, subtotal: 1000, discount: 0, total: 400, amountPaid: 0, balance: 400, current: true, outOfDate: false });
    expect(inv.lines.map((l) => l.description)).toEqual(["Credit brought forward (paid earlier)", "Tuition", "Feeding"]);
    expect(inv.termLabel).toBe("Term 1 · 2026/2027");
    expect(S(1).feesOwing).toBe(400); // an invoice never changes the balance
  });

  it("issuing numbers it from the sequence; a non-draft can't be issued again", async () => {
    const { notifyInvoiceIssued } = require("../services/notify.js");
    notifyInvoiceIssued.mockClear();
    const draft = await generateInvoice({ studentId: 1, termId: 2 }, { by: "bursar" });
    expect(notifyInvoiceIssued).not.toHaveBeenCalled(); // a draft is not announced
    const inv = await issueInvoice(draft.invoiceId, { dueDate: "2026-09-21" }, { by: "admin" });
    expect(notifyInvoiceIssued).toHaveBeenCalledWith(draft.invoiceId);
    expect(inv).toMatchObject({ status: "ISSUED", invoiceNo: "INV-2026-00001", issuedBy: "admin", dueDate: "2026-09-21", displayStatus: "OVERDUE" });
    await expect(issueInvoice(draft.invoiceId, {}, { by: "admin" })).rejects.toMatchObject({ statusCode: 409 });
    expect(notifyInvoiceIssued).toHaveBeenCalledTimes(1); // a refused re-issue is not announced
  });

  it("issuing refreshes a draft from the live bill first", async () => {
    const draft = await generateInvoice({ studentId: 1, termId: 2 }, { by: "bursar" });
    db.studentFees.push({ studentFeeId: 1, studentId: 1, name: "Bus", amount: "150.00" });
    const { recomputeStudentOwing } = require("../services/fee.js");
    await recomputeStudentOwing(1, { transaction: T });
    const inv = await issueInvoice(draft.invoiceId, {}, { by: "admin" });
    expect(inv).toMatchObject({ total: 550, balance: 550, outOfDate: false });
    expect(inv.lines.map((l) => l.description)).toContain("Bus");
  });

  it("one live invoice per pupil per term; generating again refreshes a draft", async () => {
    const a = await generateInvoice({ studentId: 1, termId: 2 }, { by: "bursar" });
    const b = await generateInvoice({ studentId: 1, termId: 2, notes: "Please pay at the office" }, { by: "bursar" });
    expect(b.invoiceId).toBe(a.invoiceId);
    expect(b.notes).toBe("Please pay at the office");
    expect(db.lines.filter((l) => l.invoiceId === a.invoiceId)).toHaveLength(3); // replaced, not doubled
    await issueInvoice(a.invoiceId, {}, { by: "admin" });
    await expect(generateInvoice({ studentId: 1, termId: 2 }, { by: "bursar" })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/INV-2026-00001/) });
  });

  it("a term the pupil was never billed for can't be invoiced; unknown ids are 404", async () => {
    await expect(generateInvoice({ studentId: 1, termId: 3 }, {})).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/not been billed/) });
    await expect(generateInvoice({ studentId: 99, termId: 2 }, {})).rejects.toMatchObject({ statusCode: 404 });
    await expect(generateInvoice({ studentId: 1, termId: 99 }, {})).rejects.toMatchObject({ statusCode: 404 });
    await expect(generateInvoice({ studentId: "1; drop", termId: 2 }, {})).rejects.toMatchObject({ statusCode: 404 });
    await expect(getInvoice("abc")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("a pupil already in credit gets an invoice that is PAID at once", async () => {
    const inv = await issued(2);
    expect(inv).toMatchObject({ total: -50, balance: -50, status: "PAID" });
  });

  it("bulk: every billed pupil of the class, alumni classes left out, problems reported with a reason", async () => {
    await issued(1);
    const out = await bulkGenerate({ termId: 2, issue: true, dueDate: "2026-12-01" }, { by: "bursar" });
    expect(out).toMatchObject({ created: 1, refreshed: 0, issued: 1, errors: [] });
    expect(out.skipped).toEqual([expect.objectContaining({ studentId: 1, name: "Ama Mensah", className: "BASIC 1", reason: expect.stringMatching(/Already invoiced/) })]);
    expect(db.invoices.filter((i) => i.studentId === 4)).toHaveLength(0);
    const next = await bulkGenerate({ termId: 3, classId: 1 }, { by: "bursar" });
    expect(next.created).toBe(0);
    expect(next.skipped).toHaveLength(2);
    expect(next.skipped[0].reason).toMatch(/not been billed/);
    await expect(bulkGenerate({ termId: 2, dueDate: "nope" }, {})).rejects.toMatchObject({ statusCode: 400 });
  });

  it("list (search by number or name, OVERDUE filter) and the class print set", async () => {
    await issued(1);
    await generateInvoice({ studentId: 2, termId: 2 }, { by: "bursar" }); // draft
    expect((await listInvoices({ termId: 2 })).invoices).toHaveLength(2);
    expect((await listInvoices({ q: "INV-2026-00001" })).invoices.map((i) => i.studentId)).toEqual([1]);
    expect((await listInvoices({ q: "kofi" })).invoices.map((i) => i.studentId)).toEqual([2]);
    expect((await listInvoices({ q: "STU/2" })).invoices.map((i) => i.studentId)).toEqual([2]);
    expect((await listInvoices({ status: "OVERDUE" })).invoices.map((i) => i.studentId)).toEqual([1]);
    expect((await listInvoices({ status: "DRAFT" })).invoices.map((i) => i.studentId)).toEqual([2]);
    await expect(listInvoices({ status: "LOST" })).rejects.toMatchObject({ statusCode: 400 });
    const print = await invoicesForPrint({ termId: 2, classId: 1 });
    expect(print.invoices.map((i) => i.invoiceNo)).toEqual(["INV-2026-00001"]); // drafts are not printed
  });
});

describe("recalculated on every payment and reversal (SchoolPro forgets payments)", () => {
  it("payment -> PARTIALLY_PAID, the rest -> PAID, reversal -> back", async () => {
    const inv = await issued(1);
    const p1 = await pay(1, 150);
    expect(await getInvoice(inv.invoiceId)).toMatchObject({ status: "PARTIALLY_PAID", amountPaid: 150, balance: 250, outOfDate: false });
    const p2 = await pay(1, 250);
    expect(await getInvoice(inv.invoiceId)).toMatchObject({ status: "PAID", amountPaid: 400, balance: 0 });
    await reverseFee(p2.feeId, { reason: "Entered twice", reversedBy: "admin" });
    expect(await getInvoice(inv.invoiceId)).toMatchObject({ status: "PARTIALLY_PAID", amountPaid: 150, balance: 250 });
    await reverseFee(p1.feeId, { reason: "Wrong pupil", reversedBy: "admin" });
    const back = await getInvoice(inv.invoiceId);
    expect(back).toMatchObject({ status: "ISSUED", amountPaid: 0, balance: 400 });
    expect(back.payments.map((p) => p.reversed)).toEqual([true, true]); // listed, not counted
  });

  it("reversing a payment from before the term puts it back: the current invoice's balance follows (as an adjustment)", async () => {
    const inv = await issued(1);
    await pay(1, 400);
    expect(await getInvoice(inv.invoiceId)).toMatchObject({ status: "PAID", balance: 0 });
    await reverseFee(10, { reason: "Old system mistake", reversedBy: "admin" });
    expect(S(1).feesOwing).toBe(600);
    expect(await getInvoice(inv.invoiceId)).toMatchObject({ status: "PARTIALLY_PAID", total: 400, adjustment: 600, balance: 600, currentOwing: 600, outOfDate: true });
    // and a credit note can still be given against what is now owed
    const cn = await createCreditNote({ invoiceId: inv.invoiceId, amount: 600, reason: "Head waived it" }, {});
    expect(cn.invoice).toMatchObject({ status: "PAID", balance: 0, adjustment: 600 });
    expect(S(1).feesOwing).toBe(0);
  });

  it("a fee change after issue: the balance includes it (re-issue to show it as lines)", async () => {
    const inv = await issued(1);
    db.classFees[1].amount = "250.00";
    const { recomputeStudentOwing } = require("../services/fee.js");
    await recomputeStudentOwing(1, { transaction: T });
    expect(await getInvoice(inv.invoiceId)).toMatchObject({ outOfDate: true, adjustment: 50, balance: 450, currentOwing: 450 });
    expect((await listInvoices({ status: "OVERDUE" })).invoices[0]).toMatchObject({ balance: 450, outOfDate: true });
    await voidInvoice(inv.invoiceId, { reason: "Feeding fee went up" }, { by: "admin" });
    const fresh = await issued(1);
    expect(fresh).toMatchObject({ total: 450, adjustment: 0, balance: 450, outOfDate: false, invoiceNo: "INV-2026-00002" });
  });

  it("once the next term is billed the old invoice is frozen at what it carried forward", async () => {
    const t1 = await issued(1);
    await pay(1, 100);
    await billTerm3();
    expect(await getInvoice(t1.invoiceId)).toMatchObject({ status: "CARRIED_FORWARD", amountPaid: 100, balance: 300 });
    // a payment from that term reversed later: the money moves to the current term, the old invoice stays as carried
    const p = db.fees.find((f) => f.paid === 100);
    await reverseFee(p.feeId, { reason: "Cheque bounced", reversedBy: "admin" });
    expect(S(1).feesOwing).toBe(1400);
    expect(await getInvoice(t1.invoiceId)).toMatchObject({ status: "CARRIED_FORWARD", amountPaid: 100, balance: 300 });
    const t2 = await issued(1, 3);
    expect(t2).toMatchObject({ arrears: 400, total: 1400, balance: 1400, adjustment: 0 });
  });
});

describe("credit notes", () => {
  it("take money off what the pupil owes (owing, invoice, statement); voiding puts it back", async () => {
    const inv = await issued(1);
    const r = await createCreditNote({ invoiceId: inv.invoiceId, amount: 100, reason: "Overbilled feeding" }, { by: "admin" });
    expect(r.creditNote).toMatchObject({ creditNoteNo: "CN-2026-00001", amount: 100, createdBy: "admin", termId: 2, periodAfterFeeId: 10 });
    expect(r.owing).toBe(300);
    expect(S(1)).toMatchObject({ feesOwing: 300, feesPaid: 600 }); // not a payment
    expect(r.invoice).toMatchObject({ amountCredited: 100, balance: 300, status: "PARTIALLY_PAID", outOfDate: false });
    const st = await getStatement(1);
    expect(st.periods.at(-1)).toMatchObject({ credited: 100, balance: 300 });
    // a payment can't pay off more than is now owed
    await expect(pay(1, 301)).rejects.toMatchObject({ statusCode: 400 });
    const v = await voidCreditNote(r.creditNote.creditNoteId, { reason: "Given by mistake" }, { by: "admin" });
    expect(v.owing).toBe(400);
    expect(v.invoice).toMatchObject({ amountCredited: 0, balance: 400, status: "ISSUED" });
    expect(v.invoice.creditNotes[0]).toMatchObject({ void: true, voidedBy: "admin", voidReason: "Given by mistake" });
    await expect(voidCreditNote(r.creditNote.creditNoteId, { reason: "again please" }, {})).rejects.toMatchObject({ statusCode: 409 });
  });

  it("never more than is still owed (fresh figures, after a payment); never on drafts or void invoices", async () => {
    const draft = await generateInvoice({ studentId: 1, termId: 2 }, {});
    await expect(createCreditNote({ invoiceId: draft.invoiceId, amount: 10, reason: "Withdrawn" }, {})).rejects.toMatchObject({ statusCode: 409 });
    await issueInvoice(draft.invoiceId, {}, {});
    await pay(1, 350);
    await expect(createCreditNote({ invoiceId: draft.invoiceId, amount: 50.01, reason: "Withdrawn" }, {})).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/GH₵ 50\.00/) });
    const ok = await createCreditNote({ invoiceId: draft.invoiceId, amount: 50, reason: "Withdrawn" }, {});
    expect(ok.invoice).toMatchObject({ status: "PAID", balance: 0 });
    expect(S(1).feesOwing).toBe(0);
    await expect(createCreditNote({ invoiceId: draft.invoiceId, amount: 1, reason: "Withdrawn" }, {})).rejects.toMatchObject({ statusCode: 409 });
    await expect(createCreditNote({ invoiceId: draft.invoiceId, amount: 1, reason: "no" }, {})).rejects.toMatchObject({ statusCode: 400 });
    await expect(createCreditNote({ invoiceId: 999, amount: 1, reason: "Withdrawn" }, {})).rejects.toMatchObject({ statusCode: 404 });
  });

  it("the same request sent twice makes one credit note", async () => {
    const inv = await issued(1);
    const body = { invoiceId: inv.invoiceId, amount: 200, reason: "Overbilled", requestId: "a1b2c3d4-0001" };
    const first = await createCreditNote(body, { by: "admin" });
    const again = await createCreditNote(body, { by: "admin" });
    expect(again).toMatchObject({ replayed: true, owing: 200 });
    expect(again.creditNote.creditNoteNo).toBe(first.creditNote.creditNoteNo);
    expect(db.credits).toHaveLength(1);
    expect(S(1).feesOwing).toBe(200);
    await expect(createCreditNote({ ...body, amount: 50 }, {})).rejects.toMatchObject({ statusCode: 409 });
    await expect(createCreditNote({ ...body, requestId: "bad id!" }, {})).rejects.toMatchObject({ statusCode: 400 });
  });

  it("an invoice with a live credit note can't be voided; void it first", async () => {
    const inv = await issued(1);
    const cn = await createCreditNote({ invoiceId: inv.invoiceId, amount: 40, reason: "Scholarship" }, {});
    await expect(voidInvoice(inv.invoiceId, { reason: "Wrong figures" }, {})).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/CN-2026-00001/) });
    await voidCreditNote(cn.creditNote.creditNoteId, { reason: "Redo it" }, {});
    const v = await voidInvoice(inv.invoiceId, { reason: "Wrong figures" }, { by: "admin" });
    expect(v).toMatchObject({ status: "VOID", voidedBy: "admin", voidReason: "Wrong figures" });
    expect(S(1).feesOwing).toBe(400); // voiding the document changes no balance
    await expect(voidInvoice(inv.invoiceId, { reason: "Wrong figures" }, {})).rejects.toMatchObject({ statusCode: 409 });
    await expect(voidInvoice(inv.invoiceId, { reason: "no" }, {})).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("billing the next term", () => {
  it("the old invoice is carried forward; the new one brings the balance in; credits are carried once", async () => {
    const t1 = await issued(1);
    await createCreditNote({ invoiceId: t1.invoiceId, amount: 100, reason: "Overbilled" }, {});
    await pay(1, 50);
    expect(S(1).feesOwing).toBe(250);
    await billTerm3();
    expect(S(1).feesOwing).toBe(1250); // 250 carried + 1000 Term 2 bill; the credit is not lost or counted twice
    expect(await getInvoice(t1.invoiceId)).toMatchObject({ status: "CARRIED_FORWARD", balance: 250, amountPaid: 50, amountCredited: 100, current: false, outOfDate: false });
    const t2 = await issued(1, 3);
    expect(t2).toMatchObject({ arrears: 250, subtotal: 1000, total: 1250, balance: 1250, current: true });
    expect(t2.lines[0]).toMatchObject({ kind: "ARREARS", description: "Balance brought forward", amount: 250 });
    // a payment now counts on the new term only
    await pay(1, 300);
    expect(await getInvoice(t2.invoiceId)).toMatchObject({ amountPaid: 300, balance: 950 });
    expect(await getInvoice(t1.invoiceId)).toMatchObject({ amountPaid: 50, balance: 250, status: "CARRIED_FORWARD" });
    // credit notes go on the current term's invoice only, and old ones stay as they are
    await expect(createCreditNote({ invoiceId: t1.invoiceId, amount: 10, reason: "Old term" }, {})).rejects.toMatchObject({ statusCode: 409 });
    await expect(voidCreditNote(1, { reason: "Old term note" }, {})).rejects.toMatchObject({ statusCode: 409 });
    // the statement still ends on what is owed and shows the credit in its term
    const st = await getStatement(1);
    expect(st.owing).toBe(950);
    expect(st.periods.at(-1).balance).toBe(950);
  });

  it("the go-live term has no saved bill: once the next term is billed it can't be invoiced any more", async () => {
    await billTerm3();
    await expect(generateInvoice({ studentId: 1, termId: 2 }, {})).rejects.toMatchObject({ statusCode: 409 });
    const inv = await issued(1, 3);
    expect(inv).toMatchObject({ total: 1400, current: true });
  });

  it("an older term with a saved bill is invoiced from that bill (and is already carried forward)", async () => {
    await billTerm3();
    // Ama is then promoted in the holiday: a new untied period starts
    const { startFeePeriod } = require("../services/fee.js");
    await pay(1, 400);
    await startFeePeriod(1, { transaction: T });
    const inv = await issued(1, 3);
    expect(inv).toMatchObject({ arrears: 400, total: 1400, amountPaid: 400, balance: 1000, current: false, status: "CARRIED_FORWARD" });
  });
});

describe("portal", () => {
  it("a pupil sees their own issued invoices only (no drafts, no other pupils', no office notes)", async () => {
    const inv = await issued(1);
    await createCreditNote({ invoiceId: inv.invoiceId, amount: 20, reason: "Internal: head approved" }, { by: "admin" });
    await generateInvoice({ studentId: 2, termId: 2 }, {}); // Kofi's draft
    expect((await portalInvoices(1)).map((i) => i.invoiceNo)).toEqual(["INV-2026-00001"]);
    expect(await portalInvoices(2)).toEqual([]);
    const one = await portalInvoice(1, inv.invoiceId);
    expect(one).toMatchObject({ balance: 380, amountCredited: 20 });
    expect(one.creditNotes[0]).toEqual({ creditNoteId: 1, creditNoteNo: "CN-2026-00001", amount: 20, createdAt: expect.anything(), void: false });
    expect(one).not.toHaveProperty("createdBy");
    expect(one).not.toHaveProperty("voidReason");
    await expect(portalInvoice(2, inv.invoiceId)).rejects.toMatchObject({ statusCode: 404 });
  });
});
