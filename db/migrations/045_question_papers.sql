-- 045 (AI-3): question papers. Two new tables, nothing existing is changed:
--   Question_paper  one paper a teacher is writing for one class + subject in
--                   one term. spec = { topics, note, durationMinutes,
--                   instructions, sections: [{ title, type, count, marksEach,
--                   difficulty, answerAny, accepted }] } (shape owned by
--                   services/papers.js). status DRAFT (editable) or FINAL
--                   (read-only until its teacher reopens it).
--   Question        the questions on a paper, by section (1-based, matching
--                   spec.sections) and position (1-based within the section).
--                   options / answer / marking_scheme are JSON:
--                     options        MCQ: [{ key: "A".."D", text }], else NULL
--                     answer         { key } (MCQ, true/false), { accepted: [..] }
--                                    (fill in, short answer), NULL (essay, structured)
--                     marking_scheme [{ point, marks }] (adds up to marks)
--                   origin: AI (as the model wrote it), AI_EDITED (the teacher
--                   changed it), TEACHER (written by hand).
--                   checker_disagrees: the second, blind AI pass gave a
--                   different answer from the key (checker_answer).
--
-- AI drafts of a section live in Ai_suggestion (043) until the teacher accepts
-- the section; only then do they become Question rows.
--
-- move-data creates every table from the models before migrations run, so the
-- CREATE TABLEs below may be skipped there: defaults, checks, keys and indexes
-- are added by name either way. Safe to re-run.

-- ---------------------------------------------------------------- Question_paper
CREATE TABLE IF NOT EXISTS "dbo"."Question_paper" (
  paper_id      SERIAL PRIMARY KEY,
  teacher_id    INTEGER      NOT NULL,
  subject_id    INTEGER      NOT NULL,
  class_id      INTEGER      NOT NULL,
  term_id       INTEGER      NOT NULL,
  title         VARCHAR(150) NOT NULL,
  spec          JSONB        NOT NULL,
  status        VARCHAR(10)  NOT NULL,
  finalised_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL,
  updated_at    TIMESTAMPTZ  NOT NULL
);
ALTER TABLE "dbo"."Question_paper" ALTER COLUMN spec SET DEFAULT '{}'::jsonb;
ALTER TABLE "dbo"."Question_paper" ALTER COLUMN status SET DEFAULT 'DRAFT';
ALTER TABLE "dbo"."Question_paper" ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE "dbo"."Question_paper" ALTER COLUMN updated_at SET DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'question_paper_status_check') THEN
    ALTER TABLE "dbo"."Question_paper"
      ADD CONSTRAINT question_paper_status_check CHECK (status IN ('DRAFT', 'FINAL'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'question_paper_title_check') THEN
    ALTER TABLE "dbo"."Question_paper"
      ADD CONSTRAINT question_paper_title_check CHECK (length(btrim(title)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'question_paper_teacher_fk') THEN
    ALTER TABLE "dbo"."Question_paper"
      ADD CONSTRAINT question_paper_teacher_fk FOREIGN KEY (teacher_id) REFERENCES "dbo"."Teacher"(teacher_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'question_paper_subject_fk') THEN
    ALTER TABLE "dbo"."Question_paper"
      ADD CONSTRAINT question_paper_subject_fk FOREIGN KEY (subject_id) REFERENCES "dbo"."Subject"(subject_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'question_paper_class_fk') THEN
    ALTER TABLE "dbo"."Question_paper"
      ADD CONSTRAINT question_paper_class_fk FOREIGN KEY (class_id) REFERENCES "dbo"."Class"(class_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'question_paper_term_fk') THEN
    ALTER TABLE "dbo"."Question_paper"
      ADD CONSTRAINT question_paper_term_fk FOREIGN KEY (term_id) REFERENCES "dbo"."Term"(term_id);
  END IF;
END $$;

-- A teacher's own list (newest first) and the head teacher's list by term / class.
CREATE INDEX IF NOT EXISTS idx_question_paper_teacher ON "dbo"."Question_paper" (teacher_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_question_paper_term_class ON "dbo"."Question_paper" (term_id, class_id, subject_id);

-- ---------------------------------------------------------------- Question
CREATE TABLE IF NOT EXISTS "dbo"."Question" (
  question_id        SERIAL PRIMARY KEY,
  paper_id           INTEGER       NOT NULL,
  section            SMALLINT      NOT NULL,
  position           SMALLINT      NOT NULL,
  type               VARCHAR(15)   NOT NULL,
  stem               TEXT          NOT NULL,
  options            JSONB,
  answer             JSONB,
  marking_scheme     JSONB         NOT NULL,
  explanation        TEXT,
  marks              NUMERIC(6,2)  NOT NULL,
  difficulty         VARCHAR(10),
  origin             VARCHAR(10)   NOT NULL,
  checker_disagrees  BOOLEAN       NOT NULL,
  checker_answer     VARCHAR(200),
  prompt_version     VARCHAR(60),
  created_at         TIMESTAMPTZ   NOT NULL,
  updated_at         TIMESTAMPTZ   NOT NULL
);
ALTER TABLE "dbo"."Question" ALTER COLUMN marking_scheme SET DEFAULT '[]'::jsonb;
ALTER TABLE "dbo"."Question" ALTER COLUMN origin SET DEFAULT 'TEACHER';
ALTER TABLE "dbo"."Question" ALTER COLUMN checker_disagrees SET DEFAULT FALSE;
ALTER TABLE "dbo"."Question" ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE "dbo"."Question" ALTER COLUMN updated_at SET DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'question_paper_fk') THEN
    ALTER TABLE "dbo"."Question"
      ADD CONSTRAINT question_paper_fk FOREIGN KEY (paper_id)
      REFERENCES "dbo"."Question_paper"(paper_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'question_type_check') THEN
    ALTER TABLE "dbo"."Question"
      ADD CONSTRAINT question_type_check CHECK (
        type IN ('MCQ', 'TRUE_FALSE', 'FILL_IN', 'SHORT_ANSWER', 'ESSAY', 'STRUCTURED')
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'question_origin_check') THEN
    ALTER TABLE "dbo"."Question"
      ADD CONSTRAINT question_origin_check CHECK (origin IN ('AI', 'AI_EDITED', 'TEACHER'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'question_difficulty_check') THEN
    ALTER TABLE "dbo"."Question"
      ADD CONSTRAINT question_difficulty_check CHECK (difficulty IS NULL OR difficulty IN ('EASY', 'MEDIUM', 'HARD'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'question_stem_check') THEN
    ALTER TABLE "dbo"."Question"
      ADD CONSTRAINT question_stem_check CHECK (length(btrim(stem)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'question_marks_check') THEN
    ALTER TABLE "dbo"."Question"
      ADD CONSTRAINT question_marks_check CHECK (marks > 0 AND marks <= 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'question_place_check') THEN
    ALTER TABLE "dbo"."Question"
      ADD CONSTRAINT question_place_check CHECK (section >= 1 AND position >= 1);
  END IF;
  -- One question per place. Deferred, so a reorder can swap positions inside
  -- one transaction and is checked at commit.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'question_place_unique') THEN
    ALTER TABLE "dbo"."Question"
      ADD CONSTRAINT question_place_unique UNIQUE (paper_id, section, position) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
