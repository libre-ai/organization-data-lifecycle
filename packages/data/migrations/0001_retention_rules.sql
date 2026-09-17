-- Tenant-configured retention (DATA-LIFECYCLE retention execution;
-- contract contracts/data/retention.v1.json). The application layer
-- (retention-bounds) validates configured values against the contract's
-- minima/maxima; these constraints are the structural floor that holds even
-- for callers that bypass the helpers.
CREATE TABLE retention_rules (
  tenant_id text NOT NULL
    CONSTRAINT retention_rules_tenant_format CHECK (tenant_id ~ '^ten_[a-z0-9]{16,64}$'),
  rule_id text NOT NULL
    CONSTRAINT retention_rules_rule_format CHECK (rule_id ~ '^[a-z][a-z0-9-]{1,63}$'),
  retention text NOT NULL
    CONSTRAINT retention_rules_iso_days CHECK (retention ~ '^P[0-9]{1,4}D$'),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, rule_id)
);

ALTER TABLE retention_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_rules FORCE ROW LEVEL SECURITY;

CREATE POLICY retention_rules_tenant_isolation ON retention_rules
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON retention_rules TO libre_ai_app;
