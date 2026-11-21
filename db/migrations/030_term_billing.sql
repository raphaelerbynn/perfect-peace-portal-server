-- 015 (B12): per-term billing on top of fee periods (migration 008).
--
-- A pupil's balance is still worked out from their current fee period:
--   owing = opening_balance + (bill - bill_at_start) - payments since the period began
-- What changes: each period now belongs to a TERM (Student.fees_period_term_id),
-- and "Bill this term" (services/termBilling.js) starts the next term's period
-- for each pupil: what is still owed (or the credit) is carried in as arrears,
-- and the term's bill (class fees + pupil fees - discounts) is added in full.
-- Every term bill is recorded in Student_term_bill (arrears carried, items,
-- discounts) for statements and printing.
--
-- GO-LIVE: THIS CHANGES NOBODY'S BALANCE. Only one new column is filled on
-- Student, and no balance column is touched:
--   * every pupil's current period (the live balance, from 008) is tied to the
--     school's current term: the open term; with no open term, the most recent
--     term that has started. Billing THAT term again skips them, so their
--     current figures stay exactly as they are; the next term's bill is added
--     only when the office bills the next term.
--   * exception: when no term is open and the most recent term is a Term 3 the
--     old system already promoted on (migration 010), the old system has
--     already put next year's class bill on the balance. Those periods are left
--     untied, and billing the next term ADOPTS them (no second bill).
-- Pupils promoted with the new Promotion page also get an untied period (it
-- holds the new class's bill); the next term billed adopts it the same way.
--
-- Safe to re-run: the tie-up runs only while no pupil is tied and nothing has
-- been billed.

ALTER TABLE "dbo"."Student" ADD COLUMN IF NOT EXISTS fees_period_term_id INTEGER;

-- One row per pupil per billed term. kind NEW = a new period was started
-- (arrears carried in + the term's bill); ADOPTED = the term took over the
-- period promotion (or the old system) had already started.
CREATE TABLE IF NOT EXISTS "dbo"."Student_term_bill" (
  student_term_bill_id SERIAL PRIMARY KEY,
  student_id   INTEGER NOT NULL,
  term_id      INTEGER NOT NULL,
  class_id     INTEGER,
  kind         VARCHAR(10) NOT NULL,
  arrears      NUMERIC(18,2) NOT NULL DEFAULT 0, -- carried in; below 0 = credit
  bill         NUMERIC(18,2) NOT NULL DEFAULT 0, -- items before discounts
  discount     NUMERIC(18,2) NOT NULL DEFAULT 0,
  items        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{ name, amount, source }]
  discounts    JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{ name, amount }]
  after_fee_id INTEGER NOT NULL DEFAULT 0,          -- the period counts payments after this fee_id
  billed_by    VARCHAR(100),
  billed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tie each pupil's current period to the current term (see the top). Runs only
-- while no pupil is tied and nothing has been billed yet: the data move creates
-- the column from the model before migrations run, so "the column is new"
-- can't be the marker.
DO $$
DECLARE
  cur_term   INTEGER;
  open_term  INTEGER;
  old_promo  BOOLEAN;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "dbo"."Student" WHERE fees_period_term_id IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM "dbo"."Student_term_bill") THEN
    SELECT t.term_id INTO open_term
      FROM "dbo"."Term" t
     WHERE t.active IS TRUE
     ORDER BY t.start_date DESC NULLS LAST, t.term_id DESC
     LIMIT 1;

    IF open_term IS NOT NULL THEN
      cur_term := open_term;
    ELSE
      SELECT t.term_id, (t.promoted_by_old_system IS TRUE) INTO cur_term, old_promo
        FROM "dbo"."Term" t
       WHERE t.start_date IS NOT NULL
         AND t.start_date <= CURRENT_DATE
       ORDER BY t.start_date DESC, t.term_id DESC
       LIMIT 1;
      IF old_promo IS TRUE THEN
        cur_term := NULL; -- untied: the next term billed adopts the period
      END IF;
    END IF;

    IF cur_term IS NOT NULL THEN
      UPDATE "dbo"."Student" SET fees_period_term_id = cur_term;
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Student_fees_period_term_id_fkey') THEN
    ALTER TABLE "dbo"."Student" ADD CONSTRAINT "Student_fees_period_term_id_fkey"
      FOREIGN KEY (fees_period_term_id) REFERENCES "dbo"."Term"(term_id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS student_fees_period_term_id_idx ON "dbo"."Student" (fees_period_term_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Student_term_bill_term_id_fkey') THEN
    ALTER TABLE "dbo"."Student_term_bill" ADD CONSTRAINT "Student_term_bill_term_id_fkey"
      FOREIGN KEY (term_id) REFERENCES "dbo"."Term"(term_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'student_term_bill_kind_chk') THEN
    ALTER TABLE "dbo"."Student_term_bill" ADD CONSTRAINT student_term_bill_kind_chk CHECK (kind IN ('NEW', 'ADOPTED'));
  END IF;
END $$;

-- One bill per pupil per term: billing a term twice can't double-bill.
CREATE UNIQUE INDEX IF NOT EXISTS student_term_bill_uq ON "dbo"."Student_term_bill" (student_id, term_id);
CREATE INDEX IF NOT EXISTS student_term_bill_term_idx ON "dbo"."Student_term_bill" (term_id);
