import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { execSync } from 'child_process';
import * as path from 'path';
import * as http from 'http';
import { AddressInfo } from 'net';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let AppModule: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let PrismaService: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let InvoicesService: any;

jest.setTimeout(180_000);

function fakeReceiptBody(no: string) {
  return {
    rcptNo: no,
    sdcId: 'SDC-TEST',
    intrlData: 'X'.repeat(26),
    rcptSign: 'Y'.repeat(16),
    qrCodeUrl: 'qr-payload',
    vsdcRcptPbctDate: new Date().toISOString(),
  };
}

interface FakeVsdcState {
  itemsHandler: (body: any) => { status: number; body: unknown }; // eslint-disable-line @typescript-eslint/no-explicit-any
  salesHandler: (body: any) => { status: number; body: unknown }; // eslint-disable-line @typescript-eslint/no-explicit-any
  creditNotesHandler: (body: any) => { status: number; body: unknown }; // eslint-disable-line @typescript-eslint/no-explicit-any
  salesDelayMs: number;
  salesCallCount: number;
}

function startFakeVsdc(): { server: http.Server; state: FakeVsdcState } {
  const state: FakeVsdcState = {
    itemsHandler: () => ({ status: 200, body: { itemCd: 'FAKE-ITEM-1' } }),
    salesHandler: () => ({ status: 200, body: fakeReceiptBody(`R-${Math.random().toString(36).slice(2)}`) }),
    creditNotesHandler: () => ({ status: 200, body: fakeReceiptBody(`CN-${Math.random().toString(36).slice(2)}`) }),
    salesDelayMs: 0,
    salesCallCount: 0,
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : {};
      const url = req.url ?? '';
      let result: { status: number; body: unknown };
      if (url.endsWith('/items')) {
        result = state.itemsHandler(body);
      } else if (url.endsWith('/sales')) {
        state.salesCallCount++;
        if (state.salesDelayMs) await new Promise((r) => setTimeout(r, state.salesDelayMs));
        result = state.salesHandler(body);
      } else if (url.endsWith('/creditnotes')) {
        result = state.creditNotesHandler(body);
      } else {
        result = { status: 200, body: {} };
      }
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });

  return { server, state };
}

describe('LedgerCore Phase 2 acceptance (e2e)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let prisma: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let invoicesService: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let http_: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let vsdcServer: http.Server;
  let vsdcState: FakeVsdcState;

  let tenantId: string;
  let ownerToken: string;
  let cashId: string;
  let revenueId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16')
      .withDatabase('ledgercore_test2')
      .withUsername('ledgercore')
      .withPassword('ledgercore')
      .start();

    const ownerUrl = `postgresql://ledgercore:ledgercore@${container.getHost()}:${container.getPort()}/ledgercore_test2?schema=public`;
    const appUrl = `postgresql://ledgercore_app:ledgercore_app@${container.getHost()}:${container.getPort()}/ledgercore_test2?schema=public`;

    process.env.DATABASE_URL = ownerUrl;
    process.env.APP_DATABASE_URL = appUrl;
    process.env.JWT_SECRET = 'test-only-secret';
    process.env.JWT_EXPIRES_IN = '1h';
    process.env.CERTIFY_BACKOFF_BASE_MS = '50';

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
    ({ InvoicesService } = await import('../src/invoicing/invoices.service'));
    const { patchBigIntJson } = await import('../src/common/bigint-json');
    patchBigIntJson();

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();

    prisma = app.get(PrismaService);
    invoicesService = app.get(InvoicesService);
    http_ = app.getHttpServer();

    const tenantResp = await request(http_)
      .post('/api/v1/tenants')
      .send({ name: 'Kigali Tours Ltd', ownerEmail: 'owner@kigalitours.rw', ownerPassword: 'supersecret1' })
      .expect(201);
    tenantId = tenantResp.body.tenant.id;

    const loginResp = await request(http_)
      .post('/api/v1/auth/login')
      .send({ tenantId, email: 'owner@kigalitours.rw', password: 'supersecret1' })
      .expect(201);
    ownerToken = loginResp.body.accessToken;

    await request(http_).post('/api/v1/accounts/seed-template?template=rw-sme').set('Authorization', `Bearer ${ownerToken}`).expect(201);
    await request(http_).post('/api/v1/periods/generate?year=2026').set('Authorization', `Bearer ${ownerToken}`).expect(201);

    const accountsResp = await request(http_).get('/api/v1/accounts').set('Authorization', `Bearer ${ownerToken}`).expect(200);
    cashId = accountsResp.body.flat.find((a: any) => a.code === '1000').id; // eslint-disable-line @typescript-eslint/no-explicit-any
    revenueId = accountsResp.body.flat.find((a: any) => a.code === '4100').id; // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  afterAll(async () => {
    await new Promise((resolve) => vsdcServer.close(resolve));
    await app.close();
    await container.stop();
  });

  async function makeContact(name: string) {
    const resp = await request(http_)
      .post('/api/v1/contacts')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ kind: 'CUSTOMER', name, tin: '123456789' })
      .expect(201);
    return resp.body.id;
  }

  async function makeItem(sku: string, priceMinor = 10000) {
    const resp = await request(http_)
      .post('/api/v1/items')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ sku, name: sku, type: 'SERVICE', taxCode: 'B', unit: 'unit', defaultPriceMinor: priceMinor, incomeAccountId: revenueId })
      .expect(201);
    return resp.body.id;
  }

  async function draftInvoice(contactId: string, itemId: string, qty = 1) {
    const resp = await request(http_)
      .post('/api/v1/invoices')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ contactId, lines: [{ itemId, qty }] })
      .expect(201);
    return resp.body;
  }

  async function pollUntilSettled(invoiceId: string, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const resp = await request(http_).get(`/api/v1/invoices/${invoiceId}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      if (resp.body.status !== 'CERTIFYING') return resp.body.status;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Invoice ${invoiceId} did not settle within ${timeoutMs}ms`);
  }

  it('issues successfully with an unregistered item under NullDriver (ebm_mode DISABLED)', async () => {
    const contactId = await makeContact('NullDriver Co');
    const itemId = await makeItem('NULL-ITEM-1');
    const invoice = await draftInvoice(contactId, itemId);

    const issued = await request(http_).post(`/api/v1/invoices/${invoice.id}/issue`).set('Authorization', `Bearer ${ownerToken}`).expect(202);
    expect(issued.body.status).toBe('CERTIFYING');
    const finalStatus = await pollUntilSettled(invoice.id);
    expect(finalStatus).toBe('ISSUED');
  });

  it('blocks issuance of an unregistered item under ebm_mode VSDC, then succeeds once registered', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { ebmMode: 'VSDC' } });

    const contactId = await makeContact('VSDC Blocked Co');
    const itemId = await makeItem('VSDC-ITEM-1');
    const invoice = await draftInvoice(contactId, itemId);

    const blocked = await request(http_).post(`/api/v1/invoices/${invoice.id}/issue`).set('Authorization', `Bearer ${ownerToken}`).expect(400);
    expect(blocked.body.message).toMatch(/not registered with EBM/);

    await request(http_).post(`/api/v1/items/${itemId}/register-ebm`).set('Authorization', `Bearer ${ownerToken}`).expect(201);

    const issued = await request(http_).post(`/api/v1/invoices/${invoice.id}/issue`).set('Authorization', `Bearer ${ownerToken}`).expect(202);
    expect(issued.body.status).toBe('CERTIFYING');
    const finalStatus = await pollUntilSettled(invoice.id);
    expect(finalStatus).toBe('ISSUED');

    await prisma.tenant.update({ where: { id: tenantId }, data: { ebmMode: 'DISABLED' } });
  });

  it('blocks receipt fetch while CERTIFYING, allows it once ISSUED', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { ebmMode: 'VSDC' } });
    vsdcState.salesDelayMs = 300;

    const contactId = await makeContact('Receipt Timing Co');
    const itemId = await makeItem('VSDC-ITEM-2');
    await request(http_).post(`/api/v1/items/${itemId}/register-ebm`).set('Authorization', `Bearer ${ownerToken}`).expect(201);
    const invoice = await draftInvoice(contactId, itemId);

    await request(http_).post(`/api/v1/invoices/${invoice.id}/issue`).set('Authorization', `Bearer ${ownerToken}`).expect(202);

    const midFlightReceipt = await request(http_)
      .get(`/api/v1/invoices/${invoice.id}/receipt.pdf`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(midFlightReceipt.status).toBe(400);
    expect(midFlightReceipt.body.message).toMatch(/Receipt not available/);

    const finalStatus = await pollUntilSettled(invoice.id, 15_000);
    expect(finalStatus).toBe('ISSUED');

    const receipt = await request(http_)
      .get(`/api/v1/invoices/${invoice.id}/receipt.pdf`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(receipt.headers['content-type']).toBe('application/pdf');

    vsdcState.salesDelayMs = 0;
    await prisma.tenant.update({ where: { id: tenantId }, data: { ebmMode: 'DISABLED' } });
  });

  it('produces exactly one ebm_receipt and one GL entry under a concurrent certify retry storm', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { ebmMode: 'VSDC' } });
    vsdcState.salesDelayMs = 100;

    const contactId = await makeContact('Retry Storm Co');
    const itemId = await makeItem('VSDC-ITEM-3');
    await request(http_).post(`/api/v1/items/${itemId}/register-ebm`).set('Authorization', `Bearer ${ownerToken}`).expect(201);
    const invoice = await draftInvoice(contactId, itemId);

    const salesCallsBefore = vsdcState.salesCallCount;

    await request(http_).post(`/api/v1/invoices/${invoice.id}/issue`).set('Authorization', `Bearer ${ownerToken}`).expect(202);

    // Simulate a retry storm: several concurrent certify attempts racing the
    // one already dispatched by issue()'s setImmediate. Without the
    // per-invoice advisory lock in runCertifyLoop, every one of these could
    // reach VSDC independently (a real, duplicate external certification per
    // call) even though only one receipt ever lands in the DB.
    await Promise.all([
      invoicesService.certifyInvoice(tenantId, invoice.id),
      invoicesService.certifyInvoice(tenantId, invoice.id),
      invoicesService.certifyInvoice(tenantId, invoice.id),
    ]);
    await pollUntilSettled(invoice.id, 15_000);

    expect(vsdcState.salesCallCount - salesCallsBefore).toBe(1);

    const receipts = await prisma.forTenant(tenantId, (tx: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
      tx.ebmReceipt.findMany({ where: { invoiceId: invoice.id, receiptType: 'NORMAL' } }),
    );
    expect(receipts).toHaveLength(1);

    const glEntries = await prisma.forTenant(tenantId, (tx: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
      tx.journalEntry.findMany({ where: { source: 'SYSTEM' } }),
    );
    const matching = glEntries.filter((e: any) => (e.sourceDocumentRef as any)?.id === invoice.id); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(matching).toHaveLength(1);

    const finalInvoice = await request(http_).get(`/api/v1/invoices/${invoice.id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect(finalInvoice.body.status).toBe('ISSUED');
    expect(finalInvoice.body.invoiceNo).toBeTruthy();

    vsdcState.salesDelayMs = 0;
    await prisma.tenant.update({ where: { id: tenantId }, data: { ebmMode: 'DISABLED' } });
  });

  it('rejects a credit note exceeding the remaining creditable balance', async () => {
    const contactId = await makeContact('Credit Note Co');
    const itemId = await makeItem('CN-ITEM-1', 10000);
    // qty 2 => net 20000, vat 3600, total 23600
    const invoice = await draftInvoice(contactId, itemId, 2);
    await request(http_).post(`/api/v1/invoices/${invoice.id}/issue`).set('Authorization', `Bearer ${ownerToken}`).expect(202);
    await pollUntilSettled(invoice.id);

    // Partial credit (qty 1 => total 11800) leaves the invoice ISSUED, not
    // CREDITED, with 11800 of remaining creditable balance.
    const cn1 = await request(http_)
      .post('/api/v1/credit-notes')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ originalInvoiceId: invoice.id, reasonCode: 'RETURN', lines: [{ itemId, qty: 1 }] })
      .expect(201);
    await request(http_).post(`/api/v1/credit-notes/${cn1.body.id}/issue`).set('Authorization', `Bearer ${ownerToken}`).expect(202);

    const deadline = Date.now() + 10_000;
    let cn1Status = '';
    while (Date.now() < deadline) {
      const cn = await request(http_).get(`/api/v1/credit-notes/${cn1.body.id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
      cn1Status = cn.body.status;
      if (cn1Status !== 'CERTIFYING') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(cn1Status).toBe('ISSUED');

    const invAfterCn1 = await request(http_).get(`/api/v1/invoices/${invoice.id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect(invAfterCn1.body.status).toBe('ISSUED'); // still open — only half credited so far

    // Requesting another full-original-amount (qty 2) credit note exceeds
    // the 11800 still remaining.
    const cn2 = await request(http_)
      .post('/api/v1/credit-notes')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ originalInvoiceId: invoice.id, reasonCode: 'RETURN', lines: [{ itemId, qty: 2 }] });
    expect(cn2.status).toBe(400);
    expect(cn2.body.message).toMatch(/exceeds remaining creditable balance/);
  });

  it('rejects payment over-allocation and moves ISSUED -> PARTIALLY_PAID -> PAID at exact thresholds', async () => {
    const contactId = await makeContact('Payments Co');
    const itemId = await makeItem('PAY-ITEM-1', 10000); // net 10000, vat 1800, total 11800
    const invoice = await draftInvoice(contactId, itemId, 1);
    await request(http_).post(`/api/v1/invoices/${invoice.id}/issue`).set('Authorization', `Bearer ${ownerToken}`).expect(202);
    await pollUntilSettled(invoice.id);

    const pay1 = await request(http_)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        direction: 'IN',
        contactId,
        method: 'CASH',
        depositAccountId: cashId,
        amountMinor: 5000,
        date: '2026-02-01',
        allocations: [{ invoiceId: invoice.id, amountMinor: 5000 }],
      })
      .expect(201);
    expect(pay1.body.allocations).toHaveLength(1);

    const afterFirst = await request(http_).get(`/api/v1/invoices/${invoice.id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect(afterFirst.body.status).toBe('PARTIALLY_PAID');

    const overAlloc = await request(http_)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        direction: 'IN',
        contactId,
        method: 'CASH',
        depositAccountId: cashId,
        amountMinor: 10000,
        date: '2026-02-02',
        allocations: [{ invoiceId: invoice.id, amountMinor: 10000 }],
      });
    expect(overAlloc.status).toBe(400);
    expect(overAlloc.body.message).toMatch(/exceeds invoice .* open balance/);

    await request(http_)
      .post('/api/v1/payments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        direction: 'IN',
        contactId,
        method: 'CASH',
        depositAccountId: cashId,
        amountMinor: 6800,
        date: '2026-02-03',
        allocations: [{ invoiceId: invoice.id, amountMinor: 6800 }],
      })
      .expect(201);

    const afterSecond = await request(http_).get(`/api/v1/invoices/${invoice.id}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect(afterSecond.body.status).toBe('PAID');
  });

  it('reconciles the AR control account to the sum of open invoice balances across a 200-document fixture', async () => {
    const contactId = await makeContact('Bulk Fixture Co');
    const itemId = await makeItem('BULK-ITEM-1', 1000); // net 1000, vat 180, total 1180
    const user = { userId: (await prisma.forTenant(tenantId, (tx: any) => tx.user.findFirst({ where: { tenantId } }))).id, tenantId, role: 'OWNER' }; // eslint-disable-line @typescript-eslint/no-explicit-any

    const invoiceIds: string[] = [];
    for (let i = 0; i < 200; i++) {
      const created = await invoicesService.create(user, { contactId, lines: [{ itemId, qty: 1 }] });
      await invoicesService.issue(user, created.id);
      invoiceIds.push(created.id);
    }
    // issue() dispatches certification via setImmediate; give NullDriver's
    // near-instant certify loop a moment to drain for all 200 invoices.
    await new Promise((r) => setTimeout(r, 3000));

    // Pay off every third invoice in full, to exercise both open and closed documents in the reconciliation.
    for (let i = 0; i < invoiceIds.length; i += 3) {
      const invoice = await prisma.forTenant(tenantId, (tx: any) => tx.invoice.findUnique({ where: { id: invoiceIds[i] } })); // eslint-disable-line @typescript-eslint/no-explicit-any
      if (invoice.status !== 'ISSUED') continue;
      await request(http_)
        .post('/api/v1/payments')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          direction: 'IN',
          contactId,
          method: 'CASH',
          depositAccountId: cashId,
          amountMinor: 1180,
          date: '2026-03-01',
          allocations: [{ invoiceId: invoiceIds[i], amountMinor: 1180 }],
        })
        .expect(201);
    }

    const openInvoices: { id: string; totalMinor: bigint }[] = await prisma.forTenant(tenantId, (tx: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
      tx.invoice.findMany({ where: { tenantId, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } } }),
    );
    const allocRows: { invoiceId: string | null; _sum: { amountMinor: bigint | null } }[] = await prisma.forTenant(tenantId, (tx: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
      tx.paymentAllocation.groupBy({ by: ['invoiceId'], _sum: { amountMinor: true }, where: { invoiceId: { not: null } } }),
    );
    const paidByInvoice = new Map<string, bigint>();
    for (const row of allocRows) {
      if (row.invoiceId) paidByInvoice.set(row.invoiceId, row._sum.amountMinor ?? 0n);
    }

    // Other tests in this shared-tenant suite may have left ISSUED invoices
    // partially credit-noted (e.g. the credit-note test) — those reduce the
    // true open balance too, exactly like payments do.
    const creditRows: { original_invoice_id: string; credited: bigint | string }[] = await prisma.forTenant(tenantId, (tx: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
      tx.$queryRaw`SELECT original_invoice_id, SUM(total_minor) AS credited FROM credit_notes WHERE tenant_id = ${tenantId} AND status = 'ISSUED' GROUP BY original_invoice_id`,
    );
    const creditedByInvoice = new Map<string, bigint>();
    for (const row of creditRows) {
      creditedByInvoice.set(row.original_invoice_id, typeof row.credited === 'bigint' ? row.credited : BigInt(row.credited.toString()));
    }

    let expectedAr = 0n;
    for (const inv of openInvoices) {
      const paid: bigint = paidByInvoice.get(inv.id) ?? 0n;
      const credited: bigint = creditedByInvoice.get(inv.id) ?? 0n;
      expectedAr += inv.totalMinor - paid - credited;
    }

    const tb = await request(http_).get('/api/v1/reports/trial-balance?as_of=2026-12-31').set('Authorization', `Bearer ${ownerToken}`).expect(200);
    const arRow = tb.body.accounts.find((a: any) => a.code === '1100'); // eslint-disable-line @typescript-eslint/no-explicit-any

    expect(arRow.closingBalance).toBe(expectedAr.toString());
  });

  it('VAT return report totals reconcile exactly to VAT Output/Input ledger movements', async () => {
    // A taxable direct expense (no bill, no draft stage) posts VAT Input the
    // same way a bill does — the report must fold it into the input side or
    // inputVat understates the ledger and inputMatches goes false.
    const accountsResp = await request(http_).get('/api/v1/accounts').set('Authorization', `Bearer ${ownerToken}`).expect(200);
    const utilitiesId = accountsResp.body.flat.find((a: any) => a.code === '5300').id; // eslint-disable-line @typescript-eslint/no-explicit-any
    await request(http_)
      .post('/api/v1/expenses')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        expenseAccountId: utilitiesId,
        paidFromAccountId: cashId,
        taxCode: 'B',
        date: new Date().toISOString().slice(0, 10),
        amountMinor: 11800,
      })
      .expect(201);

    // Invoices in this suite are issued with issueDate = "now" (certification
    // time), so the reconciliation window must cover the month this test
    // actually runs in, not a fixed calendar period.
    const period = new Date().toISOString().slice(0, 7);
    const vat = await request(http_).get(`/api/v1/reports/vat-return?period=${period}`).set('Authorization', `Bearer ${ownerToken}`).expect(200);
    expect(vat.body.reconciliation.outputMatches).toBe(true);
    expect(vat.body.reconciliation.inputMatches).toBe(true);
    expect(vat.body.totals.outputVat).toBe(vat.body.reconciliation.ledgerOutputVat);
    expect(vat.body.totals.inputVat).toBe(vat.body.reconciliation.ledgerInputVat);
  });
});
