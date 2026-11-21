-- 008: fee balances that carry over from the live system.
--
-- Live kept Student.fees_owing as a running balance (reset to the new class's
-- bill on a class change, "paid" counted from then). The new code recomputed
-- class fees + pupil fees - EVERY payment ever, so after go-live any pupil who
-- had moved up would be credited with earlier years' payments (most would show
-- owing nothing). Instead each pupil now has a fee PERIOD:
--
--   owing = opening_balance + (current bill - bill_at_start) - paid in period
--   paid  = paid_at_start + paid in period
--   "paid in period" = non-reversed payments with fee_id > period_after_fee_id
--
-- This migration starts a period for every existing pupil from what live had:
-- nothing changes at go-live; only new payments, reversals and fee edits move
-- the balance. Promotion starts a new period (arrears carry over, the new
-- class's bill is added) — services/fee.js startFeePeriod.
-- Safe to re-run: only pupils without a period are set up.

ALTER TABLE "dbo"."Student"
  ADD COLUMN IF NOT EXISTS fees_opening_balance     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fees_bill_at_start       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fees_paid_at_start       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fees_period_after_fee_id INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fees_period_started_at   TIMESTAMPTZ;

UPDATE "dbo"."Student" s SET
  fees_opening_balance = COALESCE(s.fees_owing, 0),
  fees_paid_at_start   = COALESCE(s.fees_paid, 0),
  fees_bill_at_start   =
      COALESCE((SELECT SUM(cf.amount) FROM "dbo"."ClassFee" cf WHERE cf.class_id = s.class_id), 0)
    + COALESCE((SELECT SUM(sf.amount) FROM "dbo"."StudentFee" sf WHERE sf.student_id = s.student_id), 0),
  fees_period_after_fee_id = COALESCE((SELECT MAX(f.fee_id) FROM "dbo"."Fee" f), 0),
  fees_period_started_at   = NOW()
WHERE s.fees_period_started_at IS NULL;
