-- 013 (A5a): the date the next term begins, printed on report cards
-- ("NEXT TERM BEGINS"). Optional; set per term in Term settings.
-- Safe to re-run.
ALTER TABLE "dbo"."Term" ADD COLUMN IF NOT EXISTS next_term_begins DATE;
