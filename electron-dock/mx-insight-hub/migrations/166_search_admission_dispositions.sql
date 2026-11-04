-- An explicit administrative decision retires only one historical search
-- blocker. It neither settles the unknown delivery nor changes its billing.
SET LOCAL lock_timeout = '5s';

CREATE TABLE control.search_admission_dispositions (
  original_usage_request_id uuid PRIMARY KEY REFERENCES public.usage_requests(id) ON DELETE RESTRICT,
  id uuid NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  consumer_id uuid NOT NULL REFERENCES public.consumers(id) ON DELETE RESTRICT,
  api_key_id uuid NOT NULL REFERENCES public.api_keys(id) ON DELETE RESTRICT,
  platform text NOT NULL CHECK (platform = 'twitter'),
  query_hash char(64) NOT NULL CHECK (query_hash ~ '^[0-9a-f]{64}$'),
  fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  evidence_revision char(64) NOT NULL CHECK (evidence_revision ~ '^[0-9a-f]{64}$'),
  actor text NOT NULL CHECK (length(btrim(actor)) BETWEEN 1 AND 256),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  request_id text CHECK (length(request_id) BETWEEN 1 AND 191),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION control.protect_search_admission_disposition()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'search_admission_disposition_is_immutable' USING ERRCODE = '55000';
END;
$function$;
CREATE TRIGGER search_admission_disposition_immutable
  BEFORE UPDATE OR DELETE ON control.search_admission_dispositions
  FOR EACH ROW EXECUTE FUNCTION control.protect_search_admission_disposition();
CREATE TRIGGER search_admission_disposition_no_truncate
  BEFORE TRUNCATE ON control.search_admission_dispositions
  FOR EACH STATEMENT EXECUTE FUNCTION control.protect_search_admission_disposition();
REVOKE ALL ON control.search_admission_dispositions FROM PUBLIC;
REVOKE ALL ON FUNCTION control.protect_search_admission_disposition() FROM PUBLIC;
