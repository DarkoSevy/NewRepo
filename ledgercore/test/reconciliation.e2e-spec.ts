import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { execSync } from 'child_process';
import * as path from 'path';
import * as http from 'http';
import { createHmac } from 'crypto';
import { AddressInfo } from 'net';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

// AppModule (and anything that transitively imports @prisma/client) MUST be
// imported dynamically, after DATABASE_URL/APP_DATABASE_URL point at the
// Testcontainers instance — see ledgercore.e2e-spec.ts for why.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let AppModule: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let PrismaService: any;

jest.setTimeout(240_000);

const MAPPING = {
  dateColumn: 'Date',
  descriptionColumn: 'Description',
  refColumn: 'Ref',
  amountColumn: 'Amount',
};

/** Rows: [date, description, ref, signedAmount] — positive = IN, negative = OUT. */
function csv(rows: [string, string, string, number][]): Buffer {
  const lines = ['Date,Description,Ref,Amount', ...rows.map((r) => `${r[0]},${r[1]},${r[2]},${r[3]}`)];
  return Buffer.from(lines.join('\n'));
}

interface FakeVsdcState {
  stockMovementsSucceedFirstN: number | null; // null = always succeed
  stockMovementsSuccessCount: number;
}

function startFakeVsdc(): { server: http.Server; state: FakeVsdcState } {
  const state: FakeVsdcState = { stockMovementsSucceedFirstN: null, stockMovementsSuccessCount: 0 };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = req.url ?? '';
      let status = 200;
      let body: unknown = {};
      if (url.endsWith('/items')) {
        body = { itemCd: 'RRA-E2E-ITEM' };
      } else if (url.endsWith('/stock/items')) {
        body = {};
      } else if (url.endsWith('/stock/movements')) {
        if (state.stockMovementsSucceedFirstN !== null && state.stockMovementsSuccessCount >= state.stockMovementsSucceedFirstN) {
          status = 500; // simulated crash mid-batch: everything after the first N fails
          body = { message: 'simulated VSDC outage' };
        } else {
          state.stockMovementsSuccessCount++;
          body = {};
        }
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });

  return { server, state };
}

describe('LedgerCore Phase 3 acceptance (e2e)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let prisma: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let http_: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let vsdcServer: http.Server;
  let vsdcState: FakeVsdcState;

  let tenantId: string;
  let ownerToken: string;

  // GL account ids by code
  let acc: Record<string, string> = {};

  // Financial-account registers
  let bkRegisterId: string; // 1010 Bank – BK
  let equityRegisterId: string; // 1020 Bank – Equity
  let mtnWalletId: string; // 1030 MoMo Clearing – MTN
  let airtelWalletId: string; // 1040 MoMo Clearing – Airtel

  let poolContactId: string;
  let poolInvoiceId: string;

  const MOMO_SECRET = 'test-momo-secret';

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16')
      .withDatabase('ledgercore_test3')
      .withUsername('ledgercore')
      .withPassword('ledgercore')
      .start();

    const ownerUrl = `postgresql://ledgercore:ledgercore@${container.getHost()}:${container.getPort()}/ledgercore_test3?schema=public`;
    const appUrl = `postgresql://ledgercore_app:ledgercore_app@${container.getHost()}:${container.getPort()}/ledgercore_test3?schema=public`;

    process.env.DATABASE_URL = ownerUrl;
    process.env.APP_DATABASE_URL = appUrl;
    process.env.JWT_SECRET = 'test-only-secret';
    process.env.JWT_EXPIRES_IN = '1h';
    process.env.CERTIFY_BACKOFF_BASE_MS = '50';
    process.env.MOMO_MTN_WEBHOOK_SECRET = MOMO_SECRET;

    const fake = startFakeVsdc();
    vsdcServer = fake.server;
    vsdcState = fake.state;
    await new Promise<void>((resolve) => vsdcServer.listen(0, resolve));
    const vsdcPort = (vsdcServer.address() as AddressInfo).port;
    process.env.VSDC_BASE_URL = `http://localhost:${vsdcPort}/vsdc`;

    execSync('npx prisma migrate deploy', {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: ownerUrl },
      stdio: 'inherit',
    });

    ({ AppModule } = await import('../src/app.module'));
    ({ PrismaService } = await import('../src/prisma/prisma.service'));
    const { patchBigIntJson } = await import('../src/common/bigint-json');
    patchBigIntJson();

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication({ rawBody: true }); // rawBody: HMAC webhook verification needs the exact bytes
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();

    prisma = app.get(PrismaService);
    http_ = app.getHttpServer();

    const tenantResp = await request(http_)
      .post('/api/v1/tenants')
      .send({ name: 'Recon Fixtures Ltd', ownerEmail: 'owner@recon.rw', ownerPassword: 'supersecret1' })
      .expect(201);
    tenantId = tenantResp.body.tenant.id;

    const loginResp = await request(http_)
      .post('/api/v1/auth/login')
      .send({ tenantId, email: 'owner@recon.rw', password: 'supersecret1' })
      .expect(201);
    ownerToken = loginResp.body.accessToken;

    await request(http_).post('/api/v1/accounts/seed-template?template=rw-sme').set('Authorization', `Bearer ${ownerToken}`).expect(201);
    await request(http_).post('/api/v1/periods/generate?year=2026').set('Authorization', `Bearer ${ownerToken}`).expect(201);

    const accountsResp = await request(http_).get('/api/v1/accounts').set('Authorization', `Bearer ${ownerToken}`).expect(200);
    for (const code of ['1000', '1010', '1020', '1030', '1040', '1100', '1450', '3100', '4000', '5000', '5600', '5750']) {
      acc[code] = accountsResp.body.flat.find((a: any) => a.code === code).id; // eslint-disable-line @typescript-eslint/no-explicit-any
    }

    bkRegisterId = await makeRegister('Bank – BK Current', 'BANK', acc['1010']);
    equityRegisterId = await makeRegister('Bank – Equity Current', 'BANK', acc['1020']);
    mtnWalletId = await makeRegister('MoMo Wallet – MTN', 'MOMO', acc['1030']);
    airtelWalletId = await makeRegister('MoMo Wallet – Airtel', 'MOMO', acc['1040']);

    // One large issued invoice acts as the allocation pool for every payment
    // fixture below — payments must allocate to a document, and reconciliation
    // only cares about the deposit-account journal leg, not the AR side.
    poolContactId = await makeContact('Clearing Pool Ltd');
    const itemId = await makeServiceItem('POOL-SVC', 100_000);
    const invoice = await request(http_)
      .post('/api/v1/invoices')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ contactId: poolContactId, lines: [{ itemId, qty: 10 }] })
      .expect(201);
    poolInvoiceId = invoice.body.id;
    await request(http_).post(`/api/v1/invoices/${poolInvoiceId}/issue`).set('Authorization', `Bearer ${ownerToken}`).expect(202);
    await pollInvoiceSettled(poolInvoiceId);
  });

  afterAll(async () => {
    await new Promise((resolve) => vsdcServer.close(resolve));
    await app.close();
    await container.stop();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function makeRegister(name: string, kind: string, glAccountId: string): Promise<string> {
    const resp = await request(http_)
      .post('/api/v1/financial-accounts')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name, kind, glAccountId })
      .expect(201);
    return resp.body.id;
  }

  async function makeContact(name: string): Promise<string> {
    const resp = await request(http_)
      .post('/api/v1/contacts')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ kind: 'CUSTOMER', name, tin: '123456789' })
      .expect(201);
    return resp.body.id;
  }

  async function makeServiceItem(sku: string, priceMinor: number): Promise<string> {
    const resp = await request(http_)
      .post('/api/v1/items')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ sku, name: sku, type: 'SERVICE', taxCode: 'B', unit: 'unit', defaultPriceMinor: priceMinor, incomeAccountId: acc['4000'] })
      .expect(201);
    return resp.body.id;
  }

  async function pollInvoiceSettled(invoiceId: string, timeoutMs = 15_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const resp = await request(http_).get(`/api/v1/invoices/${invoiceId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      if (resp.body.status !== 'CERTIFYING') return resp.body.status;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Invoice ${invoiceId} did not settle within ${timeoutMs}ms`);
  }

  /** Records an IN payment allocated against the pool invoice; returns paymentId. */
  async function payIn(amountMinor: number, depositAccountId: string, date: string, reference?: string): Promise<string> {
    const resp = await request(http_)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        direction: 'IN',
        contactId: poolContactId,
        method: 'BANK',
        depositAccountId,
        amountMinor,
        date,
        reference,
        allocations: [{ invoiceId: poolInvoiceId, amountMinor }],
      })
      .expect(201);
    return resp.body.id;
  }

  /** The journal line a payment posted to its deposit GL account. */
  async function paymentDepositLegId(paymentId: string, glAccountId: string): Promise<string> {
    return prisma.forTenant(tenantId, async (tx: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const entry = await tx.journalEntry.findFirstOrThrow({
        where: { sourceDocumentRef: { path: ['id'], equals: paymentId } },
      });
      const line = await tx.journalLine.findFirstOrThrow({ where: { entryId: entry.id, accountId: glAccountId } });
      return line.id;
    });
  }

  async function importStatement(financialAccountId: string, file: Buffer, filename: string) {
    const resp = await request(http_)
      .post('/api/v1/statement-imports')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('financialAccountId', financialAccountId)
      .field('mapping', JSON.stringify(MAPPING))
      .attach('file', file, filename)
      .expect(201);
    return resp.body;
  }

  async function registerLines(financialAccountId: string) {
    const resp = await request(http_)
      .get(`/api/v1/financial-accounts/${financialAccountId}/register`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    return resp.body.lines as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  function lineByDescription(lines: any[], needle: string) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const line = lines.find((l) => l.description.includes(needle));
    if (!line) throw new Error(`No statement line matching "${needle}"`);
    return line;
  }

  async function clearingBalance(registerId: string): Promise<string> {
    const resp = await request(http_)
      .get(`/api/v1/financial-accounts/${registerId}/clearing-health`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    return resp.body.clearingBalanceMinor;
  }

  // ── §10: file + line dedupe ────────────────────────────────────────────────

  it('imports the same file twice as a no-op, and only novel lines from an overlapping file', async () => {
    const fileA = csv([
      ['2026-03-01', 'TRANSFER ALPHA', '', 111111],
      ['2026-03-02', 'TRANSFER BETA', '', 222222],
    ]);

    const first = await importStatement(bkRegisterId, fileA, 'march-a.csv');
    expect(first.duplicate).toBe(false);
    expect(first.newLines).toBe(2);

    const replay = await importStatement(bkRegisterId, fileA, 'march-a-again.csv');
    expect(replay.duplicate).toBe(true); // same bytes, same hash — regardless of filename

    // Overlapping period: both existing lines plus one novel line.
    const fileB = csv([
      ['2026-03-01', 'TRANSFER ALPHA', '', 111111],
      ['2026-03-02', 'TRANSFER BETA', '', 222222],
      ['2026-03-03', 'TRANSFER GAMMA', '', 333333],
    ]);
    const overlap = await importStatement(bkRegisterId, fileB, 'march-b.csv');
    expect(overlap.duplicate).toBe(false);
    expect(overlap.newLines).toBe(1);
    expect(overlap.duplicateLines).toBe(2);
  });

  // ── §4: T1 exact-reference auto-match + bulk-confirm ──────────────────────

  it('auto-proposes a T1 exact-reference match and bulk-confirm makes the line MATCHED', async () => {
    await payIn(4444, acc['1010'], '2026-03-05', 'REF-T1-777');

    await importStatement(bkRegisterId, csv([['2026-03-05', 'INWARD CLEARING', 'REF-T1-777', 4444]]), 't1.csv');

    const lines = await registerLines(bkRegisterId);
    const line = lineByDescription(lines, 'INWARD CLEARING');
    const t1Legs = line.matchLegs.filter((l: any) => l.match.kind === 'AUTO_T1'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(t1Legs).toHaveLength(1);
    expect(t1Legs[0].match.status).toBe('PROPOSED');
    expect(line.status).toBe('UNMATCHED'); // nothing confirms without a human

    await request(http_)
      .post('/api/v1/matches/bulk-confirm')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ matchIds: [t1Legs[0].match.id] })
      .expect(201);

    const after = lineByDescription(await registerLines(bkRegisterId), 'INWARD CLEARING');
    expect(after.status).toBe('MATCHED');
  });

  // ── §10: split match exactness ─────────────────────────────────────────────

  it('confirms a split match only when statement and ledger legs sum equal to the franc', async () => {
    const p1 = await payIn(1000, acc['1010'], '2026-03-08');
    const p2 = await payIn(2000, acc['1010'], '2026-03-08');
    const p3 = await payIn(3000, acc['1010'], '2026-03-08');
    const legs = [
      await paymentDepositLegId(p1, acc['1010']),
      await paymentDepositLegId(p2, acc['1010']),
      await paymentDepositLegId(p3, acc['1010']),
    ];

    await importStatement(
      bkRegisterId,
      csv([
        ['2026-03-08', 'BULK DEPOSIT BATCH 41', '', 6000],
        ['2026-03-08', 'BULK DEPOSIT BATCH 42', '', 6001],
      ]),
      'split.csv',
    );
    const lines = await registerLines(bkRegisterId);
    const line6000 = lineByDescription(lines, 'BATCH 41');
    const line6001 = lineByDescription(lines, 'BATCH 42');

    // Off-by-one: 6001 against 6000 of ledger legs.
    const offByOne = await request(http_)
      .post('/api/v1/matches')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ statementLineIds: [line6001.id], journalLineIds: legs });
    expect(offByOne.status).toBe(400);
    expect(offByOne.body.message).toMatch(/does not equal/);

    // Partial legs: 6000 against only 3000.
    const partial = await request(http_)
      .post('/api/v1/matches')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ statementLineIds: [line6000.id], journalLineIds: legs.slice(0, 2) });
    expect(partial.status).toBe(400);

    // Exact: 1 statement line ↔ 3 payments.
    const exact = await request(http_)
      .post('/api/v1/matches')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ statementLineIds: [line6000.id], journalLineIds: legs })
      .expect(201);
    await request(http_).post(`/api/v1/matches/${exact.body.id}/confirm`).set('Authorization', `Bearer ${ownerToken}`).expect(201);

    const after = lineByDescription(await registerLines(bkRegisterId), 'BATCH 41');
    expect(after.status).toBe('MATCHED');
  });

  // ── §10: completion invariant, remediation list, lockdown ─────────────────

  it('enforces the completion invariant with an exact remediation list, then locks hard on completion', async () => {
    const pa = await payIn(5000, acc['1020'], '2026-04-05', 'REF-A');
    const pb = await payIn(7000, acc['1020'], '2026-04-10', 'REF-B');
    void pa;
    void pb;

    await importStatement(
      equityRegisterId,
      csv([
        ['2026-04-05', 'INWARD REF-A', 'REF-A', 5000],
        ['2026-04-10', 'INWARD REF-B', 'REF-B', 7000],
        ['2026-04-25', 'MONTHLY ACCOUNT FEE', '', -300],
      ]),
      'april-equity.csv',
    );

    const session = await request(http_)
      .post('/api/v1/reconciliation-sessions')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        financialAccountId: equityRegisterId,
        periodStart: '2026-04-01',
        periodEnd: '2026-04-30',
        statementClosingBalanceMinor: 11700, // 5000 + 7000 - 300
      })
      .expect(201);
    const sessionId = session.body.id;

    // Nothing confirmed yet: 3 unmatched lines AND a nonzero difference
    // (fee not in GL yet) — completion must fail with the remediation list.
    const failed = await request(http_)
      .post(`/api/v1/reconciliation-sessions/${sessionId}/complete`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(failed.status).toBe(400);
    expect(failed.body.differenceMinor).toBe('-300');
    expect(failed.body.unmatchedLineIds).toHaveLength(3);

    // Remediate: bulk-confirm the two T1 proposals…
    const lines = await registerLines(equityRegisterId);
    const t1MatchIds = ['INWARD REF-A', 'INWARD REF-B'].map((d) => {
      const leg = lineByDescription(lines, d).matchLegs.find((l: any) => l.match.kind === 'AUTO_T1'); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(leg).toBeTruthy();
      return leg.match.id;
    });
    await request(http_).post('/api/v1/matches/bulk-confirm').set('Authorization', `Bearer ${ownerToken}`).send({ matchIds: t1MatchIds }).expect(201);

    // …and create-and-match the bank fee (posts DR Bank & MoMo Charges, CR Bank).
    const feeLine = lineByDescription(lines, 'MONTHLY ACCOUNT FEE');
    const feeMatch = await request(http_)
      .post(`/api/v1/statement-lines/${feeLine.id}/create-and-match`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ glAccountId: acc['5600'] })
      .expect(201);

    const completed = await request(http_)
      .post(`/api/v1/reconciliation-sessions/${sessionId}/complete`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(201);
    expect(completed.body.status).toBe('COMPLETED');
    expect(completed.body.differenceMinor).toBe('0');

    // Lockdown via API: confirmed matches can't be deleted, locked lines can't be excluded.
    await request(http_).delete(`/api/v1/matches/${feeMatch.body.id}`).set('Authorization', `Bearer ${ownerToken}`).expect(400);
    await request(http_)
      .post(`/api/v1/statement-lines/${feeLine.id}/exclude`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ reason: 'tamper attempt' })
      .expect(400);

    // Lockdown via raw SQL: the DB trigger rejects independently of the service layer.
    await expect(
      prisma.forTenant(tenantId, (tx: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
        tx.$executeRaw`UPDATE statement_lines SET status = 'EXCLUDED', exclude_reason = 'raw tamper' WHERE id = ${feeLine.id}`,
      ),
    ).rejects.toThrow(/locked by a completed reconciliation session/);

    await expect(
      prisma.forTenant(tenantId, (tx: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
        tx.$executeRaw`DELETE FROM matches WHERE id = ${feeMatch.body.id}`,
      ),
    ).rejects.toThrow(/locked by a completed reconciliation session/);

    // The attestation artifact renders for the completed session.
    const pdf = await request(http_)
      .get(`/api/v1/reports/reconciliation/${sessionId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });

  // ── §10: rule engine + §5 clearing settlement ──────────────────────────────

  let commissionRuleId: string;

  it('rule engine: COMMISSION line creates an expense + PROPOSED match, exactly once even under re-import', async () => {
    // Airtel wallet receives 3 customer payments (15 000 total).
    await payIn(4000, acc['1040'], '2026-05-02');
    await payIn(5000, acc['1040'], '2026-05-03');
    await payIn(6000, acc['1040'], '2026-05-04');

    const rule = await request(http_)
      .post('/api/v1/match-rules')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        financialAccountId: airtelWalletId,
        predicate: { descriptionContains: 'COMMISSION', direction: 'OUT' },
        action: 'CREATE_TRANSACTION',
        createSpec: { glAccountId: acc['5600'] },
      })
      .expect(201);
    commissionRuleId = rule.body.id;

    const walletFile = csv([
      ['2026-05-02', 'MOMO RECEIPT 0788000001', '', 4000],
      ['2026-05-03', 'MOMO RECEIPT 0788000002', '', 5000],
      ['2026-05-04', 'MOMO RECEIPT 0788000003', '', 6000],
      ['2026-05-05', 'COMMISSION FEE MAY', '', -300],
      ['2026-05-10', 'SWEEP TO BANK 1', '', -6000],
      ['2026-05-28', 'SWEEP TO BANK 2', '', -8700],
    ]);
    await importStatement(airtelWalletId, walletFile, 'may-airtel.csv');

    const countRuleEntries = () =>
      prisma.forTenant(tenantId, (tx: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
        tx.journalEntry.count({ where: { sourceDocumentRef: { path: ['id'], equals: commissionRuleId } } }),
      );
    expect(await countRuleEntries()).toBe(1);

    const lines = await registerLines(airtelWalletId);
    const feeLine = lineByDescription(lines, 'COMMISSION FEE MAY');
    const ruleLegs = feeLine.matchLegs.filter((l: any) => l.match.kind === 'RULE'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(ruleLegs).toHaveLength(1);
    expect(ruleLegs[0].match.status).toBe('PROPOSED');

    // Retry: overlapping file re-carries the fee line — line-hash dedupe means
    // the rule never re-fires and no second GL entry appears.
    const overlapFile = csv([
      ['2026-05-05', 'COMMISSION FEE MAY', '', -300],
      ['2026-05-06', 'EXTRA WALLET TOPUP', '', 12345],
    ]);
    const overlap = await importStatement(airtelWalletId, overlapFile, 'may-airtel-overlap.csv');
    expect(overlap.newLines).toBe(1);
    expect(overlap.duplicateLines).toBe(1);
    expect(await countRuleEntries()).toBe(1);

    // Confirming posts nothing further (the entry exists already) and is not repeatable.
    await request(http_).post(`/api/v1/matches/${ruleLegs[0].match.id}/confirm`).set('Authorization', `Bearer ${ownerToken}`).expect(201);
    expect(await countRuleEntries()).toBe(1);
    await request(http_).post(`/api/v1/matches/${ruleLegs[0].match.id}/confirm`).set('Authorization', `Bearer ${ownerToken}`).expect(400);
  });

  it('records wallet→bank sweeps and proves the clearing account out to zero', async () => {
    // 15 000 receipts − 300 fee = 14 700 unswept before any sweep.
    expect(await clearingBalance(airtelWalletId)).toBe('14700');

    await importStatement(
      bkRegisterId,
      csv([
        ['2026-05-10', 'SWEEP FROM MOMO 1', '', 6000],
        ['2026-05-28', 'SWEEP FROM MOMO 2', '', 8700],
      ]),
      'may-bk-sweeps.csv',
    );

    const bankLines = await registerLines(bkRegisterId);
    const walletLines = await registerLines(airtelWalletId);

    await request(http_)
      .post('/api/v1/momo/record-sweep')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        bankLineId: lineByDescription(bankLines, 'SWEEP FROM MOMO 1').id,
        momoLineId: lineByDescription(walletLines, 'SWEEP TO BANK 1').id,
      })
      .expect(201);
    expect(await clearingBalance(airtelWalletId)).toBe('8700'); // = wallet balance not yet swept

    await request(http_)
      .post('/api/v1/momo/record-sweep')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        bankLineId: lineByDescription(bankLines, 'SWEEP FROM MOMO 2').id,
        momoLineId: lineByDescription(walletLines, 'SWEEP TO BANK 2').id,
      })
      .expect(201);
    expect(await clearingBalance(airtelWalletId)).toBe('0'); // clearing proves out to zero

    // Both sweep statement lines are MATCHED to the same SYSTEM entry's two legs.
    for (const [registerId, needle] of [
      [bkRegisterId, 'SWEEP FROM MOMO 1'],
      [airtelWalletId, 'SWEEP TO BANK 1'],
    ] as const) {
      const line = lineByDescription(await registerLines(registerId), needle);
      expect(line.status).toBe('MATCHED');
    }
  });

  // ── §10: MoMo webhook replay idempotency + T0 matching both ways ──────────

  it('MoMo webhook: replays are idempotent and T0 matches in both arrival orders', async () => {
    const paymentBeforeStatement = await payIn(11800, acc['1030'], '2026-06-01');
    const paymentAfterStatement = await payIn(5900, acc['1030'], '2026-06-02');

    const sendWebhook = async (paymentId: string, providerTxnId: string, amountMinor: number) => {
      const raw = JSON.stringify({
        externalId: `${tenantId}.${paymentId}`,
        providerTxnId,
        status: 'SUCCESS',
        amountMinor,
        msisdn: '250788123456',
      });
      const signature = createHmac('sha256', MOMO_SECRET).update(raw).digest('hex');
      return request(http_)
        .post('/api/v1/webhooks/momo/mtn')
        .set('Content-Type', 'application/json')
        .set('x-momo-signature', signature)
        .send(raw);
    };

    // A bad signature must be rejected outright.
    const badSig = await request(http_)
      .post('/api/v1/webhooks/momo/mtn')
      .set('Content-Type', 'application/json')
      .set('x-momo-signature', 'ff'.repeat(32))
      .send(JSON.stringify({ externalId: `${tenantId}.x`, providerTxnId: 'X', status: 'SUCCESS', amountMinor: 1 }));
    expect(badSig.status).toBe(403);

    // Same provider_txn_id delivered 5 times → one momo_event.
    const responses = [];
    for (let i = 0; i < 5; i++) {
      responses.push(await sendWebhook(paymentBeforeStatement, 'MTNTX99001', 11800));
    }
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(responses[0].body.deduped).toBe(false);
    expect(responses.slice(1).every((r) => r.body.deduped === true)).toBe(true);

    const eventCount = await prisma.forTenant(tenantId, (tx: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
      tx.momoEvent.count({ where: { providerTxnId: 'MTNTX99001' } }),
    );
    expect(eventCount).toBe(1);

    // Statement arrives after the webhook: import-time T0 matches line 1.
    await importStatement(
      mtnWalletId,
      csv([
        ['2026-06-01', 'MoMo payment MTNTX99001', '', 11800],
        ['2026-06-02', 'MoMo payment MTNTX99002', '', 5900],
      ]),
      'june-mtn.csv',
    );

    const lines1 = await registerLines(mtnWalletId);
    const t0Legs = lineByDescription(lines1, 'MTNTX99001').matchLegs.filter((l: any) => l.match.kind === 'MOMO_EVENT'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(t0Legs).toHaveLength(1);
    expect(t0Legs[0].match.status).toBe('PROPOSED');

    // Webhook arrives after the statement: the receiver retro-matches line 2.
    const late = await sendWebhook(paymentAfterStatement, 'MTNTX99002', 5900);
    expect(late.status).toBe(201);
    expect(late.body.deduped).toBe(false);

    const lines2 = await registerLines(mtnWalletId);
    const retroLegs = lineByDescription(lines2, 'MTNTX99002').matchLegs.filter((l: any) => l.match.kind === 'MOMO_EVENT'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(retroLegs).toHaveLength(1);

    // Replaying the late webhook again still creates no second match.
    await sendWebhook(paymentAfterStatement, 'MTNTX99002', 5900);
    const lines3 = await registerLines(mtnWalletId);
    expect(lineByDescription(lines3, 'MTNTX99002').matchLegs.filter((l: any) => l.match.kind === 'MOMO_EVENT')).toHaveLength(1); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  // ── §10: negative-stock policy ─────────────────────────────────────────────

  let trackedItemId: string;

  it('blocks a sale beyond qty_on_hand under BLOCK, allows it (going negative) under WARN', async () => {
    const resp = await request(http_)
      .post('/api/v1/items')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ sku: 'CEMENT-E2E', name: 'Cement 50kg', type: 'GOODS', taxCode: 'B', unit: 'bag', defaultPriceMinor: 10000, incomeAccountId: acc['4000'] })
      .expect(201);
    trackedItemId = resp.body.id;

    await request(http_)
      .patch(`/api/v1/items/${trackedItemId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ tracked: true, inventoryAccountId: acc['1450'] })
      .expect(200);

    await request(http_)
      .post('/api/v1/stock/opening-balances')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ itemId: trackedItemId, qty: 10, unitCostMinor: 5000 })
      .expect(201);

    const contactId = await makeContact('Stock Customer');
    const invoice = await request(http_)
      .post('/api/v1/invoices')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ contactId, lines: [{ itemId: trackedItemId, qty: 15 }] })
      .expect(201);

    // BLOCK (tenant default): issue fails fast, synchronously, naming the shortfall.
    const blocked = await request(http_).post(`/api/v1/invoices/${invoice.body.id}/issue`).set('Authorization', `Bearer ${ownerToken}`);
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toMatch(/Insufficient stock for CEMENT-E2E: short by 5/);

    // WARN: same sale proceeds and stock goes negative.
    await prisma.tenant.update({ where: { id: tenantId }, data: { negativeStockPolicy: 'WARN' } });
    await request(http_).post(`/api/v1/invoices/${invoice.body.id}/issue`).set('Authorization', `Bearer ${ownerToken}`).expect(202);
    expect(await pollInvoiceSettled(invoice.body.id)).toBe('ISSUED');

    const item = await prisma.forTenant(tenantId, (tx: any) => tx.item.findUniqueOrThrow({ where: { id: trackedItemId } })); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(item.qtyOnHand.toString()).toBe('-5');

    // COGS posted at WAC: 15 × 5000.
    const cogsLine = await prisma.forTenant(tenantId, (tx: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
      tx.journalLine.findFirst({ where: { accountId: acc['5000'], amountMinor: 75000n, direction: 'DEBIT' } }),
    );
    expect(cogsLine).toBeTruthy();

    await prisma.tenant.update({ where: { id: tenantId }, data: { negativeStockPolicy: 'BLOCK' } });
  });

  // ── §10: nightly EBM stock reporter idempotency ────────────────────────────

  it('EBM stock reporter: crash mid-batch, then rerun, reports each movement exactly once', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { ebmMode: 'VSDC' } });

    const resp = await request(http_)
      .post('/api/v1/items')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ sku: 'PAINT-E2E', name: 'Paint 5L', type: 'GOODS', taxCode: 'B', unit: 'tin', defaultPriceMinor: 8000, incomeAccountId: acc['4000'] })
      .expect(201);
    const paintId = resp.body.id;

    await request(http_)
      .patch(`/api/v1/items/${paintId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ tracked: true, inventoryAccountId: acc['1450'] })
      .expect(200);
    await request(http_).post(`/api/v1/items/${paintId}/register-ebm`).set('Authorization', `Bearer ${ownerToken}`).expect(201);

    // Three reportable movements.
    await request(http_)
      .post('/api/v1/stock/opening-balances')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ itemId: paintId, qty: 20, unitCostMinor: 4000 })
      .expect(201);
    await request(http_)
      .post('/api/v1/stock/adjustments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ itemId: paintId, qtyDelta: 2, reason: 'stocktake surplus' })
      .expect(201);
    await request(http_)
      .post('/api/v1/stock/adjustments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ itemId: paintId, qtyDelta: -1, reason: 'breakage' })
      .expect(201);

    // "Crash" after the first movement: everything past 1 success fails.
    vsdcState.stockMovementsSuccessCount = 0;
    vsdcState.stockMovementsSucceedFirstN = 1;
    const run1 = await request(http_).post('/api/v1/stock/ebm-report-movements').set('Authorization', `Bearer ${ownerToken}`).expect(201);
    expect(run1.body.reported).toBe(1);

    // Recovered: the rerun reports only what's still outstanding.
    vsdcState.stockMovementsSucceedFirstN = null;
    const run2 = await request(http_).post('/api/v1/stock/ebm-report-movements').set('Authorization', `Bearer ${ownerToken}`).expect(201);
    expect(run2.body.reported).toBe(2);

    // Nothing left: a third run re-sends nothing.
    const run3 = await request(http_).post('/api/v1/stock/ebm-report-movements').set('Authorization', `Bearer ${ownerToken}`).expect(201);
    expect(run3.body.reported).toBe(0);

    // Exactly one successful VSDC call per movement, ever.
    expect(vsdcState.stockMovementsSuccessCount).toBe(3);
    const unreported = await prisma.forTenant(tenantId, (tx: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
      tx.stockMovement.count({ where: { itemId: paintId, ebmReportedAt: null } }),
    );
    expect(unreported).toBe(0);

    await prisma.tenant.update({ where: { id: tenantId }, data: { ebmMode: 'DISABLED' } });
  });
});
