-- CreateEnum
CREATE TYPE "ContactKind" AS ENUM ('CUSTOMER', 'VENDOR', 'BOTH');

-- CreateEnum
CREATE TYPE "ItemType" AS ENUM ('GOODS', 'SERVICE');

-- CreateEnum
CREATE TYPE "TaxCode" AS ENUM ('A', 'B', 'C', 'D');

-- CreateEnum
CREATE TYPE "PricingMode" AS ENUM ('TAX_EXCLUSIVE', 'TAX_INCLUSIVE');

-- CreateEnum
CREATE TYPE "EbmMode" AS ENUM ('DISABLED', 'VSDC');

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('INVOICE', 'PROFORMA', 'TRAINING');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'CERTIFYING', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'CREDITED', 'CERTIFY_FAILED');

-- CreateEnum
CREATE TYPE "CreditNoteStatus" AS ENUM ('DRAFT', 'CERTIFYING', 'ISSUED', 'CERTIFY_FAILED');

-- CreateEnum
CREATE TYPE "ReceiptType" AS ENUM ('NORMAL', 'COPY', 'TRAINING', 'PROFORMA');

-- CreateEnum
CREATE TYPE "EbmDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "EbmOutcome" AS ENUM ('OK', 'RETRYABLE', 'FATAL');

-- CreateEnum
CREATE TYPE "BillStatus" AS ENUM ('DRAFT', 'APPROVED', 'PARTIALLY_PAID', 'PAID');

-- CreateEnum
CREATE TYPE "BillOrigin" AS ENUM ('MANUAL', 'EBM_SYNC');

-- CreateEnum
CREATE TYPE "PaymentDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK', 'MOMO_MTN', 'MOMO_AIRTEL', 'CARD');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "ebm_mode" "EbmMode" NOT NULL DEFAULT 'DISABLED',
ADD COLUMN     "pricing_mode" "PricingMode" NOT NULL DEFAULT 'TAX_EXCLUSIVE';

-- CreateTable
CREATE TABLE "document_no_sequences" (
    "tenant_id" TEXT NOT NULL,
    "doc_type" TEXT NOT NULL,
    "last_no" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "document_no_sequences_pkey" PRIMARY KEY ("tenant_id","doc_type")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" "ContactKind" NOT NULL,
    "name" TEXT NOT NULL,
    "tin" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "momo_number" TEXT,
    "payment_terms_days" INTEGER NOT NULL DEFAULT 30,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ItemType" NOT NULL,
    "rra_item_class_code" TEXT,
    "rra_item_code" TEXT,
    "tax_code" "TaxCode" NOT NULL,
    "unit" TEXT NOT NULL,
    "default_price_minor" BIGINT NOT NULL,
    "income_account_id" TEXT,
    "expense_account_id" TEXT,
    "ebm_registered_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rates" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" "TaxCode" NOT NULL,
    "rate_bp" INTEGER NOT NULL,
    "valid_from" DATE NOT NULL,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rra_codes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code_type" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rra_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ebm_devices" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "tin" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "device_serial" TEXT NOT NULL,
    "sdc_id" TEXT,
    "mrc" TEXT,
    "config" JSONB,
    "activated_at" TIMESTAMP(3),
    "last_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ebm_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "invoice_no" BIGINT,
    "contact_id" TEXT NOT NULL,
    "kind" "InvoiceKind" NOT NULL DEFAULT 'INVOICE',
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "issue_date" DATE,
    "due_date" DATE,
    "currency" CHAR(3) NOT NULL,
    "subtotal_minor" BIGINT NOT NULL DEFAULT 0,
    "vat_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL DEFAULT 0,
    "notes" TEXT,
    "source_quote_id" TEXT,
    "certify_fail_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "description" TEXT,
    "qty" DECIMAL(12,3) NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "tax_code" "TaxCode" NOT NULL,
    "line_net_minor" BIGINT NOT NULL,
    "line_vat_minor" BIGINT NOT NULL,
    "line_total_minor" BIGINT NOT NULL,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "credit_note_no" BIGINT,
    "original_invoice_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "status" "CreditNoteStatus" NOT NULL DEFAULT 'DRAFT',
    "reason_code" TEXT NOT NULL,
    "reason_text" TEXT,
    "issue_date" DATE,
    "currency" CHAR(3) NOT NULL,
    "subtotal_minor" BIGINT NOT NULL DEFAULT 0,
    "vat_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL DEFAULT 0,
    "notes" TEXT,
    "certify_fail_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_note_lines" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "credit_note_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "description" TEXT,
    "qty" DECIMAL(12,3) NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "tax_code" "TaxCode" NOT NULL,
    "line_net_minor" BIGINT NOT NULL,
    "line_vat_minor" BIGINT NOT NULL,
    "line_total_minor" BIGINT NOT NULL,

    CONSTRAINT "credit_note_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ebm_receipts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "invoice_id" TEXT,
    "credit_note_id" TEXT,
    "receipt_type" "ReceiptType" NOT NULL,
    "rra_receipt_no" TEXT,
    "sdc_id" TEXT,
    "internal_data" TEXT,
    "receipt_signature" TEXT,
    "qr_payload" TEXT,
    "vsdc_datetime" TIMESTAMP(3),
    "raw_response" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ebm_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ebm_transactions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "direction" "EbmDirection" NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "response" JSONB,
    "http_status" INTEGER,
    "outcome" "EbmOutcome" NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ebm_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bills" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "bill_no" BIGINT,
    "contact_id" TEXT NOT NULL,
    "origin" "BillOrigin" NOT NULL DEFAULT 'MANUAL',
    "status" "BillStatus" NOT NULL DEFAULT 'DRAFT',
    "bill_date" DATE NOT NULL,
    "due_date" DATE,
    "currency" CHAR(3) NOT NULL,
    "subtotal_minor" BIGINT NOT NULL DEFAULT 0,
    "vat_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL DEFAULT 0,
    "notes" TEXT,
    "supplier_receipt_no" TEXT,
    "supplier_tin" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "approved_by" TEXT,

    CONSTRAINT "bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_lines" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "description" TEXT,
    "qty" DECIMAL(12,3) NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "tax_code" "TaxCode" NOT NULL,
    "line_net_minor" BIGINT NOT NULL,
    "line_vat_minor" BIGINT NOT NULL,
    "line_total_minor" BIGINT NOT NULL,

    CONSTRAINT "bill_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "expense_account_id" TEXT NOT NULL,
    "paid_from_account_id" TEXT NOT NULL,
    "tax_code" "TaxCode" NOT NULL,
    "date" DATE NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "net_minor" BIGINT NOT NULL,
    "vat_minor" BIGINT NOT NULL,
    "memo" TEXT,
    "receipt_attachment_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "direction" "PaymentDirection" NOT NULL,
    "contact_id" TEXT,
    "method" "PaymentMethod" NOT NULL,
    "deposit_account_id" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "invoice_id" TEXT,
    "bill_id" TEXT,
    "amount_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "items_tenant_id_sku_key" ON "items"("tenant_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rates_tenant_id_code_valid_from_key" ON "tax_rates"("tenant_id", "code", "valid_from");

-- CreateIndex
CREATE UNIQUE INDEX "rra_codes_tenant_id_code_type_code_key" ON "rra_codes"("tenant_id", "code_type", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ebm_devices_tenant_id_key" ON "ebm_devices"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_tenant_id_invoice_no_key" ON "invoices"("tenant_id", "invoice_no");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_tenant_id_credit_note_no_key" ON "credit_notes"("tenant_id", "credit_note_no");

-- CreateIndex
CREATE UNIQUE INDEX "bills_tenant_id_bill_no_key" ON "bills"("tenant_id", "bill_no");

-- CreateIndex
CREATE UNIQUE INDEX "bills_tenant_id_supplier_tin_supplier_receipt_no_key" ON "bills"("tenant_id", "supplier_tin", "supplier_receipt_no");

-- AddForeignKey
ALTER TABLE "document_no_sequences" ADD CONSTRAINT "document_no_sequences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_income_account_id_fkey" FOREIGN KEY ("income_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_expense_account_id_fkey" FOREIGN KEY ("expense_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rra_codes" ADD CONSTRAINT "rra_codes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ebm_devices" ADD CONSTRAINT "ebm_devices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_source_quote_id_fkey" FOREIGN KEY ("source_quote_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_original_invoice_id_fkey" FOREIGN KEY ("original_invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_credit_note_id_fkey" FOREIGN KEY ("credit_note_id") REFERENCES "credit_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ebm_receipts" ADD CONSTRAINT "ebm_receipts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ebm_receipts" ADD CONSTRAINT "ebm_receipts_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ebm_receipts" ADD CONSTRAINT "ebm_receipts_credit_note_id_fkey" FOREIGN KEY ("credit_note_id") REFERENCES "credit_notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ebm_transactions" ADD CONSTRAINT "ebm_transactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_expense_account_id_fkey" FOREIGN KEY ("expense_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_paid_from_account_id_fkey" FOREIGN KEY ("paid_from_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_deposit_account_id_fkey" FOREIGN KEY ("deposit_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE SET NULL ON UPDATE CASCADE;
