-- LedgerCore business-rule enforcement.
-- Hand-written (not Prisma-generated): constraints, triggers, RLS, reporting view.

-- ── Money sanity ────────────────────────────────────────────────────────────
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_amount_positive" CHECK ("amount_minor" > 0);

-- ── Non-overlapping, contiguous accounting periods ──────────────────────────
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "accounting_periods"
  ADD CONSTRAINT "accounting_periods_no_overlap"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    daterange("start_date", "end_date", '[]') WITH &&
  );

ALTER TABLE "accounting_periods"
  ADD CONSTRAINT "accounting_periods_valid_range" CHECK ("start_date" <= "end_date");

-- ── Invariant #1: balanced entries, enforced at the DB layer ────────────────
-- Deferred so line inserts/entry updates within one posting transaction are
-- only checked once, at COMMIT, after every row is in place.
CREATE OR REPLACE FUNCTION ledgercore_check_entry_balance() RETURNS trigger AS $$
DECLARE
  v_debit  BIGINT;
  v_credit BIGINT;
BEGIN
  IF NEW.status = 'POSTED' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'POSTED') THEN
    SELECT
      COALESCE(SUM("amount_minor") FILTER (WHERE "direction" = 'DEBIT'), 0),
      COALESCE(SUM("amount_minor") FILTER (WHERE "direction" = 'CREDIT'), 0)
    INTO v_debit, v_credit
    FROM "journal_lines"
    WHERE "entry_id" = NEW.id;

    IF v_debit <> v_credit THEN
      RAISE EXCEPTION 'Unbalanced journal entry %: debits % <> credits %', NEW.id, v_debit, v_credit
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_debit = 0 THEN
      RAISE EXCEPTION 'Journal entry % has no lines', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "trg_journal_entries_balance_on_post"
  AFTER INSERT OR UPDATE ON "journal_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledgercore_check_entry_balance();

-- ── Invariant #2: immutability of POSTED/REVERSED entries ───────────────────
-- The only mutation ever allowed on a POSTED row is the POSTED -> REVERSED
-- status flip performed by reverse(); everything else, and any mutation of a
-- REVERSED row, is rejected outright. DELETE is never allowed once posted.
CREATE OR REPLACE FUNCTION ledgercore_reject_posted_entry_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('POSTED', 'REVERSED') THEN
      RAISE EXCEPTION 'Cannot delete % journal entry %', OLD.status, OLD.id
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'POSTED' THEN
    IF NEW.status = 'REVERSED'
       AND NEW.id = OLD.id
       AND NEW.tenant_id = OLD.tenant_id
       AND NEW.entry_no IS NOT DISTINCT FROM OLD.entry_no
       AND NEW.entry_date = OLD.entry_date
       AND NEW.memo IS NOT DISTINCT FROM OLD.memo
       AND NEW.source = OLD.source
       AND NEW.source_document_ref IS NOT DISTINCT FROM OLD.source_document_ref
       AND NEW.reversal_of_id IS NOT DISTINCT FROM OLD.reversal_of_id
       AND NEW.posted_at = OLD.posted_at
       AND NEW.posted_by IS NOT DISTINCT FROM OLD.posted_by
       AND NEW.created_at = OLD.created_at
       AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Cannot modify POSTED journal entry % except to mark it REVERSED', OLD.id
      USING ERRCODE = 'raise_exception';
  ELSIF OLD.status = 'REVERSED' THEN
    RAISE EXCEPTION 'Cannot modify REVERSED journal entry %', OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_journal_entries_immutable"
  BEFORE UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION ledgercore_reject_posted_entry_mutation();

CREATE OR REPLACE FUNCTION ledgercore_reject_posted_line_mutation() RETURNS trigger AS $$
DECLARE
  v_status "EntryStatus";
BEGIN
  SELECT "status" INTO v_status FROM "journal_entries" WHERE "id" = COALESCE(NEW.entry_id, OLD.entry_id);
  IF v_status IN ('POSTED', 'REVERSED') THEN
    RAISE EXCEPTION 'Cannot modify lines of % journal entry %', v_status, COALESCE(NEW.entry_id, OLD.entry_id)
      USING ERRCODE = 'raise_exception';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_journal_lines_immutable"
  BEFORE UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION ledgercore_reject_posted_line_mutation();

-- ── Invariant #7: audit_log is append-only ───────────────────────────────────
CREATE OR REPLACE FUNCTION ledgercore_reject_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_audit_log_append_only"
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION ledgercore_reject_audit_mutation();

-- ── Reporting seam (§7): reports read through this view so a future
-- materialized snapshot layer can swap in without touching report queries.
CREATE VIEW "posted_lines" AS
  SELECT
    l."id",
    l."tenant_id",
    l."entry_id",
    l."account_id",
    l."direction",
    l."amount_minor",
    l."currency",
    l."memo",
    e."entry_no",
    e."entry_date",
    e."status" AS "entry_status"
  FROM "journal_lines" l
  JOIN "journal_entries" e ON e."id" = l."entry_id"
  WHERE e."status" IN ('POSTED', 'REVERSED');

-- ── Invariant #6: tenant isolation via Row-Level Security ───────────────────
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "accounts"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::text);

ALTER TABLE "accounting_periods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "accounting_periods" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "accounting_periods"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::text);

ALTER TABLE "journal_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "journal_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "journal_entries"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::text);

ALTER TABLE "journal_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "journal_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "journal_lines"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::text);

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "users"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::text);

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "audit_log"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::text);

ALTER TABLE "entry_no_sequences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "entry_no_sequences" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "entry_no_sequences"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::text);
