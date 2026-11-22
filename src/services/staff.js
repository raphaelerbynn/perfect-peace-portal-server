import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { Class, Salary, Teacher, UserAccount } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { isValidPhoneNumber } from "../utils/func.js";
import { hasPermission, mayRelinkClasses, P } from "../utils/permissions.js";
import { assertManagersRemainWithout, assertMayChangeLogin, lockRoles } from "./roles.js";
import { clearAccessCache } from "./officeAccess.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// BE-T6: validate required/format fields and surface clean 400s instead of raw
// Sequelize 500s / DB truncation errors. On edit we validate "partially" - only
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
// B10 review: payroll and bank details on a staff record. Only a role with
// staff.view_sensitive (the Administrator) sees them; anyone else who may see
// the staff list gets it without them.
export const STAFF_PAYROLL_FIELDS = ["ssnitNumber", "tinNumber", "bank", "accountNumber", "salaryId"];

// B10 review: the request keys for those fields. Without staff.view_sensitive
// a value for any of them is refused (403, naming it) rather than dropped, so
// the office knows; an empty value is ignored (the form sends "" for fields
// the login can't see, which must not wipe the stored value).
const SENSITIVE_INPUT = { ssnit: "SSNIT number", tin: "TIN number", bank: "bank", account: "account number", salaryId: "rank / salary" };
const isBlank = (v) => v === undefined || v === null || String(v).trim() === "";

/** Remove blank sensitive keys and refuse filled ones when `actor` lacks staff.view_sensitive. */
const guardSensitiveInput = (data, actor) => {
  if (actor === undefined || hasPermission(actor, P.STAFF_VIEW_SENSITIVE)) return data;
  const filled = Object.keys(SENSITIVE_INPUT).filter((k) => !isBlank(data?.[k]));
  if (filled.length) {
    throw new AppError(`You can't set the ${filled.map((k) => SENSITIVE_INPUT[k]).join(", ")}: that needs “See staff bank, account, TIN, SSNIT and salary details”.`, 403);
  }
  const out = { ...data };
  for (const k of Object.keys(SENSITIVE_INPUT)) delete out[k];
  return out;
};

const RELINK_REFUSED = "Changing a staff member's class needs “Every class”. Ask the administrator.";

export const getStaff = async (options = {}) => {
  // BE-D6: do NOT swallow DB errors - let them propagate to the central
  // errorHandler. Success-path shape is unchanged.
  const { page, limit, user = null } = options;
  const withPayroll = hasPermission(user, P.STAFF_VIEW_SENSITIVE);

  const queryOptions = {
    attributes: { exclude: ["password", "photoKey", "photoThumbKey", ...(withPayroll ? [] : STAFF_PAYROLL_FIELDS)] }, // B17: no storage keys
    // BE-T3: never list archived staff.
    where: { isDeleted: { [Op.not]: true } },
    include: [
      {
        model: Class,
        as: "class_",
        attributes: ["name"],
      },
      ...(withPayroll ? [{ model: Salary, as: "salary" }] : []),
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

  // The class a teacher looks after is named on the CLASS (Class.teacher_id),
  // which is what the Classes page shows; live leaves Teacher.class_id empty
  // for most staff. Prefer the class record, fall back to Teacher.class_id.
  const ids = staff.map((t) => t.teacherId);
  const owned = ids.length
    ? await Class.findAll({
        where: { teacherId: { [Op.in]: ids }, isDeleted: { [Op.not]: true } },
        attributes: ["classId", "name", "teacherId"],
        order: [["name", "ASC"]],
        raw: true,
      })
    : [];
  for (const t of staff) {
    const mine = owned.filter((c) => Number(c.teacherId) === Number(t.teacherId));
    if (!mine.length) continue;
    const value = { name: mine.map((c) => String(c.name).trim()).join(", "), classId: mine[0].classId };
    if (typeof t.setDataValue === "function") t.setDataValue("class_", value);
    else t.class_ = value;
  }
  return staff;
};

// Public, minimal staff list for the PRE-LOGIN signup picker only.
// Returns id + name exclusively - never password, contact, bank or other PII -
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
export const removeStaff = async (id, actor) => {
  const out = await sequelize.transaction(async (t) => {
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

    // B10: not the last login that can manage roles (the school would be locked
    // out); under the roles lock, so two archives at once can't both pass.
    await lockRoles(t);
    const accounts = await UserAccount.findAll({
      where: { teacherId: id },
      attributes: ["username", "roleId", "category", "isDeleted"],
      raw: true,
      transaction: t,
    });
    // ...and not a login whose role holds more than the caller (archiving it
    // disables it), as when changing a login's role.
    if (actor !== undefined) {
      for (const a of (accounts || []).filter((x) => !x.isDeleted)) {
        await assertMayChangeLogin(a, actor, {
          transaction: t,
          message: "This staff member's office login has permissions you don't have, so you can't archive them.",
        });
      }
    }
    await assertManagersRemainWithout(accounts || [], { transaction: t });

    // Disable the linked management login (if any) without destroying it.
    await UserAccount.update(
      { isDeleted: true },
      { where: { teacherId: id }, transaction: t }
    );

    return { archived: true, teacherId: Number(id) };
  });
  // B10: an archived login loses its access at once (officeAccess cache).
  clearAccessCache();
  return out;
};

// BE-T1/BE-T5/BE-T2: createStaff now accepts the same keys the edit path uses
// (`class`, `salaryId`) - previously it read `data.class_id` and never read
// salaryId, so class assignment and salary/rank were silently dropped on add.
// Wrapped in a transaction; maintains the Class.teacherId back-link; validates;
// detects duplicates; does not swallow errors.
export const createStaff = async (input, actor) => {
  const data = guardSensitiveInput(input, actor);
  validateStaffInput(data);

  const classId = data.class ?? data.class_id ?? null;
  const salaryId = data.salaryId || null;
  if (classId != null && classId !== "" && !mayRelinkClasses(actor)) throw new AppError(RELINK_REFUSED, 403);

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
// (so an edit that omits a field no longer nulls it - salaryId in particular was
// being wiped on every edit); rejects an already-assigned class with a real 409;
// errors propagate.
export const editStaff = async (input, id, actor) => {
  const data = guardSensitiveInput(input, actor);
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

    // B10 review: a different class needs academics.all_classes (the link is
    // what limits a login to its own class). The current link is the class
    // naming this teacher (live keeps it there), else Teacher.class_id.
    if (newClassId !== undefined && !mayRelinkClasses(actor)) {
      const linked = await Class.findOne({ where: { teacherId: id, isDeleted: { [Op.not]: true } }, attributes: ["classId"], transaction: t });
      const currentClassId = linked?.classId ?? current.classId ?? null;
      if (String(newClassId ?? "") !== String(currentClassId ?? "")) throw new AppError(RELINK_REFUSED, 403);
    }

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
