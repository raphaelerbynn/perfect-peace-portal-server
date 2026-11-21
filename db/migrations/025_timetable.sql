-- 004 (B3): timetable.
--
-- Timetable_period: the school's bell schedule (P1 8:00-8:40, Break, ...).
-- One school-wide list for now (client question B3.1: does KG differ?). The
-- office clicks period cells instead of typing times.
--
-- Timetable_entry: one lesson. It stores its own start/end times, so editing
-- the bell schedule never rewrites lessons already placed; the grid matches a
-- lesson to the period its times overlap. day: 1 = Monday ... 5 = Friday
-- (6/7 allowed by the column so Saturday classes need no new migration).
--
-- Rules (services/timetable.js, ported from SchoolPro):
--   class clash  (same term/class/day, overlapping times) = refused (409)
--   teacher clash (same term/teacher/day, overlapping)    = saved, with a warning

CREATE TABLE IF NOT EXISTS "dbo"."Timetable_period" (
  period_id   SERIAL PRIMARY KEY,
  label       VARCHAR(40) NOT NULL,
  start_time  VARCHAR(5)  NOT NULL,
  end_time    VARCHAR(5)  NOT NULL,
  is_break    BOOLEAN     NOT NULL DEFAULT FALSE,
  sort_order  INTEGER     NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "dbo"."Timetable_entry" (
  timetable_entry_id SERIAL PRIMARY KEY,
  term_id     INTEGER NOT NULL REFERENCES "dbo"."Term"(term_id),
  class_id    INTEGER NOT NULL REFERENCES "dbo"."Class"(class_id),
  subject_id  INTEGER NOT NULL REFERENCES "dbo"."Subject"(subject_id),
  teacher_id  INTEGER NOT NULL REFERENCES "dbo"."Teacher"(teacher_id),
  day         SMALLINT NOT NULL CHECK (day BETWEEN 1 AND 7),
  start_time  VARCHAR(5) NOT NULL,
  end_time    VARCHAR(5) NOT NULL,
  room        VARCHAR(50),
  notes       VARCHAR(200),
  created_by  VARCHAR(100),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_timetable_term_class
  ON "dbo"."Timetable_entry" (term_id, class_id, day);
CREATE INDEX IF NOT EXISTS idx_timetable_teacher_term_day
  ON "dbo"."Timetable_entry" (teacher_id, term_id, day);
