import { Injectable } from '@nestjs/common';
import PDFDocument = require('pdfkit');

export interface ReconciliationReportData {
  financialAccountName: string;
  periodStart: string;
  periodEnd: string;
  statementClosingBalanceMinor: string;
  glClosingBalanceMinor: string | null;
  differenceMinor: string | null;
  status: 'OPEN' | 'COMPLETED';
  completedAt: string | null;
  matchedCount: number;
  excludedCount: number;
  unmatchedCount: number;
}

/** The attestation artifact (spec §11): proof this register was reconciled to the franc, by whom, and when. */
@Injectable()
export class ReconciliationReportRenderer {
  async render(data: ReconciliationReportData): Promise<Buffer> {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

    doc.fontSize(18).text('Reconciliation Report', { align: 'center' });
    doc.moveDown();
    doc.fontSize(11);
    doc.text(`Account: ${data.financialAccountName}`);
    doc.text(`Period: ${data.periodStart} to ${data.periodEnd}`);
    doc.text(`Status: ${data.status}`);
    doc.moveDown();
    doc.text(`Statement closing balance: ${data.statementClosingBalanceMinor}`);
    doc.text(`GL closing balance: ${data.glClosingBalanceMinor ?? '(not yet computed)'}`);
    doc.text(`Difference: ${data.differenceMinor ?? '(not yet computed)'}`);
    doc.moveDown();
    doc.text(`Matched lines: ${data.matchedCount}`);
    doc.text(`Excluded lines: ${data.excludedCount}`);
    doc.text(`Unmatched lines: ${data.unmatchedCount}`);
    doc.moveDown();

    if (data.status === 'COMPLETED') {
      doc.fontSize(12).text(`Certified reconciled as of ${data.completedAt}`, { underline: true });
    } else {
      doc.fontSize(11).fillColor('red').text('THIS SESSION IS NOT YET COMPLETE', { align: 'center' }).fillColor('black');
    }

    doc.end();
    return done;
  }
}
