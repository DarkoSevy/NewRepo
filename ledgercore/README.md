# LedgerCore — Core Accounting Engine (Phases 1 & 2)

Multi-tenant, double-entry general ledger for Rwanda / East Africa SMEs, plus
invoicing, AP, and RRA EBM 2.1 compliance. NestJS · PostgreSQL 16 · Prisma.
See the product specs for scope and invariants.

## Stack notes

- Every tenant-scoped table has Row-Level Security keyed to
  `current_setting('app.tenant_id')`. The app connects as a dedicated
  non-superuser role (`ledgercore_app`) so RLS actually applies — Postgres
  exempts superusers unconditionally. `PrismaService.forTenant()` is the
  only sanctioned way to touch tenant data; it opens a transaction, sets
  `app.tenant_id` for that transaction, and forces any deferred constraint
  triggers to run before commit.
- Balance and immutability invariants are enforced by triggers in
  `prisma/migrations/20260710130100_business_rules` (ledger) and
  `20260710133700_invoicing_business_rules` (invoices/bills/credit notes),
  independent of the equivalent service-layer checks.
- Reports read through the `posted_lines` view rather than the raw tables
  (see Phase 1 spec §7), so a future snapshot/materialization layer can
  swap in underneath without changing report queries.
- `EbmAdapter` (`src/ebm/`) is the anti-corruption layer for RRA's VSDC: no
  VSDC field names or wire formats leak past it. `NullDriver` backs
  `tenant.ebm_mode = DISABLED` (dev / non-VAT tenants) and always
  succeeds instantly; `VsdcDriver` is a real HTTP client whose endpoint
  shapes are inferred from the Phase 2 spec, not yet validated against the
  actual RRA VSDC technical spec/sandbox — treat it as a structural
  starting point for the Sprint 4 RRA integration pass, not a finished
  integration. Every exchange through either driver is logged to the
  append-only `ebm_transactions` table.
- Invoice certification (`InvoicesService.certifyInvoice`) dispatches off
  the request/response cycle via `setImmediate` and retries with
  exponential backoff, idempotent on `ebm_receipts`. Production should
  swap that dispatch for a durable queue (BullMQ, etc.) — the retry/
  idempotency logic itself doesn't need to change.

## Local setup

```bash
cp .env.example .env
docker compose up -d          # Postgres 16 on localhost:5432
npx prisma migrate deploy     # applies schema + business-rule migrations
npm run start:dev
```

The API is served under `/api/v1`. There's no self-serve signup: bootstrap
a tenant and its OWNER user first, then log in.

```bash
curl -X POST localhost:3000/api/v1/tenants \
  -H 'Content-Type: application/json' \
  -d '{"name":"Acme Rwanda Ltd","ownerEmail":"owner@acme.rw","ownerPassword":"supersecret1"}'

curl -X POST localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"tenantId":"<id from above>","email":"owner@acme.rw","password":"supersecret1"}'

curl -X POST 'localhost:3000/api/v1/accounts/seed-template?template=rw-sme' \
  -H 'Authorization: Bearer <accessToken>'
```

`POST /tenants` has no auth guard of its own — it's a platform-admin
operation with no tenant context yet to scope it by. Gate it at the
network/deployment layer before exposing it publicly.

## Tests

```bash
npm test              # unit tests
npm run test:e2e       # Testcontainers Postgres + full HTTP acceptance suite
```

`test/ledgercore.e2e-spec.ts` (Phase 1) and `test/invoicing.e2e-spec.ts`
(Phase 2) each spin up their own throwaway Postgres 16 container, run all
migrations, and drive the API through supertest.

Phase 1 covers: unbalanced-entry rejection at both layers, immutability
triggers, gap-free concurrent numbering, period locks, reversal,
trial-balance integrity, and RLS with app-layer scoping deliberately
bypassed.

Phase 2 (`test/invoicing.e2e-spec.ts`) spins up a fake VSDC HTTP server
in-process to cover: unregistered-item issuance block under
`ebm_mode=VSDC` vs success under NullDriver, receipt-fetch blocked before
ISSUED, exactly-once certification under a concurrent retry storm,
credit-note over-limit rejection, payment over-allocation and exact
ISSUED→PARTIALLY_PAID→PAID thresholds, AR-to-ledger reconciliation over a
200-invoice fixture, and VAT return reconciliation against actual VAT
Output/Input ledger postings. `src/tax/vat-calc.spec.ts` property-tests
the inclusive/exclusive rounding invariant (net + VAT = total, zero
tolerance) with `fast-check`.
