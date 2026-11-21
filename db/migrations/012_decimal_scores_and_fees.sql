-- Scores and fees accept decimals (client request 2026-11-08): a class score of
-- 7.5, a payment of GH₵ 149.50. These columns were whole numbers (INTEGER or
-- NUMERIC(18,0)), which rounded 7.5 to 8 or refused it outright.
-- Two decimal places everywhere (pesewas; half marks). Widening keeps every
-- existing value exactly, so this is safe on live data and safe to re-run.

-- Scores
ALTER TABLE "dbo"."Student_marks"
  ALTER COLUMN class_score TYPE NUMERIC(18,2),
  ALTER COLUMN exam_score TYPE NUMERIC(18,2),
  ALTER COLUMN class_score_percentage TYPE NUMERIC(18,2),
  ALTER COLUMN exam_score_percentage TYPE NUMERIC(18,2),
  ALTER COLUMN total_score TYPE NUMERIC(18,2);

ALTER TABLE "dbo"."Student_result"
  ALTER COLUMN raw_score TYPE NUMERIC(18,2);

ALTER TABLE "dbo"."KG_assessment"
  ALTER COLUMN class_score TYPE NUMERIC(18,2),
  ALTER COLUMN exam_score TYPE NUMERIC(18,2),
  ALTER COLUMN class_score_percentage TYPE NUMERIC(18,2),
  ALTER COLUMN exam_score_percentage TYPE NUMERIC(18,2);

-- Fees: payments, bills and the cached balances on the pupil
ALTER TABLE "dbo"."Fee"
  ALTER COLUMN total TYPE NUMERIC(18,2),
  ALTER COLUMN paid TYPE NUMERIC(18,2),
  ALTER COLUMN remaining TYPE NUMERIC(18,2);

ALTER TABLE "dbo"."ClassFee" ALTER COLUMN amount TYPE NUMERIC(18,2);
ALTER TABLE "dbo"."StudentFee" ALTER COLUMN amount TYPE NUMERIC(18,2);

ALTER TABLE "dbo"."Student"
  ALTER COLUMN fees_paid TYPE NUMERIC(18,2),
  ALTER COLUMN fees_owing TYPE NUMERIC(18,2),
  ALTER COLUMN fees_opening_balance TYPE NUMERIC(18,2),
  ALTER COLUMN fees_bill_at_start TYPE NUMERIC(18,2),
  ALTER COLUMN fees_paid_at_start TYPE NUMERIC(18,2);

