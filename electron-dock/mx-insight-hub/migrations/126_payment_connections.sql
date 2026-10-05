-- Hub-owned connection settings only; payment sources, routes and money stay intact.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE hub_recharge.connections (
  environment text PRIMARY KEY REFERENCES hub_recharge.routes(environment),
  revision integer NOT NULL CHECK (revision > 0),
  sealed text NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE hub_recharge.connection_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL REFERENCES hub_recharge.routes(environment),
  revision integer NOT NULL,
  actor text NOT NULL,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(environment, revision)
);
CREATE TRIGGER hub_recharge_connection_audit_immutable BEFORE UPDATE OR DELETE ON hub_recharge.connection_audit
  FOR EACH ROW EXECUTE FUNCTION mx_pay.immutable_record();
CREATE TRIGGER hub_recharge_connection_audit_no_truncate BEFORE TRUNCATE ON hub_recharge.connection_audit
  FOR EACH STATEMENT EXECUTE FUNCTION mx_pay.immutable_record();
