-- 021 (B18): automatic admission numbers for NEW pupils.
--
-- Student.admission_no: given when a pupil is added (from the format in
--   School_settings, or typed by the office). Existing pupils are NOT
--   backfilled: they keep NULL and their STU/<id> index number, which is still
--   how pupils sign in. Unique ignoring case (archived pupils keep theirs, so
--   a number is never handed out twice).
-- Admission_counter: the last running number used per scope (the format with
--   the year filled in, e.g. 'PPS/2026/{0000}'), so the count restarts each
--   year when the format has a year in it. Taken under a row lock inside the
--   create-pupil transaction: two offices adding pupils at once can't get the
--   same number.
-- Safe to re-run (IF NOT EXISTS; constraints added by name).

ALTER TABLE "dbo"."Student" ADD COLUMN IF NOT EXISTS admission_no VARCHAR(30);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_student_admission_no
  ON "dbo"."Student" (lower(admission_no))
  WHERE admission_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS "dbo"."Admission_counter" (
  scope      VARCHAR(60) PRIMARY KEY,
  last_value INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The data move and devSync create Admission_counter from the model
-- (models/AdmissionCounter.js) before migrations run, so the CREATE above can
-- be skipped. Defaults and the check are added here by name either way.
ALTER TABLE "dbo"."Admission_counter" ALTER COLUMN last_value SET DEFAULT 0;
ALTER TABLE "dbo"."Admission_counter" ALTER COLUMN updated_at SET DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admission_counter_last_value_chk') THEN
    ALTER TABLE "dbo"."Admission_counter" ADD CONSTRAINT admission_counter_last_value_chk CHECK (last_value >= 0);
  END IF;
END $$;
