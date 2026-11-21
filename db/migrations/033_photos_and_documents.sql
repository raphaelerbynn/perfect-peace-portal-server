-- 019 (B17): pupil and staff photos, and documents kept on their records.
--
-- Files live on the server's disk (UPLOAD_DIR), never in the database and
-- never at a public address: the columns below hold the storage key, and the
-- API streams the file only to a signed-in user allowed to see it.
--
-- Student.photo_key / Teacher.photo_key: the current photo (NULL = none).
-- Document: birth certificates, contracts, ... for a pupil (STUDENT) or a
--   member of staff (STAFF). owner_id is Student.student_id or
--   Teacher.teacher_id (no FK: one column points at two tables).
-- Existing rows are untouched: everyone starts with no photo and no documents.
-- Safe to re-run (IF NOT EXISTS; constraints added by name).

ALTER TABLE "dbo"."Student" ADD COLUMN IF NOT EXISTS photo_key VARCHAR(120);
ALTER TABLE "dbo"."Teacher" ADD COLUMN IF NOT EXISTS photo_key VARCHAR(120);

CREATE TABLE IF NOT EXISTS "dbo"."Document" (
  document_id   SERIAL PRIMARY KEY,
  owner_type    VARCHAR(10)  NOT NULL,
  owner_id      INTEGER      NOT NULL,
  doc_type      VARCHAR(40)  NOT NULL,
  title         VARCHAR(100) NOT NULL,
  storage_key   VARCHAR(120) NOT NULL,
  mime          VARCHAR(60)  NOT NULL,
  size_bytes    INTEGER      NOT NULL,
  original_name VARCHAR(120),
  uploaded_by   VARCHAR(100),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- The data move (scripts/moveFromMysql) creates Document from the model
-- before migrations run, so the CREATE above is skipped there and the model
-- gives created_at no database default. Defaults and constraints are added
-- here by name, whichever way the table came.
ALTER TABLE "dbo"."Document" ALTER COLUMN created_at SET DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_owner_type_chk') THEN
    ALTER TABLE "dbo"."Document" ADD CONSTRAINT document_owner_type_chk CHECK (owner_type IN ('STUDENT', 'STAFF'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_size_bytes_chk') THEN
    ALTER TABLE "dbo"."Document" ADD CONSTRAINT document_size_bytes_chk CHECK (size_bytes > 0);
  END IF;
  -- Same name the model's `unique: true` gives it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Document_storage_key_key') THEN
    ALTER TABLE "dbo"."Document" ADD CONSTRAINT "Document_storage_key_key" UNIQUE (storage_key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_document_owner
  ON "dbo"."Document" (owner_type, owner_id);
