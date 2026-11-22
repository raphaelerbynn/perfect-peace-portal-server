-- 036 (B9): staff attendance.
--
-- Staff_attendance: one mark per member of staff per day. teacher_id is
-- Teacher.teacher_id (teaching and non-teaching staff both live there).
-- No row = unmarked (never treated as present). Marks are written by the office
-- (services/staffAttendance.js) for a date inside the active term only.
--   status   PRESENT | ABSENT | LATE | SICK | ON_LEAVE | PERMISSION
--   time_in  optional arrival time "HH:mm" (24-hour)
-- Attendance % = (present + late) / days marked.
-- This creates an empty table: no existing data changes. Safe to re-run.

CREATE TABLE IF NOT EXISTS "dbo"."Staff_attendance" (
  staff_attendance_id SERIAL PRIMARY KEY,
  teacher_id  INTEGER      NOT NULL,
  term_id     INTEGER      NOT NULL,
  date        DATE         NOT NULL,
  status      VARCHAR(12)  NOT NULL,
  time_in     VARCHAR(5),
  remarks     VARCHAR(300),
  marked_by   VARCHAR(100),
  created_at  TIMESTAMPTZ  NOT NULL,
  updated_at  TIMESTAMPTZ  NOT NULL
);

-- The data move (scripts/moveFromMysql) creates the table from the model
-- before migrations run, so the CREATE above is skipped there: defaults and
-- constraints are added by name here, whichever way the table came.
ALTER TABLE "dbo"."Staff_attendance" ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE "dbo"."Staff_attendance" ALTER COLUMN updated_at SET DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_attendance_status_chk') THEN
    ALTER TABLE "dbo"."Staff_attendance" ADD CONSTRAINT staff_attendance_status_chk
      CHECK (status IN ('PRESENT', 'ABSENT', 'LATE', 'SICK', 'ON_LEAVE', 'PERMISSION'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_attendance_time_in_chk') THEN
    ALTER TABLE "dbo"."Staff_attendance" ADD CONSTRAINT staff_attendance_time_in_chk
      CHECK (time_in IS NULL OR time_in ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Staff_attendance_teacher_id_fkey') THEN
    ALTER TABLE "dbo"."Staff_attendance" ADD CONSTRAINT "Staff_attendance_teacher_id_fkey"
      FOREIGN KEY (teacher_id) REFERENCES "dbo"."Teacher"(teacher_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Staff_attendance_term_id_fkey') THEN
    ALTER TABLE "dbo"."Staff_attendance" ADD CONSTRAINT "Staff_attendance_term_id_fkey"
      FOREIGN KEY (term_id) REFERENCES "dbo"."Term"(term_id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Same names as the model's indexes (the data move creates them from there).
CREATE UNIQUE INDEX IF NOT EXISTS staff_attendance_teacher_date_uq
  ON "dbo"."Staff_attendance" (teacher_id, date);
CREATE INDEX IF NOT EXISTS staff_attendance_term_idx
  ON "dbo"."Staff_attendance" (term_id);
CREATE INDEX IF NOT EXISTS staff_attendance_date_idx
  ON "dbo"."Staff_attendance" (date);
