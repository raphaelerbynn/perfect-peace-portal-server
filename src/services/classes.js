import { Op, fn, col, where } from "sequelize";
import sequelize from "../config/database.js";
import { Class, ClassFee, Student, TeachingAssignment, Teacher, Term } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { recomputeStudentOwing } from "./fee.js";
import { isPesewaAmount } from "../utils/money.js";

// Recompute cached owing for EVERY (non-archived) student in a class — a class
// fee change shifts the bill for the whole class (parity with the studentFees
// hardening from Feature #4). Runs inside the caller's transaction.
const recomputeClassStudentsOwing = async (classId, transaction = null) => {
  if (classId == null) return;
  const students = await Student.findAll({
    attributes: ["studentId"],
    where: { classId, isDeleted: { [Op.not]: true } },
    order: [["studentId", "ASC"]], // same lock order as everywhere else
    raw: true,
    transaction,
  });
  for (const s of students) {
    await recomputeStudentOwing(s.studentId, { transaction });
  }
};

// The classes a Class Teacher office login is assigned to: the class(es) they
// are class teacher of (Class.teacher_id; Teacher.class_id as a fallback) and
// those where they teach a subject in the open term (Subjects & teachers).
const assignedClassIds = async (teacherId) => {
  if (!teacherId) return [];
  const own = await Class.findAll({ where: { teacherId, isDeleted: { [Op.not]: true } }, attributes: ["classId"], raw: true });
  const teacher = await Teacher.findOne({ where: { teacherId }, attributes: ["classId"], raw: true });
  const term = await Term.findOne({ where: { active: true }, attributes: ["termId"], raw: true });
  const taught = term
    ? await TeachingAssignment.findAll({ where: { teacherId, termId: term.termId }, attributes: ["classId"], raw: true })
    : [];
  return [...new Set([...own, ...(teacher?.classId != null ? [teacher] : []), ...taught].map((r) => Number(r.classId)))];
};

// `user`: a Class Teacher office login sees only the classes assigned to them
// (the Classes page and every class picker). Other callers: every class.
const classes = async (user = null) => {
  const classFeeList = await ClassFee.findAll({ raw: true });

  const scoped = user?.category === "Class Teacher";
  const onlyIds = scoped ? await assignedClassIds(user.teacherId) : null;
  if (scoped && onlyIds.length === 0) return [];

  // BE-V1: never list archived classes.
  const allClasses = await Class.findAll({
    where: { isDeleted: { [Op.not]: true }, ...(scoped && { classId: { [Op.in]: onlyIds } }) },
  });

  // BE-19: single grouped count instead of per-class N+1. BE-V10: exclude
  // soft-deleted students so the tiles (and dashboard reconciliation) aren't
  // inflated by archived students.
  const countRows = await Student.count({
    where: { isDeleted: { [Op.not]: true } },
    group: ["classId"],
  });

  const countByClassId = new Map(
    countRows.map((row) => [row.classId, row.count])
  );

  // A class with no teacher on its own record, but exactly one teacher whose
  // staff record names it (live: KG 2 / Gloria): show that teacher, so the
  // Classes and Staff pages agree. Saving the class then stores the link.
  const teachersByClass = new Map();
  const linked = await Teacher.findAll({
    where: { classId: { [Op.not]: null }, isDeleted: { [Op.not]: true } },
    attributes: ["teacherId", "classId"],
    raw: true,
  });
  for (const t of linked) teachersByClass.set(t.classId, [...(teachersByClass.get(t.classId) || []), t.teacherId]);

  const classData = allClasses.map((classItem) => {
    const classId = classItem.classId;
    const fallback = teachersByClass.get(classId);
    if (classItem.teacherId == null && fallback?.length === 1) {
      classItem.dataValues.teacherId = fallback[0];
    }
    const feeList = classFeeList.filter((fee) => fee.classId === classId);
    classItem.dataValues.totalStudents = countByClassId.get(classId) || 0;
    classItem.dataValues.feeList = feeList;
    return classItem;
  });

  return classData;
};

// BE-V5: validate + reject duplicate (case-insensitive) class names; guard the
// teacher assignment; maintain the two-way Class<->Teacher link in a transaction.
const MAX_CLASS_NAME = 50;

const createClass = async (data) => {
  const name = data?.name?.trim?.();
  if (!name) throw new AppError("Class name is required", 400);
  if (name.length > MAX_CLASS_NAME) throw new AppError(`Keep the class name to ${MAX_CLASS_NAME} characters or fewer`, 400);

  return await sequelize.transaction(async (t) => {
    const duplicate = await Class.findOne({
      where: {
        [Op.and]: [
          where(fn("lower", col("name")), name.toLowerCase()),
          { isDeleted: { [Op.not]: true } },
        ],
      },
      attributes: ["classId"],
      transaction: t,
    });
    if (duplicate) {
      throw new AppError("A class with this name already exists", 409);
    }

    // A teacher can only be the class-teacher of one class.
    if (data?.teacher_id) {
      const taken = await Class.findOne({
        where: { teacherId: data.teacher_id, isDeleted: { [Op.not]: true } },
        attributes: ["classId"],
        transaction: t,
      });
      if (taken) {
        throw new AppError(
          "That teacher is already assigned to a class, remove them first",
          409
        );
      }
    }

    const newClass = await Class.create(
      {
        name,
        section: data?.section,
        capacity: data?.capacity,
        teacherId: data?.teacher_id,
        // legacy "dismantled" fee columns (real fees live in ClassFee rows)
        tuition: data?.tuitionFee,
        firstAid: data?.firstAidFee,
        pta: data?.ptaFee,
        water: data?.waterFee,
        maintenance: data?.maintenanceFee,
        stationary: data?.stationaryFee,
        cocurricular: data?.cocurricular,
        fees: data?.fees,
        isDeleted: false,
      },
      { transaction: t }
    );

    if (data?.teacher_id) {
      await Teacher.update(
        { classId: newClass.classId },
        { where: { teacherId: data.teacher_id }, transaction: t }
      );
    }

    return newClass;
  });
};

// BE-V8: validate-before-write + duplicate (classId, name) guard + recompute the
// whole class's owing, all in one transaction.
const createClassFee = async (data) => {
  const name = data?.name?.trim?.();
  const amount = Number(data?.amount);
  const classId = data?.classId;

  if (!name) throw new AppError("Fee name is required", 400);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError("Fee amount must be a positive number", 400);
  }
  if (!isPesewaAmount(amount)) {
    throw new AppError("Fee amount can have at most 2 decimal places (cedis and pesewas)", 400);
  }
  if (classId == null) throw new AppError("classId is required", 400);

  return await sequelize.transaction(async (t) => {
    const targetClass = await Class.findOne({
      where: { classId, isDeleted: { [Op.not]: true } },
      attributes: ["classId"],
      transaction: t,
    });
    if (!targetClass) throw new AppError("Class not found", 404);

    const duplicate = await ClassFee.findOne({
      where: {
        classId,
        [Op.and]: [where(fn("lower", col("name")), name.toLowerCase())],
      },
      attributes: ["classFeeId"],
      transaction: t,
    });
    if (duplicate) {
      throw new AppError("This class already has a fee with that name", 409);
    }

    const created = await ClassFee.create(
      { name, amount, classId },
      { transaction: t }
    );

    await recomputeClassStudentsOwing(classId, t);
    return created;
  });
};

// BE-V7: validate + 404 + recompute the class's owing.
const editClassFee = async (data, id) => {
  const name = data?.name?.trim?.();
  const amount = Number(data?.amount);
  if (!name) throw new AppError("Fee name is required", 400);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError("Fee amount must be a positive number", 400);
  }
  if (!isPesewaAmount(amount)) {
    throw new AppError("Fee amount can have at most 2 decimal places (cedis and pesewas)", 400);
  }

  return await sequelize.transaction(async (t) => {
    const existing = await ClassFee.findOne({
      where: { classFeeId: id },
      transaction: t,
    });
    if (!existing) throw new AppError("Class fee not found", 404);

    await ClassFee.update(
      { name, amount },
      { where: { classFeeId: id }, transaction: t }
    );

    await recomputeClassStudentsOwing(existing.classId, t);

    const updated = await ClassFee.findOne({
      where: { classFeeId: id },
      transaction: t,
    });
    return updated;
  });
};

// BE-V4: rename propagates to the students' denormalized `class` name string;
// two-way teacher link kept consistent; all in one transaction; 404 if missing.
const editClass = async (data, id) => {
  return await sequelize.transaction(async (t) => {
    const existingClass = await Class.findOne({
      where: { classId: id },
      transaction: t,
    });
    if (!existingClass) throw new AppError("Class not found", 404);

    const previousTeacherId = existingClass.teacherId || null;
    const newName = data?.name?.trim?.() || existingClass.name;
    const nameChanged = newName !== existingClass.name;
    if (newName.length > MAX_CLASS_NAME) throw new AppError(`Keep the class name to ${MAX_CLASS_NAME} characters or fewer`, 400);

    // Duplicate-name guard (case-insensitive, excluding this class).
    if (nameChanged) {
      const duplicate = await Class.findOne({
        where: {
          [Op.and]: [
            where(fn("lower", col("name")), newName.toLowerCase()),
            { classId: { [Op.ne]: id }, isDeleted: { [Op.not]: true } },
          ],
        },
        attributes: ["classId"],
        transaction: t,
      });
      if (duplicate) {
        throw new AppError("A class with this name already exists", 409);
      }
    }

    // A teacher can only own one class (mirror editStaff's guard).
    if (data?.teacher_id) {
      const taken = await Class.findOne({
        where: {
          teacherId: data.teacher_id,
          classId: { [Op.ne]: id },
          isDeleted: { [Op.not]: true },
        },
        attributes: ["classId"],
        transaction: t,
      });
      if (taken) {
        throw new AppError(
          "That teacher is already assigned to another class, remove them first",
          409
        );
      }
    }

    await Class.update(
      {
        name: newName,
        section: data?.section,
        capacity: data?.capacity ?? existingClass.capacity,
        teacherId: data?.teacher_id ?? null,
      },
      { where: { classId: id }, transaction: t }
    );

    // BE-V4: keep the students' denormalized class-name string in sync.
    // Marks, results, KG assessments and registers are keyed by the class NAME
    // too: rename them with it, or the class's score sheets, register, report
    // cards and promotion would show empty under the new name. Legacy pupils
    // with no classId follow by name.
    if (nameChanged) {
      const oldName = existingClass.name;
      await Student.update(
        { class: newName },
        { where: { [Op.or]: [{ classId: id }, { classId: null, class: oldName }] }, transaction: t }
      );
      for (const table of ["Student_marks", "Student_result", "KG_assessment", "Attendance"]) {
        await sequelize.query(`UPDATE "dbo"."${table}" SET class = :newName WHERE class = :oldName`, {
          replacements: { newName, oldName },
          transaction: t,
        });
      }
      // Teachers' "promoted to" recommendations name classes too.
      await sequelize.query(`UPDATE "dbo"."Student_result" SET promoted_to = :newName WHERE promoted_to = :oldName`, {
        replacements: { newName, oldName },
        transaction: t,
      });
    }

    // Two-way Class<->Teacher sync.
    if (previousTeacherId && previousTeacherId !== data?.teacher_id) {
      await Teacher.update(
        { classId: null },
        { where: { teacherId: previousTeacherId }, transaction: t }
      );
    }
    if (data?.teacher_id) {
      await Teacher.update(
        { classId: id },
        { where: { teacherId: data.teacher_id }, transaction: t }
      );
    }

    return { updated: true, classId: Number(id) };
  });
};

// BE-V1: SOFT DELETE. Archive the class (kept resolvable for the students/fees/
// results that still reference it) and free the teacher link. Never destroys
// students, ClassFee rows, results or the class row itself. 404 if missing.
const removeClass = async (id) => {
  return await sequelize.transaction(async (t) => {
    const existing = await Class.findOne({
      where: { classId: id },
      attributes: ["classId"],
      transaction: t,
    });
    if (!existing) throw new AppError("Class not found", 404);

    await Class.update(
      { isDeleted: true, teacherId: null },
      { where: { classId: id }, transaction: t }
    );

    // Free both sides of the teacher link.
    await Teacher.update(
      { classId: null },
      { where: { classId: id }, transaction: t }
    );

    return { archived: true, classId: Number(id) };
  });
};

// BE-V7-parity: 404 + recompute the class's owing after deleting a fee.
const removeClassFee = async (id) => {
  return await sequelize.transaction(async (t) => {
    const existing = await ClassFee.findOne({
      where: { classFeeId: id },
      transaction: t,
    });
    if (!existing) throw new AppError("Class fee not found", 404);

    const classId = existing.classId;
    const response = await ClassFee.destroy({
      where: { classFeeId: id },
      transaction: t,
    });

    await recomputeClassStudentsOwing(classId, t);
    return response;
  });
};

// Resolves a class id by exact name. Returns null when not found, but a blank
// input is a 400. Excludes
// archived classes so promotion can't target a retired class.
const getClassIdByName = async (name, transaction = null) => {
  if (!name) {
    throw new AppError("Class name is required", 400);
  }

  const result = await Class.findOne({
    attributes: ["classId"],
    where: { name, isDeleted: { [Op.not]: true } },
    raw: true,
    transaction,
  });

  if (!result) {
    return null;
  }

  return result.classId;
};

export { createClass, removeClass, classes, createClassFee, editClassFee, removeClassFee, editClass, getClassIdByName };
