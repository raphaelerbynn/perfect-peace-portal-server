import { Op, UniqueConstraintError } from "sequelize";
import sequelize from "../config/database.js";
import {
  AcademicYear,
  Class,
  ClassFee,
  CreditNote,
  Fee,
  Invoice,
  InvoiceLine,
  Student,
  StudentFee,
  StudentTermBill,
  Term,
} from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { isPesewaAmount, round2, toNum } from "../utils/money.js";
import { paginatedResponse, parsePagination } from "../utils/pagination.js";
import { recomputeStudentOwing } from "./fee.js";
import { computeDiscounts, discountsForTerm } from "./feeBill.js";
import { displayStatus, isCurrentPeriod, periodEnd, recalcStudentInvoices } from "./invoiceLedger.js";

// ---------------------------------------------------------------------------
// B14: invoices and credit notes (SchoolPro invoice.service / credit-note.service,
// with its gaps closed). Rules:
//
// INVOICE = a numbered copy of a pupil's bill for ONE term (B12 billing):
//   "Balance brought forward" (arrears, below 0 = credit) + the term's fee
//   items - discounts = total. It does not change what the pupil owes (the bill
//   is already on the balance from billing the term). Payments are not tied to
//   invoices: an invoice's paid / balance come from the pupil's payments in the
//   invoice's fee period (services/invoiceLedger.js), recalculated on every
//   payment, reversal, credit note and bill change.
//   - Only a term the pupil has been billed for: their current period's term
//     (live figures, so its balance is exactly what they owe), or an earlier
//     term with a saved bill (Student_term_bill).
//   - One live invoice per pupil per term (VOID ones don't count).
//   - DRAFT (no number) -> ISSUED (INV-<year>-00001 from a sequence; a draft of
//     the current term is refreshed from the live bill first) -> PARTIALLY_PAID
//     / PAID / CARRIED_FORWARD (the next term was billed: what was left is in
//     that term's balance brought forward) by recalculation. OVERDUE is shown
//     (issued, still owed, past the due date), not stored.
//   - VOID: any invoice without live credit notes, with a reason. Voiding only
//     cancels the document; the balance is untouched. A new one can then be made.
//   - Generating again for a pupil whose invoice is still a DRAFT refreshes it.
//
// CREDIT NOTE = money off what a pupil owes for the term, against their CURRENT
// term invoice only (an older term's balance is already in the current one's
// brought-forward line). Amount > 0, at most 2 decimal places, and at most what
// is still owed on the invoice and on the account (never makes a credit)
// *(default)*. It counts in the fee-period formula (services/fee.js), so
// owing, the portal and the lockout follow at once. Void (reason) only while
// its period is still the current one. Administrator only *(default)*.
// Everything that touches a balance runs in one transaction with the pupil
// row locked first (then the invoice / credit note), queries one at a time.
// ---------------------------------------------------------------------------

export const REASON_MIN = 5;
export const REASON_MAX = 500;
const NOTES_MAX = 500;
const LIVE_STATUSES = ["ISSUED", "PARTIALLY_PAID", "PAID", "CARRIED_FORWARD"];
export const STATUSES = ["DRAFT", ...LIVE_STATUSES, "VOID", "OVERDUE"];

// INV-<year>-00001 (dbo.pp_document_no, migration 042: at least 5 digits).
const INVOICE_NO_SQL = `"dbo".pp_document_no('INV', nextval('"dbo".invoice_seq'))`;

const PUPIL_ATTRS = [
  "studentId", "fName", "mName", "lName", "classId", "class", "admissionNo", "isDeleted", "feesOwing",
  "feesOpeningBalance", "feesBillAtStart", "feesPeriodAfterFeeId", "feesPeriodTermId",
];

const fullName = (s) => [s?.fName, s?.mName, s?.lName].filter(Boolean).join(" ");
const todayLocal = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const toId = (v, what) => {
  const n = Number(v);
  if (!/^\d+$/.test(String(v ?? "")) || !Number.isInteger(n) || n <= 0) throw new AppError(`${what} not found`, 404);
  return n;
};
const plain = (row) => (row && typeof row.toJSON === "function" ? row.toJSON() : row);
const lock = (transaction) => (transaction?.LOCK ? { lock: transaction.LOCK.UPDATE } : {});

export const cleanReason = (reason, what = "reason") => {
  const r = String(reason ?? "").trim();
  if (r.length < REASON_MIN) throw new AppError(`Give a ${what} (at least ${REASON_MIN} characters)`, 400);
  if (r.length > REASON_MAX) throw new AppError(`The ${what} must be ${REASON_MAX} characters or fewer`, 400);
  return r;
};

/** "" / null -> null; else a real YYYY-MM-DD date, or 400. */
export const cleanDueDate = (v) => {
  if (v == null || v === "") return null;
  const s = String(v).slice(0, 10);
  const d = new Date(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new AppError("Enter the due date as a real date (YYYY-MM-DD)", 400);
  }
  return s;
};

const cleanNotes = (v) => {
  if (v == null) return undefined;
  const n = String(v).trim();
  if (n.length > NOTES_MAX) throw new AppError(`Notes must be ${NOTES_MAX} characters or fewer`, 400);
  return n || null;
};

export const validateCreditAmount = (amount) => {
  const n = Number(amount);
  if (amount == null || amount === "" || !Number.isFinite(n)) throw new AppError("Enter the credit note amount", 400);
  if (n <= 0) throw new AppError("The credit note amount must be more than 0", 400);
  if (!isPesewaAmount(n)) throw new AppError("Enter the amount with at most 2 decimal places (cedis and pesewas)", 400);
  return round2(n);
};

const termLabel = (t, yearName) =>
  t ? `Term ${t.term != null && String(t.term).trim() !== "" ? String(t.term).trim() : "?"}${yearName ? ` · ${yearName}` : ""}` : null;

const termLabels = async (termIds, { transaction = null } = {}) => {
  const ids = [...new Set(termIds.filter((x) => x != null).map(Number))];
  const terms = ids.length ? await Term.findAll({ where: { termId: ids }, raw: true, transaction }) : [];
  const yearIds = [...new Set(terms.map((t) => t.academicYearId).filter((x) => x != null))];
  const years = yearIds.length ? await AcademicYear.findAll({ where: { academicYearId: yearIds }, attributes: ["academicYearId", "name"], raw: true, transaction }) : [];
  const yearName = new Map(years.map((y) => [Number(y.academicYearId), y.name]));
  return new Map(terms.map((t) => [Number(t.termId), { ...t, label: termLabel(t, yearName.get(Number(t.academicYearId))) }]));
};

/**
 * Pure: the invoice lines and totals from a bill.
 * bill = { arrears, items: [{ name, amount }], discountLines: [{ name, amount }] }
 */
export const invoiceLines = ({ arrears = 0, items = [], discountLines = [] }) => {
  const lines = [];
  const a = round2(arrears);
  if (a !== 0) lines.push({ kind: "ARREARS", description: a > 0 ? "Balance brought forward" : "Credit brought forward (paid earlier)", amount: a });
  for (const i of items) lines.push({ kind: "ITEM", description: String(i.name ?? "Fee").trim().slice(0, 200) || "Fee", amount: round2(i.amount) });
  for (const d of discountLines) {
    if (round2(d.amount) > 0) lines.push({ kind: "DISCOUNT", description: `Discount: ${String(d.name ?? "").trim()}`.slice(0, 200), amount: -round2(d.amount) });
  }
  const subtotal = round2(items.reduce((n, i) => n + Math.round(toNum(i.amount) * 100), 0) / 100);
  const discount = round2(discountLines.reduce((n, d) => n + Math.round(Math.max(toNum(d.amount), 0) * 100), 0) / 100);
  return {
    lines: lines.map((l, k) => ({ ...l, position: k + 1 })),
    arrears: a,
    subtotal,
    discount,
    total: round2(a + subtotal - discount),
  };
};

/**
 * The bill an invoice for (pupil, term) copies, or null when the pupil was
 * never billed for that term. The current period uses the live figures (as the
 * fee statement does), so the invoice balance equals Student.feesOwing.
 */
const billFor = async (pupil, term, { transaction = null } = {}) => {
  if (pupil.feesPeriodTermId != null && Number(pupil.feesPeriodTermId) === Number(term.termId)) {
    const classFees =
      pupil.classId != null ? await ClassFee.findAll({ where: { classId: pupil.classId }, attributes: ["name", "amount"], raw: true, transaction }) : [];
    const studentFees = await StudentFee.findAll({ where: { studentId: pupil.studentId }, attributes: ["name", "amount"], raw: true, transaction });
    const items = [...classFees, ...studentFees].map((f) => ({ name: f.name, amount: round2(f.amount) }));
    const disc = (await discountsForTerm([pupil.studentId], term.termId, { transaction })).get(Number(pupil.studentId)) || [];
    const d = computeDiscounts(items, disc);
    return {
      current: true,
      classId: pupil.classId ?? null,
      afterFeeId: Number(pupil.feesPeriodAfterFeeId) || 0,
      // At go-live / for an adopted period the opening balance already holds the bill.
      arrears: round2(toNum(pupil.feesOpeningBalance) - toNum(pupil.feesBillAtStart)),
      items,
      discountLines: d.lines,
    };
  }
  const saved = await StudentTermBill.findOne({ where: { studentId: pupil.studentId, termId: term.termId }, raw: true, transaction });
  if (!saved) return null;
  return {
    current: false,
    classId: saved.classId ?? null,
    afterFeeId: Number(saved.afterFeeId) || 0,
    arrears: round2(saved.arrears),
    items: (saved.items || []).map((i) => ({ name: i.name, amount: round2(i.amount) })),
    discountLines: (saved.discounts || []).map((d) => ({ name: d.name, amount: round2(d.amount) })),
  };
};

const lockPupil = async (studentId, transaction) => {
  const pupil = await Student.findOne({ where: { studentId }, attributes: PUPIL_ATTRS, raw: true, transaction, ...lock(transaction) });
  if (!pupil) throw new AppError("Student not found", 404);
  return pupil;
};

const writeLines = async (invoiceId, lines, transaction) => {
  // Only a DRAFT's lines are ever replaced (it has no number and was never sent).
  await InvoiceLine.destroy({ where: { invoiceId }, transaction });
  for (const l of lines) {
    await InvoiceLine.create({ invoiceId, position: l.position, kind: l.kind, description: l.description, amount: l.amount }, { transaction });
  }
};

/** Copy the bill onto a (new or draft) invoice. */
const snapshotFields = (bill) => {
  const t = invoiceLines(bill);
  return {
    fields: {
      classId: bill.classId,
      afterFeeId: bill.afterFeeId,
      arrears: t.arrears,
      subtotal: t.subtotal,
      discount: t.discount,
      total: t.total,
    },
    lines: t.lines,
  };
};

const issueInTx = async (invoiceId, { dueDate, notes, issuedBy }, transaction) => {
  const inv = await Invoice.findOne({ where: { invoiceId }, raw: true, transaction, ...lock(transaction) });
  if (!inv) throw new AppError("Invoice not found", 404);
  if (inv.status !== "DRAFT") throw new AppError(`Only a draft can be issued (${inv.invoiceNo || "this invoice"} is ${inv.status.toLowerCase().replace("_", " ")})`, 409);
  const pupil = await Student.findOne({ where: { studentId: inv.studentId }, attributes: PUPIL_ATTRS, raw: true, transaction });
  const term = await Term.findOne({ where: { termId: inv.termId }, raw: true, transaction });
  // A draft of the current term is refreshed first, so what is issued is the bill as it is now.
  if (pupil && term && Number(pupil.feesPeriodTermId) === Number(inv.termId)) {
    const bill = await billFor(pupil, term, { transaction });
    if (bill) {
      const snap = snapshotFields(bill);
      await Invoice.update({ ...snap.fields, refreshedAt: new Date() }, { where: { invoiceId }, transaction });
      await writeLines(invoiceId, snap.lines, transaction);
    }
  }
  const due = dueDate !== undefined ? cleanDueDate(dueDate) : inv.dueDate ?? null;
  const n = cleanNotes(notes);
  await Invoice.update(
    {
      status: "ISSUED",
      invoiceNo: sequelize.literal(INVOICE_NO_SQL),
      issuedAt: new Date(),
      issuedBy,
      dueDate: due,
      ...(n !== undefined ? { notes: n } : {}),
    },
    { where: { invoiceId, status: "DRAFT" }, transaction }
  );
  await recalcStudentInvoices(inv.studentId, { transaction, include: [invoiceId] });
};

/**
 * One pupil, one term. Returns { action: CREATED | REFRESHED, invoiceId }.
 * Throws AppError for anything the office should be told.
 */
const generateInTx = async ({ studentId, term, dueDate, notes, issue, createdBy }, transaction) => {
  const pupil = await lockPupil(studentId, transaction);
  if (pupil.isDeleted) throw new AppError("This pupil has been archived", 409);
  const existing = await Invoice.findOne({
    where: { studentId, termId: term.termId, status: { [Op.ne]: "VOID" } },
    raw: true,
    transaction,
    ...lock(transaction),
  });
  if (existing && existing.status !== "DRAFT") {
    const err = new AppError(`Already invoiced for this term (${existing.invoiceNo}). Void it first to make a new one.`, 409);
    err.code = "ALREADY_INVOICED";
    throw err;
  }
  const bill = await billFor(pupil, term, { transaction });
  if (!bill) {
    const err = new AppError(`${fullName(pupil)} has not been billed for this term. Bill the term first (Finance → Billing).`, 409);
    err.code = "NOT_BILLED";
    throw err;
  }
  const snap = snapshotFields(bill);
  const due = cleanDueDate(dueDate);
  const n = cleanNotes(notes);
  let invoiceId;
  let action;
  if (existing) {
    invoiceId = existing.invoiceId;
    action = "REFRESHED";
    await Invoice.update(
      { ...snap.fields, refreshedAt: new Date(), ...(due ? { dueDate: due } : {}), ...(n !== undefined ? { notes: n } : {}) },
      { where: { invoiceId }, transaction }
    );
  } else {
    action = "CREATED";
    const created = await Invoice.create(
      { invoiceNo: null, studentId, termId: term.termId, status: "DRAFT", ...snap.fields, dueDate: due, notes: n ?? null, createdBy, createdAt: new Date() },
      { transaction }
    );
    invoiceId = plain(created).invoiceId;
  }
  await writeLines(invoiceId, snap.lines, transaction);
  await recalcStudentInvoices(studentId, { transaction, include: [invoiceId] });
  if (issue) await issueInTx(invoiceId, { dueDate: due ?? undefined, issuedBy: createdBy }, transaction);
  return { action, invoiceId };
};

const loadTerm = async (termId, { transaction = null } = {}) => {
  const term = await Term.findOne({ where: { termId: toId(termId, "Term") }, raw: true, transaction });
  if (!term) throw new AppError("Term not found", 404);
  return term;
};

const asConflict = (e) => {
  if (e instanceof UniqueConstraintError) return new AppError("Someone else made this invoice at the same moment. Look again.", 409);
  return e;
};

/** POST /invoices/generate { studentId, termId, dueDate?, notes?, issue? } */
export const generateInvoice = async (body = {}, { by = null } = {}) => {
  const studentId = toId(body.studentId, "Student");
  const term = await loadTerm(body.termId);
  try {
    const { invoiceId } = await sequelize.transaction((t) =>
      generateInTx({ studentId, term, dueDate: body.dueDate, notes: body.notes, issue: Boolean(body.issue), createdBy: by }, t)
    );
    return getInvoice(invoiceId);
  } catch (e) {
    throw asConflict(e);
  }
};

/**
 * POST /invoices/bulk { termId, classId?, dueDate?, issue? }: every pupil in the
 * class (or every class) who is billed for the term. One transaction per pupil,
 * so one problem doesn't stop the rest; each problem is reported with a reason.
 */
export const bulkGenerate = async (body = {}, { by = null } = {}) => {
  const term = await loadTerm(body.termId);
  cleanDueDate(body.dueDate); // fail before doing anything
  const classWhere = { isDeleted: false };
  if (body.classId != null && body.classId !== "") classWhere.classId = toId(body.classId, "Class");
  const classes = await Class.findAll({ where: classWhere, attributes: ["classId", "name", "isAlumni"], order: [["name", "ASC"]], raw: true });
  if (classWhere.classId && !classes.length) throw new AppError("Class not found", 404);
  const out = { created: 0, refreshed: 0, issued: 0, skipped: [], errors: [] };
  for (const c of classes) {
    if (c.isAlumni) continue;
    const pupils = await Student.findAll({
      where: { classId: c.classId, isDeleted: false },
      attributes: ["studentId", "fName", "mName", "lName"],
      order: [["studentId", "ASC"]],
      raw: true,
    });
    for (const p of pupils) {
      try {
        const r = await sequelize.transaction((t) =>
          generateInTx({ studentId: p.studentId, term, dueDate: body.dueDate, notes: body.notes, issue: Boolean(body.issue), createdBy: by }, t)
        );
        if (r.action === "CREATED") out.created += 1;
        else out.refreshed += 1;
        if (body.issue) out.issued += 1;
      } catch (e) {
        const err = asConflict(e);
        const entry = { studentId: p.studentId, name: fullName(p), className: c.name, reason: err.message };
        if (err.code === "ALREADY_INVOICED" || err.code === "NOT_BILLED") out.skipped.push(entry);
        else if (err instanceof AppError) out.errors.push(entry);
        else {
          console.error("B14 bulk invoice failed", p.studentId, e);
          out.errors.push({ ...entry, reason: "Something went wrong for this pupil; nothing was saved for them." });
        }
      }
    }
  }
  return out;
};

/** POST /invoices/:id/issue { dueDate?, notes? } */
export const issueInvoice = async (id, body = {}, { by = null } = {}) => {
  const invoiceId = toId(id, "Invoice");
  const inv = await Invoice.findOne({ where: { invoiceId }, attributes: ["invoiceId", "studentId"], raw: true });
  if (!inv) throw new AppError("Invoice not found", 404);
  await sequelize.transaction(async (t) => {
    await lockPupil(inv.studentId, t); // pupil first, then the invoice (same order everywhere)
    await issueInTx(invoiceId, { dueDate: body.dueDate, notes: body.notes, issuedBy: by }, t);
  });
  return getInvoice(invoiceId);
};

/** POST /invoices/:id/void { reason }: cancels the document; the balance is untouched. */
export const voidInvoice = async (id, body = {}, { by = null } = {}) => {
  const invoiceId = toId(id, "Invoice");
  const reason = cleanReason(body.reason);
  const found = await Invoice.findOne({ where: { invoiceId }, attributes: ["invoiceId", "studentId"], raw: true });
  if (!found) throw new AppError("Invoice not found", 404);
  await sequelize.transaction(async (t) => {
    await lockPupil(found.studentId, t);
    const inv = await Invoice.findOne({ where: { invoiceId }, raw: true, transaction: t, ...lock(t) });
    if (inv.status === "VOID") throw new AppError(`${inv.invoiceNo || "This draft"} is already void`, 409);
    const live = await CreditNote.findAll({ where: { invoiceId, voidedAt: null }, attributes: ["creditNoteNo"], raw: true, transaction: t });
    if (live.length) {
      throw new AppError(`Void its credit note${live.length > 1 ? "s" : ""} first (${live.map((c) => c.creditNoteNo).join(", ")}): voiding the invoice would leave money credited against nothing.`, 409);
    }
    const [n] = await Invoice.update(
      { status: "VOID", voidedAt: new Date(), voidedBy: by, voidReason: reason },
      { where: { invoiceId, status: { [Op.ne]: "VOID" } }, transaction: t }
    );
    if (!n) throw new AppError("This invoice is already void", 409);
  });
  return getInvoice(invoiceId);
};

// ---------------------------------------------------------------- reading

const PAYMENT_ATTRS = ["feeId", "receiptNo", "paid", "datePaid", "paymentMode", "reversedAt"];

/** Everything an invoice screen / print needs. Pass forPortal to leave out office-only detail. */
const shapeInvoice = async (inv, { forPortal = false, transaction = null } = {}) => {
  const p = await Student.findOne({ where: { studentId: inv.studentId }, attributes: PUPIL_ATTRS, raw: true, transaction });
  const lines = await InvoiceLine.findAll({ where: { invoiceId: inv.invoiceId }, order: [["position", "ASC"]], raw: true, transaction });
  const notes = await CreditNote.findAll({ where: { invoiceId: inv.invoiceId }, order: [["creditNoteId", "ASC"]], raw: true, transaction });
  const bills = await StudentTermBill.findAll({ where: { studentId: inv.studentId }, attributes: ["termId", "afterFeeId"], raw: true, transaction });
  const tl = await termLabels([inv.termId, ...bills.map((b) => b.termId)], { transaction });
  const upTo = periodEnd(inv, p, bills.map((b) => ({ ...b, term: tl.get(Number(b.termId)) || null })), tl.get(Number(inv.termId)));
  const payments = await Fee.findAll({
    where: { studentId: inv.studentId, feeId: { [Op.gt]: Number(inv.afterFeeId) || 0, ...(upTo != null ? { [Op.lte]: upTo } : {}) } },
    attributes: PAYMENT_ATTRS,
    order: [["feeId", "ASC"]],
    raw: true,
    transaction,
  });
  const k = inv.classId != null ? await Class.findOne({ where: { classId: inv.classId }, attributes: ["classId", "name"], raw: true, transaction }) : null;
  const current = isCurrentPeriod(inv, p);
  const live = inv.status !== "VOID";
  const out = {
    invoiceId: inv.invoiceId,
    invoiceNo: inv.invoiceNo,
    status: inv.status,
    displayStatus: displayStatus(inv, todayLocal()),
    studentId: inv.studentId,
    studentName: fullName(p),
    indexNumber: `STU/${inv.studentId}`,
    admissionNo: p?.admissionNo ?? null,
    classId: inv.classId,
    className: k?.name ?? null,
    termId: inv.termId,
    termLabel: tl.get(Number(inv.termId))?.label ?? null,
    arrears: round2(inv.arrears),
    subtotal: round2(inv.subtotal),
    discount: round2(inv.discount),
    total: round2(inv.total),
    amountPaid: round2(inv.amountPaid),
    amountCredited: round2(inv.amountCredited),
    // Bill changes after the invoice was made (fee edit, discount, a payment
    // from before the term reversed): the balance includes them.
    adjustment: round2(inv.adjustment),
    balance: round2(inv.balance),
    dueDate: inv.dueDate,
    issuedAt: inv.issuedAt,
    createdAt: inv.createdAt,
    current,
    currentOwing: p ? round2(p.feesOwing) : null,
    outOfDate: live && current && round2(inv.adjustment) !== 0,
    lines: lines.map((l) => ({ kind: l.kind, description: l.description, amount: round2(l.amount) })),
    payments: payments.map((f) => ({
      receiptNo: f.receiptNo,
      amount: round2(f.paid),
      datePaid: f.datePaid,
      paymentMode: f.paymentMode,
      reversed: Boolean(f.reversedAt),
      ...(forPortal ? {} : { feeId: f.feeId }),
    })),
    creditNotes: notes
      .filter((c) => !forPortal || !c.voidedAt)
      .map((c) => ({
        creditNoteId: c.creditNoteId,
        creditNoteNo: c.creditNoteNo,
        amount: round2(c.amount),
        createdAt: c.createdAt,
        void: Boolean(c.voidedAt),
        ...(forPortal ? {} : { reason: c.reason, createdBy: c.createdBy, voidedAt: c.voidedAt, voidedBy: c.voidedBy, voidReason: c.voidReason }),
      })),
  };
  if (!forPortal) {
    Object.assign(out, {
      notes: inv.notes,
      createdBy: inv.createdBy,
      issuedBy: inv.issuedBy,
      refreshedAt: inv.refreshedAt,
      voidedAt: inv.voidedAt,
      voidedBy: inv.voidedBy,
      voidReason: inv.voidReason,
    });
  } else {
    out.notes = inv.notes;
    // The portal shows the document only (office-side flags left out).
    delete out.outOfDate;
    delete out.current;
    delete out.currentOwing;
  }
  return out;
};

/** GET /invoices/:id */
export const getInvoice = async (id) => {
  const inv = await Invoice.findOne({ where: { invoiceId: toId(id, "Invoice") }, raw: true });
  if (!inv) throw new AppError("Invoice not found", 404);
  return shapeInvoice(inv);
};

const statusWhere = (status, today) => {
  if (!status) return {};
  const s = String(status).toUpperCase();
  if (!STATUSES.includes(s)) throw new AppError("Unknown status", 400);
  if (s === "OVERDUE") {
    return { status: ["ISSUED", "PARTIALLY_PAID"], dueDate: { [Op.lt]: today }, balance: { [Op.gt]: 0 } };
  }
  return { status: s };
};

/** GET /invoices?termId&classId&studentId&status&q&page&limit */
export const listInvoices = async (q = {}) => {
  const today = todayLocal();
  const where = { ...statusWhere(q.status, today) };
  if (q.termId) where.termId = toId(q.termId, "Term");
  if (q.classId) where.classId = toId(q.classId, "Class");
  if (q.studentId) where.studentId = toId(q.studentId, "Student");
  const search = String(q.q ?? "").trim();
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const idMatch = search.match(/^(?:stu\/)?(\d+)$/i);
    const nameIds = (
      await Student.findAll({
        where: { [Op.or]: [{ fName: { [Op.iLike]: like } }, { lName: { [Op.iLike]: like } }, { mName: { [Op.iLike]: like } }] },
        attributes: ["studentId"],
        limit: 500,
        raw: true,
      })
    ).map((s) => s.studentId);
    where[Op.or] = [
      { invoiceNo: { [Op.iLike]: like } },
      ...(nameIds.length ? [{ studentId: nameIds }] : []),
      ...(idMatch ? [{ studentId: Number(idMatch[1]) }] : []),
    ];
  }
  const paging = parsePagination(q, { maxLimit: 200 }) || { page: 1, limit: 50, offset: 0 };
  const { rows, count } = await Invoice.findAndCountAll({
    where,
    order: [["invoiceId", "DESC"]],
    limit: paging.limit,
    offset: paging.offset,
    raw: true,
  });
  const pupils = rows.length
    ? await Student.findAll({ where: { studentId: [...new Set(rows.map((r) => r.studentId))] }, attributes: PUPIL_ATTRS, raw: true })
    : [];
  const pupilById = new Map(pupils.map((p) => [Number(p.studentId), p]));
  const classIds = [...new Set(rows.map((r) => r.classId).filter((x) => x != null))];
  const classes = classIds.length ? await Class.findAll({ where: { classId: classIds }, attributes: ["classId", "name"], raw: true }) : [];
  const className = new Map(classes.map((c) => [Number(c.classId), c.name]));
  const tl = await termLabels(rows.map((r) => r.termId));
  const shaped = rows.map((inv) => {
    const p = pupilById.get(Number(inv.studentId));
    const current = isCurrentPeriod(inv, p);
    return {
      invoiceId: inv.invoiceId,
      invoiceNo: inv.invoiceNo,
      status: inv.status,
      displayStatus: displayStatus(inv, today),
      studentId: inv.studentId,
      studentName: fullName(p),
      className: inv.classId != null ? className.get(Number(inv.classId)) ?? null : null,
      termId: inv.termId,
      termLabel: tl.get(Number(inv.termId))?.label ?? null,
      total: round2(inv.total),
      amountPaid: round2(inv.amountPaid),
      amountCredited: round2(inv.amountCredited),
      adjustment: round2(inv.adjustment),
      balance: round2(inv.balance),
      dueDate: inv.dueDate,
      issuedAt: inv.issuedAt,
      current,
      outOfDate: inv.status !== "VOID" && current && round2(inv.adjustment) !== 0,
    };
  });
  return paginatedResponse("invoices", { rows: shaped, count }, paging);
};

/** GET /invoices/print?termId&classId: every issued invoice of a class for a term, ready to print. */
export const invoicesForPrint = async (q = {}) => {
  const termId = toId(q.termId, "Term");
  const classId = toId(q.classId, "Class");
  const rows = await Invoice.findAll({
    where: { termId, classId, status: LIVE_STATUSES },
    order: [["invoiceNo", "ASC"]],
    raw: true,
  });
  const out = [];
  for (const inv of rows) out.push(await shapeInvoice(inv)); // one at a time
  out.sort((a, b) => a.studentName.localeCompare(b.studentName));
  return { invoices: out };
};

// ---------------------------------------------------------------- portal

/** GET /portal/invoices: the signed-in pupil's issued invoices (no drafts, no void). */
export const portalInvoices = async (studentId) => {
  const id = toId(studentId, "Student");
  const today = todayLocal();
  const rows = await Invoice.findAll({ where: { studentId: id, status: LIVE_STATUSES }, order: [["invoiceId", "DESC"]], raw: true });
  const tl = await termLabels(rows.map((r) => r.termId));
  return rows.map((inv) => ({
    invoiceId: inv.invoiceId,
    invoiceNo: inv.invoiceNo,
    status: inv.status,
    displayStatus: displayStatus(inv, today),
    termLabel: tl.get(Number(inv.termId))?.label ?? null,
    total: round2(inv.total),
    amountPaid: round2(inv.amountPaid),
    amountCredited: round2(inv.amountCredited),
    adjustment: round2(inv.adjustment),
    balance: round2(inv.balance),
    dueDate: inv.dueDate,
    issuedAt: inv.issuedAt,
  }));
};

/** GET /portal/invoices/:id: one of the signed-in pupil's own issued invoices (404 for anyone else's). */
export const portalInvoice = async (studentId, id) => {
  const sid = toId(studentId, "Invoice");
  const inv = await Invoice.findOne({ where: { invoiceId: toId(id, "Invoice"), studentId: sid, status: LIVE_STATUSES }, raw: true });
  if (!inv) throw new AppError("Invoice not found", 404);
  return shapeInvoice(inv, { forPortal: true });
};

// ---------------------------------------------------------------- credit notes

/** The invoice after a committed change; null if that read fails (the change itself is saved). */
const invoiceAfterCommit = async (invoiceId) => {
  try {
    return await getInvoice(invoiceId);
  } catch (e) {
    console.error("B14: reading the invoice after a saved change failed", invoiceId, e);
    return null;
  }
};

/** POST /credit-notes { invoiceId, amount, reason } (Administrator). */
export const createCreditNote = async (body = {}, { by = null } = {}) => {
  const invoiceId = toId(body.invoiceId, "Invoice");
  const amount = validateCreditAmount(body.amount);
  const reason = cleanReason(body.reason);
  // The screen sends one key per dialog: the same request twice (double tap,
  // retry after a lost answer) makes ONE credit note.
  const requestId = body.requestId == null || body.requestId === "" ? null : String(body.requestId).trim();
  if (requestId != null && !/^[A-Za-z0-9-]{8,64}$/.test(requestId)) throw new AppError("Invalid request id", 400);
  const replay = async () => {
    const done = requestId ? await CreditNote.findOne({ where: { requestId }, raw: true }) : null;
    if (!done) return null;
    if (Number(done.invoiceId) !== invoiceId || round2(done.amount) !== amount) throw new AppError("This request was already used for a different credit note", 409);
    const p = await Student.findOne({ where: { studentId: done.studentId }, attributes: ["feesOwing"], raw: true });
    return { creditNote: { ...done, amount: round2(done.amount) }, owing: round2(p?.feesOwing ?? 0), invoice: await invoiceAfterCommit(invoiceId), replayed: true };
  };
  const earlier = await replay();
  if (earlier) return earlier;
  const found = await Invoice.findOne({ where: { invoiceId }, attributes: ["invoiceId", "studentId"], raw: true });
  if (!found) throw new AppError("Invoice not found", 404);
  const result = await sequelize.transaction(async (t) => {
    await lockPupil(found.studentId, t);
    // Same key already saved while we waited for the lock: the caller replays it below.
    if (requestId && (await CreditNote.findOne({ where: { requestId }, attributes: ["creditNoteId"], raw: true, transaction: t }))) return null;
    const before = await Invoice.findOne({ where: { invoiceId }, raw: true, transaction: t, ...lock(t) });
    if (before.status === "DRAFT") throw new AppError("Issue the invoice before giving a credit note against it", 409);
    if (before.status === "VOID") throw new AppError("This invoice is void: no credit note can be given against it", 409);
    // Fresh figures (also recalculates the invoice) before checking the limit.
    const now = await recomputeStudentOwing(found.studentId, { transaction: t });
    const pupil = await Student.findOne({ where: { studentId: found.studentId }, attributes: PUPIL_ATTRS, raw: true, transaction: t });
    const inv = await Invoice.findOne({ where: { invoiceId }, raw: true, transaction: t });
    if (!isCurrentPeriod(inv, pupil)) {
      throw new AppError(
        "Credit notes go on the pupil's current term invoice. This term's balance has already been carried into the next term: give the credit note on that invoice.",
        409
      );
    }
    const room = round2(Math.min(round2(inv.balance), round2(now.owing)));
    if (room <= 0) throw new AppError("Nothing is owed on this invoice, so there is nothing to credit", 409);
    if (amount > room) {
      throw new AppError(`The credit note (GH₵ ${amount.toFixed(2)}) is more than what is still owed (GH₵ ${room.toFixed(2)})`, 400);
    }
    const created = await CreditNote.create(
      {
        invoiceId,
        studentId: inv.studentId,
        termId: inv.termId,
        periodAfterFeeId: Number(pupil.feesPeriodAfterFeeId) || 0,
        amount,
        reason,
        createdBy: by,
        createdAt: new Date(),
        requestId,
      },
      { transaction: t }
    );
    const after = await recomputeStudentOwing(found.studentId, { transaction: t });
    const cn = await CreditNote.findOne({ where: { creditNoteId: plain(created).creditNoteId }, raw: true, transaction: t });
    return { creditNote: { ...cn, amount: round2(cn.amount) }, owing: after.owing };
  }).catch(async (e) => {
    // Two requests with the same key at once: the unique index stops the second.
    if (requestId && e instanceof UniqueConstraintError) return null;
    throw e;
  });
  if (!result) return (await replay()) || Promise.reject(new AppError("Look again: the credit note may already be saved", 409));
  return { ...result, invoice: await invoiceAfterCommit(invoiceId) };
};

/** POST /credit-notes/:id/void { reason } (Administrator): the amount goes back on the balance. */
export const voidCreditNote = async (id, body = {}, { by = null } = {}) => {
  const creditNoteId = toId(id, "Credit note");
  const reason = cleanReason(body.reason);
  const found = await CreditNote.findOne({ where: { creditNoteId }, raw: true });
  if (!found) throw new AppError("Credit note not found", 404);
  const result = await sequelize.transaction(async (t) => {
    const pupil = await lockPupil(found.studentId, t);
    const cn = await CreditNote.findOne({ where: { creditNoteId }, raw: true, transaction: t, ...lock(t) });
    if (cn.voidedAt) throw new AppError(`${cn.creditNoteNo} is already void`, 409);
    if (!isCurrentPeriod({ termId: cn.termId, afterFeeId: cn.periodAfterFeeId }, pupil)) {
      throw new AppError(
        `${cn.creditNoteNo} belongs to a term whose balance has already been carried into the next term, so it can't be voided now. Ask the developer to correct it.`,
        409
      );
    }
    const [n] = await CreditNote.update(
      { voidedAt: new Date(), voidedBy: by, voidReason: reason },
      { where: { creditNoteId, voidedAt: null }, transaction: t }
    );
    if (!n) throw new AppError(`${cn.creditNoteNo} is already void`, 409);
    const after = await recomputeStudentOwing(found.studentId, { transaction: t });
    return { creditNoteId, owing: after.owing };
  });
  return { ...result, invoice: await invoiceAfterCommit(found.invoiceId) };
};

/** GET /credit-notes?termId&status=ACTIVE|VOID&page&limit */
export const listCreditNotes = async (q = {}) => {
  const where = {};
  if (q.termId) where.termId = toId(q.termId, "Term");
  if (q.invoiceId) where.invoiceId = toId(q.invoiceId, "Invoice");
  if (q.status === "ACTIVE") where.voidedAt = null;
  else if (q.status === "VOID") where.voidedAt = { [Op.ne]: null };
  else if (q.status) throw new AppError("Unknown status", 400);
  const paging = parsePagination(q, { maxLimit: 200 }) || { page: 1, limit: 50, offset: 0 };
  const { rows, count } = await CreditNote.findAndCountAll({ where, order: [["creditNoteId", "DESC"]], limit: paging.limit, offset: paging.offset, raw: true });
  const invs = rows.length ? await Invoice.findAll({ where: { invoiceId: [...new Set(rows.map((r) => r.invoiceId))] }, attributes: ["invoiceId", "invoiceNo"], raw: true }) : [];
  const invNo = new Map(invs.map((i) => [Number(i.invoiceId), i.invoiceNo]));
  const pupils = rows.length ? await Student.findAll({ where: { studentId: [...new Set(rows.map((r) => r.studentId))] }, attributes: ["studentId", "fName", "mName", "lName"], raw: true }) : [];
  const name = new Map(pupils.map((p) => [Number(p.studentId), fullName(p)]));
  const tl = await termLabels(rows.map((r) => r.termId));
  // The total over every matching note (not just this page).
  const totalRow = await CreditNote.findAll({ where: { ...where, voidedAt: null }, attributes: [[sequelize.fn("COALESCE", sequelize.fn("SUM", sequelize.col("amount")), 0), "sum"]], raw: true });
  const shaped = rows.map((c) => ({
    creditNoteId: c.creditNoteId,
    creditNoteNo: c.creditNoteNo,
    invoiceId: c.invoiceId,
    invoiceNo: invNo.get(Number(c.invoiceId)) ?? null,
    studentId: c.studentId,
    studentName: name.get(Number(c.studentId)) ?? null,
    termLabel: tl.get(Number(c.termId))?.label ?? null,
    amount: round2(c.amount),
    reason: c.reason,
    createdBy: c.createdBy,
    createdAt: c.createdAt,
    void: Boolean(c.voidedAt),
    voidedAt: c.voidedAt,
    voidedBy: c.voidedBy,
    voidReason: c.voidReason,
  }));
  return { ...paginatedResponse("creditNotes", { rows: shaped, count }, paging), activeTotal: q.status === "VOID" ? 0 : round2(totalRow?.[0]?.sum ?? 0) };
};
