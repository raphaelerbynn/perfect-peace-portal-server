-- 006: database checks that 003-005 meant to add.
--
-- move-data creates the tables from the models BEFORE migrations run, so the
-- CREATE TABLE IF NOT EXISTS in 003-005 did nothing there and their CHECKs,
-- some foreign keys and NOW() defaults never existed. The app validates all of
-- this too; these make the database refuse bad rows as well. Each step only
-- adds what is missing, so this is safe on both kinds of schema and re-runs.

ALTER TABLE "dbo"."Teaching_assignment" ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE "dbo"."Timetable_entry"     ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE "dbo"."Promotion_rule"      ALTER COLUMN updated_at SET DEFAULT NOW();
ALTER TABLE "dbo"."Student_promotion"   ALTER COLUMN decided_at SET DEFAULT NOW();

DO $$
DECLARE
  c RECORD;
BEGIN
  -- (table, constraint name, type c=CHECK / f=FOREIGN KEY, column it guards, definition)
  FOR c IN
    SELECT * FROM (VALUES
      ('Timetable_entry',   'chk_timetable_day',             'c', 'day',           'CHECK (day BETWEEN 1 AND 7)'),
      ('Timetable_period',  'chk_period_times',              'c', 'start_time',    'CHECK (start_time < end_time)'),
      ('Promotion_rule',    'chk_promotion_pass_mark',       'c', 'pass_mark',     'CHECK (pass_mark >= 0 AND pass_mark <= 100)'),
      ('Student_promotion', 'chk_student_promotion_outcome', 'c', 'outcome',       $c$CHECK (outcome IN ('PROMOTED', 'REPEATED', 'GRADUATED'))$c$),
      ('Class',             'fk_class_next_class',           'f', 'next_class_id', 'FOREIGN KEY (next_class_id) REFERENCES "dbo"."Class"(class_id)'),
      ('Promotion_rule',    'fk_promotion_rule_class',       'f', 'class_id',      'FOREIGN KEY (class_id) REFERENCES "dbo"."Class"(class_id)'),
      ('Student_promotion', 'fk_student_promotion_student',  'f', 'student_id',    'FOREIGN KEY (student_id) REFERENCES "dbo"."Student"(student_id)')
    ) AS t(tbl, name, kind, col, def)
  LOOP
    -- Skip when the table already has a constraint of that kind on that column
    -- (004/005 create unnamed CHECKs and default-named foreign keys).
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint pc
      JOIN pg_class rc ON rc.oid = pc.conrelid
      JOIN pg_namespace n ON n.oid = rc.relnamespace
      JOIN pg_attribute a ON a.attrelid = rc.oid AND a.attnum = ANY (pc.conkey)
      WHERE n.nspname = 'dbo' AND rc.relname = c.tbl AND pc.contype = c.kind::"char" AND a.attname = c.col
    ) THEN
      EXECUTE format('ALTER TABLE "dbo".%I ADD CONSTRAINT %I %s', c.tbl, c.name, c.def);
    END IF;
  END LOOP;
END $$;
