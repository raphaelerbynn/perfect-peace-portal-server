-- 014 (B7): academic years. Terms are grouped into years ("2026/2027") so
-- past years stay organised and pickers can say "Term 2 · 2026/2027".
--
--   Academic_year(academic_year_id, name UNIQUE, start_date, end_date,
--                 status UPCOMING|ACTIVE|COMPLETED, is_current)
--   Term.academic_year_id -> Academic_year (a year with terms can't be deleted)
--
-- Backfill (existing terms): each dated term is put in the school year its
-- start date falls in, August to July (a term starting 1 Aug 2025 or later and
-- before 1 Aug 2026 belongs to "2025/2026"). A term with no start date uses
-- its end date; a term with neither stays without a year (shown as "No year").
-- Duplicate / overlapping old terms and terms with no number simply land in
-- the same year; nothing about them is changed. Each year's dates are then
-- stretched to cover all of its terms. The year holding the open term is
-- current and ACTIVE; with no open term, the year of the most recent term that
-- has started is current. Years that ended before today are COMPLETED, later
-- ones UPCOMING.
--
-- Term numbers are unique within a year for NEW and edited terms (checked in
-- services/academicYear.js under a lock on the year row), not by a database
-- index: the live data has duplicate old terms that must stay as they are.
--
-- Nothing else is touched: no balances, no results, no attendance.
-- Safe to re-run (IF NOT EXISTS; only terms without a year are filled).

CREATE TABLE IF NOT EXISTS "dbo"."Academic_year" (
  academic_year_id SERIAL PRIMARY KEY,
  name             VARCHAR(50) NOT NULL,
  start_date       DATE NOT NULL,
  end_date         DATE NOT NULL,
  status           VARCHAR(10) NOT NULL DEFAULT 'UPCOMING',
  is_current       BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT academic_year_status_chk CHECK (status IN ('UPCOMING', 'ACTIVE', 'COMPLETED')),
  CONSTRAINT academic_year_dates_chk CHECK (start_date <= end_date)
);

-- The data move (scripts/moveFromMysql) creates tables from the models before
-- migrations run, so constraints are added by name, not only in CREATE TABLE.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'academic_year_status_chk') THEN
    ALTER TABLE "dbo"."Academic_year" ADD CONSTRAINT academic_year_status_chk CHECK (status IN ('UPCOMING', 'ACTIVE', 'COMPLETED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'academic_year_dates_chk') THEN
    ALTER TABLE "dbo"."Academic_year" ADD CONSTRAINT academic_year_dates_chk CHECK (start_date <= end_date);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS academic_year_name_uq ON "dbo"."Academic_year" (LOWER(name));
-- At most one current year.
CREATE UNIQUE INDEX IF NOT EXISTS academic_year_one_current_uq ON "dbo"."Academic_year" (is_current) WHERE is_current;

ALTER TABLE "dbo"."Term" ADD COLUMN IF NOT EXISTS academic_year_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Term_academic_year_id_fkey') THEN
    ALTER TABLE "dbo"."Term" ADD CONSTRAINT "Term_academic_year_id_fkey"
      FOREIGN KEY (academic_year_id) REFERENCES "dbo"."Academic_year"(academic_year_id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS term_academic_year_id_idx ON "dbo"."Term" (academic_year_id);

-- ---- Backfill ---------------------------------------------------------------

-- The start year of the school year a term belongs to (Aug-Jul).
DROP TABLE IF EXISTS _b7_term_year;
CREATE TEMP TABLE _b7_term_year AS
SELECT t.term_id,
       CASE WHEN EXTRACT(MONTH FROM COALESCE(t.start_date, t.end_date)) >= 8
            THEN EXTRACT(YEAR FROM COALESCE(t.start_date, t.end_date))::INT
            ELSE EXTRACT(YEAR FROM COALESCE(t.start_date, t.end_date))::INT - 1
       END AS y
  FROM "dbo"."Term" t
 WHERE t.academic_year_id IS NULL
   AND COALESCE(t.start_date, t.end_date) IS NOT NULL;

-- One year per start year: nominal 1 Aug - 31 Jul, widened below to its terms.
INSERT INTO "dbo"."Academic_year" (name, start_date, end_date, status, is_current)
SELECT DISTINCT
       ty.y || '/' || (ty.y + 1),
       make_date(ty.y, 8, 1),
       make_date(ty.y + 1, 7, 31),
       'UPCOMING',
       FALSE
  FROM _b7_term_year ty
 WHERE NOT EXISTS (
   SELECT 1 FROM "dbo"."Academic_year" ay WHERE LOWER(ay.name) = LOWER(ty.y || '/' || (ty.y + 1))
 );

UPDATE "dbo"."Term" t
   SET academic_year_id = ay.academic_year_id
  FROM _b7_term_year ty
  JOIN "dbo"."Academic_year" ay ON LOWER(ay.name) = LOWER(ty.y || '/' || (ty.y + 1))
 WHERE t.term_id = ty.term_id
   AND t.academic_year_id IS NULL;

-- Every term sits inside its year's dates.
UPDATE "dbo"."Academic_year" ay
   SET start_date = LEAST(ay.start_date, x.min_start),
       end_date   = GREATEST(ay.end_date, x.max_end)
  FROM (
    SELECT academic_year_id,
           MIN(COALESCE(start_date, end_date)) AS min_start,
           MAX(COALESCE(end_date, start_date)) AS max_end
      FROM "dbo"."Term"
     WHERE academic_year_id IS NOT NULL
     GROUP BY academic_year_id
  ) x
 WHERE x.academic_year_id = ay.academic_year_id;

DROP TABLE IF EXISTS _b7_term_year;

-- Status and the current year: only when no year has been made current yet
-- (so a re-run never overrides what the office set).
DO $$
DECLARE
  cur INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "dbo"."Academic_year" WHERE is_current) THEN
    SELECT t.academic_year_id INTO cur
      FROM "dbo"."Term" t
     WHERE t.active IS TRUE AND t.academic_year_id IS NOT NULL
     ORDER BY t.start_date DESC NULLS LAST, t.term_id DESC
     LIMIT 1;
    IF cur IS NULL THEN
      SELECT t.academic_year_id INTO cur
        FROM "dbo"."Term" t
       WHERE t.academic_year_id IS NOT NULL
         AND t.start_date IS NOT NULL
         AND t.start_date <= CURRENT_DATE
       ORDER BY t.start_date DESC, t.term_id DESC
       LIMIT 1;
    END IF;

    UPDATE "dbo"."Academic_year"
       SET status = CASE
                      WHEN academic_year_id = cur THEN 'ACTIVE'
                      WHEN end_date < CURRENT_DATE THEN 'COMPLETED'
                      ELSE 'UPCOMING'
                    END,
           is_current = COALESCE(academic_year_id = cur, FALSE);
  END IF;
END $$;
