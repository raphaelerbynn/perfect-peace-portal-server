import { Op } from "sequelize";
import { Class, Subject, Teacher, TeachingAssignment } from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";

// ---------------------------------------------------------------------------
// B2: what a portal teacher (STAFF token) may do. Ported from SchoolPro's
// TeacherScopeService (common/teaching/teacher-scope.service.ts).
//
// Scores for (term, class, subject) are allowed when the teacher:
//   - is assigned that subject in that class for that term (Teaching_assignment), or
//   - is the class teacher (Class.teacher_id) and NOBODY ELSE is assigned that
//     subject in the class that term. This covers primary classes where one
//     teacher takes everything, and a school that hasn't entered assignments yet.
//
// The register (attendance) is class-teacher only (client default, see TODO B2
// question 3). Flip SUBJECT_TEACHERS_TAKE_REGISTER to let anyone assigned in
// the class take it.
//
// Office (management) users never come through here; their routes keep the
// existing role checks.
// ---------------------------------------------------------------------------

export const SUBJECT_TEACHERS_TAKE_REGISTER = false;

export const FORBIDDEN_SCORES_MESSAGE =
  "This subject is not one of yours. Only the teacher assigned to this subject in this class, " +
  "or the class teacher for a subject nobody else is assigned, can enter its scores.";
export const FORBIDDEN_REGISTER_MESSAGE =
  "This register is not one of yours. Only the class teacher can take it.";
export const FORBIDDEN_CLASS_MESSAGE =
  "This class is not one of yours. Ask the school office if you should be teaching it.";

// KG / nursery / creche classes use the KG assessment, not subject scores.
// Matches the section names the office uses (incl. the legacy spellings).
const KG_SECTIONS = new Set(["kg", "nursery", "nursury", "creche", "crech"]);
export const isKgSection = (section) => KG_SECTIONS.has(String(section ?? "").trim().toLowerCase());

// KG / nursery "subjects": the learning areas of the KG report card's
// Academic Progress section (same names the office uses). Each is a class
// score and an exam score out of 100, worth 50% each. Ids are "kg-1".."kg-5".
export const KG_AREAS = ["Language/Literacy", "Numeracy", "Phonics", "Creative Arts", "Environmental Science"];
export const kgAreaList = () => KG_AREAS.map((name, i) => ({ subjectId: `kg-${i + 1}`, name }));
export const isKgAreaId = (id) => /^kg-\d+$/.test(String(id ?? ""));
export const kgAreaName = (id) => {
  const m = /^kg-(\d+)$/.exec(String(id ?? ""));
  return (m && KG_AREAS[Number(m[1]) - 1]) || null;
};

const num = (v) => (v == null ? v : Number(v));
const sameKey = (a, b) =>
  num(a.termId) === num(b.termId) && num(a.classId) === num(b.classId) && num(a.subjectId) === num(b.subjectId);

/** The active, not-archived teacher behind a portal token, or 403. */
export const loadTeacher = async (teacherId) => {
  const teacher = teacherId
    ? await Teacher.findOne({
        where: { teacherId, isDeleted: false },
        attributes: ["teacherId", "fName", "lName"],
        raw: true,
      })
    : null;
  if (!teacher) throw new AppError("Your staff account is not active. Contact the school office.", 403);
  return { ...teacher, name: [teacher.fName, teacher.lName].filter(Boolean).join(" ") };
};

/**
 * Everything the scope rule needs for one teacher in one term:
 *   own               – (term, class, subject) assigned to this teacher
 *   classTeacherOf    – classIds where they are the class teacher
 *   othersInMyClasses – (term, class, subject) assigned to someone else in those classes
 */
export const loadScope = async (teacherId, { termId, classId } = {}) => {
  const narrow = {
    ...(termId != null && { termId }),
    ...(classId != null && { classId }),
  };
  const keyAttrs = ["termId", "classId", "subjectId"];

  const [own, classes] = await Promise.all([
    TeachingAssignment.findAll({ where: { teacherId, ...narrow }, attributes: keyAttrs, raw: true }),
    Class.findAll({
      where: { teacherId, isDeleted: false, ...(classId != null && { classId }) },
      attributes: ["classId"],
      raw: true,
    }),
  ]);
  const classTeacherOf = [...new Set(classes.map((c) => num(c.classId)))];
  // Live data: some classes (KG 2) have no teacher on the class record, only
  // on the teacher's own record. Same rule as the office Classes page
  // (services/classes.js): count it when exactly one teacher names the class.
  const staffRecord = await Teacher.findOne({ where: { teacherId }, attributes: ["classId"], raw: true });
  const namedClass = num(staffRecord?.classId);
  if (namedClass && !classTeacherOf.includes(namedClass) && (classId == null || num(classId) === namedClass)) {
    const [unowned, named] = await Promise.all([
      Class.findAll({ where: { classId: namedClass, teacherId: null, isDeleted: false }, attributes: ["classId"], raw: true }),
      Teacher.count({ where: { classId: namedClass, isDeleted: false } }),
    ]);
    if (unowned.length && named === 1) classTeacherOf.push(namedClass);
  }

  const othersInMyClasses = classTeacherOf.length
    ? await TeachingAssignment.findAll({
        where: {
          classId: { [Op.in]: classTeacherOf },
          teacherId: { [Op.ne]: teacherId },
          ...(termId != null && { termId }),
        },
        attributes: keyAttrs,
        raw: true,
      })
    : [];

  return { own, classTeacherOf, othersInMyClasses };
};

/** SchoolPro's rule, as a pure function (unit-tested directly). */
export const allows = (scope, key) => {
  if (scope.own.some((pair) => sameKey(pair, key))) return true;
  return (
    scope.classTeacherOf.includes(num(key.classId)) &&
    !scope.othersInMyClasses.some((pair) => sameKey(pair, key))
  );
};

export const canScore = async (teacherId, key) =>
  allows(await loadScope(teacherId, { termId: key.termId, classId: key.classId }), key);

export const assertCanScore = async (teacherId, key) => {
  if (!(await canScore(teacherId, key))) throw new AppError(FORBIDDEN_SCORES_MESSAGE, 403);
};

export const canTakeRegister = async (teacherId, classId, { termId } = {}) => {
  const scope = await loadScope(teacherId, { termId, classId });
  if (scope.classTeacherOf.includes(num(classId))) return true;
  return SUBJECT_TEACHERS_TAKE_REGISTER && scope.own.length > 0;
};

export const assertCanTakeRegister = async (teacherId, classId, opts) => {
  if (!(await canTakeRegister(teacherId, classId, opts))) throw new AppError(FORBIDDEN_REGISTER_MESSAGE, 403);
};

/**
 * The teacher's classes for a term, each with the subjects they may score and
 * whether they take its register. Drives the portal pickers, so it uses the
 * same rule as the write checks.
 */
export const scopedClasses = async (teacherId, { termId } = {}) => {
  const scope = await loadScope(teacherId, { termId });
  const classIds = [...new Set([...scope.own.map((o) => num(o.classId)), ...scope.classTeacherOf])];
  if (!classIds.length) return [];

  const [classes, subjects] = await Promise.all([
    Class.findAll({
      where: { classId: { [Op.in]: classIds }, isDeleted: false },
      attributes: ["classId", "name", "section", "teacherId"],
      raw: true,
    }),
    Subject.findAll({
      where: { isDeleted: false },
      attributes: ["subjectId", "name"],
      order: [["name", "ASC"]],
      raw: true,
    }),
  ]);

  return classes
    .map((c) => {
      const classId = num(c.classId);
      const isClassTeacher = scope.classTeacherOf.includes(classId);
      const kg = isKgSection(c.section);
      const mine = kg
        ? isClassTeacher
          ? kgAreaList() // the class teacher scores the KG learning areas
          : []
        : subjects
            .filter((s) => allows(scope, { termId, classId, subjectId: s.subjectId }))
            .map((s) => ({ subjectId: num(s.subjectId), name: s.name }));
      return {
        classId,
        name: c.name,
        section: c.section,
        isKg: kg,
        isClassTeacher,
        takesRegister: isClassTeacher || (SUBJECT_TEACHERS_TAKE_REGISTER && scope.own.some((o) => num(o.classId) === classId)),
        subjects: mine,
      };
    })
    .filter((c) => c.isClassTeacher || c.subjects.length)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
};

/** The class row, or 404; refuses archived classes. */
export const loadClass = async (classId) => {
  const klass = classId
    ? await Class.findOne({
        where: { classId, isDeleted: false },
        attributes: ["classId", "name", "section", "teacherId"],
        raw: true,
      })
    : null;
  if (!klass) throw new AppError("Class not found", 404);
  return klass;
};
