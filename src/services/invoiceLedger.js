import { Op } from "sequelize";
import { CreditNote, Fee, Invoice, Student, StudentTermBill, Term } from "../models/index.js";
import { round2, sumMoney } from "../utils/money.js";
import { termKey } from "./feeBill.js";

// ---------------------------------------------------------------------------
// B14: how invoices and credit notes meet the fee-period balance.
// No imports from fee.js (fee.js calls this; avoids an import cycle).
//
// CREDIT NOTES change what a pupil owes. A credit note counts in the pupil's
// CURRENT fee period only (same term_id + period_after_fee_id as the period):
//   owing = opening + (bill - bill_at_start) - payments in period - credit notes in period
// When the next period starts (billing the next term, promotion), the owing
// with the credit already off becomes the new opening balance, so the credit
// is carried, never counted twice and never lost.
//
// INVOICES never change what a pupil owes. Each one belongs to the fee period
// it was made from (term + after_fee_id). Its figures are recalculated here
// every time the pupil's balance is (payment, reversal, credit note, fee edit,
// billing a new term), which is SchoolPro's missing step.
// While it is the pupil's CURRENT period:
//   paid       = the pupil's non-reversed payments in the period (fee_id > after_fee_id)
//   credited   = the invoice's credit notes that are not void
//   balance    = Student.feesOwing (what the pupil really owes, below 0 = credit)
//   adjustment = balance - (total - paid - credited): bill changes since the
//                invoice was made (a fee edited, a discount, a payment from
//                before the term reversed). Normally 0; shown as its own line.
// Once the next period starts (next term billed, promotion) the invoice is
// FROZEN at what it carried forward (the last recalculation while it was
// current ran inside startFeePeriod, before the new period began): later
// changes belong to the new period's invoice. An invoice made for a term that
// is already past is worked out once, from the payments in its period
// (fee_id after its start, up to where the next period began).
// ---------------------------------------------------------------------------

/** Statuses recalculation never changes. */
const FIXED = new Set(["DRAFT", "VOID"]);

/**
 * Pure: the status an issued invoice has from its figures.
 * current = it belongs to the pupil's current fee period.
 */
export const invoiceStatus = ({ status, balance, paid, credited, current }) => {
  if (FIXED.has(status)) return status;
  if (round2(balance) <= 0) return "PAID";
  if (!current) return "CARRIED_FORWARD"; // what is left went into the next term's balance
  if (round2(paid) > 0 || round2(credited) > 0) return "PARTIALLY_PAID";
  return "ISSUED";
};

/** Pure: OVERDUE is shown, not stored: issued, money still owed, past the due date. */
export const displayStatus = (inv, today) => {
  if (
    (inv.status === "ISSUED" || inv.status === "PARTIALLY_PAID") &&
    inv.dueDate &&
    String(inv.dueDate).slice(0, 10) < today &&
    round2(inv.balance) > 0
  ) {
    return "OVERDUE";
  }
  return inv.status;
};

/** Pure: is this invoice (or credit note: { termId, afterFeeId }) in the pupil's current period? */
export const isCurrentPeriod = (inv, pupil) =>
  pupil != null &&
  pupil.feesPeriodTermId != null &&
  Number(inv.termId) === Number(pupil.feesPeriodTermId) &&
  Number(inv.afterFeeId) === (Number(pupil.feesPeriodAfterFeeId) || 0);

/**
 * Pure: where the invoice's period ends (the last fee_id it counts), or null
 * while it is the current period. Periods after it started at a later term's
 * bill (Student_term_bill.after_fee_id) or, for the current period, at the
 * pupil's fees_period_after_fee_id.
 * bills = [{ termId, afterFeeId, term: { termId, startDate } }]
 */
export const periodEnd = (inv, pupil, bills, invTerm) => {
  if (isCurrentPeriod(inv, pupil)) return null;
  const after = Number(inv.afterFeeId) || 0;
  const key = termKey(invTerm || { termId: inv.termId });
  const starts = bills
    .filter((b) => Number(b.termId) !== Number(inv.termId) && b.term && termKey(b.term) > key)
    .map((b) => Number(b.afterFeeId) || 0);
  starts.push(Number(pupil?.feesPeriodAfterFeeId) || 0);
  const later = starts.filter((x) => x >= after);
  return later.length ? Math.min(...later) : after;
};

/**
 * Credit notes (not void) in the pupil's current period. Inside the caller's
 * transaction (the pupil is locked there).
 */
export const periodCredits = async (pupil, { transaction = null } = {}) => {
  if (pupil?.feesPeriodTermId == null) return 0;
  const rows =
    (await CreditNote.findAll({
      where: {
        studentId: pupil.studentId,
        termId: pupil.feesPeriodTermId,
        periodAfterFeeId: Number(pupil.feesPeriodAfterFeeId) || 0,
        voidedAt: null,
      },
      attributes: ["amount"],
      raw: true,
      transaction,
    })) || [];
  return sumMoney(rows, "amount");
};

/**
 * Recalculate the pupil's invoices (not void): the current period's live, and
 * `include` (ids of invoices just made for a past term) once from their
 * period. Call inside the transaction that changed the balance, after
 * Student.fees_owing is written (recomputeStudentOwing does). One query at a
 * time (they share the transaction's connection).
 */
export const recalcStudentInvoices = async (studentId, { transaction = null, include = [] } = {}) => {
  const invoices =
    (await Invoice.findAll({
      where: { studentId, status: { [Op.ne]: "VOID" } },
      raw: true,
      transaction,
    })) || [];
  if (!invoices.length) return [];

  const pupil = await Student.findOne({
    where: { studentId },
    attributes: ["studentId", "feesOwing", "feesPeriodTermId", "feesPeriodAfterFeeId"],
    raw: true,
    transaction,
  });
  const fresh = new Set(include.map(Number));
  const work = invoices.filter((i) => isCurrentPeriod(i, pupil) || fresh.has(Number(i.invoiceId)));
  const frozen = invoices.filter((i) => !work.includes(i));

  const out = [];
  // Frozen (a past period): only the status follows (e.g. ISSUED -> CARRIED_FORWARD).
  for (const inv of frozen) {
    const status = invoiceStatus({ status: inv.status, balance: inv.balance, paid: inv.amountPaid, credited: inv.amountCredited, current: false });
    if (status !== inv.status) await Invoice.update({ status }, { where: { invoiceId: inv.invoiceId }, transaction });
    out.push({ ...inv, status });
  }
  if (!work.length) return out;

  const needsWindows = work.some((i) => !isCurrentPeriod(i, pupil));
  const bills = needsWindows ? (await StudentTermBill.findAll({ where: { studentId }, attributes: ["termId", "afterFeeId"], raw: true, transaction })) || [] : [];
  const termIds = [...new Set([...bills.map((b) => Number(b.termId)), ...work.map((i) => Number(i.termId))])];
  const terms = needsWindows ? (await Term.findAll({ where: { termId: termIds }, attributes: ["termId", "startDate"], raw: true, transaction })) || [] : [];
  const termById = new Map(terms.map((t) => [Number(t.termId), t]));
  const billsWithTerms = bills.map((b) => ({ ...b, term: termById.get(Number(b.termId)) || null }));

  const firstAfter = Math.min(...work.map((i) => Number(i.afterFeeId) || 0));
  const payments =
    (await Fee.findAll({
      where: { studentId, reversedAt: null, feeId: { [Op.gt]: firstAfter } },
      attributes: ["feeId", "paid"],
      raw: true,
      transaction,
    })) || [];
  const credits =
    (await CreditNote.findAll({
      where: { invoiceId: work.map((i) => i.invoiceId), voidedAt: null },
      attributes: ["invoiceId", "amount"],
      raw: true,
      transaction,
    })) || [];

  for (const inv of work) {
    const current = isCurrentPeriod(inv, pupil);
    const after = Number(inv.afterFeeId) || 0;
    const upTo = current ? null : periodEnd(inv, pupil, billsWithTerms, termById.get(Number(inv.termId)));
    const paid = sumMoney(payments.filter((p) => Number(p.feeId) > after && (upTo == null || Number(p.feeId) <= upTo)), "paid");
    const credited = sumMoney(credits.filter((c) => Number(c.invoiceId) === Number(inv.invoiceId)), "amount");
    const fromInvoice = round2(round2(inv.total) - paid - credited);
    // The current period's balance is what the pupil owes; the difference is the adjustment.
    const balance = current && pupil ? round2(pupil.feesOwing) : fromInvoice;
    const adjustment = round2(balance - fromInvoice);
    const status = invoiceStatus({ status: inv.status, balance, paid, credited, current });
    const next = { amountPaid: paid, amountCredited: credited, adjustment, balance, status };
    if (
      round2(inv.amountPaid) !== paid ||
      round2(inv.amountCredited) !== credited ||
      round2(inv.adjustment) !== adjustment ||
      round2(inv.balance) !== balance ||
      inv.status !== status
    ) {
      await Invoice.update(next, { where: { invoiceId: inv.invoiceId }, transaction });
    }
    out.push({ ...inv, ...next });
  }
  return out;
};
