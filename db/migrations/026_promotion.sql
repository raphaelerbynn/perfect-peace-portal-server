-- 005 (B5): smarter promotion.
--
-- Class.next_class_id: where a class's pupils go when they pass (NULL = not
--   set yet). Class.is_alumni: a "graduated" holding class (replaces the
--   hard-coded class ids 39/40). A class whose next class is an alumni class
--   graduates its pupils.
-- Promotion_rule: the pass mark (overall average %). class_id NULL = the
--   school default; a class rule beats it.
-- Student_promotion: one decision per pupil per term (the history / audit
--   trail). Accepting again updates the row instead of moving twice.

ALTER TABLE "dbo"."Class"
  ADD COLUMN IF NOT EXISTS next_class_id INTEGER REFERENCES "dbo"."Class"(class_id),
  ADD COLUMN IF NOT EXISTS is_alumni BOOLEAN NOT NULL DEFAULT FALSE;

-- The two classes the code treated as graduated (config/school.js).
UPDATE "dbo"."Class" SET is_alumni = TRUE WHERE class_id IN (39, 40);

CREATE TABLE IF NOT EXISTS "dbo"."Promotion_rule" (
  promotion_rule_id SERIAL PRIMARY KEY,
  class_id   INTEGER REFERENCES "dbo"."Class"(class_id),
  pass_mark  NUMERIC(5,2) NOT NULL CHECK (pass_mark >= 0 AND pass_mark <= 100),
  updated_by VARCHAR(100),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_promotion_rule_class
  ON "dbo"."Promotion_rule" ((COALESCE(class_id, 0)));

CREATE TABLE IF NOT EXISTS "dbo"."Student_promotion" (
  student_promotion_id SERIAL PRIMARY KEY,
  student_id      INTEGER NOT NULL REFERENCES "dbo"."Student"(student_id),
  term_id         INTEGER NOT NULL REFERENCES "dbo"."Term"(term_id),
  outcome         VARCHAR(10) NOT NULL CHECK (outcome IN ('PROMOTED', 'REPEATED', 'GRADUATED')),
  average         NUMERIC(5,2),
  pass_mark       NUMERIC(5,2),
  from_class_id   INTEGER,
  from_class_name VARCHAR(50),
  to_class_id     INTEGER,
  to_class_name   VARCHAR(50),
  teacher_recommendation VARCHAR(50),
  overridden      BOOLEAN NOT NULL DEFAULT FALSE,
  reason          VARCHAR(300),
  decided_by      VARCHAR(100),
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_student_promotion
  ON "dbo"."Student_promotion" (student_id, term_id);
CREATE INDEX IF NOT EXISTS idx_student_promotion_from
  ON "dbo"."Student_promotion" (term_id, from_class_id);
