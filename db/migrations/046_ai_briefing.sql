-- 046 (AI-5): the Monday briefing. Two new tables, nothing existing is changed:
--   Ai_briefing           one row per briefing day. run_key is the civil date
--                         in Africa/Accra (YYYY-MM-DD) and is UNIQUE: a
--                         restart or a second API instance can never make two
--                         briefings for one day (the scheduler claims the day
--                         by inserting the row, status RUNNING). "Run now"
--                         replaces that day's row in place.
--                         status   RUNNING  being made (claimed)
--                                  QUIET    nothing crossed a threshold: no AI
--                                           call, no cost, nobody notified
--                                  READY    a briefing with items
--                                  FAILED   the figures could not be read
--                         source   AI (written by the model, every figure
--                                  checked) or PLAIN (the computed list,
--                                  without AI) + fallback_reason QUOTA |
--                                  AI_OFF | AI_FAILED
--                         signals   JSON list of what was measured
--                         content   JSON { headline, summary, items[] ... }
--                         delivered JSON { inApp, email, whatsapp } results
--   Ai_briefing_settings  one row (id 1): the days (ISO weekdays 1 = Monday
--                         .. 7 = Sunday) and time (HH:MM, Africa/Accra) it is
--                         made, the GH₵ owing line, and the head teacher's
--                         email / WhatsApp delivery. The recipient address and
--                         number go to the email / WhatsApp provider only,
--                         never to the AI.
--
-- move-data creates every table from the models before migrations run, so
-- the CREATE TABLEs below may be skipped there: defaults, checks and indexes
-- are added by name either way. Safe to re-run.

-- ---------------------------------------------------------------- Ai_briefing
CREATE TABLE IF NOT EXISTS "dbo"."Ai_briefing" (
  briefing_id     SERIAL PRIMARY KEY,
  run_key         VARCHAR(40)   NOT NULL,
  briefing_date   DATE          NOT NULL,
  status          VARCHAR(10)   NOT NULL,
  source          VARCHAR(10),
  fallback_reason VARCHAR(20),
  signals         JSONB         NOT NULL,
  content         JSONB,
  delivered       JSONB         NOT NULL,
  model           VARCHAR(60),
  prompt_version  VARCHAR(60),
  cost_ghs        NUMERIC(12,4) NOT NULL,
  error           VARCHAR(300),
  run_trigger     VARCHAR(10)   NOT NULL,
  run_by          VARCHAR(110),
  created_at      TIMESTAMPTZ   NOT NULL,
  updated_at      TIMESTAMPTZ   NOT NULL
);
ALTER TABLE "dbo"."Ai_briefing" ALTER COLUMN signals SET DEFAULT '[]'::jsonb;
ALTER TABLE "dbo"."Ai_briefing" ALTER COLUMN delivered SET DEFAULT '{}'::jsonb;
ALTER TABLE "dbo"."Ai_briefing" ALTER COLUMN cost_ghs SET DEFAULT 0;
ALTER TABLE "dbo"."Ai_briefing" ALTER COLUMN run_trigger SET DEFAULT 'SCHEDULE';
ALTER TABLE "dbo"."Ai_briefing" ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE "dbo"."Ai_briefing" ALTER COLUMN updated_at SET DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_briefing_run_key_unique') THEN
    ALTER TABLE "dbo"."Ai_briefing" ADD CONSTRAINT ai_briefing_run_key_unique UNIQUE (run_key);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_briefing_status_check') THEN
    ALTER TABLE "dbo"."Ai_briefing"
      ADD CONSTRAINT ai_briefing_status_check CHECK (status IN ('RUNNING', 'QUIET', 'READY', 'FAILED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_briefing_source_check') THEN
    ALTER TABLE "dbo"."Ai_briefing"
      ADD CONSTRAINT ai_briefing_source_check CHECK (source IS NULL OR source IN ('AI', 'PLAIN'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_briefing_fallback_check') THEN
    ALTER TABLE "dbo"."Ai_briefing"
      ADD CONSTRAINT ai_briefing_fallback_check CHECK (fallback_reason IS NULL OR fallback_reason IN ('QUOTA', 'AI_OFF', 'AI_FAILED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_briefing_trigger_check') THEN
    ALTER TABLE "dbo"."Ai_briefing"
      ADD CONSTRAINT ai_briefing_trigger_check CHECK (run_trigger IN ('SCHEDULE', 'MANUAL'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_briefing_cost_check') THEN
    ALTER TABLE "dbo"."Ai_briefing" ADD CONSTRAINT ai_briefing_cost_check CHECK (cost_ghs >= 0);
  END IF;
END $$;

-- The dashboard card (latest) and the history page (newest first).
CREATE INDEX IF NOT EXISTS idx_ai_briefing_date ON "dbo"."Ai_briefing" (briefing_date DESC, briefing_id DESC);

-- ---------------------------------------------------------------- Ai_briefing_settings
CREATE TABLE IF NOT EXISTS "dbo"."Ai_briefing_settings" (
  briefing_settings_id INTEGER       PRIMARY KEY,
  days                 JSONB         NOT NULL,
  run_time             VARCHAR(5)    NOT NULL,
  owing_threshold_ghs  NUMERIC(12,2) NOT NULL,
  email_enabled        BOOLEAN       NOT NULL,
  email_to             VARCHAR(254),
  whatsapp_enabled     BOOLEAN       NOT NULL,
  whatsapp_to          VARCHAR(20),
  updated_by           VARCHAR(100),
  updated_at           TIMESTAMPTZ   NOT NULL
);
ALTER TABLE "dbo"."Ai_briefing_settings" ALTER COLUMN briefing_settings_id SET DEFAULT 1;
ALTER TABLE "dbo"."Ai_briefing_settings" ALTER COLUMN days SET DEFAULT '[1]'::jsonb;
ALTER TABLE "dbo"."Ai_briefing_settings" ALTER COLUMN run_time SET DEFAULT '06:00';
ALTER TABLE "dbo"."Ai_briefing_settings" ALTER COLUMN owing_threshold_ghs SET DEFAULT 100;
ALTER TABLE "dbo"."Ai_briefing_settings" ALTER COLUMN email_enabled SET DEFAULT FALSE;
ALTER TABLE "dbo"."Ai_briefing_settings" ALTER COLUMN whatsapp_enabled SET DEFAULT FALSE;
ALTER TABLE "dbo"."Ai_briefing_settings" ALTER COLUMN updated_at SET DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_briefing_settings_single_row_check') THEN
    ALTER TABLE "dbo"."Ai_briefing_settings"
      ADD CONSTRAINT ai_briefing_settings_single_row_check CHECK (briefing_settings_id = 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_briefing_settings_time_check') THEN
    ALTER TABLE "dbo"."Ai_briefing_settings"
      ADD CONSTRAINT ai_briefing_settings_time_check CHECK (run_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_briefing_settings_days_check') THEN
    ALTER TABLE "dbo"."Ai_briefing_settings"
      ADD CONSTRAINT ai_briefing_settings_days_check CHECK (jsonb_typeof(days) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_briefing_settings_owing_check') THEN
    ALTER TABLE "dbo"."Ai_briefing_settings"
      ADD CONSTRAINT ai_briefing_settings_owing_check CHECK (owing_threshold_ghs >= 0);
  END IF;
END $$;

-- The one row: Mondays at 06:00, in-app only (email and WhatsApp off until
-- the Administrator enters the head teacher's address / number).
INSERT INTO "dbo"."Ai_briefing_settings"
  (briefing_settings_id, days, run_time, owing_threshold_ghs, email_enabled, email_to, whatsapp_enabled, whatsapp_to, updated_by, updated_at)
VALUES (1, '[1]'::jsonb, '06:00', 100, FALSE, NULL, FALSE, NULL, NULL, now())
ON CONFLICT (briefing_settings_id) DO NOTHING;
