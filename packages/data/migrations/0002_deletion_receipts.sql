-- Deletion receipts (DATA-LIFECYCLE explicit deletion; contract
-- contracts/schemas/deletion-receipt.v1.schema.json). Receipts are immutable
-- evidence: the application role may emit and read them, never rewrite or
-- erase them. The 35-day backup ceiling (ADR-0002, retention.v1 backupExpiry
-- P35D) is a structural CHECK so no caller — including RLS-bypassing owner
-- sessions — can persist a receipt exceeding it.
CREATE TABLE deletion_receipts (
  tenant_id text NOT NULL
    CONSTRAINT deletion_receipts_tenant_format CHECK (tenant_id ~ '^ten_[a-z0-9]{16,64}$'),
  receipt_id text NOT NULL,
  receipt jsonb NOT NULL,
  completed_at timestamptz NOT NULL,
  backup_expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, receipt_id),
  CONSTRAINT deletion_receipts_backup_ceiling
    CHECK (backup_expires_at <= completed_at + interval '35 days')
);

ALTER TABLE deletion_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE deletion_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY deletion_receipts_tenant_isolation ON deletion_receipts
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- No UPDATE, DELETE or TRUNCATE: receipts are append-only evidence.
GRANT SELECT, INSERT ON deletion_receipts TO libre_ai_app;
