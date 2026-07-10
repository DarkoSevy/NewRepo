-- Runtime traffic must connect as a non-superuser, non-owner role so that
-- Row-Level Security (added in the previous migration) actually applies.
-- Postgres exempts superusers from RLS unconditionally, and exempts table
-- owners unless FORCE ROW LEVEL SECURITY is set (which we did) — but a
-- superuser bypasses even FORCE. Migrations still run as the owning role;
-- only the app pool should use ledgercore_app (see APP_DATABASE_URL).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ledgercore_app') THEN
    CREATE ROLE ledgercore_app LOGIN PASSWORD 'ledgercore_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO ledgercore_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "tenants", "users", "accounts", "accounting_periods", "entry_no_sequences",
  "journal_entries", "journal_lines"
TO ledgercore_app;

-- audit_log is append-only: no UPDATE/DELETE grant, and the trigger from the
-- previous migration rejects them even for roles that somehow gain the grant.
GRANT SELECT, INSERT ON "audit_log" TO ledgercore_app;

GRANT SELECT ON "posted_lines" TO ledgercore_app;
