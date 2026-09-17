-- Retention runtime role (retention execution + physical compaction design,
-- owner arbitrage 2026-07-24; DECISION 2 role model Option A). NOLOGIN like
-- libre_ai_app: the owner connects and drops to this role with SET LOCAL ROLE
-- inside each retention transaction. NOSUPERUSER and NOBYPASSRLS are stated
-- explicitly (not merely defaulted) so a pg_roles probe reads the
-- least-privilege posture directly — the SQL-verifiable half of the design's
-- honest property (§6.1).
--
-- INVARIANT — this migration creates the role and grants it NOTHING. Grants
-- reach libre_ai_retention ONLY through owner-declared, per-product compaction
-- migrations that live under the adopting application (first adopter:
-- Sessions' `GRANT SELECT, DELETE ON session_events TO libre_ai_retention`, in
-- apps/sessions' OWN migration — never here). The separation from the app role
-- is honest, not a SQL impossibility: SET ROLE privilege is evaluated against
-- the SESSION user, so the guarantees are the structural grants above, this
-- pg_roles probe, the single-barrier discipline (withTenantRetentionTransaction
-- is the only in-repo assumption point), and — at G4 — the Biscuit attenuated
-- token. FORCE RLS policies carry no TO clause, so they bind this role exactly
-- like any other.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'libre_ai_retention') THEN
    CREATE ROLE libre_ai_retention NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
