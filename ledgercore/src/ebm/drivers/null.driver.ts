import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import {
  CertifyCreditNoteRequest,
  CertifyReceipt,
  CertifySaleRequest,
  DeviceConfig,
  EbmAdapter,
  EbmCallResult,
  HealthStatus,
  ItemRegistrationRequest,
  ItemRegistrationResult,
  PurchaseRecord,
  RraCodeEntry,
  StockMovementReport,
} from '../ebm-adapter.interface';

/**
 * For tenant.ebm_mode = DISABLED and local development. Never talks to RRA.
 * Every receipt it produces is clearly non-official (`sdcId` prefixed
 * `NULL-`) — ReceiptsService/receipt rendering watermarks these as
 * "NOT AN OFFICIAL RECEIPT" regardless of receipt type, per spec §2/§5.
 */
@Injectable()
export class NullDriver implements EbmAdapter {
  readonly name = 'NULL';

  async init(params: { tenantId: string; tin: string; branchId: string; deviceSerial: string }): Promise<EbmCallResult<DeviceConfig>> {
    return ok(params, { sdcId: `NULL-${params.tenantId.slice(0, 8)}`, config: { driver: 'NULL' } });
  }

  async syncCodes(params: { tenantId: string }): Promise<EbmCallResult<RraCodeEntry[]>> {
    return ok(params, []);
  }

  async registerItem(params: { tenantId: string; item: ItemRegistrationRequest }): Promise<EbmCallResult<ItemRegistrationResult>> {
    return ok(params, { rraItemCode: `NULL-ITEM-${randomUUID().slice(0, 8)}` });
  }

  async certifySale(params: { tenantId: string; sale: CertifySaleRequest }): Promise<EbmCallResult<CertifyReceipt>> {
    return ok(params, fakeReceipt());
  }

  async certifyCreditNote(params: { tenantId: string; creditNote: CertifyCreditNoteRequest }): Promise<EbmCallResult<CertifyReceipt>> {
    return ok(params, fakeReceipt());
  }

  async syncPurchases(params: { tenantId: string }): Promise<EbmCallResult<PurchaseRecord[]>> {
    return ok(params, []);
  }

  async health(params: { tenantId: string }): Promise<EbmCallResult<HealthStatus>> {
    return ok(params, { lastSuccessfulSyncAt: new Date().toISOString(), hoursSinceLastSync: 0, hoursRemaining: null, locked: false });
  }

  async registerStockItem(params: { tenantId: string; rraItemCode: string }): Promise<EbmCallResult<{ registered: true }>> {
    return ok(params, { registered: true });
  }

  async reportStockMovement(params: { tenantId: string; movement: StockMovementReport }): Promise<EbmCallResult<{ acknowledged: true }>> {
    return ok(params, { acknowledged: true });
  }
}

function fakeReceipt(): CertifyReceipt {
  return {
    rraReceiptNo: `NULL-${randomUUID()}`,
    sdcId: 'NULL-DRIVER',
    internalData: 'NULLDRIVERINTERNALDATA00X', // 26 chars, clearly fake
    receiptSignature: 'NULLDRIVERSIGNAT', // 16 chars, clearly fake
    qrPayload: 'NOT-AN-EBM-DOCUMENT',
    vsdcDatetime: new Date().toISOString(),
  };
}

function ok<T>(request: unknown, data: T): EbmCallResult<T> {
  return { outcome: 'OK', request, response: data, data };
}
