// AI-4: the figures behind the watchlist, as SQL (Postgres). Each function
// returns plain rows for signals.js; nothing here decides who is at risk.
//
// Live-data notes (as AI-5 / B11): Attendance.status is CHAR(10), space-padded
// (TRIM before comparing); Class.is_deleted / is_alumni may be NULL on old
// rows; old data can hold two marks rows for a pupil, subject and term (the
// newest counts); a closed term's registers may have been rolled up into
// Total_attendance (the roll-up counts when there is one, as B11).
import { QueryTypes } from "sequelize";
import sequelize from "../../config/database.js";

const select = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const n = (v) => Number(v) || 0;
const LIVE_CLASS = `COALESCE(c.is_deleted, FALSE) = FALSE AND COALESCE(c.is_alumni, FALSE) = FALSE`;

/**
 * Pupils on roll in live classes (one class, or every class when classId is
 * null). Pupils with no class (legacy NULL class_id) can't be scoped to a
 * class teacher and are left out.
 */
export const roster = async ({ classId = null }) => {
  const rows = await select(
    `SELECT s.student_id AS "studentId", s.f_name AS "fName", s.m_name AS "mName", s.l_name AS "lName",
            s.fees_owing AS "owing", c.class_id AS "classId", c.name AS "className", c.section AS "section"
       FROM "dbo"."Student" s
       JOIN "dbo"."Class" c ON c.class_id = s.class_id
      WHERE COALESCE(s.is_deleted, FALSE) = FALSE AND ${LIVE_CLASS}
        AND (CAST(:classId AS integer) IS NULL OR c.class_id = CAST(:classId AS integer))
      ORDER BY c.name, s.l_name, s.f_name, s.student_id`,
    { classId }
  );
  return rows.map((r) => ({
    studentId: Number(r.studentId),
    name: [r.fName, r.mName, r.lName].filter(Boolean).map((x) => String(x).trim()).filter(Boolean).join(" "),
    firstName: String(r.fName ?? "").trim(),
    owing: r.owing === null || r.owing === undefined ? null : Number(r.owing),
    classId: Number(r.classId),
    className: String(r.className ?? "").trim(),
    section: r.section,
  }));
};

/**
 * This term's subject marks per pupil, one per subject (newest row). A
 * subject counts once its exam score is in, so a class score entered alone
 * mid-term doesn't look like a failed subject.
 */
export const termMarks = async ({ termId, studentIds }) => {
  if (!studentIds.length) return [];
  const rows = await select(
    `SELECT m.student_id AS "studentId", m.subject_id AS "subjectId", sub.name AS "subjectName", m.total_score AS "score"
       FROM (
         SELECT DISTINCT ON (student_id, subject_id) student_id, subject_id, total_score
           FROM "dbo"."Student_marks"
          WHERE term_id = :termId AND student_id IN (:studentIds)
            AND total_score IS NOT NULL AND exam_score IS NOT NULL
          ORDER BY student_id, subject_id, student_marks_id DESC
       ) m
       LEFT JOIN "dbo"."Subject" sub ON sub.subject_id = m.subject_id`,
    { termId, studentIds }
  );
  return rows.map((r) => ({ studentId: Number(r.studentId), subjectId: r.subjectId, subjectName: r.subjectName, score: Number(r.score) }));
};

/** Last term's average subject score and subject count per pupil (same rules). */
export const termAverages = async ({ termId, studentIds }) => {
  if (!studentIds.length || termId == null) return [];
  const rows = await select(
    `SELECT student_id AS "studentId", COUNT(*) AS "subjects", AVG(total_score) AS "average"
       FROM (
         SELECT DISTINCT ON (student_id, subject_id) student_id, subject_id, total_score
           FROM "dbo"."Student_marks"
          WHERE term_id = :termId AND student_id IN (:studentIds)
            AND total_score IS NOT NULL AND exam_score IS NOT NULL
          ORDER BY student_id, subject_id, student_marks_id DESC
       ) m
      GROUP BY student_id`,
    { termId, studentIds }
  );
  return rows.map((r) => ({ studentId: Number(r.studentId), subjects: n(r.subjects), average: r.average === null ? null : Number(r.average) }));
};

/**
 * Days present and days marked this term per pupil: the closed-term roll-up
 * (Total_attendance) when there is one, else the daily register. Sick counts
 * as not present (as the B7 summary, B11 and the briefing).
 */
export const termAttendance = async ({ termId, studentIds }) => {
  if (!studentIds.length) return [];
  const rows = await select(
    `WITH tot AS (
       SELECT DISTINCT ON (student_id) student_id, present, attendance AS days
         FROM "dbo"."Total_attendance"
        WHERE term_id = :termId AND student_id IN (:studentIds)
        ORDER BY student_id, total_attendance_id DESC
     ),
     live AS (
       SELECT student_id,
              COUNT(*) FILTER (WHERE TRIM(status) = 'Present') AS present,
              COUNT(status) AS days
         FROM "dbo"."Attendance"
        WHERE term_id = :termId AND student_id IN (:studentIds)
        GROUP BY student_id
     )
     SELECT COALESCE(t.student_id, l.student_id) AS "studentId",
            CASE WHEN t.student_id IS NOT NULL THEN t.present ELSE l.present END AS "present",
            CASE WHEN t.student_id IS NOT NULL THEN t.days ELSE l.days END AS "marked"
       FROM tot t FULL OUTER JOIN live l ON l.student_id = t.student_id`,
    { termId, studentIds }
  );
  return rows.map((r) => ({ studentId: Number(r.studentId), present: n(r.present), marked: n(r.marked) }));
};

/** Each pupil's last few register marks this term, newest first (for days away in a row). */
export const recentRegisters = async ({ termId, studentIds, limit = 15 }) => {
  if (!studentIds.length) return [];
  const rows = await select(
    `SELECT student_id AS "studentId", date_marked AS "date", TRIM(status) AS "status"
       FROM (
         SELECT a.student_id, a.date_marked, a.status,
                ROW_NUMBER() OVER (PARTITION BY a.student_id ORDER BY a.date_marked DESC, a.attendance_id DESC) AS rn
           FROM "dbo"."Attendance" a
          WHERE a.term_id = :termId AND a.student_id IN (:studentIds) AND a.status IS NOT NULL
       ) x
      WHERE rn <= :limit
      ORDER BY student_id, date_marked DESC`,
    { termId, studentIds, limit }
  );
  return rows.map((r) => ({ studentId: Number(r.studentId), date: r.date ? String(r.date).slice(0, 10) : null, status: String(r.status ?? "").trim() }));
};
