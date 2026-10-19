-- Monthly procurement exposure without a month scan inside the provider lock.
--
-- Budget admission sums the current UTC month of provider_calls (known cost,
-- evidence anomalies) and, per usage request, max(cost - customer coverage, 0)
-- (subsidy). Both are exact today because they are recomputed under the
-- provider advisory lock; the cost is O(month) per admission.
--
-- A usage request's contribution stops changing once it is finished: calls are
-- only inserted while the usage row is 'reserved' (beginProviderCall), call cost
-- evidence is only rewritten while outcome = 'pending', usage requests never
-- return to 'reserved', and a customer charge's pricing is immutable while
-- 'captured'/'released' are terminal (billing.protect_customer_charge).
-- Finished requests are therefore folded into a per provider/month/currency
-- total; every other request stays "open" and is aggregated live. Admission
-- reads total + open, which equals the full aggregate in every snapshot:
--   * a call INSERT opens its (provider, month, usage) in the same transaction;
--   * a fold deletes the open row and adds its contribution atomically;
--   * requests with anomalous evidence are never folded, so anomaly counts
--     remain entirely in the open part.
-- Folding is background work; if it never runs, admission is still exact and
-- simply as slow as before.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE IF NOT EXISTS external_platform.provider_cost_open_usages (
  provider_key text NOT NULL,
  -- First day of the UTC month of provider_calls.started_at.
  month date NOT NULL,
  usage_request_id uuid NOT NULL,
  PRIMARY KEY (provider_key, month, usage_request_id)
);

CREATE TABLE IF NOT EXISTS external_platform.provider_cost_month_totals (
  provider_key text NOT NULL,
  month date NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  folded_usages bigint NOT NULL DEFAULT 0 CHECK (folded_usages >= 0),
  known_cost_minor bigint NOT NULL DEFAULT 0 CHECK (known_cost_minor >= 0),
  subsidy_cost_minor bigint NOT NULL DEFAULT 0 CHECK (subsidy_cost_minor >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_key, month, currency)
);

COMMENT ON TABLE external_platform.provider_cost_open_usages IS
  'Usage requests whose monthly procurement exposure is still aggregated live from provider_calls.';
COMMENT ON TABLE external_platform.provider_cost_month_totals IS
  'Folded procurement exposure of finished usage requests; admission adds the open part.';

REVOKE ALL ON external_platform.provider_cost_open_usages FROM PUBLIC;
REVOKE ALL ON external_platform.provider_cost_month_totals FROM PUBLIC;

CREATE OR REPLACE FUNCTION external_platform.open_provider_cost_usage()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO external_platform.provider_cost_open_usages
    (provider_key, month, usage_request_id)
  VALUES (
    NEW.provider_key,
    date_trunc('month', NEW.started_at AT TIME ZONE 'UTC')::date,
    NEW.usage_request_id
  )
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS provider_calls_open_cost_usage
  ON external_platform.provider_calls;
CREATE TRIGGER provider_calls_open_cost_usage
AFTER INSERT ON external_platform.provider_calls
FOR EACH ROW
EXECUTE FUNCTION external_platform.open_provider_cost_usage();

-- The fold relies on these facts; make a violation loud instead of letting a
-- folded total silently drift from provider_calls. Every existing writer
-- already complies: settlement updates are guarded by outcome = 'pending', and
-- reapers/recovery change only outcome/error fields.
CREATE OR REPLACE FUNCTION external_platform.protect_provider_call_cost_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.started_at >= (
         date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month'
       ) AT TIME ZONE 'UTC'
       AND NOT EXISTS (
         SELECT 1
           FROM external_platform.provider_cost_open_usages open_usage
          WHERE open_usage.provider_key = OLD.provider_key
            AND open_usage.month = date_trunc('month', OLD.started_at AT TIME ZONE 'UTC')::date
            AND open_usage.usage_request_id = OLD.usage_request_id
       ) THEN
      RAISE EXCEPTION 'provider call cost evidence is folded into the monthly budget ledger'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.provider_key IS DISTINCT FROM OLD.provider_key
     OR NEW.usage_request_id IS DISTINCT FROM OLD.usage_request_id
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'provider call budget identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.outcome <> 'pending' AND (
       NEW.outcome = 'pending'
       OR NEW.cost_minor IS DISTINCT FROM OLD.cost_minor
       OR NEW.cost_kind IS DISTINCT FROM OLD.cost_kind
       OR NEW.currency IS DISTINCT FROM OLD.currency
     ) THEN
    RAISE EXCEPTION 'settled provider call cost evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS provider_calls_protect_cost_evidence
  ON external_platform.provider_calls;
CREATE TRIGGER provider_calls_protect_cost_evidence
BEFORE UPDATE OF provider_key, usage_request_id, started_at, outcome,
  cost_minor, cost_kind, currency
  OR DELETE
ON external_platform.provider_calls
FOR EACH ROW
EXECUTE FUNCTION external_platform.protect_provider_call_cost_evidence();
