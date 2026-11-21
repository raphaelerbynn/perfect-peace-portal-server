-- 003 (B2): teacher tools.
--
-- Teaching_assignment: which teacher teaches which subject in which class, per
-- term. One teacher per (class, subject, term). The class teacher
-- (Class.teacher_id) needs no rows: they may score every subject in their
-- class that nobody else is assigned (the primary-school case).
--
-- entered_by / entered_by_teacher_id on marks and attendance: who typed it
-- (office username, or the teacher when entered from the portal). Nullable;
-- old rows stay NULL ("unknown").

CREATE TABLE IF NOT EXISTS "dbo"."Teaching_assignment" (
  teaching_assignment_id SERIAL PRIMARY KEY,
  teacher_id  INTEGER NOT NULL REFERENCES "dbo"."Teacher"(teacher_id),
  class_id    INTEGER NOT NULL REFERENCES "dbo"."Class"(class_id),
  subject_id  INTEGER NOT NULL REFERENCES "dbo"."Subject"(subject_id),
  term_id     INTEGER NOT NULL REFERENCES "dbo"."Term"(term_id),
  created_by  VARCHAR(100),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_teaching_assignment
  ON "dbo"."Teaching_assignment" (class_id, subject_id, term_id);
CREATE INDEX IF NOT EXISTS idx_teaching_assignment_teacher
  ON "dbo"."Teaching_assignment" (teacher_id, term_id);

ALTER TABLE "dbo"."Student_marks"
  ADD COLUMN IF NOT EXISTS entered_by            VARCHAR(100),
  ADD COLUMN IF NOT EXISTS entered_by_teacher_id INTEGER;

ALTER TABLE "dbo"."Attendance"
  ADD COLUMN IF NOT EXISTS entered_by            VARCHAR(100),
  ADD COLUMN IF NOT EXISTS entered_by_teacher_id INTEGER;
