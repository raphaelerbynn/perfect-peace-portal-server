import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { Class, Salary, Teacher, UserAccount } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { isValidPhoneNumber } from "../utils/func.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// BE-T6: validate required/format fields and surface clean 400s instead of raw
// Sequelize 500s / DB truncation errors. On edit we validate "partially" — only
// the fields actually present in the payload are checked.
const validateStaffInput = (data, { partial = false } = {}) => {
  const present = (k) =>
    data[k] !== undefined && data[k] !== null && `${data[k]}`.trim() !== "";

  if (!partial || "fName" in data) {
    if (!present("fName")) throw new AppError("First name is required", 400);
  }
  if (!partial || "lName" in data) {
    if (!present("lName")) throw new AppError("Last name is required", 400);
  }
  if (!partial || "gender" in data) {
    if (!present("gender")) throw new AppError("Gender is required", 400);
  }
  if (present("phone") && !isValidPhoneNumber(`${data.phone}`)) {
    throw new AppError("Phone number is invalid", 400);
  }
  if (present("email") && !EMAIL_RE.test(`${data.email}`.trim())) {
    throw new AppError("Email is invalid", 400);
  }
};

// BE-20: optional, backward-compatible pagination. No options => identical
// behaviour and shape as before (full array). limit/offset only applied when
// pagination params are supplied.
export const getStaff = async (options = {}) => {
  // BE-D6: do NOT swallow DB errors — let them propagate to the central
  // errorHandler. Success-path shape is unchanged.
  const { page, limit } = options;

  const queryOptions = {
    attributes: { exclude: ["password"] },
    // BE-T3: never list archived staff.
    where: { isDeleted: { [Op.not]: true } },
    include: [
      {
        model: Class,
        as: "class_",
        attributes: ["name"],
      },
      {
        model: Salary,
        as: "salary",
      },
    ],
  };

  const parsedLimit = parseInt(limit, 10);
  const parsedPage = parseInt(page, 10);
  if (Number.isInteger(parsedLimit) && parsedLimit > 0) {
    queryOptions.limit = parsedLimit;
    const safePage = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    queryOptions.offset = (safePage - 1) * parsedLimit;
    queryOptions.subQuery = false;
  }

  const staff = await Teacher.findAll(queryOptions);
  return staff;
};

// Public, minimal staff list for the PRE-LOGIN signup picker only.
// Returns id + name exclusively — never password, contact, bank or other PII —
// so it is safe to expose unauthenticated. Throws on error so the controller
// can forward via next(). Excludes archived staff.
export const getStaffForSignup = async () => {
  return Teacher.findAll({
    attributes: ["teacherId", "fName", "lName"],
    where: { isDeleted: { [Op.not]: true } },
    order: [["fName", "ASC"]],
  });
};

// BE-T3: SOFT DELETE. The previous version hard-destroyed the Teacher only,
// leaving Class.teacherId dangling and the linked UserAccount login orphaned.
// We now archive the teacher in a transaction, release the class back-link, and
// disable (not destroy) the linked management login. Errors propagate (BE-T2).
export const removeStaff = async (id) => {
  return await sequelize.transaction(async (t) => {
    const teacher = await Teacher.findOne({
      attributes: ["teacherId"],
      where: { teacherId: id },
      transaction: t,
    });
    if (!teacher) {
      throw new AppError("Staff member not found", 404);
    }

    await Teacher.update(
      { isDeleted: true, dateUpdated: new Date() },
      { where: { teacherId: id }, transaction: t }
    );

    // Release the two-way Class <-> Teacher link so the class isn't shown as
    // staffed by an archived teacher.
    await Class.update(
      { teacherId: null },
      { where: { teacherId: id }, transaction: t }
    );

    // Disable the linked management login (if any) without destroying it.
    await UserAccount.update(
      { isDeleted: true },
      { where: { teacherId: id }, transaction: t }
    );

    return { archived: true, teacherId: Number(id) };
  });
};

// BE-T1/BE-T5/BE-T2: createStaff now accepts the same keys the edit path uses
// (`class`, `salaryId`) — previously it read `data.class_id` and never read
// salaryId, so class assignment and salary/rank were silently dropped on add.
// Wrapped in a transaction; maintains the Class.teacherId back-link; validates;
// detects duplicates; does not swallow errors.
export const createStaff = async (data) => {
  validateStaffInput(data);

  const classId = data.class ?? data.class_id ?? null;
  const salaryId = data.salaryId || null;

  return await sequelize.transaction(async (t) => {
    // BE-T7: duplicate detection on a natural key (name + phone when present).
    const dupWhere = {
      isDeleted: { [Op.not]: true },
      fName: data.fName,
      lName: data.lName,
    };
    if (data.phone) dupWhere.phone = data.phone;
    const existing = await Teacher.findOne({
      where: dupWhere,
      attributes: ["teacherId"],
      transaction: t,
    });
    if (existing) {
      throw new AppError("A staff member with these details already exists", 409);
    }

    // BE-T5: a class can only be assigned to one teacher.
    if (classId != null) {
      const targetClass = await Class.findOne({
        where: { classId },
        transaction: t,
      });
      if (targetClass && targetClass.teacherId) {
        throw new AppError(
          "Class already has a teacher, remove that teacher first",
          409
        );
      }
    }

    const teacher = await Teacher.create(
      {
        fName: data.fName,
        lName: data.lName,
        gender: data.gender,
        phone: data.phone,
        email: data.email,
        address: data.address,
        category: data.category,
        ssnitNumber: data.ssnit,
        tinNumber: data.tin,
        bank: data.bank,
        accountNumber: data.account,
        dateRegistered: new Date(),
        classId,
        salaryId,
        isDeleted: false,
      },
      { transaction: t }
    );

    const newId = teacher.dataValues.teacher_id ?? teacher.dataValues.teacherId;

    // BE-T5: maintain the two-way Class <-> Teacher link on create.
    if (classId != null) {
      await Class.update(
        { teacherId: newId },
        { where: { classId }, transaction: t }
      );
    }

    return teacher;
  });
};

// BE-T2/BE-T4/BE-T8/BE-T9: transactional; only updates fields actually present
// (so an edit that omits a field no longer nulls it — salaryId in particular was
// being wiped on every edit); rejects an already-assigned class with a real 409;
// errors propagate.
export const editStaff = async (data, id) => {
  validateStaffInput(data, { partial: true });

  return await sequelize.transaction(async (t) => {
    const current = await Teacher.findOne({
      where: { teacherId: id },
      transaction: t,
    });
    if (!current) {
      throw new AppError("Staff member not found", 404);
    }

    // `class` (when sent) carries the classId; "" / null means "unassign".
    const newClassId = data.class !== undefined ? data.class || null : undefined;

    // BE-T4: check (inside the transaction) that the target class isn't held by
    // a DIFFERENT teacher.
    if (newClassId) {
      const targetClass = await Class.findOne({
        where: { classId: newClassId },
        transaction: t,
      });
      if (
        targetClass &&
        targetClass.teacherId &&
        Number(targetClass.teacherId) !== Number(id)
      ) {
        throw new AppError(
          "Class already has a teacher, remove that teacher first",
          409
        );
      }
    }

    // BE-T8: build the update from ONLY the keys present in the payload.
    const update = { dateUpdated: new Date() };
    const colMap = {
      fName: "fName",
      lName: "lName",
      gender: "gender",
      phone: "phone",
      email: "email",
      address: "address",
      category: "category",
      ssnit: "ssnitNumber",
      tin: "tinNumber",
      bank: "bank",
      account: "accountNumber",
    };
    for (const [src, col] of Object.entries(colMap)) {
      if (data[src] !== undefined) update[col] = data[src];
    }
    if (data.salaryId !== undefined) update.salaryId = data.salaryId || null;
    if (newClassId !== undefined) update.classId = newClassId;

    const response = await Teacher.update(update, {
      where: { teacherId: id },
      transaction: t,
    });

    // Two-way sync, only when the class field was part of the edit.
    if (newClassId !== undefined) {
      await Class.update(
        { teacherId: null },
        { where: { teacherId: id }, transaction: t }
      );
      if (newClassId) {
        await Class.update(
          { teacherId: id },
          { where: { classId: newClassId }, transaction: t }
        );
      }
    }

    return response;
  });
};
