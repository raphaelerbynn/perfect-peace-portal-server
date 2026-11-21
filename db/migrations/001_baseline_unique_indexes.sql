-- 001: unique indexes added during the 16-feature hardening (Features #6, #8, #9).
-- The app's upserts rely on these. Translated from the MySQL DDL in the cutover
-- notes. Run AFTER the data move: if old data has duplicates, index creation
-- fails. `npm run move-data` prints the duplicates to clean up first.

-- Feature #8 (Results): one mark per student/subject/class/term …
CREATE UNIQUE INDEX IF NOT EXISTS uniq_marks
  ON "dbo"."Student_marks" (student_id, subject_id, class, term_id);

-- … one result row per student/class/term …
CREATE UNIQUE INDEX IF NOT EXISTS uniq_result
  ON "dbo"."Student_result" (student_id, class, term_id);

-- … one KG rating per student/class/term/category/assessment.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_kg
  ON "dbo"."KG_assessment" (student_id, class, term_id, category, assessment);

-- Feature #9 (Attendance): one mark per student per day per term, one total per term.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_attendance
  ON "dbo"."Attendance" (student_id, date_marked, term_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_total_attendance
  ON "dbo"."Total_attendance" (student_id, term_id);

-- Feature #6 (Subjects): names are unique case-insensitively, archived ones
-- included (matches the service's duplicate check in services/subject.js).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_subject_name
  ON "dbo"."Subject" (lower(name));
