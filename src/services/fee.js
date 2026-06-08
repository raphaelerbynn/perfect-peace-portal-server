import { ClassFee, Fee, FeeCheck, Student, StudentFee } from "../models/index.js";
import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { AppError } from "../utils/errorHandling.js";

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
  return num;
};

// BE-4: a payment must reference an existing, non-archived student.
const ensureStudentExists = async (studentId, transaction = null) => {
  if (studentId == null || studentId === "") {
    throw new AppError("studentId is required", 400);
  }
  const student = await Student.findOne({
    where: { studentId, isDeleted: false },
    ...(transaction ? { transaction } : {}),
  });
  if (!student) {
    throw new AppError("Student not found", 400);
  }
  return student;
};

// BE-D3: single authoritative recomputation of a student's denormalized
// `feesPaid` / `feesOwing` columns, derived from the underlying rows. Every fee
// mutation (Fee create/delete, StudentFee create/edit/delete, student class
// change) must call this INSIDE its surrounding transaction so the cached
// columns can never drift from the source rows.
//
// FORMULA (matches the existing intent in services/test.js#editStudent, the
// most explicit pre-existing computation in the codebase):
//   billed = sum(ClassFee.amount for the student's current class)
//          + sum(StudentFee.amount for the student)
//   paid   = sum(Fee.paid for the student)   // each Fee row is one payment receipt
//   feesPaid  = paid
//   feesOwing = billed - paid
//
// ASSUMPTIONS (flagged for the later Fees-feature review):
//   1. NO arrears carry-over beyond the current class bill. editStudent already
//      drops arrears on class change ("arrears are lost on class change"), so the
//      denormalized owing is purely (current bill - total paid). If the business
//      actually wants historical arrears to persist across class/term changes,
//      this helper (and editStudent) need a dedicated arrears column — there is
//      none today.
//   2. `Fee.paid` is the amount of THAT single payment (createFee writes
//      `paid: currentPaid`), so summing it gives lifetime paid. The legacy
//      `Fee.total` / `Fee.remaining` columns are receipt snapshots and are NOT
//      used to derive the balance.
//   3. Billing is not term-scoped here (ClassFee/StudentFee carry no term), so
//      owing is a running lifetime figure, same as before.
export const recomputeStudentOwing = async (studentId, { transaction = null } = {}) => {
  if (studentId == null) return null;

  const student = await Student.findOne({
    where: { studentId },
    attributes: ["studentId", "classId"],
    raw: true,
    transaction,
  });
  if (!student) return null;

  const [classFees, studentFees, fees] = await Promise.all([
    student.classId != null
      ? ClassFee.findAll({ where: { classId: student.classId }, attributes: ["amount"], raw: true, transaction })
      : Promise.resolve([]),
    StudentFee.findAll({ where: { studentId }, attributes: ["amount"], raw: true, transaction }),
    Fee.findAll({ where: { studentId }, attributes: ["paid"], raw: true, transaction }),
  ]);

  const classFeeTotal = classFees.reduce((sum, f) => sum + Number(f.amount || 0), 0);
  const studentFeeTotal = studentFees.reduce((sum, f) => sum + Number(f.amount || 0), 0);
  const billed = classFeeTotal + studentFeeTotal;
  const paid = fees.reduce((sum, f) => sum + Number(f.paid || 0), 0);
  // BE-7: owing is clamped at 0 — the system rejects overpayment (createFee),
  // so a negative balance is never a valid "credit"; the owing list and parent
  // app both assume owing >= 0. (feesPaid keeps the true total paid, so an
  // over-collection is still visible as paid > billed.)
  const owing = Math.max(0, billed - paid);

  await Student.update(
    { feesPaid: paid, feesOwing: owing },
    { where: { studentId }, transaction }
  );

  return { billed, paid, owing };
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

    const response = await Fee.create(
      {
        studentId: data?.studentId,
        classId: data?.classId,
        total: data?.total,
        paid: amount,
        // BE-2: store the server-computed remaining, not the client's value.
        remaining: owing - amount,
        paymentMode: data?.paymentMode,
        amountInWords: data?.amountInWords,
        datePaid: data?.datePaid,
        term: data?.term,
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
  return await sequelize.transaction(async (t) => {
    const existing = await Fee.findOne({ where: { feeId: id }, transaction: t });
    // BE-5: distinguish "deleted" from "didn't exist" — 404 instead of a silent
    // 200/0 with no recompute.
    if (!existing) {
      throw new AppError("Fee payment not found", 404);
    }
    const studentId = existing.studentId;

    const response = await Fee.destroy({ where: { feeId: id }, transaction: t });

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
