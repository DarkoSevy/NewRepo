-- Phase 3 business-rule enforcement: hash-dedupe uniqueness (already via
-- Prisma @@unique), match-leg exclusivity, statement-line/match immutability
-- and lockdown, append-only momo_events, stock-movement immutability with a
-- single allowed ebm_reported_at transition, trigram support for T2
-- matching, RLS, and grants for the restricted runtime role.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Sanity checks ────────────────────────────────────────────────────────────
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_amount_positive" CHECK ("amount_minor" > 0);
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_qty_delta_nonzero" CHECK ("qty_delta" <> 0);

-- Every match leg targets exactly one side — a statement line or a ledger
-- line, never both and never neither.
ALTER TABLE "match_legs" ADD CONSTRAINT "match_legs_one_target" CHECK (("statement_line_id" IS NOT NULL) <> ("journal_line_id" IS NOT NULL));

-- ── Statement lines are immutable except status/exclude_reason, and freeze
-- entirely once locked by a completed reconciliation session — except for
-- the single legitimate unlock transition (locked_at -> NULL, nothing else
-- touched) that ReconciliationSessionsService.reopen() performs. Without
-- this carve-out the trigger would also block its own unlock update, since
-- OLD.locked_at IS NOT NULL is exactly the condition reopen() runs under.
CREATE OR REPLACE FUNCTION ledgercore_reject_statement_line_edit() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'statement_lines are immutable (no deletes)'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.line_date <> OLD.line_date
     OR NEW.description <> OLD.description
     OR NEW.external_ref IS DISTINCT FROM OLD.external_ref
     OR NEW.amount_minor <> OLD.amount_minor
     OR NEW.direction <> OLD.direction
     OR NEW.running_balance_minor IS DISTINCT FROM OLD.running_balance_minor
     OR NEW.line_hash <> OLD.line_hash
     OR NEW.import_id <> OLD.import_id
     OR NEW.financial_account_id <> OLD.financial_account_id
  THEN
    RAISE EXCEPTION 'Cannot edit statement_line % core fields — only status/exclude_reason/locked_at may change', OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;

  IF OLD.locked_at IS NOT NULL THEN
    IF NEW.locked_at IS NOT NULL OR NEW.status <> OLD.status OR NEW.exclude_reason IS DISTINCT FROM OLD.exclude_reason THEN
      RAISE EXCEPTION 'statement_line % is locked by a completed reconciliation session', OLD.id
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_statement_lines_immutable"
  BEFORE UPDATE OR DELETE ON "statement_lines"
  FOR EACH ROW EXECUTE FUNCTION ledgercore_reject_statement_line_edit();

-- ── Matches: only PROPOSED, unlocked matches may be deleted; nothing may
-- change once locked, except the same unlock-on-reopen carve-out as above ──
CREATE OR REPLACE FUNCTION ledgercore_reject_match_edit() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.locked_at IS NOT NULL THEN
      RAISE EXCEPTION 'Match % is locked by a completed reconciliation session', OLD.id
        USING ERRCODE = 'raise_exception';
    END IF;
    IF OLD.status <> 'PROPOSED' THEN
      RAISE EXCEPTION 'Cannot delete a % match — only PROPOSED matches may be deleted', OLD.status
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.locked_at IS NOT NULL THEN
    IF NEW.locked_at IS NOT NULL
       OR NEW.status <> OLD.status
       OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
    THEN
      RAISE EXCEPTION 'Match % is locked by a completed reconciliation session', OLD.id
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_matches_immutable"
  BEFORE UPDATE OR DELETE ON "matches"
  FOR EACH ROW EXECUTE FUNCTION ledgercore_reject_match_edit();

-- match_legs are set once at match creation and never edited directly;
-- they're removed only via ON DELETE CASCADE when their (unlocked, PROPOSED)
-- parent match is deleted, which trg_matches_immutable already gates.
CREATE OR REPLACE FUNCTION ledgercore_reject_match_leg_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'match_legs cannot be edited once created'
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_match_legs_immutable"
  BEFORE UPDATE ON "match_legs"
  FOR EACH ROW EXECUTE FUNCTION ledgercore_reject_match_leg_update();

-- ── momo_events is an append-only webhook log ────────────────────────────────
CREATE OR REPLACE FUNCTION ledgercore_reject_momo_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'momo_events is append-only'
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_momo_events_append_only"
  BEFORE UPDATE OR DELETE ON "momo_events"
  FOR EACH ROW EXECUTE FUNCTION ledgercore_reject_momo_event_mutation();

-- ── stock_movements are immutable except a single one-way ebm_reported_at
-- transition (nightly EBM stock reporter) ───────────────────────────────────
CREATE OR REPLACE FUNCTION ledgercore_reject_stock_movement_edit() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stock_movements are immutable (no deletes) — record a counter-movement instead'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.item_id <> OLD.item_id
     OR NEW.movement_type <> OLD.movement_type
     OR NEW.qty_delta <> OLD.qty_delta
     OR NEW.unit_cost_minor <> OLD.unit_cost_minor
     OR NEW.source_document_ref IS DISTINCT FROM OLD.source_document_ref
  THEN
    RAISE EXCEPTION 'Cannot edit stock_movement % core fields — only ebm_reported_at may be set once', OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;

  IF OLD.ebm_reported_at IS NOT NULL AND NEW.ebm_reported_at IS DISTINCT FROM OLD.ebm_reported_at THEN
    RAISE EXCEPTION 'stock_movement % ebm_reported_at is already set and cannot change', OLD.id
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trg_stock_movements_immutable"
  BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION ledgercore_reject_stock_movement_edit();

-- Note: no persisted GIN trigram index here — Prisma's schema-diff-based
-- migrate dev treats any index it didn't generate from schema.prisma as
-- drift and drops it on the next `migrate dev` run. pg_trgm's `similarity()`
-- function still works fine unindexed at this data scale; T2 matching just
-- does a sequential scan. Add a `@@index(..., type: Gin)` in schema.prisma
-- (Prisma's extended-indexes support) before this needs to scale.

-- ── Row-Level Security ───────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'financial_accounts', 'statement_imports', 'statement_lines',
    'matches', 'match_legs', 'match_rules', 'momo_events',
    'reconciliation_sessions', 'stock_movements'
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
  "financial_accounts", "statement_imports", "match_rules", "reconciliation_sessions"
TO ledgercore_app;

-- immutable-by-trigger tables: no DELETE grant needed beyond what the
-- triggers already forbid, but withholding it too is defense in depth
GRANT SELECT, INSERT, UPDATE ON "statement_lines", "matches", "stock_movements" TO ledgercore_app;
GRANT SELECT, INSERT, DELETE ON "match_legs" TO ledgercore_app;
GRANT SELECT, INSERT ON "momo_events" TO ledgercore_app;
