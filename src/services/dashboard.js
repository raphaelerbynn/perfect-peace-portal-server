import { Op } from "sequelize";
import { Class, Student, Teacher } from "../models/index.js";
import { GRADUATED_CLASS_IDS } from "../config/school.js";

// BE-D2: dashboard stat cards. All four numbers are computed with COUNT in SQL
// (no whole-table reads). `activeStudents` excludes graduated/alumni classes.
// Contract: { totalStudents, activeStudents, totalStaff, totalClasses }.
export const getDashboardSummary = async () => {
  const [totalStudents, activeStudents, totalStaff, totalClasses] =
    await Promise.all([
      Student.count(),
      Student.count({
        where: { classId: { [Op.notIn]: GRADUATED_CLASS_IDS } },
      }),
      Teacher.count(),
      Class.count(),
    ]);

  return { totalStudents, activeStudents, totalStaff, totalClasses };
};

// BE-D9: students with an outstanding balance only. Filter (feesOwing > 0),
// sort (feesOwing DESC) and field selection are all done in SQL — the resolved
// class name comes from the Class association. NOTE: this reads the existing
// `Student.feesOwing` column as-is; reconciling that column's accuracy is owned
// by another agent and intentionally not touched here.
// Contract: [{ studentId, fName, mName, lName, class, feesOwing }] ordered desc.
export const getStudentsOwing = async () => {
  const rows = await Student.findAll({
    attributes: ["studentId", "fName", "mName", "lName", "feesOwing"],
    where: { feesOwing: { [Op.gt]: 0 } },
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
