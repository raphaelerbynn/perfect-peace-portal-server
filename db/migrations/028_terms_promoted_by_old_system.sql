-- 010: the old system moved pupils up itself when Term 3 closed. Those Term 3s
-- must not be offered on the Promotion page: accepting one again would record
-- a first decision for every pupil, which starts a new fee period and bills
-- the next class a second time (found on a copy of the live data, 2026-11-08:
-- 15 classes "to decide" for Term 3 2025/26, already promoted in July 2026).
-- Marks every Term 3 that had already ended and closed when this runs.
-- Safe to re-run.
ALTER TABLE "dbo"."Term" ADD COLUMN IF NOT EXISTS promoted_by_old_system BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE "dbo"."Term"
   SET promoted_by_old_system = TRUE
 WHERE TRIM(term) = '3'
   AND active IS NOT TRUE
   AND end_date IS NOT NULL
   AND end_date < CURRENT_DATE
   AND promoted_by_old_system = FALSE;
