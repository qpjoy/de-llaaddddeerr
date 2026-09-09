-- One billable usage request may require several independent authorization
-- axes. Keep the historical single platform/capability column as its primary
-- accounting scope while recording every required axis in this append-only
-- relation for transactional admission and independent quota accounting.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE IF NOT EXISTS usage_request_authorization_scopes (
  usage_request_id uuid NOT NULL REFERENCES usage_requests(id) ON DELETE RESTRICT,
  scope_type text NOT NULL CHECK (scope_type IN ('platform', 'capability')),
  scope_key text NOT NULL CHECK (
    length(scope_key) BETWEEN 1 AND 128
    AND scope_key !~ '[[:cntrl:]]'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (usage_request_id, scope_type, scope_key)
);

CREATE INDEX IF NOT EXISTS usage_request_authorization_scopes_quota_idx
  ON usage_request_authorization_scopes (scope_type, scope_key, usage_request_id);

CREATE FUNCTION seed_primary_usage_authorization_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO usage_request_authorization_scopes
    (usage_request_id, scope_type, scope_key, created_at)
  VALUES
    (NEW.id,
     CASE WHEN NEW.platform IS NOT NULL THEN 'platform' ELSE 'capability' END,
     coalesce(NEW.platform, NEW.capability),
     NEW.created_at)
  ON CONFLICT (usage_request_id, scope_type, scope_key) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER usage_requests_seed_primary_authorization_scope
AFTER INSERT ON usage_requests
FOR EACH ROW EXECUTE FUNCTION seed_primary_usage_authorization_scope();

CREATE FUNCTION protect_usage_request_authorization_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'usage request authorization scopes are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER usage_request_authorization_scopes_immutable
BEFORE UPDATE OR DELETE ON usage_request_authorization_scopes
FOR EACH ROW EXECUTE FUNCTION protect_usage_request_authorization_scope();

COMMENT ON TABLE usage_request_authorization_scopes IS
  'Immutable authorization axes admitted with one usage request; billing remains bound to usage_requests.billing_meter_key.';
