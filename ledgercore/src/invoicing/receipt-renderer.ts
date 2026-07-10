import { Injectable } from '@nestjs/common';
import * as QRCode from 'qrcode';
// pdfkit's CommonJS export is a bare class (module.exports = PDFDocument),
// with no __esModule interop flag — a plain `import ... from` compiles to
// `.default` under this project's tsconfig (no esModuleInterop) and fails
// at runtime with "not a constructor". import-equals gets the real export.
import PDFDocument = require('pdfkit');

export interface ReceiptData {
  documentLabel: string; // 'INVOICE' | 'CREDIT NOTE'
  documentNo: string | null;
  issueDate: Date | null;
  contactName: string;
  contactTin: string | null;
  currency: string;
  subtotalMinor: bigint;
  vatMinor: bigint;
  totalMinor: bigint;
  lines: { description: string; qty: string; unitPriceMinor: bigint; taxCode: string; lineTotalMinor: bigint }[];
  receipt: {
    receiptType: 'NORMAL' | 'COPY' | 'TRAINING' | 'PROFORMA';
    rraReceiptNo: string | null;
    sdcId: string | null;
    internalData: string | null;
    receiptSignature: string | null;
    qrPayload: string | null;
  } | null;
  isEbmDocument: boolean; // false when tenant.ebm_mode = DISABLED
}

/**
 * NORMAL receipts show the RRA fields (SDC id, receipt no, internal data,
 * signature, QR). Every other case — PROFORMA/TRAINING/COPY receipt types,
 * or a non-EBM tenant entirely — gets the distinguishing marks spec §5
 * requires: the type designation under the header, and "THIS IS NOT AN
 * OFFICIAL RECEIPT" under the totals.
 */
@Injectable()
export class ReceiptRenderer {
  async render(data: ReceiptData): Promise<Buffer> {
    const doc = new PDFDocument({ size: 'A5', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

    const isOfficial = data.isEbmDocument && data.receipt?.receiptType === 'NORMAL';

    doc.fontSize(16).text(data.documentLabel, { align: 'center' });
    if (!isOfficial) {
      const label = !data.isEbmDocument ? 'NON-EBM DOCUMENT' : data.receipt?.receiptType ?? 'DRAFT';
      doc.fontSize(10).fillColor('red').text(label, { align: 'center' }).fillColor('black');
    }
    doc.moveDown();

    doc.fontSize(10);
    doc.text(`Document No: ${data.documentNo ?? '(not yet issued)'}`);
    doc.text(`Date: ${data.issueDate ? data.issueDate.toISOString().slice(0, 10) : '-'}`);
    doc.text(`Customer: ${data.contactName}${data.contactTin ? ` (TIN ${data.contactTin})` : ''}`);
    doc.moveDown();

    for (const line of data.lines) {
      doc.text(
        `${line.description}  x${line.qty}  @ ${line.unitPriceMinor} [${line.taxCode}]  = ${line.lineTotalMinor} ${data.currency}`,
      );
    }
    doc.moveDown();
    doc.text(`Subtotal: ${data.subtotalMinor} ${data.currency}`);
    doc.text(`VAT: ${data.vatMinor} ${data.currency}`);
    doc.fontSize(12).text(`Total: ${data.totalMinor} ${data.currency}`, { underline: true });
    doc.fontSize(10);
    doc.moveDown();

    if (isOfficial && data.receipt) {
      doc.text(`SDC ID: ${data.receipt.sdcId}`);
      doc.text(`RRA Receipt No: ${data.receipt.rraReceiptNo}`);
      doc.text(`Internal Data: ${data.receipt.internalData}`);
      doc.text(`Signature: ${data.receipt.receiptSignature}`);
      if (data.receipt.qrPayload) {
        const qrDataUrl = await QRCode.toDataURL(data.receipt.qrPayload, { margin: 0 });
        const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');
        doc.image(qrBuffer, { fit: [100, 100] });
      }
    } else {
      doc.moveDown();
      doc.fontSize(11).fillColor('red').text('THIS IS NOT AN OFFICIAL RECEIPT', { align: 'center' }).fillColor('black');
    }

    doc.end();
    return done;
  }
}
