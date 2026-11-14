import { ClassFee, Fee, FeeCheck, Student, StudentFee, Term } from "../models/index.js";
import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { AppError } from "../utils/errorHandling.js";
import { isPesewaAmount, round2, sumMoney } from "../utils/money.js";

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
    // Lock the student row for the rest of the payment transaction, so two
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
//   paidInPeriod    = payments with fee_id > feesPeriodAfterFeeId
//   feesOwing       = feesOpeningBalance + (bill - feesBillAtStart) - paidInPeriod
//                     (below 0 = the pupil is in credit; live has such pupils,
//                     and the credit must carry over, not vanish on recompute)
//   feesPaid        = feesPaidAtStart + paidInPeriod
// So at go-live nothing changes (opening = live balance, bill_at_start = the
// bill then); a class fee added later adds to what pupils owe; correcting a
// pupil's class swaps the old bill for the new one; promotion starts a new
// period (startFeePeriod). Owing never goes below 0 (overpayment is refused).
export const recomputeStudentOwing = async (studentId, { transaction = null } = {}) => {
  if (studentId == null) return null;

  // Lock the pupil (inside a transaction) so a payment, deletion or fee change
  // happening at the same moment can't be left out of the balance.
  const student = await Student.findOne({
    where: { studentId },
    attributes: ["studentId", "classId", "feesOpeningBalance", "feesBillAtStart", "feesPaidAtStart", "feesPeriodAfterFeeId"],
    raw: true,
    transaction,
    ...(transaction?.LOCK ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!student) return null;

  const after = Number(student.feesPeriodAfterFeeId) || 0;
  // One query at a time: inside a transaction they share one connection.
  const classFees =
    student.classId != null
      ? await ClassFee.findAll({ where: { classId: student.classId }, attributes: ["amount"], raw: true, transaction })
      : [];
  const studentFees = await StudentFee.findAll({ where: { studentId }, attributes: ["amount"], raw: true, transaction });
  // Only this period's payments.
  const fees = await Fee.findAll({ where: { studentId, feeId: { [Op.gt]: after } }, attributes: ["paid"], raw: true, transaction });

  // Summed to the pesewa (amounts can have decimals since migration 012).
  const billed = round2(sumMoney(classFees, "amount") + sumMoney(studentFees, "amount"));
  const paidInPeriod = sumMoney(fees, "paid");
  const opening = Number(student.feesOpeningBalance) || 0;
  const billAtStart = Number(student.feesBillAtStart) || 0;
  const owing = round2(opening + (billed - billAtStart) - paidInPeriod); // < 0 = in credit, kept
  const paid = round2((Number(student.feesPaidAtStart) || 0) + paidInPeriod);

  await Student.update(
    { feesPaid: paid, feesOwing: owing },
    { where: { studentId }, transaction }
  );

  return { billed, paid, owing };
};

/**
 * Start a new fee period (promotion / start of a new year): what is still owed
 * carries over as arrears, the new class's bill is then added in full, and
 * "paid" counts from now — the live system's behaviour on a class change, but
 * keeping arrears instead of dropping them. Call BEFORE moving the pupil, then
 * recomputeStudentOwing after the move.
 */
export const startFeePeriod = async (studentId, { transaction = null } = {}) => {
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
    },
    { where: { studentId }, transaction }
  );
  return { arrears: now.owing, afterFeeId: Number(maxId) || 0 };
};

const createFee = async (data) => {
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

const removeFee = async (id) => {
  // BE-D3: deleting a payment must RESTORE the balance. Read the row first to
  // know which student to reconcile, delete, then recompute — all atomically.
  if (!/^\d+$/.test(String(id ?? ""))) throw new AppError("Fee payment not found", 404);
  return await sequelize.transaction(async (t) => {
    const existing = await Fee.findOne({ where: { feeId: id }, transaction: t });
    // BE-5: distinguish "deleted" from "didn't exist" — 404 instead of a silent
    // 200/0 with no recompute.
    if (!existing) {
      throw new AppError("Fee payment not found", 404);
    }
    const studentId = existing.studentId;
    // Lock the pupil like createFee does, so a payment recorded at the same
    // moment can't be left out of the recomputed balance.
    const p = studentId != null
      ? await Student.findOne({
          where: { studentId },
          attributes: ["studentId", "feesPeriodAfterFeeId", "feesOpeningBalance", "feesPaidAtStart"],
          raw: true,
          transaction: t,
          lock: t.LOCK?.UPDATE,
        })
      : null;

    const response = await Fee.destroy({ where: { feeId: id }, transaction: t });
    // Someone deleted it between our read and now (double click, two people):
    // the balance was already corrected once. Nothing more to do.
    if (response === 0) {
      throw new AppError("Fee payment not found", 404);
    }

    // A payment from before the pupil's current fee period (e.g. paid on the
    // live system before go-live) is inside the opening balance, not the
    // period's payments: deleting it puts the money back on what is owed.
    if (p && Number(existing.feeId) <= (Number(p.feesPeriodAfterFeeId) || 0)) {
      const amount = Number(existing.paid) || 0;
      await Student.update(
        {
          feesOpeningBalance: round2((Number(p.feesOpeningBalance) || 0) + amount),
          feesPaidAtStart: Math.max(0, round2((Number(p.feesPaidAtStart) || 0) - amount)),
        },
        { where: { studentId }, transaction: t }
      );
    }
    if (studentId != null) {
      await recomputeStudentOwing(studentId, { transaction: t });
    }

    return response;
  });
}

const getOneFee = async (id) => {
  const response = await Fee.findOne({
    where: {
      feeId: id
    }
  })
  return response;
}

const getFeesData = async (data) => {
  // console.log(data)
  if (data.all === "true") {
    return await Fee.findAll();
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
    return await Fee.findAll({
      where: {
        datePaid: {
          [Op.between]: [startDate, endDate],
        },
      },
    });
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
        studentId: indexNumber
      },
      limit: 1,
      order: [['fee_id', 'DESC']]
    });

    return lastFee;
};

export { createFee, removeFee, getFeeCheck, getLastFee, getFeesData, getOneFee };
