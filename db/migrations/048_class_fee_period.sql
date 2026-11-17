-- 048 (B12, client 2026-11-17): a class fee item can be entered per YEAR.
--
--   ClassFee.period        TERM (default: the amount is billed every term, as
--                          today) or YEAR (the amount is for the academic year
--                          and each term bills its share: equal whole-cedi
--                          parts, the remainder on the last term, e.g. 1000 =
--                          333 / 333 / 334; services/classFeeShare.js).
--   ClassFee.term_amounts  what the item was billed at for each term already
--                          billed, {"<term_id>": {period, amount, yearly, no, of}}.
--                          Written only for items that are (or were) YEAR:
--                          when a term is billed, and before a yearly amount or
--                          the TERM/YEAR choice is changed, so a change only
--                          reaches terms not billed yet.
--
-- GO-LIVE: THIS CHANGES NOBODY'S BALANCE. Every existing row becomes TERM with
-- no billed amounts, which is exactly today's rule (the item's amount every
-- term). Safe to re-run.

ALTER TABLE "dbo"."ClassFee" ADD COLUMN IF NOT EXISTS period VARCHAR(4);
ALTER TABLE "dbo"."ClassFee" ADD COLUMN IF NOT EXISTS term_amounts JSONB;

-- The data move may already have created both columns from the model (with no
-- database default): fill and default them either way.
UPDATE "dbo"."ClassFee" SET period = 'TERM' WHERE period IS NULL;
UPDATE "dbo"."ClassFee" SET term_amounts = '{}'::jsonb WHERE term_amounts IS NULL;
ALTER TABLE "dbo"."ClassFee" ALTER COLUMN period SET DEFAULT 'TERM';
ALTER TABLE "dbo"."ClassFee" ALTER COLUMN term_amounts SET DEFAULT '{}'::jsonb;
ALTER TABLE "dbo"."ClassFee" ALTER COLUMN period SET NOT NULL;
ALTER TABLE "dbo"."ClassFee" ALTER COLUMN term_amounts SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'class_fee_period_chk') THEN
    ALTER TABLE "dbo"."ClassFee" ADD CONSTRAINT class_fee_period_chk CHECK (period IN ('TERM', 'YEAR'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'class_fee_term_amounts_chk') THEN
    ALTER TABLE "dbo"."ClassFee" ADD CONSTRAINT class_fee_term_amounts_chk CHECK (jsonb_typeof(term_amounts) = 'object');
  END IF;
END $$;
