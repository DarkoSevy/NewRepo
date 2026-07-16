-- CreateEnum
CREATE TYPE "FinancialAccountKind" AS ENUM ('BANK', 'MOMO', 'CASH');

-- CreateEnum
CREATE TYPE "StatementImportStatus" AS ENUM ('PARSED', 'PARTIALLY_MATCHED', 'RECONCILED');

-- CreateEnum
CREATE TYPE "StatementLineStatus" AS ENUM ('UNMATCHED', 'MATCHED', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "MatchKind" AS ENUM ('MANUAL', 'RULE', 'AUTO_T1', 'AUTO_T2', 'MOMO_EVENT');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('PROPOSED', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "MatchRuleAction" AS ENUM ('MATCH_CONTACT', 'CREATE_TRANSACTION');

-- CreateEnum
CREATE TYPE "MomoProvider" AS ENUM ('MTN', 'AIRTEL');

-- CreateEnum
CREATE TYPE "ReconciliationSessionStatus" AS ENUM ('OPEN', 'COMPLETED');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('OPENING', 'PURCHASE', 'SALE', 'CREDIT_NOTE_RETURN', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "NegativeStockPolicy" AS ENUM ('BLOCK', 'WARN');

-- AlterTable
ALTER TABLE "items" ADD COLUMN     "inventory_account_id" TEXT,
ADD COLUMN     "qty_on_hand" DECIMAL(14,3) NOT NULL DEFAULT 0,
ADD COLUMN     "tracked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "wac_minor" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "negative_stock_policy" "NegativeStockPolicy" NOT NULL DEFAULT 'BLOCK';

-- CreateTable
CREATE TABLE "financial_accounts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "FinancialAccountKind" NOT NULL,
    "gl_account_id" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "bank_code" TEXT,
    "account_number_masked" TEXT,
    "parser_template" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "statement_imports" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "financial_account_id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "opening_balance_minor" BIGINT NOT NULL,
    "closing_balance_minor" BIGINT NOT NULL,
    "line_count" INTEGER NOT NULL,
    "status" "StatementImportStatus" NOT NULL DEFAULT 'PARSED',
    "imported_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "statement_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "statement_lines" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "financial_account_id" TEXT NOT NULL,
    "line_date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "external_ref" TEXT,
    "amount_minor" BIGINT NOT NULL,
    "direction" "PaymentDirection" NOT NULL,
    "running_balance_minor" BIGINT,
    "line_hash" TEXT NOT NULL,
    "status" "StatementLineStatus" NOT NULL DEFAULT 'UNMATCHED',
    "exclude_reason" TEXT,
    "locked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "financial_account_id" TEXT NOT NULL,
    "created_by" TEXT,
    "kind" "MatchKind" NOT NULL,
    "status" "MatchStatus" NOT NULL DEFAULT 'PROPOSED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3),
    "confirmed_by" TEXT,
    "locked_at" TIMESTAMP(3),

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_legs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "statement_line_id" TEXT,
    "journal_line_id" TEXT,

    CONSTRAINT "match_legs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_rules" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "financial_account_id" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "predicate" JSONB NOT NULL,
    "action" "MatchRuleAction" NOT NULL,
    "create_spec" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "momo_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider" "MomoProvider" NOT NULL,
    "external_id" TEXT,
    "provider_txn_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "msisdn_masked" TEXT,
    "raw" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "momo_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_sessions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "financial_account_id" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "statement_closing_balance_minor" BIGINT NOT NULL,
    "gl_closing_balance_minor" BIGINT,
    "difference_minor" BIGINT,
    "status" "ReconciliationSessionStatus" NOT NULL DEFAULT 'OPEN',
    "completed_by" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "movement_type" "StockMovementType" NOT NULL,
    "qty_delta" DECIMAL(14,3) NOT NULL,
    "unit_cost_minor" BIGINT NOT NULL,
    "source_document_ref" JSONB,
    "ebm_reported_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "financial_accounts_gl_account_id_key" ON "financial_accounts"("gl_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "statement_imports_financial_account_id_file_hash_key" ON "statement_imports"("financial_account_id", "file_hash");

-- CreateIndex
CREATE UNIQUE INDEX "statement_lines_financial_account_id_line_hash_key" ON "statement_lines"("financial_account_id", "line_hash");

-- CreateIndex
CREATE UNIQUE INDEX "momo_events_tenant_id_provider_provider_txn_id_key" ON "momo_events"("tenant_id", "provider", "provider_txn_id");

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_inventory_account_id_fkey" FOREIGN KEY ("inventory_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_accounts" ADD CONSTRAINT "financial_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_accounts" ADD CONSTRAINT "financial_accounts_gl_account_id_fkey" FOREIGN KEY ("gl_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_financial_account_id_fkey" FOREIGN KEY ("financial_account_id") REFERENCES "financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "statement_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_financial_account_id_fkey" FOREIGN KEY ("financial_account_id") REFERENCES "financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_financial_account_id_fkey" FOREIGN KEY ("financial_account_id") REFERENCES "financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_legs" ADD CONSTRAINT "match_legs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_legs" ADD CONSTRAINT "match_legs_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_legs" ADD CONSTRAINT "match_legs_statement_line_id_fkey" FOREIGN KEY ("statement_line_id") REFERENCES "statement_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_legs" ADD CONSTRAINT "match_legs_journal_line_id_fkey" FOREIGN KEY ("journal_line_id") REFERENCES "journal_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_rules" ADD CONSTRAINT "match_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_rules" ADD CONSTRAINT "match_rules_financial_account_id_fkey" FOREIGN KEY ("financial_account_id") REFERENCES "financial_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "momo_events" ADD CONSTRAINT "momo_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_sessions" ADD CONSTRAINT "reconciliation_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_sessions" ADD CONSTRAINT "reconciliation_sessions_financial_account_id_fkey" FOREIGN KEY ("financial_account_id") REFERENCES "financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
