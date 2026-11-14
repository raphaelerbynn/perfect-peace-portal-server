-- 022 (A1 follow-up): Student.fees_owing / fees_paid are never NULL.
--
-- The old system left both blank for many pupils (222 of 451 owing and 32 paid
-- on the 2026-11-14 live copy). The portal then had no figure to show. Since
-- migration 008 every blank already counts as 0 (fees_opening_balance =
-- COALESCE(fees_owing, 0), fees_paid_at_start = COALESCE(fees_paid, 0)), and the
-- next recompute (services/fee.js recomputeStudentOwing) writes exactly those
-- numbers, so filling them in with the same values changes nobody's balance.
-- New pupils start at 0 as well.

-- One UPDATE, not two: pupils whose class was deleted in the old system break
-- Student_class_id_fkey (kept NOT VALID). Postgres skips that check when the key
-- doesn't change, but not for a row this transaction already updated.
UPDATE "dbo"."Student"
SET fees_owing = COALESCE(fees_owing, fees_opening_balance),
    fees_paid  = COALESCE(fees_paid, fees_paid_at_start)
WHERE fees_owing IS NULL OR fees_paid IS NULL;

ALTER TABLE "dbo"."Student" ALTER COLUMN fees_owing SET DEFAULT 0;
ALTER TABLE "dbo"."Student" ALTER COLUMN fees_paid  SET DEFAULT 0;
