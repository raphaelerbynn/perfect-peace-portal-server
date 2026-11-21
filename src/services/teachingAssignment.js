import sequelize from "../config/database.js";
import { Class, Subject, Teacher, TeachingAssignment, Term } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";

// B2: office CRUD for "who teaches which subject in which class, per term".
// One teacher per (class, subject, term); setting a cell replaces its teacher.

const toInt = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(`${name} is required`, 400);
  return n;
};

const INCLUDE = [
  { model: Teacher, as: "teacher", attributes: ["fName", "lName", "isDeleted"], required: false },
  { model: Class, as: "class", attributes: ["name", "section"], required: false },
  { model: Subject, as: "subject", attributes: ["name"], required: false },
  { model: Term, as: "term", attributes: ["term", "startDate", "endDate"], required: false },
];

const flatten = (row) => {
  const r = typeof row?.toJSON === "function" ? row.toJSON() : row;
  const { teacher, class: klass, subject, term, ...rest } = r;
  return {
    ...rest,
    teacherName: teacher ? [teacher.fName, teacher.lName].filter(Boolean).join(" ") : null,
    teacherArchived: Boolean(teacher?.isDeleted),
    className: klass?.name ?? null,
    section: klass?.section ?? null,
    subjectName: subject?.name ?? null,
    termName: term?.term ?? null,
  };
};

const listTeachingAssignments = async ({ termId, classId, teacherId } = {}) => {
  const where = {
    ...(termId && { termId: toInt(termId, "termId") }),
    ...(classId && { classId: toInt(classId, "classId") }),
    ...(teacherId && { teacherId: toInt(teacherId, "teacherId") }),
  };
  const rows = await TeachingAssignment.findAll({
    where,
    include: INCLUDE,
    order: [["termId", "DESC"], ["classId", "ASC"], ["subjectId", "ASC"]],
  });
  return rows.map(flatten);
};

const mustExist = async (Model, pk, label, where = {}, transaction) => {
  const row = await Model.findOne({ where: { ...where, ...pk }, raw: true, transaction });
  if (!row) throw new AppError(`${label} not found`, 404);
  return row;
};

/**
 * Set (or replace) the teacher of one (class, subject, term). Returns the row.
 */
const setTeachingAssignment = async ({ teacherId, classId, subjectId, termId }, { createdBy = null } = {}) => {
  const ids = {
    teacherId: toInt(teacherId, "teacherId"),
    classId: toInt(classId, "classId"),
    subjectId: toInt(subjectId, "subjectId"),
    termId: toInt(termId, "termId"),
  };
  return await sequelize.transaction(async (transaction) => {
    await mustExist(Teacher, { teacherId: ids.teacherId }, "Teacher", { isDeleted: false }, transaction);
    await mustExist(Class, { classId: ids.classId }, "Class", { isDeleted: false }, transaction);
    await mustExist(Subject, { subjectId: ids.subjectId }, "Subject", { isDeleted: false }, transaction);
    await mustExist(Term, { termId: ids.termId }, "Term", {}, transaction);

    const key = { classId: ids.classId, subjectId: ids.subjectId, termId: ids.termId };
    const existing = await TeachingAssignment.findOne({ where: key, transaction, lock: transaction.LOCK?.UPDATE });
    if (existing) {
      if (Number(existing.teacherId) !== ids.teacherId) {
        await TeachingAssignment.update(
          { teacherId: ids.teacherId, createdBy, createdAt: new Date() },
          { where: { teachingAssignmentId: existing.teachingAssignmentId }, transaction }
        );
      }
      return flatten(
        await TeachingAssignment.findOne({
          where: { teachingAssignmentId: existing.teachingAssignmentId },
          include: INCLUDE,
          transaction,
        })
      );
    }
    const created = await TeachingAssignment.create({ ...ids, createdBy }, { transaction });
    return flatten(
      await TeachingAssignment.findOne({
        where: { teachingAssignmentId: created.teachingAssignmentId },
        include: INCLUDE,
        transaction,
      })
    );
  });
};

const removeTeachingAssignment = async (id) => {
  const deleted = await TeachingAssignment.destroy({ where: { teachingAssignmentId: toInt(id, "id") } });
  if (!deleted) throw new AppError("Assignment not found", 404);
  return { deleted };
};

/**
 * Copy one term's assignments into another (start of a new term). Cells the
 * target term already has are left alone; archived teachers/classes/subjects
 * are skipped.
 */
const copyTeachingAssignments = async ({ fromTermId, toTermId }, { createdBy = null } = {}) => {
  const from = toInt(fromTermId, "fromTermId");
  const to = toInt(toTermId, "toTermId");
  if (from === to) throw new AppError("Pick two different terms", 400);
  await mustExist(Term, { termId: from }, "Source term");
  await mustExist(Term, { termId: to }, "Target term");

  return await sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT pg_advisory_xact_lock(4204244, :to)", { replacements: { to }, transaction });
    // One query at a time: inside a transaction they share one connection.
    const source = await TeachingAssignment.findAll({
      where: { termId: from },
      include: [
        { model: Teacher, as: "teacher", attributes: ["isDeleted"], required: true },
        { model: Class, as: "class", attributes: ["isDeleted"], required: true },
        { model: Subject, as: "subject", attributes: ["isDeleted"], required: true },
      ],
      transaction,
    });
    const target = await TeachingAssignment.findAll({ where: { termId: to }, attributes: ["classId", "subjectId"], raw: true, transaction });
    const taken = new Set(target.map((t) => `${t.classId}:${t.subjectId}`));
    let copied = 0;
    let skipped = 0;
    for (const row of source) {
      const archived = row.teacher?.isDeleted || row.class?.isDeleted || row.subject?.isDeleted;
      const key = `${row.classId}:${row.subjectId}`;
      if (archived || taken.has(key)) {
        skipped += 1;
        continue;
      }
      await TeachingAssignment.create(
        { teacherId: row.teacherId, classId: row.classId, subjectId: row.subjectId, termId: to, createdBy },
        { transaction }
      );
      taken.add(key);
      copied += 1;
    }
    return { copied, skipped };
  });
};

export { listTeachingAssignments, setTeachingAssignment, removeTeachingAssignment, copyTeachingAssignments };
