-- 002 (B13): official receipt numbers + safe payment reversal for "dbo"."Fee".
--
-- Receipt numbers look like PPS-2026-000123. The number part comes from a
-- Postgres sequence, so two cashiers recording at the same moment can never get
-- the same number (a COUNT(*)+1 scheme can). The year is the year the receipt
-- was issued. Numbers are never reused: a reversed payment keeps its number.
--
-- Reversal replaces hard delete: the row stays, marked reversed_at/by/reason,
-- and is excluded from balances, totals, charts and profit/loss by the app.

ALTER TABLE "dbo"."Fee"
  ADD COLUMN IF NOT EXISTS receipt_no      VARCHAR(30),
  ADD COLUMN IF NOT EXISTS recorded_by     VARCHAR(100),
  ADD COLUMN IF NOT EXISTS recorded_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_by     VARCHAR(100),
  ADD COLUMN IF NOT EXISTS reversal_reason VARCHAR(500);

CREATE SEQUENCE IF NOT EXISTS "dbo".receipt_seq;

-- Number historical payments in the order they were paid (year = year paid).
WITH ordered AS (
  SELECT fee_id, date_paid,
         ROW_NUMBER() OVER (ORDER BY date_paid NULLS FIRST, fee_id) AS rn
    FROM "dbo"."Fee"
   WHERE receipt_no IS NULL
)
UPDATE "dbo"."Fee" f
   SET receipt_no = 'PPS-' || COALESCE(to_char(o.date_paid, 'YYYY'), '0000') || '-' || lpad(o.rn::text, 6, '0')
  FROM ordered o
 WHERE f.fee_id = o.fee_id;

-- Continue the sequence after the highest number handed out.
SELECT setval(
  '"dbo".receipt_seq',
  GREATEST(COALESCE((SELECT MAX(split_part(receipt_no, '-', 3)::bigint) FROM "dbo"."Fee"), 0), 1),
  EXISTS (SELECT 1 FROM "dbo"."Fee")
);

-- New payments get a number automatically.
ALTER TABLE "dbo"."Fee"
  ALTER COLUMN receipt_no SET DEFAULT ('PPS-' || to_char(NOW(), 'YYYY') || '-' || lpad(nextval('"dbo".receipt_seq')::text, 6, '0')),
  ALTER COLUMN receipt_no SET NOT NULL,
  ALTER COLUMN recorded_at SET DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS uniq_fee_receipt_no ON "dbo"."Fee" (receipt_no);

-- Balances only ever sum live (not reversed) payments per student.
CREATE INDEX IF NOT EXISTS idx_fee_student_live ON "dbo"."Fee" (student_id) WHERE reversed_at IS NULL;
