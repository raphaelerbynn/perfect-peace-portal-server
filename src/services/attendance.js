import { Op } from "sequelize";
import sequelize from "../config/database.js";
import { Attendance, Class, Student, TotalAttendance } from "../models/index.js";
import { getTerm } from "./term.js";
import { AppError } from "../utils/errorHandling.js";

// BE-7: the term roll-up (addTermAttendance) only sums these statuses. A mark
// with any other value is silently dropped from every count, so reject it at
// write time.
const VALID_STATUSES = ["Present", "Sick", "Absent"];

const normName = (s) => String(s ?? "").trim().toLowerCase();

// BE-5: resolve the class NAME a Class Teacher is assigned to. Attendance rows
// key on the denormalized class-name string (not classId), so we compare names.
// Administrators are never class-scoped (returns null = no restriction).
const getTeacherClassName = async (user) => {
    if (!user || user.category === "Administrator") return null;
    if (!user.teacherId) {
        throw new AppError("Your account is not linked to a class", 403);
    }
    const klass = await Class.findOne({
        where: { teacherId: user.teacherId, isDeleted: false },
        raw: true,
    });
    return klass ? klass.name : null;
};

// BE-5: throw 403 unless `user` may act on `className`. Administrator bypasses;
// a Class Teacher may only touch the class they are assigned to. Used by every
// attendance read/write so a Class Teacher can no longer pass an arbitrary
// `class` and reach another class via the API.
const assertClassAccess = async (user, className) => {
    if (!user || user.category === "Administrator") return;
    const own = await getTeacherClassName(user);
    if (!own || normName(own) !== normName(className)) {
        throw new AppError("You can only manage attendance for your own class", 403);
    }
};

// Security review: assertClassAccess only checks the class NAME in the body.
// For a Class Teacher login also check that every pupil written to is in that
// class (else a false "absent" SMS could go to any parent, or marks be filed
// for another class's pupil) and that the write is for the open term (closed
// terms' results, e.g. after promotion, are office-only). Administrators are
// unchanged.
const assertClassWrite = async (user, className, studentIds = [], termId = null) => {
    await assertClassAccess(user, className);
    if (!user || user.category === "Administrator") return;
    const term = await getTerm();
    if (termId != null && termId !== "" && Number(termId) !== Number(term?.termId)) {
        throw new AppError("Class Teachers can only change the open term. Ask the administrator.", 403);
    }
    const ids = [...new Set(studentIds.filter((x) => x != null).map(Number))];
    if (!ids.length) return;
    // The teacher's own class record (assertClassAccess already matched the
    // name leniently): live has names like " NURSERY 2", so an exact name
    // lookup missed the class and refused every pupil in it.
    const klass = await Class.findOne({ where: { teacherId: user.teacherId, isDeleted: false }, attributes: ["classId", "name"], raw: true });
    const pupils = await Student.findAll({
        where: {
            studentId: { [Op.in]: ids },
            isDeleted: false,
            [Op.or]: [{ classId: klass?.classId ?? -1 }, { classId: null, class: klass?.name ?? className }],
        },
        attributes: ["studentId"],
        raw: true,
    });
    if (pupils.length !== ids.length) {
        throw new AppError("A pupil in this list is not in your class. Reload and try again.", 403);
    }
};

// BE-1/BE-2/BE-4: mark a whole class's attendance for one day, ATOMICALLY.
// The old code fired the inserts (inside .map) concurrently with the delete,
// so a re-mark could delete the rows it had just inserted (silent data loss),
// and nothing was transactional. Here we delete the class+day's existing rows
// FIRST and then insert the new ones, all inside ONE transaction — so a partial
// failure rolls everything back and a re-mark is last-write-wins with no dupes.
// The composite UNIQUE index (student_id, date_marked, term_id) backs this at
// the DB level against concurrent callers.
const markClassAttendance = async ({ className, dateMarked, dateEnd, studentAttendance }) => {
    const term = await getTerm();
    const termId = term ? term.termId : null;

    return await sequelize.transaction(async (t) => {
        // delete the existing day FIRST (correct ordering), scoped to class+day
        await Attendance.destroy({
            where: { class: className, dateMarked },
            transaction: t,
        });

        const rows = [];
        for (const mark of studentAttendance) {
            const row = await Attendance.create(
                {
                    studentId: mark.studentId,
                    class: className,
                    status: mark.status,
                    dateMarked,
                    // BE-6: getTerm() returns a raw object, so the old
                    // `term.dataValues.endDate` was always undefined → dateEnd
                    // was always null. Read the plain field instead.
                    dateEnd: dateEnd ?? (term ? term.endDate : null),
                    termId,
                },
                { transaction: t }
            );
            rows.push(row);
        }
        return rows;
    });
};

// BE-10: count of distinct marked days for a class, scoped to the active term.
// `group: ['dateMarked']` returns one row per day; its length is the number of
// days that have any attendance recorded. (Shape preserved for the admin FE,
// which reads `.length`.)
const totalAttendanceMarked = async (data) => {
    // Sequelize throws (500) on an undefined where value; say what's missing.
    if (!data?.class) throw new AppError("class is required", 400);
    const term = await getTerm();
    const totalCount = await Attendance.count({
        where: {
            class: data?.class,
            ...(term ? { termId: term.termId } : {}),
        },
        group: ["dateMarked"],
    });

    return totalCount;
};

// BE-8/BE-9: hard-require class AND dateMarked. Sequelize silently DROPS
// `undefined` keys from a where clause, so a delete missing dateMarked used to
// wipe the entire class's attendance across every date. Validate up front.
const removeAttendance = async (data, { transaction } = {}) => {
    if (!data?.class || !data?.dateMarked) {
        throw new AppError("class and dateMarked are required", 400);
    }
    const response = await Attendance.destroy({
        where: {
            class: data.class,
            dateMarked: data.dateMarked,
        },
        ...(transaction ? { transaction } : {}),
    });

    return response;
};

const getAttendance = async (data) => {
    if (!data?.class || !data?.date) {
        throw new AppError("class and date are required", 400);
    }
    const response = await Attendance.findAll({
        where: {
            class: data.class,
            dateMarked: data.date,
        },
        raw: true,
        order: [["studentId", "ASC"]],
    });

    return response;
};

const getTotalStudentAttendance = async (data) => {
    if (!data?.studentId || !data?.termId) {
        throw new AppError("studentId and termId are required", 400);
    }
    const response = await TotalAttendance.findOne({
        where: {
            studentId: data.studentId,
            termId: data.termId,
        },
        raw: true,
        order: [["totalAttendanceId", "DESC"]],
    });

    return response;
};

// BE-3/BE-17: roll the active term's daily attendance into TotalAttendance.
// Previously this:
//   - grouped only by studentId, so each row's term_id was a nondeterministic
//     "any value from the group" (MySQL) and could be attributed to the wrong term;
//   - `Attendance.destroy({ truncate: true })` wiped ALL attendance for ALL
//     terms/classes, destroying cross-term history irrecoverably; and
//   - blindly `create`d, so re-running duplicated every TotalAttendance row.
// Now it is scoped to the active term, grouped by (studentId, termId), upserted
// on the (studentId, termId) unique index, and only the active term's source
// rows are deleted — all in ONE transaction.
const addTermAttendance = async () => {
    const term = await getTerm();
    if (!term?.termId) {
        throw new AppError("No active term is set", 400);
    }

    // valid (non-deleted) student IDs — drop attendance for students that no
    // longer exist / were archived.
    const validStudents = await Student.findAll({
        attributes: ["studentId"],
        where: { isDeleted: false },
        raw: true,
    });
    const validStudentIds = new Set(validStudents.map((s) => s.studentId));

    return await sequelize.transaction(async (t) => {
        // Select ONLY the grouped columns + aggregates. The old version selected
        // every other column too (class, date_end…): MySQL allowed that, but
        // Postgres refuses it, so closing a term failed on Postgres.
        const attendances = await Attendance.findAll({
            attributes: [
                "studentId",
                "termId",
                [sequelize.fn("SUM", sequelize.literal(`CASE WHEN TRIM(status) = 'Present' THEN 1 ELSE 0 END`)), "present"],
                [sequelize.fn("SUM", sequelize.literal(`CASE WHEN TRIM(status) = 'Sick' THEN 1 ELSE 0 END`)), "sick"],
                [sequelize.fn("SUM", sequelize.literal(`CASE WHEN TRIM(status) = 'Absent' THEN 1 ELSE 0 END`)), "absent"],
                [sequelize.fn("COUNT", sequelize.col("status")), "attendance"],
            ],
            where: { termId: term.termId },
            raw: true,
            group: ["studentId", "termId"],
            transaction: t,
        });

        const validAttendances = attendances.filter((a) => validStudentIds.has(a.studentId));

        const results = [];
        for (const attendance of validAttendances) {
            // BE-11: `absent` is intentionally NOT stored — TotalAttendance has
            // no absent column. Consumers derive it as
            // (attendance - present - sick). We persist the three that have columns.
            const [row] = await TotalAttendance.upsert(
                {
                    studentId: attendance.studentId,
                    present: attendance.present,
                    sick: attendance.sick,
                    attendance: attendance.attendance,
                    termId: term.termId,
                },
                { transaction: t }
            );
            results.push(row);
        }

        // only clear THIS term's source rows, never the whole table
        await Attendance.destroy({
            where: { termId: term.termId },
            transaction: t,
        });

        return results;
    });
};

export {
    markClassAttendance,
    assertClassAccess,
    assertClassWrite,
    getTeacherClassName,
    VALID_STATUSES,
    removeAttendance,
    getAttendance,
    totalAttendanceMarked,
    addTermAttendance,
    getTotalStudentAttendance,
};
