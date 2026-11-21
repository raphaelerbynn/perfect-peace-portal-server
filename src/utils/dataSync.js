// Pure helpers for the live MySQL -> new Postgres top-up sync
// (src/scripts/syncFromMysql.js). They only build SQL and make decisions, so
// they can be unit-tested without a database.
//
// How the sync compares rows: the live rows are loaded into a temporary table
// with the target table's own column types, and Postgres compares them with
// IS DISTINCT FROM. So "12.5" vs 12.50, dates and booleans compare exactly the
// way the move stored them, and an unchanged row is never rewritten.
import { UNIQUE_KEYS } from "./dataMove.js";

export const LIVE = '"_sync_live"';
export const CAND = '"_sync_cand"';
export const q = (c) => `"${c}"`;

// "a matches b on this unique key": every column equal (an empty column never
// matches, like a Postgres unique index); lower(name) keys compare lower-cased.
export const keyMatchSql = (columns, a, b) =>
  columns
    .map((c) => {
      const m = /^lower\((\w+)\)$/.exec(c);
      return m ? `lower(${a}.${q(m[1])}) = lower(${b}.${q(m[1])})` : `${a}.${q(c)} = ${b}.${q(c)}`;
    })
    .join(" AND ");

export const uniqueKeysFor = (table) => UNIQUE_KEYS.filter((k) => k.table === table);

// Changed rows: live wins on every column live has (never the id).
export const changedCountSql = (target, pk, cols) =>
  `SELECT ${cols.map((c) => `COUNT(*) FILTER (WHERE t.${q(c)} IS DISTINCT FROM l.${q(c)})::int AS ${q(c)}`).join(", ") || "0 AS none"}
     FROM ${target} t JOIN ${LIVE} l ON l.${q(pk)} = t.${q(pk)}`;

export const updateSql = (target, pk, cols) =>
  cols.length
    ? `UPDATE ${target} t SET ${cols.map((c) => `${q(c)} = l.${q(c)}`).join(", ")}
         FROM ${LIVE} l
        WHERE t.${q(pk)} = l.${q(pk)}
          AND (${cols.map((c) => `t.${q(c)} IS DISTINCT FROM l.${q(c)}`).join(" OR ")})
       RETURNING t.${q(pk)} AS id`
    : null;

// Ids the duplicate clean-up (db/cleanup/before-001-remove-duplicates.sql, or
// an earlier sync) removed: live still has them, they must not come back.
export const skipRemovedSql = (target, pk) =>
  `DELETE FROM ${LIVE} l
    WHERE l.${q(pk)}::text IN (SELECT row_data->>'${pk}' FROM "dbo"."_removed_duplicates" WHERE table_name = :table)
      AND NOT EXISTS (SELECT 1 FROM ${target} t WHERE t.${q(pk)} = l.${q(pk)})
   RETURNING l.${q(pk)} AS id`;

export const candidatesSql = (target, pk) =>
  `CREATE TEMP TABLE ${CAND} AS
   SELECT l.* FROM ${LIVE} l WHERE NOT EXISTS (SELECT 1 FROM ${target} t WHERE t.${q(pk)} = l.${q(pk)})`;

// New live rows that clash with another row on a unique key (a register saved
// twice, a total rolled up again …). Same rule as the clean-up file: keep the
// most recent save (highest id); every removed row goes to _removed_duplicates.
// Three steps: among the new rows; an existing row loses to a newer live row;
// a new live row loses to a newer existing row.
const logRemoved = (from, alias, where, using) =>
  `WITH gone AS (DELETE FROM ${from} ${alias} USING ${using} WHERE ${where} RETURNING ${alias}.*)
   INSERT INTO "dbo"."_removed_duplicates" (table_name, row_data) SELECT :table, to_jsonb(gone) FROM gone
   RETURNING 1`;

// The keep-the-latest rule is only safe for rows nothing else points at
// (registers, totals, marks, results, KG). A clashing Subject is refused:
// replacing it would cut its marks off from it.
export const REPLACEABLE_DUPLICATE_TABLES = new Set(["Attendance", "Total_attendance", "Student_marks", "Student_result", "KG_assessment"]);

export const clashSql = (target, pk, columns) =>
  `SELECT c.${q(pk)} AS live_id, t.${q(pk)} AS new_id FROM ${CAND} c JOIN ${target} t ON ${keyMatchSql(columns, "c", "t")}
   UNION ALL
   SELECT c.${q(pk)}, d.${q(pk)} FROM ${CAND} c JOIN ${CAND} d ON ${keyMatchSql(columns, "c", "d")} AND d.${q(pk)} > c.${q(pk)}
   LIMIT 20`;

// Rows --mirror-deletes must never delete: other rows point at them and their
// ON DELETE rules don't run while the keys are off. They are listed instead.
export const NO_MIRROR_DELETE_TABLES = new Set(["Term", "Fee"]);

export const dedupeSqls = (target, pk, columns) => [
  { step: "newer live row wins over another new row", sql: logRemoved(CAND, "c", `${keyMatchSql(columns, "c", "d")} AND d.${q(pk)} > c.${q(pk)}`, `${CAND} d`) },
  { step: "newer live row replaces an existing row", sql: logRemoved(target, "t", `${keyMatchSql(columns, "t", "c")} AND c.${q(pk)} > t.${q(pk)}`, `${CAND} c`) },
  { step: "existing newer row wins over a live row", sql: logRemoved(CAND, "c", `${keyMatchSql(columns, "c", "t")} AND t.${q(pk)} > c.${q(pk)}`, `${target} t`) },
];

// Payments are inserted in date order, so their receipt numbers follow the
// same order migration 023 gave the old payments.
export const insertSql = (target, pk, cols, table) =>
  `INSERT INTO ${target} (${cols.map(q).join(", ")})
   SELECT ${cols.map(q).join(", ")} FROM ${CAND}
   ORDER BY ${table === "Fee" && cols.includes("date_paid") ? `${q("date_paid")} NULLS FIRST, ` : ""}${q(pk)}
   RETURNING ${q(pk)} AS id`;

export const onlyInTargetSql = (target, pk, softDelete) =>
  `SELECT t.${q(pk)} AS id FROM ${target} t
    WHERE NOT EXISTS (SELECT 1 FROM ${LIVE} l WHERE l.${q(pk)} = t.${q(pk)})
      ${softDelete ? `AND t.${q("is_deleted")} IS NOT TRUE` : ""}
    ORDER BY 1`;

// A row whose id matches but whose identity is completely different was most
// likely created in the new system and given an id live has used since. Live
// winning would overwrite it, so the sync refuses. (A corrected name changes
// one column, not all of them.)
export const IDENTITY_COLUMNS = {
  Student: ["f_name", "l_name"],
  Teacher: ["f_name", "l_name"],
  Class: ["name"],
  Subject: ["name"],
  Term: ["term", "start_date"],
  Parent: ["f_name", "contact"],
};

export const identityClashSql = (target, pk, columns) =>
  `SELECT t.${q(pk)} AS id, ${columns.map((c) => `t.${q(c)} AS ${q(`new_${c}`)}, l.${q(c)} AS ${q(`live_${c}`)}`).join(", ")}
     FROM ${target} t JOIN ${LIVE} l ON l.${q(pk)} = t.${q(pk)}
    WHERE ${columns
      .map((c) => `lower(trim(t.${q(c)}::text)) IS DISTINCT FROM lower(trim(l.${q(c)}::text)) AND t.${q(c)} IS NOT NULL AND l.${q(c)} IS NOT NULL`)
      .join(" AND ")}
    ORDER BY 1 LIMIT 20`;

// The sync is for BEFORE go-live: the new system is loaded but nobody uses it.
// Any of these means it has been used, and "live wins" would lose that work.
export const NEW_SYSTEM_ACTIVITY = [
  { what: "payments recorded or reversed in the new system", table: "Fee", sql: `SELECT COUNT(*)::int AS n FROM "dbo"."Fee" WHERE recorded_by IS NOT NULL OR reversed_at IS NOT NULL` },
  { what: "terms billed in the new system", table: "Student_term_bill", sql: `SELECT COUNT(*)::int AS n FROM "dbo"."Student_term_bill"` },
  { what: "discounts given in the new system", table: "Student_discount", sql: `SELECT COUNT(*)::int AS n FROM "dbo"."Student_discount"` },
  { what: "promotions accepted in the new system", table: "Student_promotion", sql: `SELECT COUNT(*)::int AS n FROM "dbo"."Student_promotion"` },
  { what: "marks entered in the new system", table: "Student_marks", sql: `SELECT COUNT(*)::int AS n FROM "dbo"."Student_marks" WHERE entered_by IS NOT NULL OR entered_by_teacher_id IS NOT NULL` },
  { what: "registers taken in the new system", table: "Attendance", sql: `SELECT COUNT(*)::int AS n FROM "dbo"."Attendance" WHERE entered_by IS NOT NULL OR entered_by_teacher_id IS NOT NULL` },
  { what: "salaries paid in the new system", table: "Salary_payment", sql: `SELECT COUNT(*)::int AS n FROM "dbo"."Salary_payment" WHERE salary_snapshot IS NOT NULL` },
  // B15 (037): posts written in the new system, and likes, comments, votes.
  // A --mirror-deletes would remove such a post with its children left behind
  // (keys are off during the sync), and "live wins" could retitle it.
  // Keyed on Post_like so a database without 037 skips it. (Not by id like
  // NEW_ROW_TABLES: live deletes news rows, so its highest id goes down.)
  // Every post made in the new system has created_by (also the old /add-news).
  {
    what: "news posts, likes, comments or votes made in the new system",
    table: "Post_like",
    sql: `SELECT ((SELECT COUNT(*) FROM "dbo"."Event" WHERE created_by IS NOT NULL OR post_type <> 'NEWS' OR status <> 'PUBLISHED')
      + (SELECT COUNT(*) FROM "dbo"."Post_like") + (SELECT COUNT(*) FROM "dbo"."Post_comment") + (SELECT COUNT(*) FROM "dbo"."Poll_vote"))::int AS n`,
  },
  // B14 (042): invoices / credit notes exist only in the new system.
  { what: "invoices or credit notes made in the new system", table: "Invoice", sql: `SELECT ((SELECT COUNT(*) FROM "dbo"."Invoice") + (SELECT COUNT(*) FROM "dbo"."Credit_note"))::int AS n` },
];

// 037: published_at for news rows the sync adds (live stores Date.now() as
// text); otherwise the event date. Only rows still without one.
export const EVENT_PUBLISHED_AT_SQL = `UPDATE "dbo"."Event" SET published_at = CASE
    WHEN TRIM(created_at) ~ '^[0-9]{13}$' THEN to_timestamp(TRIM(created_at)::BIGINT / 1000.0)
    WHEN TRIM(created_at) ~ '^[0-9]{10}$' THEN to_timestamp(TRIM(created_at)::BIGINT)
    ELSE "date"::timestamptz END
  WHERE published_at IS NULL AND (TRIM(created_at) ~ '^[0-9]{10}([0-9]{3})?$' OR "date" IS NOT NULL)
  RETURNING event_id`;

export const activityProblems = (counts) =>
  NEW_SYSTEM_ACTIVITY.map((a, i) => ({ what: a.what, rows: Number(counts[i] || 0) })).filter((a) => a.rows > 0);

// Besides the activity checks above, the move and every sync record, per table, the highest id live had
// (dbo._sync_state). A row above that id was not copied from live: it was
// typed into the new system (even if live has since used the same id, which
// would otherwise let "live wins" overwrite it silently). If there is one, the
// sync refuses. Without a record yet (a move made before this), the highest
// id live has now is used. Fees set up in the new system count too (they
// would never be charged once the balance is set back to live's).
export const NEW_ROW_TABLES = new Set([
  "Fee", "Attendance", "Total_attendance", "Student_marks", "Student_result", "KG_assessment", "Salary_payment",
  "ClassFee", "StudentFee",
]);

export const SYNC_STATE_DDL = `CREATE TABLE IF NOT EXISTS "dbo"."_sync_state" (
  table_name TEXT PRIMARY KEY, live_max_id BIGINT NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;

export const saveSyncStateSql = `INSERT INTO "dbo"."_sync_state" (table_name, live_max_id, recorded_at)
  VALUES (:table, :maxId, NOW())
  ON CONFLICT (table_name) DO UPDATE SET live_max_id = EXCLUDED.live_max_id, recorded_at = NOW()`;

// :threshold = the recorded live max (or live's max now when none is recorded).
export const newRowsSql = (target, pk) =>
  `SELECT t.${q(pk)} AS id FROM ${target} t WHERE t.${q(pk)} > :threshold ORDER BY 1 LIMIT 20`;

export const liveMaxSql = (pk) => `SELECT COALESCE(MAX(l.${q(pk)}), 0)::bigint AS n FROM ${LIVE} l`;

// Fix-ups on the live rows before comparing, so the sync agrees with what the
// migrations did and a second run changes nothing:
//   Student: migration 022 never leaves fees_owing / fees_paid blank.
export const LIVE_FIXUPS = {
  Student: [
    `UPDATE ${LIVE} SET fees_owing = COALESCE(fees_owing, 0), fees_paid = COALESCE(fees_paid, 0)
      WHERE fees_owing IS NULL OR fees_paid IS NULL`,
  ],
};

// Passwords: live keeps plaintext, the new system bcrypt. Keep the existing
// hash when it still matches the live password, so an unchanged password is
// not rewritten (bcrypt salts differ every time). Returns the value to load.
export const resolvePassword = async (live, existingHash, compare) => {
  if (typeof live !== "string" || live === "" || /^\$2[aby]\$/.test(live)) return live;
  if (typeof existingHash === "string" && /^\$2[aby]\$/.test(existingHash) && (await compare(live, existingHash))) {
    return existingHash;
  }
  return live; // transformRows hashes it
};

// ------------------------------------------------------------------ after the rows
// What the migrations computed from the data at the time they ran, redone for
// the rows this sync added or changed. :ids is the list of changed ids.

// 002: inserted payments got the column default (this year); give them the
// year they were paid, keeping the sequence number.
export const FEE_RECEIPT_YEAR_SQL = `
UPDATE "dbo"."Fee"
   SET receipt_no = 'PPS-' || COALESCE(to_char(date_paid, 'YYYY'), '0000') || '-' || split_part(receipt_no, '-', 3)
 WHERE fee_id IN (:ids)`;

// 011: the term each payment belongs to. Same rule, for the payments this
// sync changed and every payment still without a term (a term live created
// since may now match it, as 011 would). Only rows whose term changes.
export const FEE_TERM_SQL = `
WITH m AS (
  SELECT f.fee_id, COALESCE(
     (SELECT t.term_id FROM "dbo"."Term" t
       WHERE TRIM(t.term) = TRIM(f.term)
         AND f.date_paid BETWEEN t.start_date - 120 AND t.end_date + 30
       ORDER BY CASE WHEN f.date_paid BETWEEN t.start_date AND t.end_date THEN 0 ELSE 1 END,
                LEAST(ABS(f.date_paid - t.start_date), ABS(f.date_paid - t.end_date)),
                t.term_id DESC
       LIMIT 1),
     (SELECT t.term_id FROM "dbo"."Term" t
       WHERE f.date_paid BETWEEN t.start_date AND t.end_date
       ORDER BY t.term_id DESC
       LIMIT 1)) AS term_id
    FROM "dbo"."Fee" f
   WHERE (f.fee_id IN (:ids) OR f.term_id IS NULL)
     AND f.date_paid IS NOT NULL
)
UPDATE "dbo"."Fee" f SET term_id = m.term_id
  FROM m
 WHERE f.fee_id = m.fee_id AND f.term_id IS DISTINCT FROM m.term_id
RETURNING f.fee_id`;

// 010: Term 3s that have ended were promoted by the old system.
export const TERM_PROMOTED_SQL = `
UPDATE "dbo"."Term"
   SET promoted_by_old_system = TRUE
 WHERE TRIM(term) = '3' AND active IS NOT TRUE AND end_date IS NOT NULL
   AND end_date < CURRENT_DATE AND promoted_by_old_system = FALSE
RETURNING term_id`;

// 050 (B10): an office login on a system role follows live's category (a
// login live added, or one whose category live changed); a login given a
// custom role in the new system keeps it. Only the three system names.
export const LOGIN_ROLE_SQL = `
UPDATE "dbo"."User_account" u
   SET role_id = r.role_id
  FROM "dbo"."Role" r
 WHERE r.is_system AND r.role_id IN (1, 2, 3) AND r.name = u.category
   AND (u.role_id IS NULL OR u.role_id IN (1, 2, 3))
   AND u.role_id IS DISTINCT FROM r.role_id
RETURNING u.username`;

// 014: new terms go into their school year (Aug-Jul), created if needed; years
// stretch to cover their terms; the active term's year is the current one.
export const TERM_YEAR_SQLS = [
  `CREATE TEMP TABLE _sync_term_year AS
   SELECT t.term_id,
          CASE WHEN EXTRACT(MONTH FROM COALESCE(t.start_date, t.end_date)) >= 8
               THEN EXTRACT(YEAR FROM COALESCE(t.start_date, t.end_date))::INT
               ELSE EXTRACT(YEAR FROM COALESCE(t.start_date, t.end_date))::INT - 1 END AS y
     FROM "dbo"."Term" t
    WHERE t.academic_year_id IS NULL AND COALESCE(t.start_date, t.end_date) IS NOT NULL`,
  `INSERT INTO "dbo"."Academic_year" (name, start_date, end_date, status, is_current)
   SELECT DISTINCT ty.y || '/' || (ty.y + 1), make_date(ty.y, 8, 1), make_date(ty.y + 1, 7, 31), 'UPCOMING', FALSE
     FROM _sync_term_year ty
    WHERE NOT EXISTS (SELECT 1 FROM "dbo"."Academic_year" ay WHERE LOWER(ay.name) = LOWER(ty.y || '/' || (ty.y + 1)))`,
  `UPDATE "dbo"."Term" t SET academic_year_id = ay.academic_year_id
     FROM _sync_term_year ty JOIN "dbo"."Academic_year" ay ON LOWER(ay.name) = LOWER(ty.y || '/' || (ty.y + 1))
    WHERE t.term_id = ty.term_id AND t.academic_year_id IS NULL`,
  `DROP TABLE _sync_term_year`,
  `UPDATE "dbo"."Academic_year" ay
      SET start_date = LEAST(ay.start_date, x.min_start), end_date = GREATEST(ay.end_date, x.max_end)
     FROM (SELECT academic_year_id, MIN(COALESCE(start_date, end_date)) AS min_start, MAX(COALESCE(end_date, start_date)) AS max_end
             FROM "dbo"."Term" WHERE academic_year_id IS NOT NULL GROUP BY academic_year_id) x
    WHERE x.academic_year_id = ay.academic_year_id
      AND (ay.start_date > x.min_start OR ay.end_date < x.max_end)`,
  // Clear the old current year first: the one-current index is checked row by
  // row, so setting both in one UPDATE can fail.
  `WITH cur AS (
     SELECT t.academic_year_id AS id FROM "dbo"."Term" t
      WHERE t.active IS TRUE AND t.academic_year_id IS NOT NULL
      ORDER BY t.start_date DESC NULLS LAST, t.term_id DESC LIMIT 1)
   UPDATE "dbo"."Academic_year" ay SET is_current = FALSE
     FROM cur
    WHERE ay.is_current AND ay.academic_year_id <> cur.id`,
  `WITH cur AS (
     SELECT t.academic_year_id AS id FROM "dbo"."Term" t
      WHERE t.active IS TRUE AND t.academic_year_id IS NOT NULL
      ORDER BY t.start_date DESC NULLS LAST, t.term_id DESC LIMIT 1)
   UPDATE "dbo"."Academic_year" ay
      SET status = CASE WHEN ay.academic_year_id = cur.id THEN 'ACTIVE'
                        WHEN ay.end_date < CURRENT_DATE THEN 'COMPLETED' ELSE 'UPCOMING' END,
          is_current = (ay.academic_year_id = cur.id)
     FROM cur
    WHERE NOT EXISTS (SELECT 1 FROM "dbo"."Academic_year" x WHERE x.academic_year_id = cur.id AND x.is_current)`,
];

// 018: JHS marks carry their BECE 1-9 grade: changed marks are re-graded, and
// any JHS mark still without a grade gets one (a class newly made JHS).
export const MARK_GRADE_SQLS = [
  `UPDATE "dbo"."Student_marks" SET grade = NULL WHERE student_marks_id IN (:ids)`,
  `UPDATE "dbo"."Student_marks" sm
      SET grade = CASE WHEN sm.total_score >= 90 THEN '1' WHEN sm.total_score >= 80 THEN '2'
                       WHEN sm.total_score >= 70 THEN '3' WHEN sm.total_score >= 60 THEN '4'
                       WHEN sm.total_score >= 55 THEN '5' WHEN sm.total_score >= 50 THEN '6'
                       WHEN sm.total_score >= 40 THEN '7' WHEN sm.total_score >= 35 THEN '8' ELSE '9' END
     FROM "dbo"."Class" c
    WHERE c.name = sm.class AND c.section = 'JHS' AND sm.total_score IS NOT NULL
      AND sm.grade IS NULL
    RETURNING sm.student_marks_id`,
];

// 008 + 015 + 022: every pupil's fee period starts from their LIVE balance,
// after the last live payment, tied to the current term (030's rule). This is
// exactly what the go-live migrations do, so nobody's balance changes. Only
// pupils whose baseline actually moves are touched (and re-dated).
export const REBASE_STUDENTS_SQL = `
WITH base AS (
  SELECT s.student_id,
         COALESCE(s.fees_owing, 0) AS opening,
         COALESCE(s.fees_paid, 0) AS paid_start,
         COALESCE((SELECT SUM(cf.amount) FROM "dbo"."ClassFee" cf WHERE cf.class_id = s.class_id), 0)
       + COALESCE((SELECT SUM(sf.amount) FROM "dbo"."StudentFee" sf WHERE sf.student_id = s.student_id), 0) AS bill_start,
         COALESCE((SELECT MAX(f.fee_id) FROM "dbo"."Fee" f), 0) AS after_fee,
         COALESCE(
           (SELECT t.term_id FROM "dbo"."Term" t WHERE t.active IS TRUE
             ORDER BY t.start_date DESC NULLS LAST, t.term_id DESC LIMIT 1),
           (SELECT CASE WHEN t.promoted_by_old_system THEN NULL ELSE t.term_id END FROM "dbo"."Term" t
             WHERE t.start_date IS NOT NULL AND t.start_date <= CURRENT_DATE
             ORDER BY t.start_date DESC, t.term_id DESC LIMIT 1)) AS period_term
    FROM "dbo"."Student" s
)
UPDATE "dbo"."Student" s
   SET fees_owing = b.opening,
       fees_paid = b.paid_start,
       fees_opening_balance = b.opening,
       fees_paid_at_start = b.paid_start,
       fees_bill_at_start = b.bill_start,
       fees_period_after_fee_id = b.after_fee,
       fees_period_term_id = b.period_term,
       fees_period_started_at = NOW()
  FROM base b
 WHERE s.student_id = b.student_id
   AND (s.fees_owing, s.fees_paid, s.fees_opening_balance, s.fees_paid_at_start, s.fees_bill_at_start,
        s.fees_period_after_fee_id, s.fees_period_term_id, s.fees_period_started_at IS NULL)
       IS DISTINCT FROM
       (b.opening, b.paid_start, b.opening, b.paid_start, b.bill_start, b.after_fee, b.period_term, FALSE)
RETURNING s.student_id`;
