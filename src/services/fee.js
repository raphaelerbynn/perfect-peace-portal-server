import { Class, ClassFee, Fee, FeeCheck, Student, StudentFee, Term } from "../models/index.js";
import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { AppError } from "../utils/errorHandling.js";
import { isPesewaAmount, round2, sumMoney } from "../utils/money.js";
import { computeDiscounts, discountsForTerm } from "./feeBill.js";
import { periodCredits, recalcStudentInvoices } from "./invoiceLedger.js";

// BE-1: a payment amount must be a finite number > 0. (Mirrors
// studentFees.validateAmount; defined locally to avoid a circular import.)
const validatePaymentAmount = (amount) => {
  const num = Number(amount);
  if (amount == null || amount === "" || !Number.isFinite(num)) {
    throw new AppError("Payment amount is required and must be a number", 400);
  }
  if (num <= 0) {
    throw new AppError("Payment amount must be a positive number", 400);
  }
  // Cedis and pesewas (migration 012: NUMERIC(18,2)). A third decimal place
  // would be rounded by the database, so refuse it instead.
  if (!isPesewaAmount(num)) {
    throw new AppError("Enter the payment with at most 2 decimal places (cedis and pesewas).", 400);
  }
  return round2(num);
};

// BE-4: a payment must reference an existing, non-archived student.
const ensureStudentExists = async (studentId, transaction = null) => {
  if (studentId == null || studentId === "") {
    throw new AppError("studentId is required", 400);
  }
  const student = await Student.findOne({
    where: { studentId, isDeleted: false },
    // B13: lock the student row for the rest of the payment transaction, so two
    // payments recorded at the same moment are checked one after the other
    // (otherwise both pass the "not more than the balance" check together).
    ...(transaction ? { transaction, lock: transaction.LOCK?.UPDATE } : {}),
  });
  if (!student) {
    throw new AppError("Student not found", 400);
  }
  return student;
};

// Single authoritative recomputation of a pupil's cached `feesPaid` /
// `feesOwing`, from the underlying rows, inside the caller's transaction.
//
// FEE PERIODS (migration 008): balances carry over from the live system.
//   bill            = sum(ClassFee for the pupil's current class) + sum(StudentFee)
//   paidInPeriod    = non-reversed payments with fee_id > feesPeriodAfterFeeId
//   feesOwing       = feesOpeningBalance + (bill - feesBillAtStart) - paidInPeriod
//                     (below 0 = the pupil is in credit; live has such pupils,
//                     and the credit must carry over, not vanish on recompute)
//   feesPaid        = feesPaidAtStart + paidInPeriod
// So at go-live nothing changes (opening = live balance, bill_at_start = the
// bill then); a class fee added later adds to what pupils owe; correcting a
// pupil's class swaps the old bill for the new one; promotion starts a new
// period (startFeePeriod). Owing never goes below 0 (overpayment is refused).
//
// B12: bill = fee items - the pupil's discounts for the period's term
// (feesPeriodTermId; a period with no term yet has no discounts). Billing a
// term starts its period (services/termBilling.js).
// B14: owing also subtracts the period's credit notes, and the pupil's
// invoices are recalculated (services/invoiceLedger.js).
export const recomputeStudentOwing = async (studentId, { transaction = null } = {}) => {
  if (studentId == null) return null;

  // Lock the pupil (inside a transaction) so a payment, reversal or fee change
  // happening at the same moment can't be left out of the balance.
  const student = await Student.findOne({
    where: { studentId },
    attributes: ["studentId", "classId", "feesOpeningBalance", "feesBillAtStart", "feesPaidAtStart", "feesPeriodAfterFeeId", "feesPeriodTermId"],
    raw: true,
    transaction,
    ...(transaction?.LOCK ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!student) return null;

  const after = Number(student.feesPeriodAfterFeeId) || 0;
  // One query at a time: inside a transaction they share one connection.
  const classFees =
    student.classId != null
      ? await ClassFee.findAll({ where: { classId: student.classId }, attributes: ["name", "amount"], raw: true, transaction })
      : [];
  const studentFees = await StudentFee.findAll({ where: { studentId }, attributes: ["name", "amount"], raw: true, transaction });
  // B12: the pupil's discounts for the term this period bills.
  const discounts =
    student.feesPeriodTermId != null
      ? (await discountsForTerm([studentId], student.feesPeriodTermId, { transaction })).get(Number(studentId)) || []
      : [];
  // B13: reversed payments no longer count; only this period's payments.
  const fees = await Fee.findAll({ where: { studentId, reversedAt: null, feeId: { [Op.gt]: after } }, attributes: ["paid"], raw: true, transaction });

  // Summed to the pesewa (amounts can have decimals since migration 012).
  const billed = computeDiscounts([...classFees, ...studentFees], discounts).net;
  const paidInPeriod = sumMoney(fees, "paid");
  const opening = Number(student.feesOpeningBalance) || 0;
  const billAtStart = Number(student.feesBillAtStart) || 0;
  // B14: credit notes made in this period come off what is owed (not "paid").
  const credits = await periodCredits(student, { transaction });
  const owing = round2(opening + (billed - billAtStart) - paidInPeriod - credits); // < 0 = in credit, kept
  const paid = round2((Number(student.feesPaidAtStart) || 0) + paidInPeriod);

  await Student.update(
    { feesPaid: paid, feesOwing: owing },
    { where: { studentId }, transaction }
  );
  // B14: the pupil's invoices follow every change to the balance.
  await recalcStudentInvoices(studentId, { transaction });

  return { billed, paid, owing };
};

/**
 * Start a new fee period (promotion / start of a new year): what is still owed
 * carries over as arrears, the new class's bill is then added in full, and
 * "paid" counts from now — the live system's behaviour on a class change, but
 * keeping arrears instead of dropping them. Call BEFORE moving the pupil, then
 * recomputeStudentOwing after the move.
 */
export const startFeePeriod = async (studentId, { transaction = null, termId = null, unlessBilledAfter = null } = {}) => {
  // B12: promotion passes its term's start date. A pupil already billed for a
  // LATER term (the office billed the new term before accepting promotion)
  // keeps that period: the class change just swaps the bill, no second bill.
  if (unlessBilledAfter) {
    const s = await Student.findOne({ where: { studentId }, attributes: ["studentId", "feesPeriodTermId"], raw: true, transaction });
    if (s?.feesPeriodTermId != null) {
      const billedTerm = await Term.findOne({ where: { termId: s.feesPeriodTermId }, attributes: ["termId", "startDate"], raw: true, transaction });
      if (billedTerm?.startDate && String(billedTerm.startDate).slice(0, 10) > String(unlessBilledAfter).slice(0, 10)) {
        return { arrears: null, skipped: true };
      }
    }
  }
  const now = await recomputeStudentOwing(studentId, { transaction });
  if (!now) return null;
  const [[{ maxId }]] = await sequelize.query(`SELECT COALESCE(MAX(fee_id), 0) AS "maxId" FROM "dbo"."Fee"`, { transaction });
  await Student.update(
    {
      feesOpeningBalance: now.owing,
      feesBillAtStart: 0,
      feesPaidAtStart: 0,
      feesPeriodAfterFeeId: Number(maxId) || 0,
      feesPeriodStartedAt: new Date(),
      // B12: the term this period bills (null = started by promotion; the
      // next term billed takes it over).
      feesPeriodTermId: termId ?? null,
    },
    { where: { studentId }, transaction }
  );
  return { arrears: now.owing, afterFeeId: Number(maxId) || 0 };
};

const createFee = async (data, { recordedBy = null } = {}) => {
  // BE-1/BE-2/BE-4: record the payment AND reconcile the student's cached owing
  // from the underlying rows in ONE transaction. Previously the payment amount
  // was written straight from the request with no validation (a negative/NaN
  // payment corrupted owing) and overpayment was silently accepted (owing went
  // negative). Now: validate amount > 0, verify the student exists, reject any
  // payment that exceeds the current balance, then persist + recompute.
  const amount = validatePaymentAmount(data?.currentPaid);

  return await sequelize.transaction(async (t) => {
    await ensureStudentExists(data?.studentId, t);

    // BE-2: current owing BEFORE this payment (recompute also self-heals the
    // cached columns). Reject anything larger than the outstanding balance.
    const { owing } = await recomputeStudentOwing(data.studentId, { transaction: t });
    if (amount > owing) {
      throw new AppError(
        `Payment (GHc${amount}) exceeds the outstanding balance (GHc${owing})`,
        400
      );
    }

    // The payment counts toward the open term (Fees page totals by term).
    const openTerm = await Term.findOne({ where: { active: true }, attributes: ["termId", "term"], raw: true, transaction: t });
    const response = await Fee.create(
      {
        termId: openTerm?.termId ?? null,
        studentId: data?.studentId,
        classId: data?.classId,
        total: data?.total,
        paid: amount,
        // BE-2: store the server-computed remaining, not the client's value.
        remaining: round2(owing - amount),
        paymentMode: data?.paymentMode,
        amountInWords: data?.amountInWords,
        datePaid: data?.datePaid,
        term: data?.term ?? openTerm?.term ?? null,
        // B13: receipt_no is assigned by the database; record who took the money.
        recordedBy,
      },
      { transaction: t }
    );

    // BE-3: recompute and surface the authoritative owing so the controller can
    // build the confirmation SMS from it (not the forgeable client `remaining`).
    const recompute = await recomputeStudentOwing(data.studentId, { transaction: t });

    const result = typeof response.toJSON === "function" ? response.toJSON() : response;
    result.owing = recompute.owing;
    result.feesPaid = recompute.paid;
    return result;
  });
}

export const REVERSAL_REASON_MIN = 5;
export const REVERSAL_REASON_MAX = 500;

// B13: reverse a payment entered by mistake. The row is KEPT (receipt number
// stays used, audit trail intact) and marked reversed; the student's balance is
// recomputed without it. Claimed atomically: two people reversing the same
// payment at once -> exactly one succeeds, the other gets 409.
const reverseFee = async (id, { reason, reversedBy = null } = {}) => {
  if (!/^\d+$/.test(String(id ?? ""))) throw new AppError("Fee payment not found", 404);
  const cleanReason = String(reason ?? "").trim();
  if (cleanReason.length < REVERSAL_REASON_MIN) {
    throw new AppError(`Give a reason for the reversal (at least ${REVERSAL_REASON_MIN} characters)`, 400);
  }
  if (cleanReason.length > REVERSAL_REASON_MAX) {
    throw new AppError(`The reason must be ${REVERSAL_REASON_MAX} characters or fewer`, 400);
  }

  return await sequelize.transaction(async (t) => {
    const existing = await Fee.findOne({ where: { feeId: id }, transaction: t });
    if (!existing) {
      throw new AppError("Fee payment not found", 404);
    }
    if (existing.reversedAt) {
      throw new AppError(`Receipt ${existing.receiptNo} was already reversed`, 409);
    }
    // Lock the pupil like createFee does, so a payment recorded at the same
    // moment can't be left out of the recomputed balance.
    if (existing.studentId != null) {
      await Student.findOne({ where: { studentId: existing.studentId }, attributes: ["studentId"], transaction: t, lock: t.LOCK?.UPDATE });
    }

    const [claimed] = await Fee.update(
      { reversedAt: new Date(), reversedBy, reversalReason: cleanReason },
      { where: { feeId: id, reversedAt: null }, transaction: t }
    );
    if (claimed === 0) {
      // Someone else reversed it between our read and our update.
      throw new AppError(`Receipt ${existing.receiptNo} was already reversed`, 409);
    }

    // A payment from before the pupil's current fee period (e.g. paid on the
    // live system before go-live) is inside the opening balance, not the
    // period's payments: reversing it puts the money back on what is owed.
    if (existing.studentId != null) {
      const p = await Student.findOne({
        where: { studentId: existing.studentId },
        attributes: ["feesPeriodAfterFeeId", "feesOpeningBalance", "feesPaidAtStart"],
        raw: true,
        transaction: t,
      });
      if (p && Number(existing.feeId) <= (Number(p.feesPeriodAfterFeeId) || 0)) {
        const amount = Number(existing.paid) || 0;
        await Student.update(
          {
            feesOpeningBalance: (Number(p.feesOpeningBalance) || 0) + amount,
            feesPaidAtStart: Math.max(0, (Number(p.feesPaidAtStart) || 0) - amount),
          },
          { where: { studentId: existing.studentId }, transaction: t }
        );
      }
    }
    const recompute = existing.studentId != null
      ? await recomputeStudentOwing(existing.studentId, { transaction: t })
      : null;

    const updated = await Fee.findOne({ where: { feeId: id }, transaction: t });
    const result = typeof updated.toJSON === "function" ? updated.toJSON() : updated;
    result.owing = recompute?.owing ?? null;
    return result;
  });
};

// B13: payment rows for the admin list, each with the payer's name and class
// (the admin page used to look names up in a paged student list, so most rows
// showed "—").
const LIST_INCLUDE = [
  { model: Student, as: "student", attributes: ["fName", "mName", "lName"], required: false },
  { model: Class, as: "class", attributes: ["name"], required: false },
];
const withNames = (rows) =>
  rows.map((row) => {
    const { student, class: klass, ...fee } = typeof row.toJSON === "function" ? row.toJSON() : row;
    return {
      ...fee,
      studentName: student ? [student.fName, student.mName, student.lName].filter(Boolean).join(" ") : null,
      className: klass?.name ?? null,
    };
  });

// B13: everything a printed receipt needs, in one call.
const getOneFee = async (id) => {
  if (!/^\d+$/.test(String(id ?? ""))) throw new AppError("Fee payment not found", 404);
  const fee = await Fee.findOne({ where: { feeId: id }, raw: true });
  if (!fee) throw new AppError("Fee payment not found", 404);

  const [student, klass] = await Promise.all([
    fee.studentId != null
      ? Student.findOne({
          where: { studentId: fee.studentId },
          attributes: ["studentId", "fName", "mName", "lName", "class", "feesOwing"],
          raw: true,
        })
      : null,
    fee.classId != null
      ? Class.findOne({ where: { classId: fee.classId }, attributes: ["classId", "name"], raw: true })
      : null,
  ]);

  return {
    ...fee,
    studentName: student ? [student.fName, student.mName, student.lName].filter(Boolean).join(" ") : null,
    indexNumber: student ? `STU/${student.studentId}` : null,
    className: klass?.name ?? student?.class ?? null,
    currentOwing: student ? Number(student.feesOwing ?? 0) : null,
  };
};

const getFeesData = async (data) => {
  // console.log(data)
  // B13: look up a receipt by its number (partial, case-insensitive).
  if (data?.receiptNo) {
    return withNames(await Fee.findAll({
      // % and _ are LIKE wildcards: match them literally.
      where: { receiptNo: { [Op.iLike]: `%${String(data.receiptNo).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` } },
      include: LIST_INCLUDE,
      order: [["feeId", "DESC"]],
      limit: 50,
    }));
  }
  // Reversed payments ARE returned (flagged by reversedAt) so the list can show
  // them struck through; every total must skip them.
  if (data.all === "true") {
    return withNames(await Fee.findAll({ include: LIST_INCLUDE }));
  } else {
    // BE-6: validate the date params up front. Previously a missing/garbage date
    // made `new Date(...).toISOString()` throw a RangeError -> opaque 500.
    const start = new Date(data.startDate);
    const end = new Date(data.endDate);
    if (
      !data.startDate || !data.endDate ||
      Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())
    ) {
      throw new AppError("Valid startDate and endDate are required", 400);
    }
    // BE-D11: parameterized date filter (mirrors getProfitLoss in graph.js).
    // Inclusive range on the `datePaid` column. Normalize to YYYY-MM-DD so the
    // bounds line up with the DATEONLY-style values stored in `date_paid`.
    const startDate = start.toISOString().slice(0, 10);
    const endDate = end.toISOString().slice(0, 10);
    return withNames(await Fee.findAll({
      where: {
        datePaid: {
          [Op.between]: [startDate, endDate],
        },
      },
      include: LIST_INCLUDE,
    }));
  }
};

const getFeeCheck = async () => {
  return await FeeCheck.findAll({
    attributes: ["value"],
  });
};

const getLastFee = async (indexNumber) => {
    // BE-10: await the query (was returning an unresolved promise). Shape kept
    // as a 1-element array for parent-app back-compat.
    const lastFee = await Fee.findAll({
      where: {
        studentId: indexNumber,
        reversedAt: null, // B13: a reversed payment is not "the last payment"
      },
      limit: 1,
      order: [['fee_id', 'DESC']]
    });

    return lastFee;
};

export { createFee, reverseFee, getFeeCheck, getLastFee, getFeesData, getOneFee };
