-- Application runtime role. NOLOGIN: connections authenticate as the owner
-- role and drop to this one with SET LOCAL ROLE inside each transaction.
-- Default role attributes already exclude SUPERUSER and BYPASSRLS; stating
-- nothing keeps the least-privilege posture explicit in pg_roles probes.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'libre_ai_app') THEN
    CREATE ROLE libre_ai_app NOLOGIN;
  END IF;
END
$$;
