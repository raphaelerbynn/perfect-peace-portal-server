-- 043 (AI-0): shared AI infrastructure. Three new tables, nothing existing
-- is changed:
--   Ai_usage_log   one row per model call (and per refused call): feature,
--                  who, model, prompt version, token counts, cost, status.
--                  The monthly spend cap sums cost_ghs for the month.
--                  user_ref = "OFFICE:<username>" or "STAFF:<teacherId>".
--                  cost_micros = estimated USD cost in millionths of a dollar
--                  (what Google bills); cost_ghs = the same in cedis at the
--                  AI_USD_TO_GHS rate of the day it was recorded.
--   Ai_suggestion  every AI result is a draft: PENDING -> EDITED -> ACCEPTED
--                  or REJECTED. content is JSON (shape is per feature).
--                  Accepting runs the feature's own handler (services/ai).
--   Ai_settings    one row (id 1): the school's AI switch, per-feature
--                  switches (JSON, a missing key = the app's default), the
--                  monthly cap in GH₵ (NULL = AI_MONTHLY_BUDGET_GHS) and the
--                  tone for drafted notices (JSON).
--
-- AI stays OFF: the row starts with enabled = FALSE, and the server also
-- needs AI_ENABLED=true and GEMINI_API_KEY before anything is sent.
--
-- move-data creates every table from the models before migrations run, so
-- the CREATE TABLEs below may be skipped there: defaults, checks and indexes
-- are added by name either way. Safe to re-run.

-- ---------------------------------------------------------------- Ai_usage_log
CREATE TABLE IF NOT EXISTS "dbo"."Ai_usage_log" (
  usage_id       SERIAL PRIMARY KEY,
  feature        VARCHAR(30)   NOT NULL,
  user_ref       VARCHAR(110),
  model          VARCHAR(60)   NOT NULL,
  prompt_version VARCHAR(60),
  input_tokens   INTEGER       NOT NULL,
  cached_tokens  INTEGER       NOT NULL,
  output_tokens  INTEGER       NOT NULL,
  cost_micros    BIGINT        NOT NULL,
  cost_ghs       NUMERIC(12,4) NOT NULL,
  status         VARCHAR(10)   NOT NULL,
  error_class    VARCHAR(20),
  error_message  VARCHAR(300),
  latency_ms     INTEGER,
  created_at     TIMESTAMPTZ   NOT NULL
);
ALTER TABLE "dbo"."Ai_usage_log" ALTER COLUMN input_tokens SET DEFAULT 0;
ALTER TABLE "dbo"."Ai_usage_log" ALTER COLUMN cached_tokens SET DEFAULT 0;
ALTER TABLE "dbo"."Ai_usage_log" ALTER COLUMN output_tokens SET DEFAULT 0;
ALTER TABLE "dbo"."Ai_usage_log" ALTER COLUMN cost_micros SET DEFAULT 0;
ALTER TABLE "dbo"."Ai_usage_log" ALTER COLUMN cost_ghs SET DEFAULT 0;
ALTER TABLE "dbo"."Ai_usage_log" ALTER COLUMN created_at SET DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_usage_log_status_check') THEN
    ALTER TABLE "dbo"."Ai_usage_log"
      ADD CONSTRAINT ai_usage_log_status_check CHECK (status IN ('OK', 'ERROR', 'BLOCKED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_usage_log_error_class_check') THEN
    ALTER TABLE "dbo"."Ai_usage_log"
      ADD CONSTRAINT ai_usage_log_error_class_check CHECK (
        error_class IS NULL OR error_class IN
          ('RATE_LIMIT', 'TIMEOUT', 'SAFETY_BLOCK', 'MALFORMED_OUTPUT', 'AUTH', 'PROVIDER_ERROR', 'UNKNOWN', 'QUOTA', 'DISABLED')
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_usage_log_counts_check') THEN
    ALTER TABLE "dbo"."Ai_usage_log"
      ADD CONSTRAINT ai_usage_log_counts_check CHECK (
        input_tokens >= 0 AND cached_tokens >= 0 AND output_tokens >= 0 AND cost_micros >= 0 AND cost_ghs >= 0
      );
  END IF;
END $$;

-- This month's spend (the cap check runs before every call) and the usage page.
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_created ON "dbo"."Ai_usage_log" (created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_feature ON "dbo"."Ai_usage_log" (feature, created_at);
-- "Recent failures" on the Settings -> AI page.
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_failures
  ON "dbo"."Ai_usage_log" (created_at DESC) WHERE status <> 'OK';

-- ---------------------------------------------------------------- Ai_suggestion
CREATE TABLE IF NOT EXISTS "dbo"."Ai_suggestion" (
  suggestion_id  SERIAL PRIMARY KEY,
  feature        VARCHAR(30)  NOT NULL,
  entity_type    VARCHAR(40)  NOT NULL,
  entity_id      VARCHAR(60),
  field          VARCHAR(60),
  content        JSONB        NOT NULL,
  status         VARCHAR(10)  NOT NULL,
  model          VARCHAR(60),
  prompt_version VARCHAR(60),
  created_by     VARCHAR(110),
  reviewed_by    VARCHAR(110),
  reviewed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL,
  updated_at     TIMESTAMPTZ  NOT NULL
);
ALTER TABLE "dbo"."Ai_suggestion" ALTER COLUMN status SET DEFAULT 'PENDING';
ALTER TABLE "dbo"."Ai_suggestion" ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE "dbo"."Ai_suggestion" ALTER COLUMN updated_at SET DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_suggestion_status_check') THEN
    ALTER TABLE "dbo"."Ai_suggestion"
      ADD CONSTRAINT ai_suggestion_status_check CHECK (status IN ('PENDING', 'EDITED', 'ACCEPTED', 'REJECTED'));
  END IF;
END $$;

-- The review queue (per feature, open first, newest first) and "drafts for this record".
CREATE INDEX IF NOT EXISTS idx_ai_suggestion_queue
  ON "dbo"."Ai_suggestion" (feature, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_suggestion_entity
  ON "dbo"."Ai_suggestion" (entity_type, entity_id);
-- A teacher's own drafts (AI-3 question papers).
CREATE INDEX IF NOT EXISTS idx_ai_suggestion_created_by
  ON "dbo"."Ai_suggestion" (created_by, created_at DESC);

-- ---------------------------------------------------------------- Ai_settings
CREATE TABLE IF NOT EXISTS "dbo"."Ai_settings" (
  ai_settings_id  INTEGER       PRIMARY KEY,
  enabled         BOOLEAN       NOT NULL,
  feature_toggles JSONB         NOT NULL,
  monthly_cap_ghs NUMERIC(10,2),
  tone            JSONB         NOT NULL,
  updated_by      VARCHAR(100),
  updated_at      TIMESTAMPTZ   NOT NULL
);
ALTER TABLE "dbo"."Ai_settings" ALTER COLUMN ai_settings_id SET DEFAULT 1;
ALTER TABLE "dbo"."Ai_settings" ALTER COLUMN enabled SET DEFAULT FALSE;
ALTER TABLE "dbo"."Ai_settings" ALTER COLUMN feature_toggles SET DEFAULT '{}'::jsonb;
ALTER TABLE "dbo"."Ai_settings" ALTER COLUMN tone SET DEFAULT '{}'::jsonb;
ALTER TABLE "dbo"."Ai_settings" ALTER COLUMN updated_at SET DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_settings_single_row_check') THEN
    ALTER TABLE "dbo"."Ai_settings"
      ADD CONSTRAINT ai_settings_single_row_check CHECK (ai_settings_id = 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_settings_cap_check') THEN
    ALTER TABLE "dbo"."Ai_settings"
      ADD CONSTRAINT ai_settings_cap_check CHECK (monthly_cap_ghs IS NULL OR monthly_cap_ghs >= 0);
  END IF;
END $$;

-- The one row, switched off. Empty toggles/tone = the app's defaults.
INSERT INTO "dbo"."Ai_settings" (ai_settings_id, enabled, feature_toggles, monthly_cap_ghs, tone, updated_by, updated_at)
VALUES (1, FALSE, '{}'::jsonb, NULL, '{}'::jsonb, NULL, now())
ON CONFLICT (ai_settings_id) DO NOTHING;
