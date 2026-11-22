import { Op } from "sequelize";
import sequelize from "../config/database.js";
import {
  Class,
  Student,
  Subject,
  Teacher,
  TeachingAssignment,
  TimetableEntry,
  TimetablePeriod,
  Term,
} from "../models/index.js";
import { AppError } from "../utils/errorHandling.js";

// ---------------------------------------------------------------------------
// B3: timetable. Ported from SchoolPro's TimetableService
// (schoolpro-server/src/timetable/timetable.service.ts):
//   - a class can't be in two lessons at once        -> 409, nothing saved
//   - a teacher booked twice at the same time         -> saved, with a warning
//   - overlap = !(newEnd <= start || newStart >= end) (back-to-back is fine)
// Improvements on SchoolPro:
//   - a school-wide bell schedule (Timetable_period), so the office clicks cells
//   - bulk create and "copy last term" run in ONE transaction (all or nothing)
//   - the class row is locked while checking, so two saves can't both take a slot
//   - "sync subject teachers" feeds the timetable into B2's teaching assignments
// ---------------------------------------------------------------------------

/** School days. Add { day: 6, ... } here if the school has Saturday classes (TODO B3 Q2). */
export const DAYS = [
  { day: 1, label: "Monday", short: "Mon" },
  { day: 2, label: "Tuesday", short: "Tue" },
  { day: 3, label: "Wednesday", short: "Wed" },
  { day: 4, label: "Thursday", short: "Thu" },
  { day: 5, label: "Friday", short: "Fri" },
];
const DAY_NUMBERS = new Set(DAYS.map((d) => d.day));
export const dayLabel = (day) => DAYS.find((d) => d.day === Number(day))?.label ?? `Day ${day}`;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const toMinutes = (t) => {
  const [h, m] = String(t).split(":").map(Number);
  return h * 60 + m;
};
/** "13:05" -> "1:05 PM". Staff read timetables on a 12-hour clock. */
export const to12Hour = (t) => {
  const [h, m] = String(t).split(":").map(Number);
  if (!Number.isFinite(h)) return t;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
};
export const timeRange = (a, b) => `${to12Hour(a)}–${to12Hour(b)}`;
export const overlaps = (a, b) =>
  !(toMinutes(a.endTime) <= toMinutes(b.startTime) || toMinutes(a.startTime) >= toMinutes(b.endTime));

const toInt = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(`${name} is required`, 400);
  return n;
};
const optText = (v, max, name) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > max) throw new AppError(`${name} must be ${max} characters or fewer`, 400);
  return s;
};
const checkTimes = (startTime, endTime, what = "The lesson") => {
  if (!HHMM.test(String(startTime ?? "")) || !HHMM.test(String(endTime ?? ""))) {
    throw new AppError(`${what} needs a start and end time like 08:00`, 400);
  }
  if (toMinutes(startTime) >= toMinutes(endTime)) {
    throw new AppError(`${what} must end after it starts`, 400);
  }
};

const personName = (p) => (p ? [p.fName, p.lName].filter(Boolean).join(" ") : null);

// --- bell schedule -----------------------------------------------------------

export const listPeriods = async () =>
  TimetablePeriod.findAll({ order: [["startTime", "ASC"], ["sortOrder", "ASC"]], raw: true });

/** Checks a whole bell schedule; returns it sorted by start time. */
export const validatePeriods = (periods) => {
  if (!Array.isArray(periods)) throw new AppError("periods must be a list", 400);
  if (periods.length > 20) throw new AppError("A school day can have at most 20 periods", 400);
  const rows = periods.map((p, i) => {
    const label = optText(p?.label, 40, "A period name");
    if (!label) throw new AppError(`Row ${i + 1} needs a name, for example "Period 1" or "Break"`, 400);
    checkTimes(p.startTime, p.endTime, label);
    return { label, startTime: p.startTime, endTime: p.endTime, isBreak: Boolean(p.isBreak) };
  });
  rows.sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
  for (let i = 1; i < rows.length; i += 1) {
    if (overlaps(rows[i - 1], rows[i])) {
      throw new AppError(
        `${rows[i - 1].label} (${timeRange(rows[i - 1].startTime, rows[i - 1].endTime)}) overlaps ` +
          `${rows[i].label} (${timeRange(rows[i].startTime, rows[i].endTime)})`,
        400
      );
    }
  }
  return rows.map((r, i) => ({ ...r, sortOrder: i + 1 }));
};

/** Replace the whole bell schedule. Lessons keep their own times. */
export const replacePeriods = async (periods) => {
  const rows = validatePeriods(periods);
  await sequelize.transaction(async (transaction) => {
    await TimetablePeriod.destroy({ where: {}, transaction });
    if (rows.length) await TimetablePeriod.bulkCreate(rows, { transaction });
  });
  return listPeriods();
};

// --- entries -----------------------------------------------------------------

const INCLUDE = [
  { model: Class, as: "class", attributes: ["name", "section", "teacherId", "isDeleted"], required: false },
  { model: Subject, as: "subject", attributes: ["name"], required: false },
  { model: Teacher, as: "teacher", attributes: ["fName", "lName", "isDeleted"], required: false },
];

export const flattenEntry = (row) => {
  const r = typeof row?.toJSON === "function" ? row.toJSON() : row;
  const { class: klass, subject, teacher, ...rest } = r;
  return {
    ...rest,
    day: Number(rest.day),
    className: klass?.name ?? rest.className ?? null,
    subjectName: subject?.name ?? rest.subjectName ?? null,
    teacherName: teacher ? personName(teacher) : rest.teacherName ?? null,
    teacherArchived: Boolean(teacher?.isDeleted),
    classArchived: Boolean(klass?.isDeleted),
  };
};

const sortEntries = (a, b) => a.day - b.day || toMinutes(a.startTime) - toMinutes(b.startTime);

/** Validated fields for one lesson. Throws 400 with a readable message. */
export const normaliseEntry = (body = {}) => {
  const day = Number(body.day);
  if (!DAY_NUMBERS.has(day)) throw new AppError("Pick a school day (Monday to Friday)", 400);
  checkTimes(body.startTime, body.endTime);
  return {
    termId: toInt(body.termId, "termId"),
    classId: toInt(body.classId, "classId"),
    subjectId: toInt(body.subjectId, "Subject"),
    teacherId: toInt(body.teacherId, "Teacher"),
    day,
    startTime: body.startTime,
    endTime: body.endTime,
    room: optText(body.room, 50, "Room"),
    notes: optText(body.notes, 200, "Notes"),
  };
};

const describe = (e, { withClass = false, withTeacher = false } = {}) =>
  `${e.subjectName ?? "a lesson"}${withClass && e.className ? ` in ${e.className}` : ""}` +
  `${withTeacher && e.teacherName ? ` with ${e.teacherName}` : ""} at ${timeRange(e.startTime, e.endTime)}`;

/** Lessons in the same class + day that overlap `entry` (the hard rule). */
export const findClassClashes = (entry, existing, excludeId) =>
  existing.filter(
    (e) =>
      Number(e.timetableEntryId) !== Number(excludeId) &&
      Number(e.classId) === entry.classId &&
      Number(e.termId) === entry.termId &&
      Number(e.day) === entry.day &&
      overlaps(e, entry)
  );

/** Lessons the same teacher already has at that time (the soft rule). */
export const findTeacherClashes = (entry, existing, excludeId) =>
  existing.filter(
    (e) =>
      Number(e.timetableEntryId) !== Number(excludeId) &&
      Number(e.teacherId) === entry.teacherId &&
      Number(e.termId) === entry.termId &&
      Number(e.day) === entry.day &&
      overlaps(e, entry)
  );

export const classClashMessage = (className, entry, clashes) =>
  `${className} already has ${clashes.map((c) => describe(c, { withTeacher: true })).join(" and ")} on ` +
  `${dayLabel(entry.day)}. Pick a free slot or change that lesson.`;

export const teacherClashWarning = (teacherName, entry, clashes) =>
  `${teacherName} is also teaching ${clashes.map((c) => describe(c, { withClass: true })).join(" and ")} on ` +
  `${dayLabel(entry.day)}. Saved anyway; check this is right.`;

const mustExist = async (Model, where, label, transaction) => {
  const row = await Model.findOne({ where, raw: true, transaction });
  if (!row) throw new AppError(`${label} not found`, 404);
  return row;
};

/** Loads (and checks) the class, subject, teacher and term of a lesson. */
const loadRefs = async (entry, transaction) => {
  // One at a time: queries on a transaction share one connection.
  const klass = await mustExist(Class, { classId: entry.classId, isDeleted: false }, "Class", transaction);
  const subject = await mustExist(Subject, { subjectId: entry.subjectId, isDeleted: false }, "Subject", transaction);
  const teacher = await mustExist(Teacher, { teacherId: entry.teacherId, isDeleted: false }, "Teacher", transaction);
  await mustExist(Term, { termId: entry.termId }, "Term", transaction);
  return { klass, subject, teacher };
};

/** Same-day lessons for this class or this teacher in the term. */
const sameDayLessons = async (entry, transaction) =>
  (
    await TimetableEntry.findAll({
      where: {
        termId: entry.termId,
        day: entry.day,
        [Op.or]: [{ classId: entry.classId }, { teacherId: entry.teacherId }],
      },
      include: INCLUDE,
      transaction,
    })
  ).map(flattenEntry);

/**
 * Checks one lesson against `existing` and returns teacher warnings. Throws 409
 * on a class clash. `refs` gives names for the messages.
 */
const checkClashes = (entry, existing, refs, excludeId) => {
  const classClashes = findClassClashes(entry, existing, excludeId);
  if (classClashes.length) throw new AppError(classClashMessage(refs.klass.name, entry, classClashes), 409);
  const teacherClashes = findTeacherClashes(entry, existing, excludeId);
  return teacherClashes.length ? [teacherClashWarning(personName(refs.teacher), entry, teacherClashes)] : [];
};

// Locking the class row serialises saves for one class, so two people can't
// both take the same free slot.
const lockClass = (classId, transaction) =>
  Class.findOne({ where: { classId }, attributes: ["classId"], transaction, lock: transaction?.LOCK?.UPDATE });

const reload = async (id, transaction) =>
  flattenEntry(await TimetableEntry.findOne({ where: { timetableEntryId: id }, include: INCLUDE, transaction }));

export const listTimetable = async ({ termId, classId, teacherId } = {}) => {
  if (!classId && !teacherId) throw new AppError("Pick a class or a teacher", 400);
  const rows = await TimetableEntry.findAll({
    where: {
      termId: toInt(termId, "termId"),
      ...(classId && { classId: toInt(classId, "classId") }),
      ...(teacherId && { teacherId: toInt(teacherId, "teacherId") }),
    },
    include: INCLUDE,
  });
  return rows.map(flattenEntry).sort(sortEntries);
};

export const createEntry = async (body, { createdBy = null } = {}) => {
  const entry = normaliseEntry(body);
  return sequelize.transaction(async (transaction) => {
    const refs = await loadRefs(entry, transaction);
    await lockClass(entry.classId, transaction);
    const warnings = checkClashes(entry, await sameDayLessons(entry, transaction), refs);
    const created = await TimetableEntry.create({ ...entry, createdBy }, { transaction });
    return { entry: await reload(created.timetableEntryId, transaction), warnings };
  });
};

export const updateEntry = async (id, body, { createdBy = null } = {}) => {
  const entryId = toInt(id, "id");
  return sequelize.transaction(async (transaction) => {
    const current = await TimetableEntry.findOne({ where: { timetableEntryId: entryId }, raw: true, transaction });
    if (!current) throw new AppError("Lesson not found", 404);
    const pick = (k) => (body[k] !== undefined ? body[k] : current[k]);
    const entry = normaliseEntry({
      termId: current.termId, // a lesson stays in its term and class
      classId: current.classId,
      ...Object.fromEntries(["subjectId", "teacherId", "day", "startTime", "endTime", "room", "notes"].map((k) => [k, pick(k)])),
    });
    const refs = await loadRefs(entry, transaction);
    await lockClass(entry.classId, transaction);
    const warnings = checkClashes(entry, await sameDayLessons(entry, transaction), refs, entryId);
    await TimetableEntry.update({ ...entry, createdBy }, { where: { timetableEntryId: entryId }, transaction });
    return { entry: await reload(entryId, transaction), warnings };
  });
};

export const deleteEntry = async (id) => {
  const deleted = await TimetableEntry.destroy({ where: { timetableEntryId: toInt(id, "id") } });
  if (!deleted) throw new AppError("Lesson not found", 404);
  return { deleted };
};

/**
 * Many lessons in one transaction: every row is checked against the database
 * AND the rows before it. Any class clash or bad row rolls back everything.
 */
export const bulkCreateEntries = async (rows, { createdBy = null } = {}) => {
  if (!Array.isArray(rows) || rows.length === 0) throw new AppError("Send at least one lesson", 400);
  if (rows.length > 500) throw new AppError("At most 500 lessons at a time", 400);
  const entries = rows.map((r, i) => {
    try {
      return normaliseEntry(r);
    } catch (e) {
      throw new AppError(`Row ${i + 1}: ${e.message}`, e.statusCode || 400);
    }
  });
  return sequelize.transaction(async (transaction) => {
    // Rows saved earlier in this batch are visible to later queries in the
    // same transaction, so each row is checked against them too.
    let created = 0;
    const warnings = [];
    const classIds = [...new Set(entries.map((e) => e.classId))].sort((a, b) => a - b);
    for (const classId of classIds) await lockClass(classId, transaction); // fixed order: no deadlocks
    for (const [i, entry] of entries.entries()) {
      try {
        const refs = await loadRefs(entry, transaction);
        warnings.push(...checkClashes(entry, await sameDayLessons(entry, transaction), refs).map((w) => `Row ${i + 1}: ${w}`));
      } catch (e) {
        throw new AppError(`Row ${i + 1}: ${e.message}`, e.statusCode || 400);
      }
      await TimetableEntry.create({ ...entry, createdBy }, { transaction });
      created += 1;
    }
    return { created, warnings };
  });
};

/**
 * Start a new term from the last one. Only classes with NO lessons in the
 * target term are copied (a class half-built by hand is left alone). Lessons
 * with an archived teacher or subject are skipped.
 */
export const copyTimetable = async ({ fromTermId, toTermId }, { createdBy = null } = {}) => {
  const from = toInt(fromTermId, "fromTermId");
  const to = toInt(toTermId, "toTermId");
  if (from === to) throw new AppError("Pick two different terms", 400);
  await mustExist(Term, { termId: from }, "Source term");
  await mustExist(Term, { termId: to }, "Target term");

  return sequelize.transaction(async (transaction) => {
    // One copy at a time: a double click would otherwise copy every lesson twice
    // (lessons have no unique key to stop it).
    await sequelize.query("SELECT pg_advisory_xact_lock(4204243, :to)", { replacements: { to }, transaction });
    const source = await TimetableEntry.findAll({ where: { termId: from }, include: INCLUDE, transaction });
    const target = await TimetableEntry.findAll({ where: { termId: to }, attributes: ["classId"], raw: true, transaction });
    const built = new Set(target.map((t) => Number(t.classId)));
    const subjects = await Subject.findAll({ where: { isDeleted: false }, attributes: ["subjectId"], raw: true, transaction });
    const liveSubjects = new Set(subjects.map((s) => Number(s.subjectId)));
    const copiedClasses = new Set();
    const skippedClasses = new Set();
    let copied = 0;
    let skipped = 0;
    const rows = [];
    for (const raw of source) {
      const e = typeof raw.toJSON === "function" ? raw.toJSON() : raw;
      const classId = Number(e.classId);
      if (built.has(classId)) {
        skippedClasses.add(classId);
        continue;
      }
      if (e.teacher?.isDeleted || !liveSubjects.has(Number(e.subjectId)) || e.class?.isDeleted) {
        skipped += 1;
        continue;
      }
      rows.push({
        termId: to,
        classId,
        subjectId: e.subjectId,
        teacherId: e.teacherId,
        day: e.day,
        startTime: e.startTime,
        endTime: e.endTime,
        room: e.room,
        notes: e.notes,
        createdBy,
      });
      copiedClasses.add(classId);
      copied += 1;
    }
    if (rows.length) await TimetableEntry.bulkCreate(rows, { transaction });
    return { copied, skipped, classes: copiedClasses.size, classesAlreadyBuilt: skippedClasses.size };
  });
};

/**
 * B2 link: make the subject-teacher assignments match the timetable. For each
 * (class, subject) the timetable gives exactly one teacher; that teacher is
 * assigned (replacing anyone else). A class teacher teaching their own class
 * needs no row, unless someone else is assigned there. A subject with two
 * different teachers on the timetable is reported, not guessed.
 */
export const planAssignmentSync = (entries, assignments, classTeachers) => {
  const teachersOf = new Map();
  for (const e of entries) {
    const key = `${e.classId}:${e.subjectId}`;
    if (!teachersOf.has(key)) teachersOf.set(key, { entry: e, teachers: new Map() });
    teachersOf.get(key).teachers.set(Number(e.teacherId), e.teacherName);
  }
  const current = new Map(assignments.map((a) => [`${a.classId}:${a.subjectId}`, Number(a.teacherId)]));
  const set = [];
  const conflicts = [];
  let unchanged = 0;
  for (const [key, { entry, teachers }] of teachersOf) {
    if (teachers.size > 1) {
      conflicts.push({ className: entry.className, subjectName: entry.subjectName, teachers: [...teachers.values()] });
      continue;
    }
    const [teacherId] = teachers.keys();
    const assigned = current.get(key);
    const isClassTeacher = Number(classTeachers.get(Number(entry.classId))) === teacherId;
    if (assigned === teacherId || (assigned === undefined && isClassTeacher)) {
      unchanged += 1;
      continue;
    }
    set.push({ classId: Number(entry.classId), subjectId: Number(entry.subjectId), teacherId });
  }
  return { set, unchanged, conflicts };
};

export const syncAssignmentsFromTimetable = async ({ termId }, { createdBy = null } = {}) => {
  const term = toInt(termId, "termId");
  await mustExist(Term, { termId: term }, "Term");
  return sequelize.transaction(async (transaction) => {
    const entries = (await TimetableEntry.findAll({ where: { termId: term }, include: INCLUDE, transaction })).map(
      flattenEntry
    );
    const live = entries.filter((e) => !e.teacherArchived && !e.classArchived);
    const assignments = await TeachingAssignment.findAll({ where: { termId: term }, raw: true, transaction });
    const classes = await Class.findAll({ attributes: ["classId", "teacherId"], raw: true, transaction });
    const classTeachers = new Map(classes.map((c) => [Number(c.classId), c.teacherId]));
    const plan = planAssignmentSync(live, assignments, classTeachers);
    for (const s of plan.set) {
      const where = { classId: s.classId, subjectId: s.subjectId, termId: term };
      const existing = await TeachingAssignment.findOne({ where, transaction });
      if (existing) {
        await TeachingAssignment.update(
          { teacherId: s.teacherId, createdBy, createdAt: new Date() },
          { where: { teachingAssignmentId: existing.teachingAssignmentId }, transaction }
        );
      } else {
        await TeachingAssignment.create({ ...where, teacherId: s.teacherId, createdBy }, { transaction });
      }
    }
    return { set: plan.set.length, unchanged: plan.unchanged, conflicts: plan.conflicts };
  });
};

// --- portal ------------------------------------------------------------------

/**
 * The signed-in pupil's class timetable, or the signed-in teacher's own
 * lessons, for the open term. `term: null` between terms.
 */
export const getPortalTimetable = async ({ id, userRole }) => {
  const term = await Term.findOne({ where: { active: true }, raw: true });
  const periods = await listPeriods();
  const base = { days: DAYS, periods, term: term ? { termId: term.termId, term: term.term } : null, entries: [] };

  if (userRole === "STAFF") {
    const teacher = await Teacher.findOne({ where: { teacherId: id, isDeleted: false }, raw: true });
    if (!teacher) throw new AppError("Your staff account is not active. Contact the school office.", 403);
    const out = { ...base, view: "teacher", title: personName(teacher) };
    if (!term) return out;
    return { ...out, entries: await listTimetable({ termId: term.termId, teacherId: teacher.teacherId }) };
  }

  if (userRole === "STU") {
    const student = await Student.findOne({ where: { studentId: id, isDeleted: false }, raw: true });
    if (!student) throw new AppError("Student not found", 404);
    const klass = student.classId
      ? await Class.findOne({ where: { classId: student.classId }, raw: true })
      : await Class.findOne({ where: { name: student.class, isDeleted: false }, raw: true });
    const out = { ...base, view: "class", title: klass?.name ?? student.class ?? null };
    if (!term || !klass) return out;
    return { ...out, entries: await listTimetable({ termId: term.termId, classId: klass.classId }) };
  }

  throw new AppError("You do not have permission to perform this action", 403);
};
