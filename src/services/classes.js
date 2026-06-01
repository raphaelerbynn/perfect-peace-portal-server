import { Op, fn, col, where } from "sequelize";
import sequelize from "../config/database.js";
import { Class, ClassFee, Student, Teacher } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";
import { recomputeStudentOwing } from "./fee.js";

// Recompute cached owing for EVERY (non-archived) student in a class — a class
// fee change shifts the bill for the whole class (parity with the studentFees
// hardening from Feature #4). Runs inside the caller's transaction.
const recomputeClassStudentsOwing = async (classId, transaction = null) => {
  if (classId == null) return;
  const students = await Student.findAll({
    attributes: ["studentId"],
    where: { classId, isDeleted: { [Op.not]: true } },
    raw: true,
    transaction,
  });
  for (const s of students) {
    await recomputeStudentOwing(s.studentId, { transaction });
  }
};

const classes = async () => {
  const classFeeList = await ClassFee.findAll({ raw: true });

  // BE-V1: never list archived classes.
  const allClasses = await Class.findAll({
    where: { isDeleted: { [Op.not]: true } },
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

  const classData = allClasses.map((classItem) => {
    const classId = classItem.classId;
    const feeList = classFeeList.filter((fee) => fee.classId === classId);
    classItem.dataValues.totalStudents = countByClassId.get(classId) || 0;
    classItem.dataValues.feeList = feeList;
    return classItem;
  });

  return classData;
};

// BE-V5: validate + reject duplicate (case-insensitive) class names; guard the
// teacher assignment; maintain the two-way Class<->Teacher link in a transaction.
const createClass = async (data) => {
  const name = data?.name?.trim?.();
  if (!name) throw new AppError("Class name is required", 400);

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
    if (nameChanged) {
      await Student.update(
        { class: newName },
        { where: { classId: id }, transaction: t }
      );
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

// Resolves a class id by exact name. Returns null when not found (callers such
// as promoteStudents rely on null to skip), but a blank input is a 400. Excludes
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
