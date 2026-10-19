-- Reconcile the monthly procurement ledger (migration 163) with provider_calls.
--
-- Read-only, ROLLBACK at the end. Section 1 reads only the small ledger tables
-- and is safe at any time. Sections 2-3 recompute the current month from
-- provider_calls and customer_charges (O(month)); run them off-peak. Every
-- row they return is a discrepancy; an empty result is a clean ledger.
--
--   psql -X "$DATABASE_URL" -v ON_ERROR_STOP=1 < scripts/provider-cost-ledger-check.sql
--
-- Repair for one provider (exact at every instant; admission is O(month) for
-- that provider until background folds catch up):
--   BEGIN;
--   SELECT pg_advisory_xact_lock(hashtext('external-platform-cost-ledger:' || '<provider>'));
--   DELETE FROM external_platform.provider_cost_month_totals
--    WHERE provider_key = '<provider>' AND month = date_trunc('month', now() AT TIME ZONE 'UTC')::date;
--   INSERT INTO external_platform.provider_cost_open_usages (provider_key, month, usage_request_id)
--   SELECT DISTINCT provider_key, date_trunc('month', now() AT TIME ZONE 'UTC')::date, usage_request_id
--     FROM external_platform.provider_calls
--    WHERE provider_key = '<provider>'
--      AND started_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
--      AND started_at < (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC'
--   ON CONFLICT DO NOTHING;
--   COMMIT;
-- (PostgresExternalPlatformStore.resetProviderCostLedger does the same.)

BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '1s';

-- 1. Ledger shape: requests still aggregated live vs folded, per provider.
SELECT provider_key,
       sum(open_usages)::bigint AS open_usages,
       sum(folded_usages)::bigint AS folded_usage_currencies,
       sum(known_cost_minor)::bigint AS folded_known_cost_minor,
       sum(subsidy_cost_minor)::bigint AS folded_subsidy_cost_minor
  FROM (
    SELECT provider_key, count(*) AS open_usages, 0 AS folded_usages,
           0 AS known_cost_minor, 0 AS subsidy_cost_minor
      FROM external_platform.provider_cost_open_usages
     WHERE month = date_trunc('month', now() AT TIME ZONE 'UTC')::date
     GROUP BY provider_key
    UNION ALL
    SELECT provider_key, 0, folded_usages, known_cost_minor, subsidy_cost_minor
      FROM external_platform.provider_cost_month_totals
     WHERE month = date_trunc('month', now() AT TIME ZONE 'UTC')::date
  ) ledger
 GROUP BY provider_key
 ORDER BY open_usages DESC;

-- 2. Off-peak: folded totals must equal the same contributions recomputed
-- from every request that is not open (known cost and subsidy per currency).
WITH bounds AS MATERIALIZED (
  SELECT date_trunc('month', now() AT TIME ZONE 'UTC')::date AS month,
         date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS starts_at,
         (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC' AS ends_at
), usage_costs AS (
  SELECT call.provider_key, call.currency, call.usage_request_id,
         sum(call.cost_minor)::bigint AS cost_minor
    FROM external_platform.provider_calls call
    JOIN bounds ON call.started_at >= bounds.starts_at AND call.started_at < bounds.ends_at
   WHERE call.cost_minor IS NOT NULL AND call.currency ~ '^[A-Z]{3}$'
     AND NOT EXISTS (
       SELECT 1 FROM external_platform.provider_cost_open_usages open_usage
        WHERE open_usage.provider_key = call.provider_key
          AND open_usage.month = bounds.month
          AND open_usage.usage_request_id = call.usage_request_id)
   GROUP BY call.provider_key, call.currency, call.usage_request_id
), recomputed AS (
  SELECT usage_cost.provider_key, usage_cost.currency,
         sum(usage_cost.cost_minor)::bigint AS known_cost_minor,
         sum(greatest(usage_cost.cost_minor - CASE
               WHEN charge.enforcement_mode = 'enforced'
                AND charge.status IN ('reserved', 'captured', 'unknown')
                AND charge.currency = usage_cost.currency
               THEN charge.quoted_minor ELSE 0 END, 0))::bigint AS subsidy_cost_minor
    FROM usage_costs usage_cost
    LEFT JOIN billing.customer_charges charge
      ON charge.usage_request_id = usage_cost.usage_request_id
   GROUP BY usage_cost.provider_key, usage_cost.currency
), ledger AS (
  SELECT total.provider_key, total.currency::text AS currency,
         total.known_cost_minor, total.subsidy_cost_minor
    FROM external_platform.provider_cost_month_totals total
    JOIN bounds ON total.month = bounds.month
)
SELECT coalesce(recomputed.provider_key, ledger.provider_key) AS provider_key,
       coalesce(recomputed.currency::text, ledger.currency) AS currency,
       recomputed.known_cost_minor AS recomputed_known, ledger.known_cost_minor AS ledger_known,
       recomputed.subsidy_cost_minor AS recomputed_subsidy, ledger.subsidy_cost_minor AS ledger_subsidy
  FROM recomputed
  FULL JOIN ledger
    ON ledger.provider_key = recomputed.provider_key AND ledger.currency = recomputed.currency::text
 WHERE coalesce(recomputed.known_cost_minor, 0) <> coalesce(ledger.known_cost_minor, 0)
    OR coalesce(recomputed.subsidy_cost_minor, 0) <> coalesce(ledger.subsidy_cost_minor, 0);

-- 3. Off-peak: a request that is not open must have nothing left to change.
SELECT call.provider_key, call.usage_request_id, call.id AS call_id, call.outcome,
       call.cost_minor, call.cost_kind, call.currency, request.status AS usage_status,
       charge.enforcement_mode, charge.status AS charge_status
  FROM external_platform.provider_calls call
  JOIN usage_requests request ON request.id = call.usage_request_id
  LEFT JOIN billing.customer_charges charge ON charge.usage_request_id = call.usage_request_id
 WHERE call.started_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
   AND NOT EXISTS (
     SELECT 1 FROM external_platform.provider_cost_open_usages open_usage
      WHERE open_usage.provider_key = call.provider_key
        AND open_usage.month = date_trunc('month', call.started_at AT TIME ZONE 'UTC')::date
        AND open_usage.usage_request_id = call.usage_request_id)
   AND (request.status = 'reserved'
     OR call.outcome = 'pending'
     OR (charge.enforcement_mode = 'enforced' AND charge.status NOT IN ('captured', 'released'))
     OR (call.cost_kind <> 'unknown' AND (call.cost_minor IS NULL OR call.cost_minor <= 0))
     OR (call.cost_minor IS NOT NULL AND (call.currency IS NULL OR call.currency !~ '^[A-Z]{3}$')))
 LIMIT 100;

ROLLBACK;
