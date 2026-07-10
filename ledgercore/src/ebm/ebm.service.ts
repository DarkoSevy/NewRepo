import { Injectable } from '@nestjs/common';
import { EbmMode } from '@prisma/client';
import { TenantTx } from '../prisma/prisma.service';
import { NullDriver } from './drivers/null.driver';
import { VsdcDriver } from './drivers/vsdc.driver';
import {
  CertifyCreditNoteRequest,
  CertifyReceipt,
  CertifySaleRequest,
  EbmAdapter,
  EbmCallResult,
  ItemRegistrationRequest,
  ItemRegistrationResult,
} from './ebm-adapter.interface';

/**
 * The one door other modules (items, invoicing, AP sync) knock on for any
 * RRA interaction. Selects NullDriver vs VsdcDriver per tenant.ebm_mode and
 * logs every exchange to `ebm_transactions` — this doubles as certification
 * evidence (spec §2).
 */
@Injectable()
export class EbmService {
  constructor(
    private readonly nullDriver: NullDriver,
    private readonly vsdcDriver: VsdcDriver,
  ) {}

  private driverFor(ebmMode: EbmMode): EbmAdapter {
    return ebmMode === 'VSDC' ? this.vsdcDriver : this.nullDriver;
  }

  private async logAndReturn<T>(
    tx: TenantTx,
    tenantId: string,
    endpoint: string,
    attempt: number,
    result: EbmCallResult<T>,
  ): Promise<EbmCallResult<T>> {
    await tx.ebmTransaction.create({
      data: {
        tenantId,
        direction: 'OUTBOUND',
        endpoint,
        request: (result.request ?? {}) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        response: (result.response ?? undefined) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        httpStatus: result.httpStatus,
        outcome: result.outcome,
        attempt,
      },
    });
    return result;
  }

  async registerItem(
    tx: TenantTx,
    tenantId: string,
    ebmMode: EbmMode,
    item: ItemRegistrationRequest,
    attempt = 1,
  ): Promise<EbmCallResult<ItemRegistrationResult>> {
    const result = await this.driverFor(ebmMode).registerItem({ tenantId, item });
    return this.logAndReturn(tx, tenantId, '/items', attempt, result);
  }

  async certifySale(
    tx: TenantTx,
    tenantId: string,
    ebmMode: EbmMode,
    sale: CertifySaleRequest,
    attempt = 1,
  ): Promise<EbmCallResult<CertifyReceipt>> {
    const result = await this.driverFor(ebmMode).certifySale({ tenantId, sale });
    return this.logAndReturn(tx, tenantId, '/sales', attempt, result);
  }

  async certifyCreditNote(
    tx: TenantTx,
    tenantId: string,
    ebmMode: EbmMode,
    creditNote: CertifyCreditNoteRequest,
    attempt = 1,
  ): Promise<EbmCallResult<CertifyReceipt>> {
    const result = await this.driverFor(ebmMode).certifyCreditNote({ tenantId, creditNote });
    return this.logAndReturn(tx, tenantId, '/creditnotes', attempt, result);
  }

  async syncCodes(tx: TenantTx, tenantId: string, ebmMode: EbmMode) {
    const result = await this.driverFor(ebmMode).syncCodes({ tenantId });
    await this.logAndReturn(tx, tenantId, '/codes', 1, result);
    if (result.outcome === 'OK' && result.data) {
      for (const entry of result.data) {
        await tx.rraCode.upsert({
          where: { tenantId_codeType_code: { tenantId, codeType: entry.codeType, code: entry.code } },
          create: { tenantId, codeType: entry.codeType, code: entry.code, name: entry.name },
          update: { name: entry.name, syncedAt: new Date() },
        });
      }
    }
    return result;
  }

  async syncPurchases(tx: TenantTx, tenantId: string, ebmMode: EbmMode) {
    const result = await this.driverFor(ebmMode).syncPurchases({ tenantId });
    return this.logAndReturn(tx, tenantId, '/purchases', 1, result);
  }

  async initDevice(tx: TenantTx, tenantId: string, ebmMode: EbmMode, params: { tin: string; branchId: string; deviceSerial: string }) {
    const result = await this.driverFor(ebmMode).init({ tenantId, ...params });
    await this.logAndReturn(tx, tenantId, '/initializer', 1, result);
    if (result.outcome === 'OK' && result.data) {
      await tx.ebmDevice.upsert({
        where: { tenantId },
        create: {
          tenantId,
          tin: params.tin,
          branchId: params.branchId,
          deviceSerial: params.deviceSerial,
          sdcId: result.data.sdcId,
          mrc: result.data.mrc,
          config: result.data.config as any, // eslint-disable-line @typescript-eslint/no-explicit-any
          activatedAt: new Date(),
        },
        update: {
          tin: params.tin,
          branchId: params.branchId,
          deviceSerial: params.deviceSerial,
          sdcId: result.data.sdcId,
          mrc: result.data.mrc,
          config: result.data.config as any, // eslint-disable-line @typescript-eslint/no-explicit-any
          activatedAt: new Date(),
        },
      });
    }
    return result;
  }

  async health(tx: TenantTx, tenantId: string, ebmMode: EbmMode) {
    const result = await this.driverFor(ebmMode).health({ tenantId });
    if (result.outcome === 'OK' && result.data) {
      await tx.ebmDevice.updateMany({ where: { tenantId }, data: { lastSyncAt: new Date() } });
    }
    return result;
  }
}
