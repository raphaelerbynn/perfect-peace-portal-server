-- 037 (B15): school news feed, polls and the events calendar.
--
-- The old "Event" table becomes the post table. It keeps its name and its
-- columns, so the old /news, /events, /add-news ... calls and the
-- MySQL -> Postgres move (which copies live's Event table by name) keep
-- working:
--   name        = the post title (widened from 50 to 255, as in live MySQL;
--                 the app allows 150)
--   description = the post body
--   date        = the event (start) date; time = the free-text event time
-- New columns: post type (NEWS | EVENT | POLL), status (DRAFT | PUBLISHED |
-- ARCHIVED), pin, audience (ALL | CLASSES | STAFF + class ids), comments on or
-- off, an image (storage key, never sent to the browser), event end date and
-- place, poll closing time, who wrote it and when it was published.
-- Existing rows become NEWS, PUBLISHED, for everyone, comments on.
--
-- New tables (the voter / commenter is a pupil, a teacher or an office login,
-- so each row stores actor_type STUDENT | STAFF | OFFICE + actor_id):
--   Post_like     one per post per actor
--   Post_comment  status VISIBLE | HIDDEN (an Administrator hides it)
--   Poll_option   the choices of a POLL post
--   Poll_vote     ONE vote per poll per actor (unique on post + actor)
-- Children are removed with their post (ON DELETE CASCADE).
--
-- move-data creates every table from the models before migrations run, so
-- the ADD COLUMN / CREATE TABLE below may be skipped there: defaults,
-- backfills, checks, keys and indexes are added here by name either way.
-- Safe to re-run.

-- ---------------------------------------------------------------- Event = post
ALTER TABLE "dbo"."Event" ALTER COLUMN name TYPE VARCHAR(255);

ALTER TABLE "dbo"."Event" ADD COLUMN IF NOT EXISTS post_type          VARCHAR(10);
ALTER TABLE "dbo"."Event" ADD COLUMN IF NOT EXISTS status             VARCHAR(10);
ALTER TABLE "dbo"."Event" ADD COLUMN IF NOT EXISTS is_pinned          BOOLEAN;
ALTER TABLE "dbo"."Event" ADD COLUMN IF NOT EXISTS audience           VARCHAR(10);
ALTER TABLE "dbo"."Event" ADD COLUMN IF NOT EXISTS audience_class_ids INTEGER[];
ALTER TABLE "dbo"."Event" ADD COLUMN IF NOT EXISTS comments_enabled   BOOLEAN;
ALTER TABLE "dbo"."Event" ADD COLUMN IF NOT EXISTS image_key          VARCHAR(120);
ALTER TABLE "dbo"."Event" ADD COLUMN IF NOT EXISTS event_end_date     DATE;
ALTER TABLE "dbo"."Event" ADD COLUMN IF NOT EXISTS location           VARCHAR(200);
ALTER TABLE "dbo"."Event" ADD COLUMN IF NOT EXISTS poll_closes_at     TIMESTAMPTZ;
ALTER TABLE "dbo"."Event" ADD COLUMN IF NOT EXISTS created_by         VARCHAR(100);
ALTER TABLE "dbo"."Event" ADD COLUMN IF NOT EXISTS published_at       TIMESTAMPTZ;
ALTER TABLE "dbo"."Event" ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ;

-- Existing rows (and any the move left empty).
UPDATE "dbo"."Event" SET post_type = 'NEWS' WHERE post_type IS NULL;
UPDATE "dbo"."Event" SET status = 'PUBLISHED' WHERE status IS NULL;
UPDATE "dbo"."Event" SET is_pinned = FALSE WHERE is_pinned IS NULL;
UPDATE "dbo"."Event" SET audience = 'ALL' WHERE audience IS NULL;
UPDATE "dbo"."Event" SET comments_enabled = TRUE WHERE comments_enabled IS NULL;

-- published_at from the old created_at text: Date.now() milliseconds (old
-- app), seconds, or an ISO timestamp (A1 follow-up). Anything unreadable
-- falls back to the event date, else stays NULL (the feed then sorts it by
-- its date). Row by row so one bad value can't fail the file. (npm run
-- sync-data fills it the same way for rows it adds later: EVENT_PUBLISHED_AT_SQL.)
DO $$
DECLARE
  r RECORD;
  ts TIMESTAMPTZ;
BEGIN
  FOR r IN SELECT event_id, TRIM(created_at) AS c, date FROM "dbo"."Event" WHERE published_at IS NULL LOOP
    ts := NULL;
    BEGIN
      IF r.c ~ '^\d{13}$' THEN
        ts := to_timestamp(r.c::BIGINT / 1000.0);
      ELSIF r.c ~ '^\d{10}$' THEN
        ts := to_timestamp(r.c::BIGINT);
      ELSIF r.c ~ '^\d{4}-\d{2}-\d{2}' THEN
        ts := r.c::TIMESTAMPTZ;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      ts := NULL;
    END;
    IF ts IS NULL AND r.date IS NOT NULL THEN
      ts := r.date::TIMESTAMPTZ;
    END IF;
    IF ts IS NOT NULL THEN
      UPDATE "dbo"."Event" SET published_at = ts WHERE event_id = r.event_id;
    END IF;
  END LOOP;
END $$;

ALTER TABLE "dbo"."Event" ALTER COLUMN post_type SET DEFAULT 'NEWS';
ALTER TABLE "dbo"."Event" ALTER COLUMN status SET DEFAULT 'PUBLISHED';
ALTER TABLE "dbo"."Event" ALTER COLUMN is_pinned SET DEFAULT FALSE;
ALTER TABLE "dbo"."Event" ALTER COLUMN audience SET DEFAULT 'ALL';
ALTER TABLE "dbo"."Event" ALTER COLUMN comments_enabled SET DEFAULT TRUE;
ALTER TABLE "dbo"."Event" ALTER COLUMN post_type SET NOT NULL;
ALTER TABLE "dbo"."Event" ALTER COLUMN status SET NOT NULL;
ALTER TABLE "dbo"."Event" ALTER COLUMN is_pinned SET NOT NULL;
ALTER TABLE "dbo"."Event" ALTER COLUMN audience SET NOT NULL;
ALTER TABLE "dbo"."Event" ALTER COLUMN comments_enabled SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_event_post_type') THEN
    ALTER TABLE "dbo"."Event" ADD CONSTRAINT chk_event_post_type CHECK (post_type IN ('NEWS', 'EVENT', 'POLL'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_event_status') THEN
    ALTER TABLE "dbo"."Event" ADD CONSTRAINT chk_event_status CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_event_audience') THEN
    ALTER TABLE "dbo"."Event" ADD CONSTRAINT chk_event_audience CHECK (audience IN ('ALL', 'CLASSES', 'STAFF'));
  END IF;
  -- NOT VALID: an old row with odd dates must not stop go-live; new writes are checked.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_event_end_after_start') THEN
    ALTER TABLE "dbo"."Event" ADD CONSTRAINT chk_event_end_after_start
      CHECK (event_end_date IS NULL OR "date" IS NULL OR event_end_date >= "date") NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_event_feed ON "dbo"."Event" (status, is_pinned, published_at);
CREATE INDEX IF NOT EXISTS idx_event_date ON "dbo"."Event" ("date");

-- ---------------------------------------------------------------- likes
CREATE TABLE IF NOT EXISTS "dbo"."Post_like" (
  like_id    SERIAL PRIMARY KEY,
  post_id    INTEGER      NOT NULL,
  actor_type VARCHAR(10)  NOT NULL,
  actor_id   VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
ALTER TABLE "dbo"."Post_like" ALTER COLUMN created_at SET DEFAULT NOW();
CREATE UNIQUE INDEX IF NOT EXISTS uniq_post_like ON "dbo"."Post_like" (post_id, actor_type, actor_id);

-- ---------------------------------------------------------------- comments
CREATE TABLE IF NOT EXISTS "dbo"."Post_comment" (
  comment_id SERIAL PRIMARY KEY,
  post_id    INTEGER       NOT NULL,
  actor_type VARCHAR(10)   NOT NULL,
  actor_id   VARCHAR(100)  NOT NULL,
  actor_name VARCHAR(120),
  body       VARCHAR(1000) NOT NULL,
  status     VARCHAR(10)   NOT NULL DEFAULT 'VISIBLE',
  hidden_by  VARCHAR(100),
  hidden_at  TIMESTAMPTZ,
  created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
ALTER TABLE "dbo"."Post_comment" ALTER COLUMN status SET DEFAULT 'VISIBLE';
ALTER TABLE "dbo"."Post_comment" ALTER COLUMN created_at SET DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_post_comment_post ON "dbo"."Post_comment" (post_id, created_at);

-- ---------------------------------------------------------------- polls
CREATE TABLE IF NOT EXISTS "dbo"."Poll_option" (
  option_id SERIAL PRIMARY KEY,
  post_id   INTEGER      NOT NULL,
  label     VARCHAR(200) NOT NULL,
  position  INTEGER      NOT NULL DEFAULT 0
);
ALTER TABLE "dbo"."Poll_option" ALTER COLUMN position SET DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_poll_option_post ON "dbo"."Poll_option" (post_id, position);

CREATE TABLE IF NOT EXISTS "dbo"."Poll_vote" (
  vote_id    SERIAL PRIMARY KEY,
  post_id    INTEGER      NOT NULL,
  option_id  INTEGER      NOT NULL,
  actor_type VARCHAR(10)  NOT NULL,
  actor_id   VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
ALTER TABLE "dbo"."Poll_vote" ALTER COLUMN created_at SET DEFAULT NOW();
-- One vote per voter per poll (also stops two votes sent at the same time).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_poll_vote_voter ON "dbo"."Poll_vote" (post_id, actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_poll_vote_option ON "dbo"."Poll_vote" (option_id);

-- ---------------------------------------------------------------- checks + keys
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_post_like_actor') THEN
    ALTER TABLE "dbo"."Post_like" ADD CONSTRAINT chk_post_like_actor CHECK (actor_type IN ('STUDENT', 'STAFF', 'OFFICE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_post_comment_actor') THEN
    ALTER TABLE "dbo"."Post_comment" ADD CONSTRAINT chk_post_comment_actor CHECK (actor_type IN ('STUDENT', 'STAFF', 'OFFICE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_post_comment_status') THEN
    ALTER TABLE "dbo"."Post_comment" ADD CONSTRAINT chk_post_comment_status CHECK (status IN ('VISIBLE', 'HIDDEN'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_poll_vote_actor') THEN
    ALTER TABLE "dbo"."Poll_vote" ADD CONSTRAINT chk_poll_vote_actor CHECK (actor_type IN ('STUDENT', 'STAFF', 'OFFICE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_post_like_post') THEN
    ALTER TABLE "dbo"."Post_like" ADD CONSTRAINT fk_post_like_post
      FOREIGN KEY (post_id) REFERENCES "dbo"."Event"(event_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_post_comment_post') THEN
    ALTER TABLE "dbo"."Post_comment" ADD CONSTRAINT fk_post_comment_post
      FOREIGN KEY (post_id) REFERENCES "dbo"."Event"(event_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_poll_option_post') THEN
    ALTER TABLE "dbo"."Poll_option" ADD CONSTRAINT fk_poll_option_post
      FOREIGN KEY (post_id) REFERENCES "dbo"."Event"(event_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_poll_vote_post') THEN
    ALTER TABLE "dbo"."Poll_vote" ADD CONSTRAINT fk_poll_vote_post
      FOREIGN KEY (post_id) REFERENCES "dbo"."Event"(event_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_poll_vote_option') THEN
    ALTER TABLE "dbo"."Poll_vote" ADD CONSTRAINT fk_poll_vote_option
      FOREIGN KEY (option_id) REFERENCES "dbo"."Poll_option"(option_id) ON DELETE CASCADE;
  END IF;
END $$;
