-- Explicit operator recovery receipts only. Applying this migration never
-- changes usage, provider evidence, customer charges or wallet balances.
CREATE TABLE control.facebook_empty_page_recoveries (
  request_id uuid PRIMARY KEY REFERENCES public.usage_requests(id) ON DELETE RESTRICT,
  provider_call_id uuid NOT NULL UNIQUE REFERENCES external_platform.provider_calls(id) ON DELETE RESTRICT,
  preview_sha256 char(64) NOT NULL CHECK (preview_sha256 ~ '^[a-f0-9]{64}$'),
  restricted_sha256 char(64) NOT NULL CHECK (restricted_sha256 ~ '^[a-f0-9]{64}$'),
  operational_sha256 char(64) NOT NULL CHECK (operational_sha256 ~ '^[a-f0-9]{64}$'),
  response_sha256 char(64) NOT NULL CHECK (response_sha256 ~ '^[a-f0-9]{64}$'),
  previous_state jsonb NOT NULL CHECK (jsonb_typeof(previous_state) = 'object'),
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
  actor text NOT NULL CHECK (length(actor) BETWEEN 3 AND 100),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON control.facebook_empty_page_recoveries FROM PUBLIC;
CREATE FUNCTION control.reject_facebook_empty_recovery_mutation() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'Facebook recovery receipts are append-only' USING ERRCODE = '55000';
END;
$function$;
CREATE TRIGGER facebook_empty_recovery_no_row_mutation
BEFORE UPDATE OR DELETE ON control.facebook_empty_page_recoveries
FOR EACH ROW EXECUTE FUNCTION control.reject_facebook_empty_recovery_mutation();
CREATE TRIGGER facebook_empty_recovery_no_truncate
BEFORE TRUNCATE ON control.facebook_empty_page_recoveries
FOR EACH STATEMENT EXECUTE FUNCTION control.reject_facebook_empty_recovery_mutation();
