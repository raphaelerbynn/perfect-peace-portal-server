-- 040 (B16): in-app notifications, the email delivery log and the
-- per-type notification switches.
--
-- The old "Notification" table (notification / class / date, copied from live
-- MySQL by move-data, never used by the app) is left alone. B16 uses three
-- new tables:
--   User_notification   one row per recipient. recipient_type STUDENT | STAFF
--                       | OFFICE (as B15's actor_type) + recipient_id
--                       (studentId, teacherId, or the office username).
--                       Parents use the pupil's login, so a pupil's rows are
--                       the family's. read_at NULL = unread.
--   Email_log           one row per email tried: SENT, LOGGED (EMAIL_DRIVER=log,
--                       nothing sent) or FAILED (+ a short error).
--   Notification_setting one row per notification type: in-app on/off, email
--                       on/off. A type with no row uses the app's default.
--
-- move-data creates every table from the models before migrations run, so
-- the CREATE TABLEs below may be skipped there: defaults, checks and indexes
-- are added by name either way. Safe to re-run.

-- ---------------------------------------------------------------- User_notification
CREATE TABLE IF NOT EXISTS "dbo"."User_notification" (
  notification_id SERIAL PRIMARY KEY,
  recipient_type  VARCHAR(10)  NOT NULL,
  recipient_id    VARCHAR(100) NOT NULL,
  type            VARCHAR(30)  NOT NULL,
  title           VARCHAR(200) NOT NULL,
  body            TEXT,
  link_url        VARCHAR(300),
  entity_type     VARCHAR(30),
  entity_id       VARCHAR(60),
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL
);
ALTER TABLE "dbo"."User_notification" ALTER COLUMN created_at SET DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_notification_recipient_type_check') THEN
    ALTER TABLE "dbo"."User_notification"
      ADD CONSTRAINT user_notification_recipient_type_check CHECK (recipient_type IN ('STUDENT', 'STAFF', 'OFFICE'));
  END IF;
END $$;

-- The bell (unread count) and the list (newest first) for one recipient.
CREATE INDEX IF NOT EXISTS idx_user_notification_unread
  ON "dbo"."User_notification" (recipient_type, recipient_id, read_at);
CREATE INDEX IF NOT EXISTS idx_user_notification_recent
  ON "dbo"."User_notification" (recipient_type, recipient_id, created_at DESC);
-- "Already sent?" checks (absence per pupil per day, results per class/term).
CREATE INDEX IF NOT EXISTS idx_user_notification_entity
  ON "dbo"."User_notification" (type, entity_type, entity_id);

-- ---------------------------------------------------------------- Email_log
CREATE TABLE IF NOT EXISTS "dbo"."Email_log" (
  email_id          SERIAL PRIMARY KEY,
  notification_type VARCHAR(30),
  recipient_type    VARCHAR(10),
  recipient_id      VARCHAR(100),
  to_address        VARCHAR(255) NOT NULL,
  subject           VARCHAR(200) NOT NULL,
  status            VARCHAR(10)  NOT NULL,
  error             VARCHAR(300),
  created_at        TIMESTAMPTZ  NOT NULL
);
ALTER TABLE "dbo"."Email_log" ALTER COLUMN created_at SET DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_log_status_check') THEN
    ALTER TABLE "dbo"."Email_log"
      ADD CONSTRAINT email_log_status_check CHECK (status IN ('SENT', 'LOGGED', 'FAILED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_email_log_created ON "dbo"."Email_log" (created_at DESC);

-- ---------------------------------------------------------------- Notification_setting
CREATE TABLE IF NOT EXISTS "dbo"."Notification_setting" (
  type       VARCHAR(30) PRIMARY KEY,
  in_app     BOOLEAN     NOT NULL,
  email      BOOLEAN     NOT NULL,
  updated_by VARCHAR(100),
  updated_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE "dbo"."Notification_setting" ALTER COLUMN in_app SET DEFAULT TRUE;
ALTER TABLE "dbo"."Notification_setting" ALTER COLUMN email SET DEFAULT FALSE;
ALTER TABLE "dbo"."Notification_setting" ALTER COLUMN updated_at SET DEFAULT now();

-- The starting switches (services/notify.js TYPES has the same defaults, so a
-- missing row behaves the same). Email is sent only once EMAIL_DRIVER=smtp.
INSERT INTO "dbo"."Notification_setting" (type, in_app, email, updated_by, updated_at) VALUES
  ('NEWS_POST',         TRUE, FALSE, NULL, now()),
  ('PAYMENT_RECORDED',  TRUE, TRUE,  NULL, now()),
  ('RESULTS_READY',     TRUE, TRUE,  NULL, now()),
  ('ATTENDANCE_ABSENT', TRUE, FALSE, NULL, now()),
  ('PASSWORD_CHANGED',  TRUE, TRUE,  NULL, now()),
  ('SCORES_MISSING',    TRUE, FALSE, NULL, now())
ON CONFLICT (type) DO NOTHING;
