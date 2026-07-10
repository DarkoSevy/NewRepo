# LedgerCore — Core Accounting Engine (Phase 1)

Multi-tenant, double-entry general ledger for Rwanda / East Africa SMEs.
NestJS · PostgreSQL 16 · Prisma. See the product spec for scope and invariants.

## Stack notes

- Every tenant-scoped table has Row-Level Security keyed to
  `current_setting('app.tenant_id')`. The app connects as a dedicated
  non-superuser role (`ledgercore_app`) so RLS actually applies — Postgres
  exempts superusers unconditionally. `PrismaService.forTenant()` is the
  only sanctioned way to touch tenant data; it opens a transaction, sets
  `app.tenant_id` for that transaction, and forces any deferred constraint
  triggers to run before commit.
- Balance and immutability invariants are enforced by triggers in
  `prisma/migrations/20260710130100_business_rules`, independent of the
  service-layer checks in `JournalService`.
- Reports read through the `posted_lines` view rather than the raw tables
  (see spec §7), so a future snapshot/materialization layer can swap in
  underneath without changing report queries.

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

`test/ledgercore.e2e-spec.ts` spins up a throwaway Postgres 16 container,
runs all migrations against it, and drives the API through supertest,
covering the acceptance targets in spec §9 (unbalanced-entry rejection at
both layers, immutability triggers, gap-free concurrent numbering, period
locks, reversal, trial-balance integrity, and RLS with app-layer scoping
deliberately bypassed).
