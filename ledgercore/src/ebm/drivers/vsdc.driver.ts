import { Injectable, Logger } from '@nestjs/common';
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
} from '../ebm-adapter.interface';

/**
 * Real VSDC HTTP client for tenant.ebm_mode = VSDC.
 *
 * IMPORTANT: the endpoint paths and payload shapes below are our best
 * inference from spec §5's function-group description, not a transcription
 * of the actual RRA VSDC technical spec (no sandbox/checkpoint sheet was
 * available while building this). Before the Sprint 4 RRA integration pass,
 * every method here must be checked against the real VSDC WAR's API and
 * adjusted — that is the whole point of keeping this behind the EbmAdapter
 * interface: only this file should need to change.
 */
@Injectable()
export class VsdcDriver implements EbmAdapter {
  readonly name = 'VSDC';
  private readonly logger = new Logger(VsdcDriver.name);
  private readonly baseUrl = process.env.VSDC_BASE_URL ?? 'http://localhost:8088/vsdc';
  private readonly timeoutMs = Number(process.env.VSDC_TIMEOUT_MS ?? 15000);

  async init(params: { tenantId: string; tin: string; branchId: string; deviceSerial: string }): Promise<EbmCallResult<DeviceConfig>> {
    return this.call('/initializer', {
      tin: params.tin,
      bhfId: params.branchId,
      dvcSrlNo: params.deviceSerial,
    }, (body) => ({
      sdcId: body.sdcId,
      mrc: body.mrc,
      config: body,
    }));
  }

  async syncCodes(params: { tenantId: string }): Promise<EbmCallResult<RraCodeEntry[]>> {
    void params;
    return this.call('/codes', {}, (body) =>
      (body.codes ?? []).map((c: any) => ({ codeType: c.cdCls, code: c.cd, name: c.cdNm })), // eslint-disable-line @typescript-eslint/no-explicit-any
    );
  }

  async registerItem(params: { tenantId: string; item: ItemRegistrationRequest }): Promise<EbmCallResult<ItemRegistrationResult>> {
    return this.call('/items', {
      itemNm: params.item.name,
      itemCd: params.item.sku,
      itemClsCd: undefined,
      taxTyCd: params.item.taxCode,
      qtyUnitCd: params.item.unit,
    }, (body) => ({ rraItemCode: body.itemCd, rraItemClassCode: body.itemClsCd }));
  }

  async certifySale(params: { tenantId: string; sale: CertifySaleRequest }): Promise<EbmCallResult<CertifyReceipt>> {
    return this.call('/sales', {
      invcNo: params.sale.invoiceUuid,
      custTin: params.sale.buyerTin,
      custNm: params.sale.buyerName,
      totTaxblAmt: params.sale.subtotalMinor,
      totTaxAmt: params.sale.vatMinor,
      totAmt: params.sale.totalMinor,
      itemList: params.sale.lines,
    }, receiptFromBody);
  }

  async certifyCreditNote(params: { tenantId: string; creditNote: CertifyCreditNoteRequest }): Promise<EbmCallResult<CertifyReceipt>> {
    return this.call('/creditnotes', {
      orgInvcNo: params.creditNote.originalRraReceiptNo,
      rfdRsnCd: params.creditNote.reasonCode,
      custTin: params.creditNote.buyerTin,
      totTaxblAmt: params.creditNote.subtotalMinor,
      totTaxAmt: params.creditNote.vatMinor,
      totAmt: params.creditNote.totalMinor,
      itemList: params.creditNote.lines,
    }, receiptFromBody);
  }

  async syncPurchases(params: { tenantId: string }): Promise<EbmCallResult<PurchaseRecord[]>> {
    void params;
    return this.call('/purchases', {}, (body) => body.purchases ?? []);
  }

  async health(params: { tenantId: string }): Promise<EbmCallResult<HealthStatus>> {
    void params;
    return this.call('/status', {}, (body) => ({
      lastSuccessfulSyncAt: body.lastSyncAt ?? null,
      hoursSinceLastSync: body.hoursSinceLastSync ?? null,
      hoursRemaining: body.hoursRemaining ?? null,
      locked: Boolean(body.locked),
    }));
  }

  private async call<T>(
    path: string,
    payload: unknown,
    mapResponse: (body: any) => T, // eslint-disable-line @typescript-eslint/no-explicit-any
  ): Promise<EbmCallResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const text = await res.text();
      let body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { raw: text };
      }

      if (res.status >= 200 && res.status < 300) {
        return { outcome: 'OK', httpStatus: res.status, request: payload, response: body, data: mapResponse(body) };
      }
      if (res.status >= 400 && res.status < 500) {
        return { outcome: 'FATAL', httpStatus: res.status, request: payload, response: body, errorMessage: body?.message ?? `VSDC rejected ${path} with ${res.status}` };
      }
      return { outcome: 'RETRYABLE', httpStatus: res.status, request: payload, response: body, errorMessage: `VSDC ${path} returned ${res.status}` };
    } catch (err) {
      this.logger.warn(`VSDC call to ${path} failed: ${(err as Error).message}`);
      return { outcome: 'RETRYABLE', request: payload, response: null, errorMessage: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
}

function receiptFromBody(body: any): CertifyReceipt { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    rraReceiptNo: body.rcptNo,
    sdcId: body.sdcId,
    internalData: body.intrlData,
    receiptSignature: body.rcptSign,
    qrPayload: body.qrCodeUrl ?? body.qrData,
    vsdcDatetime: body.vsdcRcptPbctDate ?? new Date().toISOString(),
  };
}
