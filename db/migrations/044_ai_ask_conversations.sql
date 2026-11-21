-- 044 (AI-1): "Ask the school" conversations. Two new tables, nothing
-- existing is changed:
--   Ai_conversation  one thread of questions per office user. user_ref is
--                    who owns it ("OFFICE:<username>", as Ai_usage_log), and
--                    only that user can list, read or delete it. title = the
--                    first question, cut short.
--   Ai_message       each question (role USER) and answer (role ASSISTANT).
--                    user_ref is copied onto every row so the per-user limit
--                    (20 questions an hour by default) is one indexed COUNT.
--                    tools_used = the read-only tools the answer looked at
--                    (JSON list of names); fast_path = answered without the AI
--                    (no cost); status OK | STOPPED (the asker pressed Stop or
--                    closed the page) | ERROR; cost_ghs = what the AI calls
--                    for this answer cost (the usage log stays the record).
-- Deleting a conversation deletes its messages (ON DELETE CASCADE). The
-- usage log is not touched, so the month's spend is unchanged.
--
-- move-data creates every table from the models before migrations run, so
-- the CREATE TABLEs below may be skipped there: defaults, checks, the foreign
-- key and indexes are added by name either way. Safe to re-run.

-- ---------------------------------------------------------------- Ai_conversation
CREATE TABLE IF NOT EXISTS "dbo"."Ai_conversation" (
  conversation_id SERIAL PRIMARY KEY,
  user_ref        VARCHAR(110) NOT NULL,
  title           VARCHAR(120) NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL,
  updated_at      TIMESTAMPTZ  NOT NULL
);
ALTER TABLE "dbo"."Ai_conversation" ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE "dbo"."Ai_conversation" ALTER COLUMN updated_at SET DEFAULT now();

-- "My conversations", newest first.
CREATE INDEX IF NOT EXISTS idx_ai_conversation_user
  ON "dbo"."Ai_conversation" (user_ref, updated_at DESC);

-- ---------------------------------------------------------------- Ai_message
CREATE TABLE IF NOT EXISTS "dbo"."Ai_message" (
  message_id      SERIAL PRIMARY KEY,
  conversation_id INTEGER       NOT NULL,
  user_ref        VARCHAR(110)  NOT NULL,
  role            VARCHAR(10)   NOT NULL,
  content         TEXT          NOT NULL,
  tools_used      JSONB         NOT NULL,
  fast_path       BOOLEAN       NOT NULL,
  status          VARCHAR(10)   NOT NULL,
  prompt_version  VARCHAR(60),
  cost_ghs        NUMERIC(12,4) NOT NULL,
  created_at      TIMESTAMPTZ   NOT NULL
);
ALTER TABLE "dbo"."Ai_message" ALTER COLUMN tools_used SET DEFAULT '[]'::jsonb;
ALTER TABLE "dbo"."Ai_message" ALTER COLUMN fast_path SET DEFAULT FALSE;
ALTER TABLE "dbo"."Ai_message" ALTER COLUMN status SET DEFAULT 'OK';
ALTER TABLE "dbo"."Ai_message" ALTER COLUMN cost_ghs SET DEFAULT 0;
ALTER TABLE "dbo"."Ai_message" ALTER COLUMN created_at SET DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_message_conversation_fk') THEN
    ALTER TABLE "dbo"."Ai_message"
      ADD CONSTRAINT ai_message_conversation_fk FOREIGN KEY (conversation_id)
      REFERENCES "dbo"."Ai_conversation" (conversation_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_message_role_check') THEN
    ALTER TABLE "dbo"."Ai_message"
      ADD CONSTRAINT ai_message_role_check CHECK (role IN ('USER', 'ASSISTANT'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_message_status_check') THEN
    ALTER TABLE "dbo"."Ai_message"
      ADD CONSTRAINT ai_message_status_check CHECK (status IN ('OK', 'STOPPED', 'ERROR'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_message_cost_check') THEN
    ALTER TABLE "dbo"."Ai_message"
      ADD CONSTRAINT ai_message_cost_check CHECK (cost_ghs >= 0);
  END IF;
END $$;

-- A conversation's messages in order.
CREATE INDEX IF NOT EXISTS idx_ai_message_conversation
  ON "dbo"."Ai_message" (conversation_id, message_id);
-- The per-user limit: questions this user asked in the last hour.
CREATE INDEX IF NOT EXISTS idx_ai_message_user_questions
  ON "dbo"."Ai_message" (user_ref, created_at) WHERE role = 'USER';
