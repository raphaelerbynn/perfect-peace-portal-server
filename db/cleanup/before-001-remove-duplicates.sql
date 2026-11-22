-- Run AFTER the MySQL -> Postgres move and BEFORE `npm run migrate` (001's
-- unique indexes refuse duplicates). Found in the live data on 2026-11-08:
--   Attendance        112 pupil-days saved twice (12 + 14 Oct 2026, a double
--                     submit; one of them Present then corrected to Absent)
--   Total_attendance  406 pupil-terms with several totals: the old app added a
--                     new total each time attendance was rolled up mid-term
--                     (10/16, 15/22, 17/24 days), the last one is complete.
-- Rule for both: keep the most recent save (highest id), remove the others.
-- Rows with an empty key column are left alone (unique indexes allow them).
-- Every removed row is kept in dbo._removed_duplicates. Safe to re-run.
CREATE TABLE IF NOT EXISTS "dbo"."_removed_duplicates" (
  table_name TEXT NOT NULL,
  row_data   JSONB NOT NULL,
  removed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

WITH ranked AS (
  SELECT attendance_id, row_number() OVER (
           PARTITION BY student_id, date_marked, term_id ORDER BY attendance_id DESC) AS rn
  FROM "dbo"."Attendance"
  WHERE student_id IS NOT NULL AND date_marked IS NOT NULL AND term_id IS NOT NULL
), gone AS (
  DELETE FROM "dbo"."Attendance" a USING ranked r
  WHERE a.attendance_id = r.attendance_id AND r.rn > 1
  RETURNING a.*
)
INSERT INTO "dbo"."_removed_duplicates" (table_name, row_data)
SELECT 'Attendance', to_jsonb(gone) FROM gone;

WITH ranked AS (
  SELECT total_attendance_id, row_number() OVER (
           PARTITION BY student_id, term_id ORDER BY total_attendance_id DESC) AS rn
  FROM "dbo"."Total_attendance"
  WHERE student_id IS NOT NULL AND term_id IS NOT NULL
), gone AS (
  DELETE FROM "dbo"."Total_attendance" t USING ranked r
  WHERE t.total_attendance_id = r.total_attendance_id AND r.rn > 1
  RETURNING t.*
)
INSERT INTO "dbo"."_removed_duplicates" (table_name, row_data)
SELECT 'Total_attendance', to_jsonb(gone) FROM gone;
