-- 016 (B12): fee discounts.
--
--   Discount_type    a named discount: PERCENT (0-100) or FIXED (GH₵), taken off
--                    every fee item, or only items with one name (e.g. "Tuition").
--   Student_discount a pupil gets a discount type from a term onward (to_term_id
--                    NULL = until ended). source SIBLING = confirmed from the
--                    sibling suggestions; MANUAL = given by the office.
--
-- A discount lowers a pupil's bill for every term it covers (services/
-- discounts.js). It changes a balance only when the office adds or ends one:
-- this migration creates empty tables, so NOBODY'S BALANCE CHANGES.
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS "dbo"."Discount_type" (
  discount_type_id SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  description VARCHAR(500),
  kind        VARCHAR(10) NOT NULL,
  value       NUMERIC(18,2) NOT NULL,
  applies_to  VARCHAR(50),             -- NULL = all fee items; else one item name
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  VARCHAR(100),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS discount_type_name_uq ON "dbo"."Discount_type" (LOWER(name));

CREATE TABLE IF NOT EXISTS "dbo"."Student_discount" (
  student_discount_id SERIAL PRIMARY KEY,
  student_id       INTEGER NOT NULL,
  discount_type_id INTEGER NOT NULL,
  from_term_id     INTEGER NOT NULL,
  to_term_id       INTEGER,
  source           VARCHAR(10) NOT NULL DEFAULT 'MANUAL',
  reason           VARCHAR(300),
  created_by       VARCHAR(100),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Constraints by name: the data move may already have created both tables
-- from the models (without them).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discount_type_kind_chk') THEN
    ALTER TABLE "dbo"."Discount_type" ADD CONSTRAINT discount_type_kind_chk CHECK (kind IN ('PERCENT', 'FIXED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discount_type_value_chk') THEN
    ALTER TABLE "dbo"."Discount_type" ADD CONSTRAINT discount_type_value_chk CHECK (value >= 0 AND (kind <> 'PERCENT' OR value <= 100));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'student_discount_source_chk') THEN
    ALTER TABLE "dbo"."Student_discount" ADD CONSTRAINT student_discount_source_chk CHECK (source IN ('MANUAL', 'SIBLING'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Student_discount_discount_type_id_fkey') THEN
    ALTER TABLE "dbo"."Student_discount" ADD CONSTRAINT "Student_discount_discount_type_id_fkey"
      FOREIGN KEY (discount_type_id) REFERENCES "dbo"."Discount_type"(discount_type_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Student_discount_from_term_id_fkey') THEN
    ALTER TABLE "dbo"."Student_discount" ADD CONSTRAINT "Student_discount_from_term_id_fkey"
      FOREIGN KEY (from_term_id) REFERENCES "dbo"."Term"(term_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Student_discount_to_term_id_fkey') THEN
    ALTER TABLE "dbo"."Student_discount" ADD CONSTRAINT "Student_discount_to_term_id_fkey"
      FOREIGN KEY (to_term_id) REFERENCES "dbo"."Term"(term_id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS student_discount_student_idx ON "dbo"."Student_discount" (student_id);
CREATE INDEX IF NOT EXISTS student_discount_type_idx ON "dbo"."Student_discount" (discount_type_id);
