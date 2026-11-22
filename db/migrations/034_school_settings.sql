-- 020 (B18): the school's name, address, logo and colours, kept in the
-- database instead of in the apps (one row, id 1).
--
-- The row is filled with what the apps print today, so nothing looks
-- different until the office changes it. Colours NULL = the built-in green
-- and gold theme; logo_key NULL = the built-in crest.
-- admission_format: how new pupils' admission numbers are made (B18,
-- services/admission.js). {YYYY}/{YY} = year of admission, {0000} = the
-- running number padded to that many digits. NULL/empty = no automatic
-- numbers. Safe to re-run (an existing row is left alone; constraints added
-- by name).

CREATE TABLE IF NOT EXISTS "dbo"."School_settings" (
  school_settings_id INTEGER PRIMARY KEY DEFAULT 1,
  name               VARCHAR(100) NOT NULL,
  short_name         VARCHAR(40),
  motto              VARCHAR(150),
  address_lines      VARCHAR(300),
  email              VARCHAR(100),
  phones             VARCHAR(80),
  logo_key           VARCHAR(120),
  primary_color      VARCHAR(7),
  accent_color       VARCHAR(7),
  admission_format   VARCHAR(40),
  report_card_footer VARCHAR(300),
  receipt_footer     VARCHAR(300),
  updated_by         VARCHAR(100),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The data move (scripts/moveFromMysql) creates School_settings from the
-- model before migrations run, so the CREATE above is skipped there and the
-- model gives updated_at no database default. Defaults and constraints are
-- added here by name, whichever way the table came.
ALTER TABLE "dbo"."School_settings" ALTER COLUMN school_settings_id SET DEFAULT 1;
ALTER TABLE "dbo"."School_settings" ALTER COLUMN updated_at SET DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'school_settings_one_row_chk') THEN
    ALTER TABLE "dbo"."School_settings" ADD CONSTRAINT school_settings_one_row_chk CHECK (school_settings_id = 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'school_settings_primary_color_chk') THEN
    ALTER TABLE "dbo"."School_settings" ADD CONSTRAINT school_settings_primary_color_chk CHECK (primary_color ~ '^#[0-9a-f]{6}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'school_settings_accent_color_chk') THEN
    ALTER TABLE "dbo"."School_settings" ADD CONSTRAINT school_settings_accent_color_chk CHECK (accent_color ~ '^#[0-9a-f]{6}$');
  END IF;
END $$;

-- Every NOT NULL column is given (updated_at too: never rely on a default
-- that a table made from the model may not have).
INSERT INTO "dbo"."School_settings"
  (school_settings_id, name, short_name, address_lines, email, phones, admission_format, updated_at)
VALUES
  (1, 'PERFECT PEACE PREPARATORY SCHOOL', 'Perfect Peace', E'P.O. BOX 13\nMEMPEASEM/ESSAMAN',
   'perfectpeacepreparatoryschool@gmail.com', '024 233 2420/024 315 4072', 'PPS/{YYYY}/{0000}', NOW())
ON CONFLICT (school_settings_id) DO NOTHING;
