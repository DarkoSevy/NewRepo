-- Phase 2 business-rule enforcement: header/line sanity checks, document
-- immutability past DRAFT, append-only EBM evidence tables, RLS, and grants
-- for the restricted ledgercore_app role. Mirrors the Phase 1 pattern in
-- 20260710130100_business_rules / 20260710130200_app_role.

-- ── Sanity checks ────────────────────────────────────────────────────────────
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_qty_positive" CHECK ("qty" > 0);
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_amounts_nonneg" CHECK ("line_net_minor" >= 0 AND "line_vat_minor" >= 0 AND "line_total_minor" >= 0);

ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_qty_positive" CHECK ("qty" > 0);
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_amounts_nonneg" CHECK ("line_net_minor" >= 0 AND "line_vat_minor" >= 0 AND "line_total_minor" >= 0);

ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_qty_positive" CHECK ("qty" > 0);
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_amounts_nonneg" CHECK ("line_net_minor" >= 0 AND "line_vat_minor" >= 0 AND "line_total_minor" >= 0);

ALTER TABLE "invoices" ADD CONSTRAINT "invoices_amounts_consistent" CHECK ("subtotal_minor" >= 0 AND "vat_minor" >= 0 AND "total_minor" = "subtotal_minor" + "vat_minor");
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_amounts_consistent" CHECK ("subtotal_minor" >= 0 AND "vat_minor" >= 0 AND "total_minor" = "subtotal_minor" + "vat_minor");
ALTER TABLE "bills" ADD CONSTRAINT "bills_amounts_consistent" CHECK ("subtotal_minor" >= 0 AND "vat_minor" >= 0 AND "total_minor" = "subtotal_minor" + "vat_minor");

ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_positive" CHECK ("amount_minor" > 0);
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_amount_positive" CHECK ("amount_minor" > 0);
-- Exactly one of invoice_id / bill_id — an allocation always targets one AR or AP document, never both.
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_one_target" CHECK (("invoice_id" IS NOT NULL) <> ("bill_id" IS NOT NULL));

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_amounts_consistent" CHECK ("net_minor" >= 0 AND "vat_minor" >= 0 AND "amount_minor" = "net_minor" + "vat_minor");

-- ── Header totals must equal Σ line amounts (spec §4: zero tolerance) ───────
-- Deferred so lines can be inserted/updated freely while DRAFT; only checked
-- once the document leaves DRAFT (i.e. at issue/approve time), exactly like
-- the Phase 1 journal-entry balance trigger.
CREATE OR REPLACE FUNCTION ledgercore_check_invoice_totals() RETURNS trigger AS $$
DECLARE
  v_net BIGINT;
  v_vat BIGINT;
  v_total BIGINT;
BEGIN
  IF NEW.status <> 'DRAFT' THEN
    SELECT COALESCE(SUM(line_net_minor), 0), COALESCE(SUM(line_vat_minor), 0), COALESCE(SUM(line_total_minor), 0)
    INTO v_net, v_vat, v_total
    FROM invoice_lines WHERE invoice_id = NEW.id;
    IF v_net <> NEW.subtotal_minor OR v_vat <> NEW.vat_minor OR v_total <> NEW.total_minor THEN
      RAISE EXCEPTION 'Invoice % header totals (%,%,%) do not match line sums (%,%,%)',
        NEW.id, NEW.subtotal_minor, NEW.vat_minor, NEW.total_minor, v_net, v_vat, v_total
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "trg_invoices_totals"
  AFTER INSERT OR UPDATE ON "invoices"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledgercore_check_invoice_totals();

CREATE OR REPLACE FUNCTION ledgercore_check_credit_note_totals() RETURNS trigger AS $$
DECLARE
  v_net BIGINT;
  v_vat BIGINT;
  v_total BIGINT;
BEGIN
  IF NEW.status <> 'DRAFT' THEN
    SELECT COALESCE(SUM(line_net_minor), 0), COALESCE(SUM(line_vat_minor), 0), COALESCE(SUM(line_total_minor), 0)
    INTO v_net, v_vat, v_total
    FROM credit_note_lines WHERE credit_note_id = NEW.id;
    IF v_net <> NEW.subtotal_minor OR v_vat <> NEW.vat_minor OR v_total <> NEW.total_minor THEN
      RAISE EXCEPTION 'Credit note % header totals (%,%,%) do not match line sums (%,%,%)',
        NEW.id, NEW.subtotal_minor, NEW.vat_minor, NEW.total_minor, v_net, v_vat, v_total
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "trg_credit_notes_totals"
  AFTER INSERT OR UPDATE ON "credit_notes"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledgercore_check_credit_note_totals();

CREATE OR REPLACE FUNCTION ledgercore_check_bill_totals() RETURNS trigger AS $$
DECLARE
  v_net BIGINT;
  v_vat BIGINT;
  v_total BIGINT;
BEGIN
  IF NEW.status <> 'DRAFT' THEN
    SELECT COALESCE(SUM(line_net_minor), 0), COALESCE(SUM(line_vat_minor), 0), COALESCE(SUM(line_total_minor), 0)
    INTO v_net, v_vat, v_total
    FROM bill_lines WHERE bill_id = NEW.id;
    IF v_net <> NEW.subtotal_minor OR v_vat <> NEW.vat_minor OR v_total <> NEW.total_minor THEN
      RAISE EXCEPTION 'Bill % header totals (%,%,%) do not match line sums (%,%,%)',
        NEW.id, NEW.subtotal_minor, NEW.vat_minor, NEW.total_minor, v_net, v_vat, v_total
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "trg_bills_totals"
  AFTER INSERT OR UPDATE ON "bills"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledgercore_check_bill_totals();

-- ── Document immutability past DRAFT (spec: "No edits after DRAFT. ─────────
-- Corrections happen only via credit note + reissue") — the economic
-- content (amounts/contact/currency/kind) is frozen; status/date/reason
-- fields stay mutable because the lifecycle engine itself writes them.
CREATE OR REPLACE FUNCTION ledgercore_reject_invoice_economic_edit() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    IF NEW.contact_id <> OLD.contact_id
       OR NEW.kind <> OLD.kind
       OR NEW.currency <> OLD.currency
       OR NEW.subtotal_minor <> OLD.subtotal_minor
       OR NEW.vat_minor <> OLD.vat_minor
       OR NEW.total_minor <> OLD.total_minor
    THEN
      RAISE EXCEPTION 'Cannot edit economic content of invoice % once it has left DRAFT', OLD.id
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_invoices_immutable"
  BEFORE UPDATE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION ledgercore_reject_invoice_economic_edit();

CREATE OR REPLACE FUNCTION ledgercore_reject_invoice_line_edit() RETURNS trigger AS $$
DECLARE
  v_status "InvoiceStatus";
BEGIN
  SELECT status INTO v_status FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Cannot modify lines of invoice % (status %)', COALESCE(NEW.invoice_id, OLD.invoice_id), v_status
      USING ERRCODE = 'raise_exception';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_invoice_lines_immutable"
  BEFORE UPDATE OR DELETE ON "invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION ledgercore_reject_invoice_line_edit();

CREATE OR REPLACE FUNCTION ledgercore_reject_credit_note_economic_edit() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    IF NEW.contact_id <> OLD.contact_id
       OR NEW.currency <> OLD.currency
       OR NEW.subtotal_minor <> OLD.subtotal_minor
       OR NEW.vat_minor <> OLD.vat_minor
       OR NEW.total_minor <> OLD.total_minor
    THEN
      RAISE EXCEPTION 'Cannot edit economic content of credit note % once it has left DRAFT', OLD.id
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_credit_notes_immutable"
  BEFORE UPDATE ON "credit_notes"
  FOR EACH ROW EXECUTE FUNCTION ledgercore_reject_credit_note_economic_edit();

CREATE OR REPLACE FUNCTION ledgercore_reject_credit_note_line_edit() RETURNS trigger AS $$
DECLARE
  v_status "CreditNoteStatus";
BEGIN
  SELECT status INTO v_status FROM credit_notes WHERE id = COALESCE(NEW.credit_note_id, OLD.credit_note_id);
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Cannot modify lines of credit note % (status %)', COALESCE(NEW.credit_note_id, OLD.credit_note_id), v_status
      USING ERRCODE = 'raise_exception';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_credit_note_lines_immutable"
  BEFORE UPDATE OR DELETE ON "credit_note_lines"
  FOR EACH ROW EXECUTE FUNCTION ledgercore_reject_credit_note_line_edit();

CREATE OR REPLACE FUNCTION ledgercore_reject_bill_economic_edit() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'DRAFT' THEN
    IF NEW.contact_id <> OLD.contact_id
       OR NEW.currency <> OLD.currency
       OR NEW.subtotal_minor <> OLD.subtotal_minor
       OR NEW.vat_minor <> OLD.vat_minor
       OR NEW.total_minor <> OLD.total_minor
    THEN
      RAISE EXCEPTION 'Cannot edit economic content of bill % once it has left DRAFT', OLD.id
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_bills_immutable"
  BEFORE UPDATE ON "bills"
  FOR EACH ROW EXECUTE FUNCTION ledgercore_reject_bill_economic_edit();

CREATE OR REPLACE FUNCTION ledgercore_reject_bill_line_edit() RETURNS trigger AS $$
DECLARE
  v_status "BillStatus";
BEGIN
  SELECT status INTO v_status FROM bills WHERE id = COALESCE(NEW.bill_id, OLD.bill_id);
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Cannot modify lines of bill % (status %)', COALESCE(NEW.bill_id, OLD.bill_id), v_status
      USING ERRCODE = 'raise_exception';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_bill_lines_immutable"
  BEFORE UPDATE OR DELETE ON "bill_lines"
  FOR EACH ROW EXECUTE FUNCTION ledgercore_reject_bill_line_edit();

-- ── EBM evidence tables are append-only ──────────────────────────────────────
CREATE OR REPLACE FUNCTION ledgercore_reject_ebm_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_ebm_receipts_append_only"
  BEFORE UPDATE OR DELETE ON "ebm_receipts"
  FOR EACH ROW EXECUTE FUNCTION ledgercore_reject_ebm_mutation();

CREATE TRIGGER "trg_ebm_transactions_append_only"
  BEFORE UPDATE OR DELETE ON "ebm_transactions"
  FOR EACH ROW EXECUTE FUNCTION ledgercore_reject_ebm_mutation();

-- ── Row-Level Security ───────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'contacts', 'items', 'tax_rates', 'rra_codes', 'ebm_devices',
    'invoices', 'invoice_lines', 'credit_notes', 'credit_note_lines',
    'ebm_receipts', 'ebm_transactions',
    'bills', 'bill_lines', 'expenses', 'payments', 'payment_allocations',
    'document_no_sequences'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::text)',
      t
    );
  END LOOP;
END $$;

-- ── Grants for the restricted runtime role ───────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "contacts", "items", "tax_rates", "rra_codes", "ebm_devices",
  "invoices", "invoice_lines", "credit_notes", "credit_note_lines",
  "bills", "bill_lines", "expenses", "payments", "payment_allocations",
  "document_no_sequences"
TO ledgercore_app;

-- append-only evidence trail: no UPDATE/DELETE grant, backstopped by the trigger above
GRANT SELECT, INSERT ON "ebm_receipts", "ebm_transactions" TO ledgercore_app;
