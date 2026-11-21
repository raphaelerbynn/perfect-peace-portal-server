-- 049 (AI-4): the pupils-at-risk watchlist. One new table, nothing existing is
-- changed. Who is on the watchlist is COMPUTED every time it is read (SQL +
-- services/atRisk/signals.js); this table only keeps what people (and the AI)
-- add to a pupil's entry for one term:
--
--   Ai_watchlist_entry  one row per pupil per term, made the first time
--                       someone acts on that pupil's entry.
--     status            NULL       open (on the list, nobody has acted)
--                       HANDLING   "being handled": someone is on it
--                       DISMISSED  taken off the list for this term
--     status_note       optional words with it ("called mum on Monday")
--     status_kinds      the reasons the pupil was flagged for when it was
--                       set (JSON list): a NEW reason appearing later puts a
--                       dismissed pupil back on the list
--     status_by / _at   who and when (OFFICE:<username>)
--     ai_note / ai_next_step
--                       the AI's short note ("why flagged, suggested next
--                       step"), every figure in it checked against the
--                       computed figures. Staff-only, so not a draft.
--     ai_fingerprint    a hash of the reasons and figures the note was
--                       written for: when the figures move, the note is
--                       not shown any more (and can be written again)
--     ai_model / ai_prompt_version / ai_written_by / ai_written_at
--
-- Pupils and terms are referenced with ON DELETE CASCADE (pupils are only
-- soft-deleted in practice; deleting a term drops its watchlist marks).
-- move-data creates every table from the models before migrations run, so
-- the CREATE TABLE below may be skipped there: checks, keys and indexes are
-- added by name either way. Safe to re-run.

CREATE TABLE IF NOT EXISTS "dbo"."Ai_watchlist_entry" (
  student_id        INTEGER      NOT NULL,
  term_id           INTEGER      NOT NULL,
  status            VARCHAR(10),
  status_note       VARCHAR(300),
  status_kinds      JSONB,
  status_by         VARCHAR(110),
  status_at         TIMESTAMPTZ,
  ai_note           VARCHAR(600),
  ai_next_step      VARCHAR(400),
  ai_fingerprint    VARCHAR(16),
  ai_model          VARCHAR(60),
  ai_prompt_version VARCHAR(60),
  ai_written_by     VARCHAR(110),
  ai_written_at     TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ  NOT NULL
);
ALTER TABLE "dbo"."Ai_watchlist_entry" ALTER COLUMN updated_at SET DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'dbo' AND t.relname = 'Ai_watchlist_entry' AND c.contype = 'p'
  ) THEN
    ALTER TABLE "dbo"."Ai_watchlist_entry" ADD CONSTRAINT ai_watchlist_entry_pkey PRIMARY KEY (student_id, term_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_watchlist_entry_status_check') THEN
    ALTER TABLE "dbo"."Ai_watchlist_entry"
      ADD CONSTRAINT ai_watchlist_entry_status_check CHECK (status IS NULL OR status IN ('HANDLING', 'DISMISSED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_watchlist_entry_student_fk') THEN
    ALTER TABLE "dbo"."Ai_watchlist_entry"
      ADD CONSTRAINT ai_watchlist_entry_student_fk FOREIGN KEY (student_id) REFERENCES "dbo"."Student" (student_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_watchlist_entry_term_fk') THEN
    ALTER TABLE "dbo"."Ai_watchlist_entry"
      ADD CONSTRAINT ai_watchlist_entry_term_fk FOREIGN KEY (term_id) REFERENCES "dbo"."Term" (term_id) ON DELETE CASCADE;
  END IF;
END $$;

-- The watchlist reads one term's marks at a time.
CREATE INDEX IF NOT EXISTS idx_ai_watchlist_entry_term ON "dbo"."Ai_watchlist_entry" (term_id);
