import { StudentFee, Student } from "../models/index.js";
import sequelize from "../config/database.js";
// BE-D3: derive the cached owing from the underlying rows after every mutation
// instead of hand-rolled increment/decrement (which drifted from the source of
// truth and ignored payments / class fees).
import { recomputeStudentOwing } from "./fee.js";

const validateAmount = (amount) => {
  if (amount == null || isNaN(Number(amount))) {
    throw new Error("Amount is required and must be a number");
  }
  if (Number(amount) <= 0) {
    throw new Error("Amount must be a positive number");
  }
};

const ensureStudentExists = async (studentId, transaction = null) => {
  if (!studentId) throw new Error("studentId is required");
  const opts = transaction ? { transaction } : {};
  const student = await Student.findOne({ where: { studentId }, ...opts });
  if (!student) throw new Error("Student not found");
  return student;
};

const createStudentFee = async (data) => {
  const t = await sequelize.transaction();
  try {
    const created = await StudentFee.create(
      {
        name: data?.name,
        amount: data?.amount,
        studentId: data?.studentId,
      },
      { transaction: t }
    );

    // validate input early
    validateAmount(data?.amount);
    if (!data?.studentId) throw new Error("studentId is required");

    // BE-D3: reconcile cached owing from rows (new StudentFee now included).
    await ensureStudentExists(data.studentId, t);
    await recomputeStudentOwing(data.studentId, { transaction: t });

    await t.commit();
    return created;
  } catch (err) {
    await t.rollback();
    console.error("Error creating student fee with transaction", err);
    throw err;
  }
};

const editStudentFee = async (data, id) => {
  const t = await sequelize.transaction();
  try {
    const existing = await StudentFee.findOne({ where: { studentFeeId: id }, transaction: t });
    if (!existing) {
      await t.rollback();
      throw new Error("StudentFee not found");
    }

    const updated = await StudentFee.update(
      {
        name: data?.name,
        amount: data?.amount,
      },
      {
        where: {
          studentFeeId: id,
        },
        transaction: t,
      }
    );

    // BE-D3: reconcile cached owing from rows (the updated amount is now persisted).
    await ensureStudentExists(existing.studentId, t);
    await recomputeStudentOwing(existing.studentId, { transaction: t });

    await t.commit();
    return updated;
  } catch (err) {
    await t.rollback();
    console.error("Error editing student fee with transaction", err);
    throw err;
  }
};

const removeStudentFee = async (id) => {
  const t = await sequelize.transaction();
  try {
    const existing = await StudentFee.findOne({ where: { studentFeeId: id }, transaction: t });
    if (!existing) {
      await t.rollback();
      throw new Error("StudentFee not found");
    }

    const destroyed = await StudentFee.destroy({ where: { studentFeeId: id }, transaction: t });

    // BE-D3: reconcile cached owing from rows (the deleted StudentFee is gone).
    await ensureStudentExists(existing.studentId, t);
    await recomputeStudentOwing(existing.studentId, { transaction: t });

    await t.commit();
    return destroyed;
  } catch (err) {
    await t.rollback();
    console.error("Error deleting student fee with transaction", err);
    throw err;
  }
};

const getStudentFees = async (studentId) => {
  return await StudentFee.findAll({ where: { studentId } });
};

export { createStudentFee, editStudentFee, removeStudentFee, getStudentFees };
