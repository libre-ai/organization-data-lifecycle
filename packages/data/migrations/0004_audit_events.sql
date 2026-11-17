-- Audit events, one table per product database (never a journal shared across
-- databases or products). Built like deletion_receipts: tenant-format CHECK,
-- tenant-inclusive primary key, ENABLE + FORCE ROW LEVEL SECURITY, isolation
-- policy bound to the transaction-local app.tenant_id.
--
-- An audit line carries opaque identifiers only: no network address, no client
-- signature, no cleartext subject. The enumerations and the object shape of
-- `context` are structural CHECKs so that no caller — including RLS-bypassing
-- owner sessions — can persist a line outside them. This file is the only
-- place where the table is defined: the code holds no copy of this DDL.
CREATE TABLE audit_events (
  tenant_id text NOT NULL
    CONSTRAINT audit_events_tenant_format CHECK (tenant_id ~ '^ten_[a-z0-9]{16,64}$'),
  event_id text NOT NULL,
  action text NOT NULL,
  actor_id text NOT NULL,
  actor_role text,
  resource text,
  outcome text NOT NULL
    CONSTRAINT audit_events_outcome_enum
      CHECK (outcome IN ('success', 'failure', 'denied', 'error')),
  severity text NOT NULL
    CONSTRAINT audit_events_severity_enum
      CHECK (severity IN ('info', 'warn', 'high', 'critical')),
  context jsonb NOT NULL
    CONSTRAINT audit_events_context_object CHECK (jsonb_typeof(context) = 'object'),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, event_id)
);

CREATE INDEX audit_events_tenant_occurred_at ON audit_events (tenant_id, occurred_at DESC);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_events_tenant_isolation ON audit_events
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- No UPDATE, DELETE or TRUNCATE: audit events are append-only evidence.
-- libre_ai_retention receives nothing here: purging expired events is granted
-- by the adopting product's own migration, never by this one.
GRANT SELECT, INSERT ON audit_events TO libre_ai_app;
