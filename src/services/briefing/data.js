// AI-5: the figures behind each briefing signal, as aggregates in SQL
// (Postgres). Each function returns plain rows for signals.js; nothing here
// decides what is news.
//
// Window (see service.js#windowFor): [weekStart, weekEnd) = the 7 days before
// the briefing day; the baseline is the 4 weeks before that. Dates are civil
// "YYYY-MM-DD" strings (DATEONLY columns).
//
// Live-data notes: Attendance.status is CHAR(10) (space-padded, TRIM before
// comparing); attendance rows are grouped by the pupil's CURRENT class (rows
// carry a class-name string that renames and promotion leave behind);
// Class.is_deleted may be NULL on old rows; reversed payments don't count.
import { QueryTypes } from "sequelize";
import sequelize from "../../config/database.js";

const select = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const n = (v) => Number(v) || 0;

// Classes still in use: not archived, not a graduated / left class.
const LIVE_CLASS = `COALESCE(c.is_deleted, FALSE) = FALSE AND COALESCE(c.is_alumni, FALSE) = FALSE`;

/**
 * Per class: register marks and "Present" marks in the window and in the
 * baseline (from `baselineStart`, which the service keeps inside this term).
 */
export const attendanceByClass = async ({ weekStart, weekEnd, baselineStart }) => {
  const rows = await select(
    `SELECT c.class_id AS "classId", c.name AS "className",
            COUNT(*) FILTER (WHERE a.date_marked >= :weekStart) AS "weekMarked",
            COUNT(*) FILTER (WHERE a.date_marked >= :weekStart AND TRIM(a.status) = 'Present') AS "weekPresent",
            COUNT(*) FILTER (WHERE a.date_marked < :weekStart) AS "baselineMarked",
            COUNT(*) FILTER (WHERE a.date_marked < :weekStart AND TRIM(a.status) = 'Present') AS "baselinePresent"
       FROM "dbo"."Attendance" a
       JOIN "dbo"."Student" s ON s.student_id = a.student_id
       JOIN "dbo"."Class" c ON c.class_id = s.class_id
      WHERE a.date_marked >= :baselineStart AND a.date_marked < :weekEnd
        AND s.is_deleted = FALSE AND ${LIVE_CLASS}
      GROUP BY c.class_id, c.name`,
    { weekStart, weekEnd, baselineStart }
  );
  return rows.map((r) => ({ ...r, weekMarked: n(r.weekMarked), weekPresent: n(r.weekPresent), baselineMarked: n(r.baselineMarked), baselinePresent: n(r.baselinePresent) }));
};

/**
 * Pupils away (absent or sick) at least once in the window, with their term
 * counts up to the end of the window and up to its start.
 */
export const absenceByPupil = async ({ termId, weekStart, weekEnd }) => {
  const rows = await select(
    `SELECT s.student_id AS "studentId", s.f_name AS "fName", s.l_name AS "lName", c.name AS "className",
            COUNT(*) FILTER (WHERE a.date_marked < :weekEnd) AS "markedToDate",
            COUNT(*) FILTER (WHERE a.date_marked < :weekEnd AND TRIM(a.status) <> 'Present') AS "missedToDate",
            COUNT(*) FILTER (WHERE a.date_marked < :weekStart) AS "markedBefore",
            COUNT(*) FILTER (WHERE a.date_marked < :weekStart AND TRIM(a.status) <> 'Present') AS "missedBefore"
       FROM "dbo"."Attendance" a
       JOIN "dbo"."Student" s ON s.student_id = a.student_id
       LEFT JOIN "dbo"."Class" c ON c.class_id = s.class_id
      WHERE a.term_id = :termId AND s.is_deleted = FALSE
        AND (c.class_id IS NULL OR (${LIVE_CLASS}))
      GROUP BY s.student_id, s.f_name, s.l_name, c.name
     HAVING COUNT(*) FILTER (WHERE a.date_marked >= :weekStart AND a.date_marked < :weekEnd AND TRIM(a.status) <> 'Present') > 0`,
    { termId, weekStart, weekEnd }
  );
  return rows.map((r) => ({
    studentId: r.studentId,
    name: [r.fName, r.lName].filter(Boolean).map((x) => String(x).trim()).join(" "),
    className: r.className,
    markedToDate: n(r.markedToDate),
    missedToDate: n(r.missedToDate),
    markedBefore: n(r.markedBefore),
    missedBefore: n(r.missedBefore),
  }));
};

/**
 * Fee payments per week: bucket 0 = [weekStart, weekEnd), 1..4 = the weeks
 * before. Reversed payments are not money taken.
 */
export const feesByWeek = async ({ weekEnd, baselineStart }) => {
  const rows = await select(
    `SELECT ((CAST(:weekEnd AS date) - 1 - f.date_paid) / 7) AS "bucket",
            COALESCE(SUM(f.paid), 0) AS "total",
            COUNT(*) AS "payments"
       FROM "dbo"."Fee" f
      WHERE f.reversed_at IS NULL AND f.paid > 0
        AND f.date_paid >= :baselineStart AND f.date_paid < :weekEnd
      GROUP BY 1`,
    { weekEnd, baselineStart }
  );
  return rows.map((r) => ({ bucket: n(r.bucket), total: n(r.total), payments: n(r.payments) }));
};

/** Pupils on roll owing the line or more, their total, and the 3 classes with most. */
export const owingSummary = async ({ threshold }) => {
  const [sum] = await select(
    `SELECT COUNT(*) FILTER (WHERE s.fees_owing >= :threshold) AS "count",
            COALESCE(SUM(s.fees_owing) FILTER (WHERE s.fees_owing >= :threshold), 0) AS "total",
            COUNT(*) AS "onRoll"
       FROM "dbo"."Student" s
       LEFT JOIN "dbo"."Class" c ON c.class_id = s.class_id
      WHERE s.is_deleted = FALSE AND (c.class_id IS NULL OR (${LIVE_CLASS}))`,
    { threshold }
  );
  const byClass = await select(
    `SELECT COALESCE(c.name, 'No class') AS "className", COUNT(*) AS "count"
       FROM "dbo"."Student" s
       LEFT JOIN "dbo"."Class" c ON c.class_id = s.class_id
      WHERE s.is_deleted = FALSE AND (c.class_id IS NULL OR (${LIVE_CLASS})) AND s.fees_owing >= :threshold
      GROUP BY COALESCE(c.name, 'No class')
      ORDER BY 2 DESC, 1
      LIMIT 3`,
    { threshold }
  );
  return { count: n(sum?.count), total: n(sum?.total), onRoll: n(sum?.onRoll), byClass: byClass.map((r) => ({ className: r.className, count: n(r.count) })) };
};

/** Staff marked ABSENT in the window (B9), per person. */
export const staffAbsences = async ({ weekStart, weekEnd }) => {
  const rows = await select(
    `SELECT t.teacher_id AS "teacherId", t.f_name AS "fName", t.l_name AS "lName", COUNT(*) AS "weekAbsences"
       FROM "dbo"."Staff_attendance" sa
       JOIN "dbo"."Teacher" t ON t.teacher_id = sa.teacher_id
      WHERE sa.date >= :weekStart AND sa.date < :weekEnd AND sa.status = 'ABSENT' AND t.is_deleted = FALSE
      GROUP BY t.teacher_id, t.f_name, t.l_name`,
    { weekStart, weekEnd }
  );
  return rows.map((r) => ({ teacherId: r.teacherId, name: [r.fName, r.lName].filter(Boolean).map((x) => String(x).trim()).join(" "), weekAbsences: n(r.weekAbsences) }));
};

/**
 * Unmarked registers: school days = weekdays in the window (and the term) on
 * which any class marked a register; per class with pupils, the school days it
 * marked nothing. -> { schoolDays, rows: [{ classId, className, missed }] }
 */
export const unmarkedRegisters = async ({ weekStart, weekEnd, termStart }) => {
  const from = termStart && termStart > weekStart ? termStart : weekStart;
  const days = `SELECT DISTINCT a.date_marked AS d FROM "dbo"."Attendance" a
                 WHERE a.date_marked >= :from AND a.date_marked < :weekEnd AND EXTRACT(ISODOW FROM a.date_marked) < 6`;
  const [count] = await select(`SELECT COUNT(*) AS "schoolDays" FROM (${days}) x`, { from, weekEnd });
  const schoolDays = n(count?.schoolDays);
  if (!schoolDays) return { schoolDays: 0, rows: [] };
  const rows = await select(
    `WITH days AS (${days}),
          classes AS (
            SELECT c.class_id, c.name FROM "dbo"."Class" c
             WHERE ${LIVE_CLASS}
               AND EXISTS (SELECT 1 FROM "dbo"."Student" s WHERE s.class_id = c.class_id AND s.is_deleted = FALSE)
          ),
          marked AS (
            SELECT DISTINCT s.class_id, a.date_marked AS d
              FROM "dbo"."Attendance" a JOIN "dbo"."Student" s ON s.student_id = a.student_id
             WHERE a.date_marked >= :from AND a.date_marked < :weekEnd
          )
     SELECT cl.class_id AS "classId", cl.name AS "className", COUNT(*) AS "missed"
       FROM classes cl CROSS JOIN days dd
       LEFT JOIN marked m ON m.class_id = cl.class_id AND m.d = dd.d
      WHERE m.class_id IS NULL
      GROUP BY cl.class_id, cl.name`,
    { from, weekEnd }
  );
  return { schoolDays, rows: rows.map((r) => ({ classId: r.classId, className: r.className, missed: n(r.missed) })) };
};
