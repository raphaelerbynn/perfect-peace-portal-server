-- 042 (B14): invoices and credit notes.
--
--   Invoice       a numbered, printable copy of a pupil's bill for one term
--                 (B12 term billing): balance brought forward + the term's fee
--                 items - discounts = total. Its paid / credited / balance /
--                 status are recalculated whenever the pupil's balance is
--                 (services/fee.js recomputeStudentOwing -> invoiceLedger.js),
--                 so it never goes stale after a payment or a reversal. While
--                 its term is the pupil's current fee period its balance IS
--                 what they owe (bill changes since it was made show as
--                 "adjustment"); once the next period starts it is frozen at
--                 what was carried forward.
--                 An invoice does NOT change what a pupil owes: the bill is
--                 already on the balance from billing the term.
--   Invoice_line  the invoice's lines (ARREARS / ITEM / DISCOUNT), a snapshot.
--   Credit_note   takes money off what a pupil owes for the term on their
--                 current invoice. It counts in the fee-period formula:
--                   owing = opening + (bill - bill_at_start) - payments - credit notes
--                 (credit notes of the current period only: same student,
--                 term_id = fees_period_term_id and period_after_fee_id =
--                 fees_period_after_fee_id; when the next period starts the
--                 credit is already inside its opening balance). Voided, never
--                 deleted.
--
-- Numbers come from sequences (race-safe): INV-<year>-00001 when an invoice is
-- issued (drafts have none), CN-<year>-00001 when a credit note is made.
--
-- GO-LIVE: creates empty tables, so NOBODY'S BALANCE CHANGES. Safe to re-run.
-- Ships with 036 / 037 / 039 on feature/part-b (see README).

CREATE SEQUENCE IF NOT EXISTS "dbo".invoice_seq;
CREATE SEQUENCE IF NOT EXISTS "dbo".credit_note_seq;

-- "CN-2026-00001": at least 5 digits (lpad alone would cut 100000 down to
-- 10000 and repeat numbers). The year is the year the number is given.
CREATE OR REPLACE FUNCTION "dbo".pp_document_no(prefix TEXT, n BIGINT) RETURNS TEXT
  LANGUAGE sql VOLATILE AS
$fn$ SELECT prefix || '-' || to_char(NOW(), 'YYYY') || '-' || lpad(n::text, GREATEST(5, length(n::text)), '0') $fn$;

CREATE TABLE IF NOT EXISTS "dbo"."Invoice" (
  invoice_id SERIAL PRIMARY KEY,
  invoice_no      VARCHAR(30),
  student_id      INTEGER NOT NULL,
  term_id         INTEGER NOT NULL,
  class_id        INTEGER,
  status          VARCHAR(20) NOT NULL,
  after_fee_id    INTEGER NOT NULL,           -- the fee period it belongs to (payments after this fee_id)
  arrears         NUMERIC(18,2) NOT NULL,     -- brought forward; below 0 = credit
  subtotal        NUMERIC(18,2) NOT NULL,     -- the term's items before discounts
  discount        NUMERIC(18,2) NOT NULL,
  total           NUMERIC(18,2) NOT NULL,     -- arrears + subtotal - discount
  amount_paid     NUMERIC(18,2) NOT NULL,
  amount_credited NUMERIC(18,2) NOT NULL,
  adjustment      NUMERIC(18,2) NOT NULL,     -- bill changes after the invoice was made (fee edit, earlier payment reversed…)
  balance         NUMERIC(18,2) NOT NULL,     -- total + adjustment - paid - credited; below 0 = credit
  due_date        DATE,
  notes           VARCHAR(500),
  created_by      VARCHAR(100),
  created_at      TIMESTAMPTZ NOT NULL,
  refreshed_at    TIMESTAMPTZ,
  issued_by       VARCHAR(100),
  issued_at       TIMESTAMPTZ,
  voided_by       VARCHAR(100),
  voided_at       TIMESTAMPTZ,
  void_reason     VARCHAR(500)
);

ALTER TABLE "dbo"."Invoice"
  ALTER COLUMN status SET DEFAULT 'DRAFT',
  ALTER COLUMN after_fee_id SET DEFAULT 0,
  ALTER COLUMN arrears SET DEFAULT 0,
  ALTER COLUMN subtotal SET DEFAULT 0,
  ALTER COLUMN discount SET DEFAULT 0,
  ALTER COLUMN total SET DEFAULT 0,
  ALTER COLUMN amount_paid SET DEFAULT 0,
  ALTER COLUMN amount_credited SET DEFAULT 0,
  ALTER COLUMN adjustment SET DEFAULT 0,
  ALTER COLUMN balance SET DEFAULT 0,
  ALTER COLUMN created_at SET DEFAULT NOW();

CREATE TABLE IF NOT EXISTS "dbo"."Invoice_line" (
  invoice_line_id SERIAL PRIMARY KEY,
  invoice_id  INTEGER NOT NULL,
  position    INTEGER NOT NULL,
  kind        VARCHAR(10) NOT NULL,           -- ARREARS | ITEM | DISCOUNT
  description VARCHAR(200) NOT NULL,
  amount      NUMERIC(18,2) NOT NULL          -- DISCOUNT lines are below 0
);

CREATE TABLE IF NOT EXISTS "dbo"."Credit_note" (
  credit_note_id SERIAL PRIMARY KEY,
  credit_note_no      VARCHAR(30),
  invoice_id          INTEGER NOT NULL,
  student_id          INTEGER NOT NULL,
  term_id             INTEGER NOT NULL,
  period_after_fee_id INTEGER NOT NULL,       -- the fee period it counts in
  amount              NUMERIC(18,2) NOT NULL,
  reason              VARCHAR(500) NOT NULL,
  created_by          VARCHAR(100),
  created_at          TIMESTAMPTZ NOT NULL,
  voided_by           VARCHAR(100),
  voided_at           TIMESTAMPTZ,
  void_reason         VARCHAR(500),
  request_id          VARCHAR(64)             -- the screen's key: the same request sent twice makes one note
);

ALTER TABLE "dbo"."Credit_note"
  ALTER COLUMN credit_note_no SET DEFAULT "dbo".pp_document_no('CN', nextval('"dbo".credit_note_seq')),
  ALTER COLUMN created_at SET DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_status_chk') THEN
    ALTER TABLE "dbo"."Invoice" ADD CONSTRAINT invoice_status_chk
      CHECK (status IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'CARRIED_FORWARD', 'VOID'));
  END IF;
  -- Anything issued has a number (a draft voided before issue has none).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_issued_number_chk') THEN
    ALTER TABLE "dbo"."Invoice" ADD CONSTRAINT invoice_issued_number_chk
      CHECK (status IN ('DRAFT', 'VOID') OR invoice_no IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_void_reason_chk') THEN
    ALTER TABLE "dbo"."Invoice" ADD CONSTRAINT invoice_void_reason_chk
      CHECK (status <> 'VOID' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Invoice_student_id_fkey') THEN
    ALTER TABLE "dbo"."Invoice" ADD CONSTRAINT "Invoice_student_id_fkey"
      FOREIGN KEY (student_id) REFERENCES "dbo"."Student"(student_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Invoice_term_id_fkey') THEN
    ALTER TABLE "dbo"."Invoice" ADD CONSTRAINT "Invoice_term_id_fkey"
      FOREIGN KEY (term_id) REFERENCES "dbo"."Term"(term_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Invoice_line_invoice_id_fkey') THEN
    ALTER TABLE "dbo"."Invoice_line" ADD CONSTRAINT "Invoice_line_invoice_id_fkey"
      FOREIGN KEY (invoice_id) REFERENCES "dbo"."Invoice"(invoice_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_line_kind_chk') THEN
    ALTER TABLE "dbo"."Invoice_line" ADD CONSTRAINT invoice_line_kind_chk CHECK (kind IN ('ARREARS', 'ITEM', 'DISCOUNT'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Credit_note_invoice_id_fkey') THEN
    ALTER TABLE "dbo"."Credit_note" ADD CONSTRAINT "Credit_note_invoice_id_fkey"
      FOREIGN KEY (invoice_id) REFERENCES "dbo"."Invoice"(invoice_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Credit_note_student_id_fkey') THEN
    ALTER TABLE "dbo"."Credit_note" ADD CONSTRAINT "Credit_note_student_id_fkey"
      FOREIGN KEY (student_id) REFERENCES "dbo"."Student"(student_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_note_amount_chk') THEN
    ALTER TABLE "dbo"."Credit_note" ADD CONSTRAINT credit_note_amount_chk CHECK (amount > 0);
  END IF;
END $$;

ALTER TABLE "dbo"."Credit_note" ALTER COLUMN credit_note_no SET NOT NULL;

-- One live (not void) invoice per pupil per term; numbers unique.
CREATE UNIQUE INDEX IF NOT EXISTS invoice_one_live_uq ON "dbo"."Invoice" (student_id, term_id) WHERE status <> 'VOID';
CREATE UNIQUE INDEX IF NOT EXISTS invoice_no_uq ON "dbo"."Invoice" (invoice_no);
CREATE INDEX IF NOT EXISTS invoice_term_class_idx ON "dbo"."Invoice" (term_id, class_id);
CREATE INDEX IF NOT EXISTS invoice_student_idx ON "dbo"."Invoice" (student_id);
CREATE INDEX IF NOT EXISTS invoice_line_invoice_idx ON "dbo"."Invoice_line" (invoice_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS credit_note_no_uq ON "dbo"."Credit_note" (credit_note_no);
CREATE UNIQUE INDEX IF NOT EXISTS credit_note_request_uq ON "dbo"."Credit_note" (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS credit_note_invoice_idx ON "dbo"."Credit_note" (invoice_id);
CREATE INDEX IF NOT EXISTS credit_note_period_idx ON "dbo"."Credit_note" (student_id, term_id) WHERE voided_at IS NULL;
