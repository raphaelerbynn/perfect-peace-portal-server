import { Op, fn, col, where as sequelizeWhere } from "sequelize";
import sequelize from "../config/database.js";
import { Subject } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";

// BE-U: optional, backward-compatible pagination. No options => identical
// behaviour and shape (full array). limit/offset only applied when supplied.
// ALWAYS excludes soft-deleted (archived) subjects.
const subjects = async (options = {}) => {
  const { page, limit } = options;

  const queryOptions = {
    // BE-U: never list archived subjects.
    where: { isDeleted: { [Op.not]: true } },
  };

  const parsedLimit = parseInt(limit, 10);
  const parsedPage = parseInt(page, 10);
  if (Number.isInteger(parsedLimit) && parsedLimit > 0) {
    queryOptions.limit = parsedLimit;
    const safePage = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    queryOptions.offset = (safePage - 1) * parsedLimit;
  }

  // Return shape unchanged: a plain array (the frontend consumes an array).
  return await Subject.findAll(queryOptions);
};

// BE-U: coerce a numeric field. Returns undefined for empty/absent (so the DB
// keeps NULL); throws AppError 400 on a non-numeric or out-of-range value.
const coerceNumeric = (value, label, { max } = {}) => {
  if (value === undefined || value === null || `${value}`.trim() === "") {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new AppError(`${label} must be a number`, 400);
  }
  if (n < 0) {
    throw new AppError(`${label} cannot be negative`, 400);
  }
  if (max != null && n > max) {
    throw new AppError(`${label} cannot exceed ${max}`, 400);
  }
  return n;
};

// BE-U4/BE-U5: validate-then-write. Trim + require name; case-insensitive
// duplicate check across ALL subjects (incl. archived, since the DB unique
// index is global); coerce/validate numeric fields; FIX the passMark(s) bug.
// Errors are NOT swallowed.
const createSubject = async (data) => {
  // --- name: required, trimmed ----------------------------------------
  const name = data?.name?.trim?.() ?? "";
  if (!name) {
    throw new AppError("Subject name is required", 400);
  }

  // --- case-insensitive duplicate check (global, incl. archived) ------
  // The DB unique index on `name` is global, so we must check archived rows
  // too — otherwise an archived duplicate would cause an opaque DB 500.
  const existing = await Subject.findOne({
    where: sequelizeWhere(fn("lower", col("name")), name.toLowerCase()),
    attributes: ["subjectId"],
  });
  if (existing) {
    throw new AppError("A subject with this name already exists", 409);
  }

  // --- numeric fields: coerce + validate ------------------------------
  const examTotalMarks = coerceNumeric(data?.examTotalMarks, "Exam total marks");
  const classTotalMarks = coerceNumeric(data?.classTotalMarks, "Class total marks");
  const examPercentage = coerceNumeric(data?.examPercentage, "Exam percentage", { max: 100 });
  const classPercentage = coerceNumeric(data?.classPercentage, "Class percentage", { max: 100 });
  // FIX: model column is `passMarks` (plural); the old code read `data.passMark`
  // (singular) so the pass mark was always saved as null. Accept both keys.
  const passMarks = coerceNumeric(data?.passMarks ?? data?.passMark, "Pass marks", { max: 100 });

  const response = await Subject.create({
    name,
    examTotalMarks,
    classTotalMarks,
    examPercentage,
    classPercentage,
    passMarks,
    isDeleted: false,
  });

  return response;
};

// BE-U1/U2/U3: SOFT DELETE. The previous version hard-destroyed the Subject AND
// every StudentMarks row for it (data loss) via a non-awaited Promise.all, then
// swallowed errors. We now archive the subject in a transaction and NEVER touch
// marks/results (StudentMarks / StudentResult / KgAssessment). Errors propagate.
const removeSubject = async (id) => {
  return await sequelize.transaction(async (t) => {
    const subject = await Subject.findOne({
      attributes: ["subjectId"],
      where: { subjectId: id },
      transaction: t,
    });
    if (!subject) {
      throw new AppError("Subject not found", 404);
    }

    await Subject.update(
      { isDeleted: true },
      { where: { subjectId: id }, transaction: t }
    );

    return { archived: true, subjectId: Number(id) };
  });
};

export { subjects, createSubject, removeSubject };
