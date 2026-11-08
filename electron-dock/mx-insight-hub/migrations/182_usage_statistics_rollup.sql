-- Incremental usage statistics (server/stores/usage-rollup.mjs).
--
-- Usage and billing summaries used to aggregate the whole request history on
-- every read. Here every change of a counted column appends one small signed
-- delta row in the same transaction as the change itself; the Admin process
-- folds committed deltas into hourly totals. Readers sum totals + pending
-- deltas (+ raw rows of partial edge hours) in one snapshot, so results stay
-- exact and real time while reads no longer scan request history.
--
-- Delta tables have no indexes and no constraints beyond NOT NULL: inserts
-- never wait on each other and add no index writes to the request path. Only
-- the single compactor/builder (advisory lock) updates totals.
--
-- Bucket = UTC hour of usage_requests.created_at. Charges are bucketed and
-- filtered by their request (tenant/consumer/key/hour), exactly like the
-- request join they replace. Totals stay unused until the Admin process has
-- built the baseline (state 'ready'); until then readers keep the old queries.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE SCHEMA IF NOT EXISTS reporting;

CREATE TABLE reporting.usage_request_deltas (
  bucket timestamptz NOT NULL,
  tenant_id uuid NOT NULL,
  consumer_id uuid NOT NULL,
  api_key_id uuid NOT NULL,
  -- usage_requests carries exactly one of platform / capability (migration
  -- 018), so either may be NULL; the trigger must never reject a request.
  platform text,
  capability text,
  meter_key text,
  status text NOT NULL,
  requests bigint NOT NULL,
  units bigint NOT NULL,
  latency_sum bigint NOT NULL,
  latency_count bigint NOT NULL
);

CREATE TABLE reporting.usage_request_totals (LIKE reporting.usage_request_deltas);
CREATE UNIQUE INDEX usage_request_totals_key_idx ON reporting.usage_request_totals
  (bucket, tenant_id, consumer_id, api_key_id, platform, capability, meter_key, status) NULLS NOT DISTINCT;
CREATE INDEX usage_request_totals_tenant_idx ON reporting.usage_request_totals (tenant_id, bucket);
CREATE INDEX usage_request_totals_consumer_idx ON reporting.usage_request_totals (consumer_id, bucket);
CREATE INDEX usage_request_totals_api_key_idx ON reporting.usage_request_totals (api_key_id, bucket);

CREATE TABLE reporting.customer_charge_deltas (
  bucket timestamptz NOT NULL,
  tenant_id uuid NOT NULL,
  consumer_id uuid NOT NULL,
  api_key_id uuid NOT NULL,
  meter_key text NOT NULL,
  currency text NOT NULL,
  enforcement_mode text NOT NULL,
  status text NOT NULL,
  quoted_positive boolean NOT NULL,
  charges bigint NOT NULL,
  quoted_minor bigint NOT NULL,
  charged_minor bigint NOT NULL
);

CREATE TABLE reporting.customer_charge_totals (LIKE reporting.customer_charge_deltas);
CREATE UNIQUE INDEX customer_charge_totals_key_idx ON reporting.customer_charge_totals
  (bucket, tenant_id, consumer_id, api_key_id, meter_key, currency, enforcement_mode, status, quoted_positive);
CREATE INDEX customer_charge_totals_tenant_idx ON reporting.customer_charge_totals (tenant_id, bucket);
CREATE INDEX customer_charge_totals_consumer_idx ON reporting.customer_charge_totals (consumer_id, bucket);
CREATE INDEX customer_charge_totals_api_key_idx ON reporting.customer_charge_totals (api_key_id, bucket);

-- 'pending' until the Admin process builds the baseline for definition_version;
-- setting it back to 'pending' forces a full, exact rebuild.
CREATE TABLE reporting.usage_rollup_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  status text NOT NULL CHECK (status IN ('pending', 'ready')),
  definition_version integer NOT NULL,
  built_at timestamptz,
  compacted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO reporting.usage_rollup_state (status, definition_version) VALUES ('pending', 0);

-- Fully qualified names and a fixed search_path: charge updates also run inside
-- SECURITY DEFINER billing functions with search_path = pg_catalog, billing.
CREATE FUNCTION reporting.capture_usage_request_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    INSERT INTO reporting.usage_request_deltas VALUES (
      date_trunc('hour', OLD.created_at, 'UTC'), OLD.tenant_id, OLD.consumer_id, OLD.api_key_id,
      OLD.platform, OLD.capability, coalesce(OLD.billing_meter_key, OLD.capability, OLD.platform), OLD.status,
      -1, -coalesce(OLD.units_actual, 0), -coalesce(OLD.upstream_latency_ms, 0),
      CASE WHEN OLD.upstream_latency_ms IS NULL THEN 0 ELSE -1 END);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO reporting.usage_request_deltas VALUES (
      date_trunc('hour', NEW.created_at, 'UTC'), NEW.tenant_id, NEW.consumer_id, NEW.api_key_id,
      NEW.platform, NEW.capability, coalesce(NEW.billing_meter_key, NEW.capability, NEW.platform), NEW.status,
      1, coalesce(NEW.units_actual, 0), coalesce(NEW.upstream_latency_ms, 0),
      CASE WHEN NEW.upstream_latency_ms IS NULL THEN 0 ELSE 1 END);
  END IF;
  -- A charge is counted under its request's hour and owner. If those ever
  -- change, move the charge too. This trigger sorts before the billing
  -- settlement triggers, so the charge is still in its pre-settlement state.
  IF TG_OP = 'UPDATE' AND (OLD.created_at, OLD.tenant_id, OLD.consumer_id, OLD.api_key_id)
      IS DISTINCT FROM (NEW.created_at, NEW.tenant_id, NEW.consumer_id, NEW.api_key_id) THEN
    INSERT INTO reporting.customer_charge_deltas
    SELECT date_trunc('hour', OLD.created_at, 'UTC'), OLD.tenant_id, OLD.consumer_id, OLD.api_key_id,
           charge.meter_key, charge.currency, charge.enforcement_mode, charge.status, charge.quoted_minor > 0,
           -1, -charge.quoted_minor, -charge.charged_minor
      FROM billing.customer_charges charge WHERE charge.usage_request_id = OLD.id
    UNION ALL
    SELECT date_trunc('hour', NEW.created_at, 'UTC'), NEW.tenant_id, NEW.consumer_id, NEW.api_key_id,
           charge.meter_key, charge.currency, charge.enforcement_mode, charge.status, charge.quoted_minor > 0,
           1, charge.quoted_minor, charge.charged_minor
      FROM billing.customer_charges charge WHERE charge.usage_request_id = OLD.id;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE FUNCTION reporting.capture_customer_charge_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  request_created_at timestamptz;
  request_tenant_id uuid;
  request_consumer_id uuid;
  request_api_key_id uuid;
BEGIN
  -- FK RESTRICT guarantees the request exists; the charge's own copy of the
  -- owner is only a defensive fallback.
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT created_at, tenant_id, consumer_id, api_key_id
      INTO request_created_at, request_tenant_id, request_consumer_id, request_api_key_id
      FROM public.usage_requests WHERE id = OLD.usage_request_id;
    INSERT INTO reporting.customer_charge_deltas VALUES (
      date_trunc('hour', coalesce(request_created_at, OLD.created_at), 'UTC'),
      coalesce(request_tenant_id, OLD.tenant_id), coalesce(request_consumer_id, OLD.consumer_id),
      coalesce(request_api_key_id, OLD.api_key_id),
      OLD.meter_key, OLD.currency, OLD.enforcement_mode, OLD.status, OLD.quoted_minor > 0,
      -1, -OLD.quoted_minor, -OLD.charged_minor);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT created_at, tenant_id, consumer_id, api_key_id
      INTO request_created_at, request_tenant_id, request_consumer_id, request_api_key_id
      FROM public.usage_requests WHERE id = NEW.usage_request_id;
    INSERT INTO reporting.customer_charge_deltas VALUES (
      date_trunc('hour', coalesce(request_created_at, NEW.created_at), 'UTC'),
      coalesce(request_tenant_id, NEW.tenant_id), coalesce(request_consumer_id, NEW.consumer_id),
      coalesce(request_api_key_id, NEW.api_key_id),
      NEW.meter_key, NEW.currency, NEW.enforcement_mode, NEW.status, NEW.quoted_minor > 0,
      1, NEW.quoted_minor, NEW.charged_minor);
  END IF;
  RETURN NULL;
END;
$function$;

-- Trigger names start with "report" so they fire before the "reserve"/"settle"
-- billing triggers of the same event (PostgreSQL orders them by name).
CREATE TRIGGER usage_requests_report_insert_delete
AFTER INSERT OR DELETE ON public.usage_requests
FOR EACH ROW EXECUTE FUNCTION reporting.capture_usage_request_change();

CREATE TRIGGER usage_requests_report_update
AFTER UPDATE ON public.usage_requests
FOR EACH ROW
WHEN ((OLD.status, OLD.units_actual, OLD.upstream_latency_ms, OLD.platform, OLD.capability,
       OLD.billing_meter_key, OLD.tenant_id, OLD.consumer_id, OLD.api_key_id, OLD.created_at)
  IS DISTINCT FROM (NEW.status, NEW.units_actual, NEW.upstream_latency_ms, NEW.platform, NEW.capability,
       NEW.billing_meter_key, NEW.tenant_id, NEW.consumer_id, NEW.api_key_id, NEW.created_at))
EXECUTE FUNCTION reporting.capture_usage_request_change();

CREATE TRIGGER customer_charges_report_insert_delete
AFTER INSERT OR DELETE ON billing.customer_charges
FOR EACH ROW EXECUTE FUNCTION reporting.capture_customer_charge_change();

CREATE TRIGGER customer_charges_report_update
AFTER UPDATE ON billing.customer_charges
FOR EACH ROW
WHEN ((OLD.usage_request_id, OLD.meter_key, OLD.currency, OLD.enforcement_mode, OLD.status,
       OLD.quoted_minor, OLD.charged_minor)
  IS DISTINCT FROM (NEW.usage_request_id, NEW.meter_key, NEW.currency, NEW.enforcement_mode, NEW.status,
       NEW.quoted_minor, NEW.charged_minor))
EXECUTE FUNCTION reporting.capture_customer_charge_change();
