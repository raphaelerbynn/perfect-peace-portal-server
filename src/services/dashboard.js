import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { Class, Student, Teacher } from "../models/index.js";

const idList = (v) =>
  String(v ?? "")
    .split(",")
    .map((x) => Number.parseInt(x, 10))
    .filter(Number.isInteger);

// Pupils "on the books": not archived, and not in a graduated / left class
// (Class.is_alumni) unless that class is ticked (`include`). A pupil with no
// class counts.
const countedWhere = (alumniIds, include) => {
  const hidden = alumniIds.filter((id) => !include.includes(id));
  return {
    isDeleted: false,
    ...(hidden.length && { [Op.or]: [{ classId: null }, { classId: { [Op.notIn]: hidden } }] }),
  };
};

// BE-D2: dashboard stat cards, all COUNTs in SQL.
// { totalStudents, activeStudents, students, boys, girls, alumniClasses, totalStaff, totalClasses,
//   classCounts: [{ classId, name, totalStudents, isAlumni }] }
//   students / boys / girls = active + the ticked graduated / left classes.
export const getDashboardSummary = async ({ include } = {}) => {
  const alumni = await Class.findAll({ where: { isAlumni: true, isDeleted: { [Op.not]: true } }, attributes: ["classId", "name"], raw: true });
  const alumniIds = alumni.map((c) => c.classId);
  const ticked = idList(include).filter((id) => alumniIds.includes(id));
  const where = countedWhere(alumniIds, ticked);
  // One query at a time (they share the pool; keeps it predictable).
  const totalStudents = await Student.count({ where: { isDeleted: false } });
  const activeStudents = await Student.count({ where: countedWhere(alumniIds, []) });
  const students = await Student.count({ where });
  const genderOf = (g) => Student.count({ where: { ...where, [Op.and]: [sequelize.where(sequelize.fn("lower", sequelize.fn("trim", sequelize.col("gender"))), g)] } });
  const boys = await genderOf("male");
  const girls = await genderOf("female");
  const alumniClasses = [];
  for (const c of alumni) {
    alumniClasses.push({ classId: c.classId, name: c.name, pupils: await Student.count({ where: { isDeleted: false, classId: c.classId } }), included: ticked.includes(c.classId) });
  }
  const totalStaff = await Teacher.count({ where: { isDeleted: false } });
  const totalClasses = await Class.count({ where: { isDeleted: false } });
  // "Students per class" chart: EVERY class, for everyone who sees the dashboard.
  // The /class list is cut to a Class Teacher's own class, so the chart can't use
  // it. Names and pupil counts only (like the totals above), no pupil details.
  const classRows = await Class.findAll({ where: { isDeleted: { [Op.not]: true } }, attributes: ["classId", "name"], order: [["classId", "ASC"]], raw: true });
  const perClass = await Student.count({ where: { isDeleted: { [Op.not]: true } }, group: ["classId"] });
  const countOf = new Map((Array.isArray(perClass) ? perClass : []).map((r) => [r.classId, Number(r.count)]));
  const classCounts = classRows.map((c) => ({ classId: c.classId, name: c.name, totalStudents: countOf.get(c.classId) || 0, isAlumni: alumniIds.includes(c.classId) }));
  return { totalStudents, activeStudents, students, boys, girls, alumniClasses, totalStaff, totalClasses, classCounts };
};

// BE-D9: students with an outstanding balance only. Filter (feesOwing > 0),
// sort (feesOwing DESC) and field selection are all done in SQL - the resolved
// class name comes from the Class association. NOTE: this reads the existing
// `Student.feesOwing` column as-is; reconciling that column's accuracy is owned
// by another agent and intentionally not touched here.
// Contract: [{ studentId, fName, mName, lName, class, feesOwing }] ordered desc.
export const getStudentsOwing = async ({ include } = {}) => {
  // Graduated / left classes are hidden unless ticked (`include`); with no
  // argument at all (other callers) everyone who owes is listed, as before.
  let where = { feesOwing: { [Op.gt]: 0 }, isDeleted: false };
  if (include !== undefined) {
    const alumni = await Class.findAll({ where: { isAlumni: true }, attributes: ["classId"], raw: true });
    where = { ...countedWhere(alumni.map((c) => c.classId), idList(include)), feesOwing: { [Op.gt]: 0 } };
  }
  const rows = await Student.findAll({
    attributes: ["studentId", "fName", "mName", "lName", "feesOwing"],
    where,
    include: [
      {
        model: Class,
        attributes: ["name"],
        required: false,
      },
    ],
    order: [["feesOwing", "DESC"]],
    raw: true,
    nest: true,
  });

  // Flatten the joined class name into the contracted `class` field.
  return rows.map((row) => ({
    studentId: row.studentId,
    fName: row.fName,
    mName: row.mName,
    lName: row.lName,
    class: row.class_?.name ?? null,
    feesOwing: row.feesOwing,
  }));
};
