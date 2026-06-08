import { StudentFee, Student } from "../models/index.js";
import sequelize from "../config/database.js";
// BE-D3: derive the cached owing from the underlying rows after every mutation
// instead of hand-rolled increment/decrement (which drifted from the source of
// truth and ignored payments / class fees).
import { recomputeStudentOwing } from "./fee.js";
import { AppError } from "../utils/errorHandling.js";

// BE-S6: validate amount BEFORE any DB write. Must be a finite number > 0.
const validateAmount = (amount) => {
  const num = Number(amount);
  if (amount == null || amount === "" || !Number.isFinite(num)) {
    throw new AppError("Amount is required and must be a number", 400);
  }
  if (num <= 0) {
    throw new AppError("Amount must be a positive number", 400);
  }
};

// BE-S6: the StudentFee model only carries a `name` field (no separate
// `description` column), so the "name/description" requirement maps to `name`.
const validateName = (name) => {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new AppError("Fee name/description is required", 400);
  }
};

// BE-S6: studentId must reference an existing, NON-archived (not soft-deleted)
// student. The Student model uses `isDeleted` (field `is_deleted`) for archival.
const ensureStudentExists = async (studentId, transaction = null) => {
  if (studentId == null || studentId === "") {
    throw new AppError("studentId is required", 400);
  }
  const opts = transaction ? { transaction } : {};
  const student = await Student.findOne({
    where: { studentId, isDeleted: false },
    ...opts,
  });
  if (!student) {
    throw new AppError("Student not found", 400);
  }
  return student;
};

const createStudentFee = async (data) => {
  // BE-S6: VALIDATE-BEFORE-WRITE. Run every validation that does not require a
  // DB write first, then verify the student exists, then (and only then) create
  // the row — all inside one transaction so owing recompute stays consistent.
  validateAmount(data?.amount);
  validateName(data?.name);
  if (data?.studentId == null || data?.studentId === "") {
    throw new AppError("studentId is required", 400);
  }

  const t = await sequelize.transaction();
  try {
    // Confirms the student exists and is not archived before writing.
    await ensureStudentExists(data.studentId, t);

    // BE-S10: treat (studentId, name) as unique so copying a class fee twice (or
    // re-adding a fee with the same name) cannot double-bill the student.
    const duplicate = await StudentFee.findOne({
      where: { studentId: data.studentId, name: data.name.trim() },
      transaction: t,
    });
    if (duplicate) {
      throw new AppError(
        "A fee with this name already exists for this student",
        409
      );
    }

    const created = await StudentFee.create(
      {
        name: data.name.trim(),
        amount: Number(data.amount),
        studentId: data.studentId,
      },
      { transaction: t }
    );

    // BE-D3: reconcile cached owing from rows (new StudentFee now included).
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
  // BE-S19 (backend half): updating a student fee must persist BOTH amount and
  // name/description, verify the row exists, and recompute owing afterward.
  validateAmount(data?.amount);
  validateName(data?.name);

  const t = await sequelize.transaction();
  try {
    const existing = await StudentFee.findOne({
      where: { studentFeeId: id },
      transaction: t,
    });
    if (!existing) {
      // AppError 404 so the central errorHandler returns a proper status.
      throw new AppError("StudentFee not found", 404);
    }

    await StudentFee.update(
      {
        name: data.name.trim(),
        amount: Number(data.amount),
      },
      {
        where: { studentFeeId: id },
        transaction: t,
      }
    );

    // BE-D3: reconcile cached owing from rows (the updated amount is now persisted).
    await recomputeStudentOwing(existing.studentId, { transaction: t });

    await t.commit();
    // Backward-compatible shape: return the refreshed row.
    return await StudentFee.findOne({ where: { studentFeeId: id } });
  } catch (err) {
    await t.rollback();
    console.error("Error editing student fee with transaction", err);
    throw err;
  }
};

const removeStudentFee = async (id) => {
  const t = await sequelize.transaction();
  try {
    const existing = await StudentFee.findOne({
      where: { studentFeeId: id },
      transaction: t,
    });
    if (!existing) {
      throw new AppError("StudentFee not found", 404);
    }

    const destroyed = await StudentFee.destroy({
      where: { studentFeeId: id },
      transaction: t,
    });

    // BE-D3: reconcile cached owing from rows (the deleted StudentFee is gone).
    await recomputeStudentOwing(existing.studentId, { transaction: t });

    await t.commit();
    return destroyed;
  } catch (err) {
    await t.rollback();
    console.error("Error deleting student fee with transaction", err);
    throw err;
  }
};

export { createStudentFee, editStudentFee, removeStudentFee };
