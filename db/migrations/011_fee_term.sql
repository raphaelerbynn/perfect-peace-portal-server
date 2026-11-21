-- 011: which term a payment belongs to. The old system kept only the term
-- NUMBER ("1", "2", "3") on each payment, so "Term 1" mixed every year and the
-- Fees page could not total the current term. New payments get the open term
-- (services/fee.js); old ones are matched once:
--   1. a term with the same number whose dates the payment falls in, or up to
--      120 days before it starts (fees paid in the holiday) / 30 days after;
--      inside the term beats before/after, then the nearest date, then the
--      newest duplicate term row;
--   2. otherwise any term whose dates contain the payment date
--      (2024 terms were recorded without a number).
-- On the live copy (2026-11-08): 3,395 of 3,408 matched; 13 from 2023, before
-- any term was set up, stay unmatched (shown under "All terms").
-- Safe to re-run (only fills empty term_id).
ALTER TABLE "dbo"."Fee" ADD COLUMN IF NOT EXISTS term_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Fee_term_id_fkey') THEN
    ALTER TABLE "dbo"."Fee" ADD CONSTRAINT "Fee_term_id_fkey"
      FOREIGN KEY (term_id) REFERENCES "dbo"."Term"(term_id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS fee_term_id_idx ON "dbo"."Fee" (term_id);

UPDATE "dbo"."Fee" f
   SET term_id = COALESCE(
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
       LIMIT 1))
 WHERE f.term_id IS NULL
   AND f.date_paid IS NOT NULL;
