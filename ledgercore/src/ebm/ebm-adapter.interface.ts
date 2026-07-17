// EbmAdapter is the anti-corruption layer between LedgerCore and RRA's VSDC
// (or a future OSDC/other CIS backend). No VSDC field names or wire formats
// may leak past this boundary — every driver implementation translates its
// own request/response shapes into these plain types. If RRA revs the spec,
// or a tenant needs a different device backend, only the driver changes.

export type EbmOutcome = 'OK' | 'RETRYABLE' | 'FATAL';

export interface EbmCallResult<T> {
  outcome: EbmOutcome;
  httpStatus?: number;
  request: unknown;
  response: unknown;
  data?: T;
  errorMessage?: string;
}

export interface DeviceConfig {
  sdcId: string;
  mrc?: string;
  config: Record<string, unknown>;
}

export interface RraCodeEntry {
  codeType: string;
  code: string;
  name: string;
}

export interface ItemRegistrationRequest {
  sku: string;
  name: string;
  type: 'GOODS' | 'SERVICE';
  taxCode: 'A' | 'B' | 'C' | 'D';
  unit: string;
}

export interface ItemRegistrationResult {
  rraItemCode: string;
  rraItemClassCode?: string;
}

export interface CertifyLineInput {
  rraItemCode: string;
  description: string;
  qty: string;
  unitPriceMinor: string;
  taxCode: 'A' | 'B' | 'C' | 'D';
  lineNetMinor: string;
  lineVatMinor: string;
  lineTotalMinor: string;
}

export interface CertifySaleRequest {
  invoiceUuid: string;
  buyerTin?: string;
  buyerName?: string;
  currency: string;
  subtotalMinor: string;
  vatMinor: string;
  totalMinor: string;
  lines: CertifyLineInput[];
}

export interface CertifyCreditNoteRequest extends CertifySaleRequest {
  originalRraReceiptNo: string;
  reasonCode: string;
  reasonText?: string;
}

export interface CertifyReceipt {
  rraReceiptNo: string;
  sdcId: string;
  internalData: string;
  receiptSignature: string;
  qrPayload: string;
  vsdcDatetime: string;
}

export interface PurchaseRecord {
  supplierTin: string;
  supplierName: string;
  supplierReceiptNo: string;
  purchaseDate: string;
  currency: string;
  subtotalMinor: string;
  vatMinor: string;
  totalMinor: string;
  lines: {
    description: string;
    qty: string;
    unitPriceMinor: string;
    taxCode: 'A' | 'B' | 'C' | 'D';
    lineNetMinor: string;
    lineVatMinor: string;
    lineTotalMinor: string;
  }[];
}

export interface HealthStatus {
  lastSuccessfulSyncAt: string | null;
  hoursSinceLastSync: number | null;
  hoursRemaining: number | null;
  locked: boolean;
}

export interface StockMovementReport {
  rraItemCode: string;
  movementType: 'OPENING' | 'PURCHASE' | 'SALE' | 'CREDIT_NOTE_RETURN' | 'ADJUSTMENT';
  qtyDelta: string;
  unitCostMinor: string;
  movementDate: string;
}

export interface EbmAdapter {
  readonly name: string;

  init(params: { tenantId: string; tin: string; branchId: string; deviceSerial: string }): Promise<EbmCallResult<DeviceConfig>>;

  syncCodes(params: { tenantId: string }): Promise<EbmCallResult<RraCodeEntry[]>>;

  registerItem(params: { tenantId: string; item: ItemRegistrationRequest }): Promise<EbmCallResult<ItemRegistrationResult>>;

  certifySale(params: { tenantId: string; sale: CertifySaleRequest }): Promise<EbmCallResult<CertifyReceipt>>;

  certifyCreditNote(params: { tenantId: string; creditNote: CertifyCreditNoteRequest }): Promise<EbmCallResult<CertifyReceipt>>;

  syncPurchases(params: { tenantId: string }): Promise<EbmCallResult<PurchaseRecord[]>>;

  health(params: { tenantId: string }): Promise<EbmCallResult<HealthStatus>>;

  /** Registers an item as stock-tracked with the VSDC — required before its movements can be reported (spec §6). */
  registerStockItem(params: { tenantId: string; rraItemCode: string }): Promise<EbmCallResult<{ registered: true }>>;

  /** Reports a single stock in/out movement. Called once per stock_movement row; never batches, so retry/idempotency stays at the movement grain. */
  reportStockMovement(params: { tenantId: string; movement: StockMovementReport }): Promise<EbmCallResult<{ acknowledged: true }>>;
}
