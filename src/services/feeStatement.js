import { Op } from "sequelize";
import { AcademicYear, Class, CreditNote, Fee, Student, StudentTermBill, Term } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { round2, sumMoney, toNum } from "../utils/money.js";
import { computeDiscounts, discountsForTerm } from "./feeBill.js";
import { periodItems } from "./classFeeShare.js";

// ---------------------------------------------------------------------------
// B12: a pupil's fee statement, term by term:
//   arrears brought in + the term's items - discounts - payments = balance.
// Past terms come from their saved bills (Student_term_bill); the current
// period uses the live figures, so its balance is exactly Student.feesOwing.
// Payments are placed in the period they were made in (by fee_id, the same rule
// as the balance). Reversed payments are listed but never counted (B13).
// B14: credit notes come off like payments (void ones listed, not counted).
// ---------------------------------------------------------------------------

const fullName = (s) => [s.fName, s.mName, s.lName].filter(Boolean).join(" ");
const termLabel = (t, yearName) =>
  t ? `${t.term != null && String(t.term).trim() !== "" ? `Term ${String(t.term).trim()}` : "Term (no number)"}${yearName ? ` · ${yearName}` : ""}` : null;

/** Pure: payments with fee_id in (after, upTo] (upTo null = no upper bound). */
export const paymentsBetween = (payments, after, upTo) =>
  payments.filter((p) => Number(p.feeId) > Number(after || 0) && (upTo == null || Number(p.feeId) <= Number(upTo)));

export const getStatement = async (studentId) => {
  const id = Number(studentId);
  if (!Number.isInteger(id) || id <= 0) throw new AppError("Student not found", 404);
  const pupil = await Student.findOne({
    where: { studentId: id },
    attributes: [
      "studentId", "fName", "mName", "lName", "classId", "class", "feesOwing", "feesPaid",
      "feesOpeningBalance", "feesBillAtStart", "feesPeriodAfterFeeId", "feesPeriodTermId", "feesPeriodStartedAt",
    ],
    raw: true,
  });
  if (!pupil) throw new AppError("Student not found", 404);

  const bills = await StudentTermBill.findAll({ where: { studentId: id }, order: [["afterFeeId", "ASC"], ["studentTermBillId", "ASC"]], raw: true });
  const firstAfter = bills.length ? Number(bills[0].afterFeeId) : Number(pupil.feesPeriodAfterFeeId) || 0;
  const payments = await Fee.findAll({
    where: { studentId: id, feeId: { [Op.gt]: firstAfter } },
    attributes: ["feeId", "receiptNo", "paid", "datePaid", "paymentMode", "reversedAt"],
    order: [["feeId", "ASC"]],
    raw: true,
  });
  // B14: credit notes, placed in the period they were made in (term + period start).
  const creditRows = await CreditNote.findAll({
    where: { studentId: id },
    attributes: ["creditNoteId", "creditNoteNo", "invoiceId", "termId", "periodAfterFeeId", "amount", "createdAt", "voidedAt"],
    order: [["creditNoteId", "ASC"]],
    raw: true,
  });
  const creditsIn = (termId, after) =>
    creditRows.filter((c) => Number(c.termId) === Number(termId) && Number(c.periodAfterFeeId) === Number(after || 0));
  const shapeCredits = (list) =>
    list.map((c) => ({ creditNoteNo: c.creditNoteNo, amount: round2(c.amount), createdAt: c.createdAt, void: Boolean(c.voidedAt) }));
  const countedCredits = (list) => sumMoney(list.filter((c) => !c.voidedAt), "amount");
  const termIds = [...new Set([...bills.map((b) => b.termId), pupil.feesPeriodTermId].filter((x) => x != null))];
  const terms = termIds.length ? await Term.findAll({ where: { termId: termIds }, raw: true }) : [];
  const yearIds = [...new Set(terms.map((t) => t.academicYearId).filter((x) => x != null))];
  const years = yearIds.length ? await AcademicYear.findAll({ where: { academicYearId: yearIds }, attributes: ["academicYearId", "name"], raw: true }) : [];
  const yearName = new Map(years.map((y) => [Number(y.academicYearId), y.name]));
  const termById = new Map(terms.map((t) => [Number(t.termId), t]));
  const label = (termId) => {
    const t = termById.get(Number(termId));
    return t ? termLabel(t, yearName.get(Number(t.academicYearId))) : null;
  };
  const klass = pupil.classId != null ? await Class.findOne({ where: { classId: pupil.classId }, attributes: ["classId", "name"], raw: true }) : null;

  const shape = (list) =>
    list.map((p) => ({ feeId: p.feeId, receiptNo: p.receiptNo, amount: round2(p.paid), datePaid: p.datePaid, paymentMode: p.paymentMode, reversed: Boolean(p.reversedAt) }));
  const counted = (list) => sumMoney(list.filter((p) => !p.reversedAt), "paid");

  const currentAfter = Number(pupil.feesPeriodAfterFeeId) || 0;
  const opening = round2(pupil.feesOpeningBalance);
  // At go-live (and for an old-system period) the opening balance already
  // includes the bill then (bill_at_start): what was owed before it is the rest.
  const billAtStart = round2(pupil.feesBillAtStart);
  const currentArrears = round2(opening - billAtStart);

  // Past periods: each saved bill up to the next boundary. Each row reads
  //   arrears + bill - discounts (+ changes during the term) - payments = carried forward
  // and what it carries forward is exactly what the next row brought in, so the
  // last row ends on Student.feesOwing. "Changes" = what moved the balance
  // during the term other than the bill and payments (a fee edited, a class
  // corrected, a payment reversed later): normally 0.
  const boundaries = [...bills.map((b) => Number(b.afterFeeId)), currentAfter];
  const past = [];
  bills.forEach((b, i) => {
    const isCurrent = Number(b.afterFeeId) === currentAfter && Number(b.termId) === Number(pupil.feesPeriodTermId);
    if (isCurrent) return; // shown below with the live figures
    const upTo = boundaries.slice(i + 1).find((x) => x >= Number(b.afterFeeId)) ?? null;
    past.push({ b, paid: paymentsBetween(payments, b.afterFeeId, upTo) });
  });
  const periods = past.map(({ b, paid }, i) => {
    const arrears = round2(b.arrears);
    const due = round2(arrears + toNum(b.bill) - toNum(b.discount));
    const carried = i + 1 < past.length ? round2(past[i + 1].b.arrears) : currentArrears;
    const cns = creditsIn(b.termId, b.afterFeeId);
    return {
      termId: b.termId,
      label: label(b.termId),
      kind: b.kind,
      arrears,
      items: b.items || [],
      discounts: b.discounts || [],
      bill: round2(b.bill),
      discount: round2(b.discount),
      adjustment: round2(carried - (due - counted(paid) - countedCredits(cns))),
      payments: shape(paid),
      paid: counted(paid),
      creditNotes: shapeCredits(cns),
      credited: countedCredits(cns),
      balance: carried,
      current: false,
    };
  });

  // The current period, live.
  // B12 (048): a YEAR class fee is the period's term's share, labelled.
  const { items } = await periodItems(pupil);
  const disc =
    pupil.feesPeriodTermId != null
      ? (await discountsForTerm([id], pupil.feesPeriodTermId)).get(id) || []
      : [];
  const d = computeDiscounts(items, disc);
  const paidNow = paymentsBetween(payments, currentAfter, null);
  const cnsNow = pupil.feesPeriodTermId != null ? creditsIn(pupil.feesPeriodTermId, currentAfter) : [];
  periods.push({
    termId: pupil.feesPeriodTermId ?? null,
    label: label(pupil.feesPeriodTermId) || "Current (next term not billed yet)",
    kind: "CURRENT",
    arrears: currentArrears,
    openingBalance: opening,
    billAtStart,
    items,
    discounts: d.lines.filter((l) => l.amount > 0),
    bill: d.gross,
    discount: d.discount,
    adjustment: 0,
    payments: shape(paidNow),
    paid: counted(paidNow),
    creditNotes: shapeCredits(cnsNow),
    credited: countedCredits(cnsNow),
    balance: round2(pupil.feesOwing),
    current: true,
  });

  return {
    student: { studentId: id, name: fullName(pupil), indexNumber: `STU/${id}`, className: klass?.name ?? (pupil.class ? String(pupil.class).trim() : null) },
    owing: round2(pupil.feesOwing),
    periods,
  };
};
