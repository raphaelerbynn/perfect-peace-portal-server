-- 009: a KG total is the average of the class and exam scores, so it can be a
-- half mark. The live MySQL stores it as text ("52.50", 1,905 rows on
-- 2026-11-08); INTEGER refused the move (and would have rounded the card).
-- NUMERIC(5,2) keeps every value exactly. Widening keeps the data; safe to re-run.
ALTER TABLE "dbo"."KG_assessment" ALTER COLUMN total_score TYPE NUMERIC(5,2);
