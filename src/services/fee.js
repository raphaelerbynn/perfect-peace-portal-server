import { ClassFee, Fee, FeeCheck, Student, StudentFee } from "../models/index.js";
import { Op } from "sequelize";
import sequelize from "../config/database.js";

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
  const owing = billed - paid;

  await Student.update(
    { feesPaid: paid, feesOwing: owing },
    { where: { studentId }, transaction }
  );

  return { billed, paid, owing };
};

const createFee = async (data) => {
  // BE-D3 / BE-D4: record the payment AND reconcile the student's cached owing
  // from the underlying rows in ONE transaction. Previously the student columns
  // were set straight from the request-supplied `remaining`/`totalPaid`, which
  // could disagree with the actual Fee rows.
  return await sequelize.transaction(async (t) => {
    const response = await Fee.create(
      {
        studentId: data?.studentId,
        classId: data?.classId,
        total: data?.total,
        paid: data?.currentPaid,
        remaining: data?.remaining,
        paymentMode: data?.paymentMode,
        amountInWords: data?.amountInWords,
        datePaid: data?.datePaid,
        term: data?.term,
      },
      { transaction: t }
    );

    await recomputeStudentOwing(data?.studentId, { transaction: t });

    return response;
  });
}

const removeFee = async (id) => {
  // BE-D3: deleting a payment must RESTORE the balance. The old version just
  // destroyed the Fee row and left Student.feesOwing/feesPaid stale (the
  // unambiguous bug). Read the row first to know which student to reconcile,
  // delete, then recompute — all atomically.
  return await sequelize.transaction(async (t) => {
    const existing = await Fee.findOne({ where: { feeId: id }, transaction: t });
    const studentId = existing?.studentId;

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
    // BE-D11: parameterized date filter (mirrors getProfitLoss in graph.js).
    // Replaces the raw `literal(DATE_FORMAT('${startDate}'...))` string interp,
    // which was an injection risk. Behaviour is unchanged: an inclusive range on
    // the `datePaid` column. Normalize to YYYY-MM-DD so the bounds line up with
    // the DATEONLY-style values stored in `date_paid`.
    const startDate = new Date(data.startDate).toISOString().slice(0, 10);
    const endDate = new Date(data.endDate).toISOString().slice(0, 10);
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
    const lastFee = Fee.findAll({
      where: {
        studentId: indexNumber
      },
      limit: 1,
      order: [['fee_id', 'DESC']]
    })

    return lastFee;
  
};

export { createFee, removeFee, getFeeCheck, getLastFee, getFeesData, getOneFee };
