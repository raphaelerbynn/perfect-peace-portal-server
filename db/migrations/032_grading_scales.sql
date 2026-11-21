-- 018 (B8): the school's own grading scales.
--
-- Grading_scale: a named scale; exactly one is the default.
-- Grade_band: its bands on the 0-100 subject total. grade is optional
--   (primary prints the remark, JHS prints 1-9); the service picks the band
--   with the highest min_score <= score (max_score is for display).
-- Grading_scale_section: which scale grades a class section (Class.section,
--   e.g. 'JHS'). Sections without a row use the default scale.
-- Student_marks.grade: the grade stamped when the mark is saved, next to the
--   remark (already stamped). remarks widens 10 -> 50 for longer remarks.
--
-- Seeds two scales that reproduce what the report cards print today, so
-- nothing changes until the office edits them:
--   "Primary (standard)" (default): Fail <40, Pass <50, Credit <60, Good <70,
--     Very Good <80, Excellent (services/results.js gradeRemark).
--   "JHS (BECE 1-9)", linked to JHS: 1 >=90 ... 9 <35 (the portal report
--     card's getGrade), each with the remark it already gets above.
-- Backfill: JHS marks get the 1-9 grade the portal card computed from their
-- total, so the card no longer needs to compute it. Other marks keep
-- grade NULL (they print the remark, as now). Remarks are not touched.
--
-- Safe to re-run: IF NOT EXISTS, constraints added by name, seeds only when
-- missing (every NOT NULL column given), backfill only fills NULLs.

CREATE TABLE IF NOT EXISTS "dbo"."Grading_scale" (
  grading_scale_id SERIAL PRIMARY KEY,
  name             VARCHAR(100) NOT NULL,
  is_default       BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS "dbo"."Grade_band" (
  grade_band_id    SERIAL PRIMARY KEY,
  grading_scale_id INTEGER NOT NULL,
  grade            VARCHAR(10),
  remark           VARCHAR(50) NOT NULL,
  min_score        NUMERIC(5,2) NOT NULL,
  max_score        NUMERIC(5,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS "dbo"."Grading_scale_section" (
  section          VARCHAR(50) PRIMARY KEY,
  grading_scale_id INTEGER NOT NULL
);

-- The data move (scripts/moveFromMysql) creates these tables from the models
-- before migrations run, so the CREATEs above are skipped there. Everything
-- that matters is therefore added here, by name, whichever way the table came.
ALTER TABLE "dbo"."Grading_scale" ALTER COLUMN is_default SET DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_grade_band_range') THEN
    ALTER TABLE "dbo"."Grade_band" ADD CONSTRAINT ck_grade_band_range
      CHECK (min_score >= 0 AND min_score <= max_score AND max_score <= 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Grade_band_grading_scale_id_fkey') THEN
    ALTER TABLE "dbo"."Grade_band" ADD CONSTRAINT "Grade_band_grading_scale_id_fkey"
      FOREIGN KEY (grading_scale_id) REFERENCES "dbo"."Grading_scale"(grading_scale_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Grading_scale_section_grading_scale_id_fkey') THEN
    ALTER TABLE "dbo"."Grading_scale_section" ADD CONSTRAINT "Grading_scale_section_grading_scale_id_fkey"
      FOREIGN KEY (grading_scale_id) REFERENCES "dbo"."Grading_scale"(grading_scale_id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_grading_scale_name ON "dbo"."Grading_scale" (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS ux_grading_scale_one_default ON "dbo"."Grading_scale" (is_default) WHERE is_default;
CREATE INDEX IF NOT EXISTS idx_grade_band_scale ON "dbo"."Grade_band" (grading_scale_id);

ALTER TABLE "dbo"."Student_marks" ADD COLUMN IF NOT EXISTS grade VARCHAR(10);
-- Widen only (never narrow a wider or TEXT column).
DO $$
BEGIN
  IF (SELECT character_maximum_length FROM information_schema.columns
      WHERE table_schema = 'dbo' AND table_name = 'Student_marks' AND column_name = 'remarks') < 50 THEN
    ALTER TABLE "dbo"."Student_marks" ALTER COLUMN remarks TYPE VARCHAR(50);
  END IF;
END $$;

-- Seed the two scales (only if the school has none yet).
INSERT INTO "dbo"."Grading_scale" (name, is_default)
SELECT 'Primary (standard)', TRUE
WHERE NOT EXISTS (SELECT 1 FROM "dbo"."Grading_scale");

INSERT INTO "dbo"."Grading_scale" (name, is_default)
SELECT 'JHS (BECE 1-9)', FALSE
WHERE NOT EXISTS (SELECT 1 FROM "dbo"."Grading_scale" WHERE lower(name) = lower('JHS (BECE 1-9)'))
  AND NOT EXISTS (SELECT 1 FROM "dbo"."Grading_scale_section");

INSERT INTO "dbo"."Grade_band" (grading_scale_id, grade, remark, min_score, max_score)
SELECT s.grading_scale_id, b.grade, b.remark, b.min_score, b.max_score
FROM "dbo"."Grading_scale" s
CROSS JOIN (VALUES
  (NULL::VARCHAR, 'Fail',       0.00,  39.99),
  (NULL,          'Pass',      40.00,  49.99),
  (NULL,          'Credit',    50.00,  59.99),
  (NULL,          'Good',      60.00,  69.99),
  (NULL,          'Very Good', 70.00,  79.99),
  (NULL,          'Excellent', 80.00, 100.00)
) AS b(grade, remark, min_score, max_score)
WHERE s.name = 'Primary (standard)'
  AND NOT EXISTS (SELECT 1 FROM "dbo"."Grade_band" x WHERE x.grading_scale_id = s.grading_scale_id);

INSERT INTO "dbo"."Grade_band" (grading_scale_id, grade, remark, min_score, max_score)
SELECT s.grading_scale_id, b.grade, b.remark, b.min_score, b.max_score
FROM "dbo"."Grading_scale" s
CROSS JOIN (VALUES
  ('9', 'Fail',       0.00,  34.99),
  ('8', 'Fail',      35.00,  39.99),
  ('7', 'Pass',      40.00,  49.99),
  ('6', 'Credit',    50.00,  54.99),
  ('5', 'Credit',    55.00,  59.99),
  ('4', 'Good',      60.00,  69.99),
  ('3', 'Very Good', 70.00,  79.99),
  ('2', 'Excellent', 80.00,  89.99),
  ('1', 'Excellent', 90.00, 100.00)
) AS b(grade, remark, min_score, max_score)
WHERE s.name = 'JHS (BECE 1-9)'
  AND NOT EXISTS (SELECT 1 FROM "dbo"."Grade_band" x WHERE x.grading_scale_id = s.grading_scale_id);

INSERT INTO "dbo"."Grading_scale_section" (section, grading_scale_id)
SELECT 'JHS', s.grading_scale_id
FROM "dbo"."Grading_scale" s
WHERE s.name = 'JHS (BECE 1-9)'
ON CONFLICT (section) DO NOTHING;

-- Backfill: the 1-9 grade the portal card showed for JHS marks (same join as
-- the portal results query: Student_marks.class = Class.name).
UPDATE "dbo"."Student_marks" sm
SET grade = CASE
    WHEN sm.total_score >= 90 THEN '1'
    WHEN sm.total_score >= 80 THEN '2'
    WHEN sm.total_score >= 70 THEN '3'
    WHEN sm.total_score >= 60 THEN '4'
    WHEN sm.total_score >= 55 THEN '5'
    WHEN sm.total_score >= 50 THEN '6'
    WHEN sm.total_score >= 40 THEN '7'
    WHEN sm.total_score >= 35 THEN '8'
    ELSE '9'
  END
FROM "dbo"."Class" c
WHERE c.name = sm.class
  AND c.section = 'JHS'
  AND sm.grade IS NULL
  AND sm.total_score IS NOT NULL;
