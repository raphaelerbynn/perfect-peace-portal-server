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

// Payments are inserted in date order (their ids are live's anyway).
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
// Part A has no "entered by" or receipt columns to tell new-system rows apart,
// so the move and every sync record, per table, the highest id live had
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

// 008 + 022: every pupil's fee period starts from their LIVE balance, after the
// last live payment. This is exactly what the go-live migrations do, so
// nobody's balance changes. Only pupils whose baseline actually moves are
// touched (and re-dated).
export const REBASE_STUDENTS_SQL = `
WITH base AS (
  SELECT s.student_id,
         COALESCE(s.fees_owing, 0) AS opening,
         COALESCE(s.fees_paid, 0) AS paid_start,
         COALESCE((SELECT SUM(cf.amount) FROM "dbo"."ClassFee" cf WHERE cf.class_id = s.class_id), 0)
       + COALESCE((SELECT SUM(sf.amount) FROM "dbo"."StudentFee" sf WHERE sf.student_id = s.student_id), 0) AS bill_start,
         COALESCE((SELECT MAX(f.fee_id) FROM "dbo"."Fee" f), 0) AS after_fee
    FROM "dbo"."Student" s
)
UPDATE "dbo"."Student" s
   SET fees_owing = b.opening,
       fees_paid = b.paid_start,
       fees_opening_balance = b.opening,
       fees_paid_at_start = b.paid_start,
       fees_bill_at_start = b.bill_start,
       fees_period_after_fee_id = b.after_fee,
       fees_period_started_at = NOW()
  FROM base b
 WHERE s.student_id = b.student_id
   AND (s.fees_owing, s.fees_paid, s.fees_opening_balance, s.fees_paid_at_start, s.fees_bill_at_start,
        s.fees_period_after_fee_id, s.fees_period_started_at IS NULL)
       IS DISTINCT FROM
       (b.opening, b.paid_start, b.opening, b.paid_start, b.bill_start, b.after_fee, FALSE)
RETURNING s.student_id`;
