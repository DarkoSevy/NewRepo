import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { execSync } from 'child_process';
import * as path from 'path';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

// AppModule (and anything that transitively imports @prisma/client) MUST be
// imported dynamically, after DATABASE_URL/APP_DATABASE_URL point at the
// Testcontainers instance — @prisma/client eagerly loads `.env` as a
// side effect of being `require`d, and a static top-level import would run
// before the container's connection string is known.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let AppModule: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let PrismaService: any;

jest.setTimeout(180_000);

describe('LedgerCore Phase 1 acceptance (e2e)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let prisma: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let http: any; // eslint-disable-line @typescript-eslint/no-explicit-any

  let tenantId: string;
  let ownerToken: string;
  let cashId: string;
  let revenueId: string;
  let openPeriodId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16')
      .withDatabase('ledgercore_test')
      .withUsername('ledgercore')
      .withPassword('ledgercore')
      .start();

    const ownerUrl = `postgresql://ledgercore:ledgercore@${container.getHost()}:${container.getPort()}/ledgercore_test?schema=public`;
    const appUrl = `postgresql://ledgercore_app:ledgercore_app@${container.getHost()}:${container.getPort()}/ledgercore_test?schema=public`;

    process.env.DATABASE_URL = ownerUrl;
    process.env.APP_DATABASE_URL = appUrl;
    process.env.JWT_SECRET = 'test-only-secret';
    process.env.JWT_EXPIRES_IN = '1h';

    execSync('npx prisma migrate deploy', {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: ownerUrl },
      stdio: 'inherit',
    });

    ({ AppModule } = await import('../src/app.module'));
    ({ PrismaService } = await import('../src/prisma/prisma.service'));
    const { patchBigIntJson } = await import('../src/common/bigint-json');
    patchBigIntJson();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();

    prisma = app.get(PrismaService);
    http = app.getHttpServer();

    // Bootstrap one tenant with a seeded CoA and 2026 periods, shared by
    // every test below (fresh state per `it` would be prohibitively slow
    // given the container startup cost).
    const tenantResp = await request(http)
      .post('/api/v1/tenants')
      .send({ name: 'Acme Rwanda Ltd', ownerEmail: 'owner@acme.rw', ownerPassword: 'supersecret1' })
      .expect(201);
    tenantId = tenantResp.body.tenant.id;

    const loginResp = await request(http)
      .post('/api/v1/auth/login')
      .send({ tenantId, email: 'owner@acme.rw', password: 'supersecret1' })
      .expect(201);
    ownerToken = loginResp.body.accessToken;

    await request(http)
      .post('/api/v1/accounts/seed-template?template=rw-sme')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(201);

    await request(http)
      .post('/api/v1/periods/generate?year=2026')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(201);

    const accountsResp = await request(http)
      .get('/api/v1/accounts')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    cashId = accountsResp.body.flat.find((a: any) => a.code === '1000').id; // eslint-disable-line @typescript-eslint/no-explicit-any
    revenueId = accountsResp.body.flat.find((a: any) => a.code === '4000').id; // eslint-disable-line @typescript-eslint/no-explicit-any

    const periodsResp = await request(http)
      .get('/api/v1/periods')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    openPeriodId = periodsResp.body.find((p: any) => p.startDate.startsWith('2026-01')).id; // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  afterAll(async () => {
    await app.close();
    await container.stop();
  });

  function draft(entryDate: string, debitAmount: number, creditAmount: number, memo = 'test entry') {
    return request(http)
      .post('/api/v1/journal-entries')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        entryDate,
        memo,
        lines: [
          { accountId: cashId, direction: 'DEBIT', amountMinor: debitAmount, currency: 'RWF' },
          { accountId: revenueId, direction: 'CREDIT', amountMinor: creditAmount, currency: 'RWF' },
        ],
      });
  }

  it('rejects an unbalanced entry at the service layer', async () => {
    const created = await draft('2026-02-01', 1000, 900).expect(201);
    const res = await request(http)
      .post(`/api/v1/journal-entries/${created.body.id}/post`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);
    expect(res.body.message).toMatch(/not balanced/i);
  });

  it('rejects an unbalanced entry at the DB layer independently of the service', async () => {
    // Bypass JournalService entirely: insert straight through Prisma, then
    // flip status to POSTED in a raw update, exercising only the deferred
    // constraint trigger from the business_rules migration.
    await expect(
      prisma.forTenant(tenantId, async (tx: any) => {
        // eslint-disable-line @typescript-eslint/no-explicit-any
        const entry = await tx.journalEntry.create({
          data: { tenantId, entryDate: new Date('2026-02-02'), status: 'DRAFT', source: 'MANUAL' },
        });
        await tx.journalLine.createMany({
          data: [
            { tenantId, entryId: entry.id, accountId: cashId, direction: 'DEBIT', amountMinor: 1000n, currency: 'RWF' },
            { tenantId, entryId: entry.id, accountId: revenueId, direction: 'CREDIT', amountMinor: 500n, currency: 'RWF' },
          ],
        });
        await tx.journalEntry.update({ where: { id: entry.id }, data: { status: 'POSTED', entryNo: 999999n } });
      }),
    ).rejects.toThrow(/Unbalanced journal entry/);
  });

  it('rejects UPDATE and DELETE on a posted line via the immutability trigger', async () => {
    const created = await draft('2026-02-03', 1000, 1000).expect(201);
    const posted = await request(http)
      .post(`/api/v1/journal-entries/${created.body.id}/post`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(201);
    const lineId = posted.body.lines[0].id;

    await expect(
      prisma.forTenant(tenantId, (tx: any) => tx.journalLine.update({ where: { id: lineId }, data: { amountMinor: 1n } })), // eslint-disable-line @typescript-eslint/no-explicit-any
    ).rejects.toThrow(/Cannot modify lines of POSTED/);

    await expect(
      prisma.forTenant(tenantId, (tx: any) => tx.journalLine.delete({ where: { id: lineId } })), // eslint-disable-line @typescript-eslint/no-explicit-any
    ).rejects.toThrow(/Cannot modify lines of POSTED/);

    await expect(
      prisma.forTenant(tenantId, (tx: any) => tx.journalEntry.delete({ where: { id: created.body.id } })), // eslint-disable-line @typescript-eslint/no-explicit-any
    ).rejects.toThrow(/Cannot delete POSTED/);
  });

  it('assigns consecutive, gap-free entry numbers under concurrent posting', async () => {
    const drafts = await Promise.all(
      Array.from({ length: 8 }, () => draft('2026-02-10', 200, 200).then((r) => r.body.id)),
    );

    const posted = await Promise.all(
      drafts.map((id) =>
        request(http).post(`/api/v1/journal-entries/${id}/post`).set('Authorization', `Bearer ${ownerToken}`),
      ),
    );

    const entryNos = posted.map((r) => {
      expect(r.status).toBe(201);
      return Number(r.body.entryNo);
    });
    const sorted = [...entryNos].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]).toBe(sorted[i - 1] + 1); // no gap, no duplicate
    }
  });

  it('blocks posting into a CLOSED period, and reopening (as OWNER) unblocks it — both audited', async () => {
    await request(http)
      .post(`/api/v1/periods/${openPeriodId}/close`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(201);

    const created = await draft('2026-01-05', 100, 100).expect(201);
    const rejected = await request(http)
      .post(`/api/v1/journal-entries/${created.body.id}/post`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);
    expect(rejected.body.message).toMatch(/CLOSED/);

    await request(http)
      .post(`/api/v1/periods/${openPeriodId}/reopen`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(201);

    await request(http)
      .post(`/api/v1/journal-entries/${created.body.id}/post`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(201);

    const auditActions = await prisma.forTenant(tenantId, (tx: any) =>
      // eslint-disable-line @typescript-eslint/no-explicit-any
      tx.auditLog.findMany({ where: { entityId: openPeriodId }, orderBy: { at: 'asc' } }),
    );
    const actions = auditActions.map((a: any) => a.action); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(actions).toContain('PERIOD_CLOSED');
    expect(actions).toContain('PERIOD_REOPENED');
  });

  it('produces mirror-image lines on reversal, flips status, and forbids reversing twice', async () => {
    const created = await draft('2026-03-01', 7500, 7500).expect(201);
    const posted = await request(http)
      .post(`/api/v1/journal-entries/${created.body.id}/post`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(201);

    const reversal = await request(http)
      .post(`/api/v1/journal-entries/${created.body.id}/reverse`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ date: '2026-03-02' })
      .expect(201);

    const originalLines = posted.body.lines.sort((a: any, b: any) => a.accountId.localeCompare(b.accountId)); // eslint-disable-line @typescript-eslint/no-explicit-any
    const reversalLines = reversal.body.lines.sort((a: any, b: any) => a.accountId.localeCompare(b.accountId)); // eslint-disable-line @typescript-eslint/no-explicit-any
    for (let i = 0; i < originalLines.length; i++) {
      expect(reversalLines[i].accountId).toBe(originalLines[i].accountId);
      expect(reversalLines[i].amountMinor).toBe(originalLines[i].amountMinor);
      expect(reversalLines[i].direction).not.toBe(originalLines[i].direction);
    }

    const originalAfter = await request(http)
      .get(`/api/v1/journal-entries/${created.body.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(originalAfter.body.status).toBe('REVERSED');

    const secondReversal = await request(http)
      .post(`/api/v1/journal-entries/${created.body.id}/reverse`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({})
      .expect(400);
    expect(secondReversal.body.message).toMatch(/Only POSTED entries can be reversed/);
  });

  it('keeps the trial balance footer in balance across a larger fixture', async () => {
    const N = 60;
    for (let i = 0; i < N; i++) {
      const created = await draft('2026-04-01', 111, 111, `fixture ${i}`).expect(201);
      await request(http)
        .post(`/api/v1/journal-entries/${created.body.id}/post`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(201);
    }

    const tb = await request(http)
      .get('/api/v1/reports/trial-balance?as_of=2026-12-31')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(tb.body.footer.balanced).toBe(true);
    expect(tb.body.footer.totalDebits).toBe(tb.body.footer.totalCredits);
    expect(typeof tb.body.footer.totalDebits).toBe('string');
    expect(tb.body.footer.totalDebits).not.toMatch(/\./); // integer minor units, no decimals
  });

  it('rejects cross-tenant reads/writes under RLS even with app-layer scoping disabled', async () => {
    const otherTenant = await request(http)
      .post('/api/v1/tenants')
      .send({ name: 'Beta Co', ownerEmail: 'owner@beta.rw', ownerPassword: 'supersecret1' })
      .expect(201);
    const otherLogin = await request(http)
      .post('/api/v1/auth/login')
      .send({ tenantId: otherTenant.body.tenant.id, email: 'owner@beta.rw', password: 'supersecret1' })
      .expect(201);
    const otherToken = otherLogin.body.accessToken;

    // App-layer scoping (JwtAuthGuard + service filtering by tenantId from
    // the JWT) still applies here — tenant B simply cannot see tenant A's
    // accounts via the API.
    const crossRead = await request(http)
      .get('/api/v1/accounts')
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200);
    expect(crossRead.body.flat).toHaveLength(0);

    // Now disable app-layer scoping deliberately: query straight through
    // Prisma without going through `forTenant` (i.e. without ever setting
    // app.tenant_id). RLS must fail closed and return zero rows regardless.
    const unscoped = await prisma.account.findMany({ where: { code: '1000' } });
    expect(unscoped).toHaveLength(0);
  });
});
