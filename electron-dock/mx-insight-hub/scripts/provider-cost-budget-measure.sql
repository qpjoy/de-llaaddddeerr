-- Size the provider procurement-budget critical section in production.
--
-- Read-only, one READ ONLY transaction, ROLLBACK at the end. No EXPLAIN
-- ANALYZE and no full-table count: sections 1-4 read catalog, statistics and
-- planner estimates only and are safe at any time; section 4 is the live probe
-- to repeat during a burst. Sections 5-6 range-scan recent calls per provider
-- through external_platform_provider_calls_time_idx (current month / last 24 h)
-- and belong off-peak; each statement stops at 30 s.
--
--   psql -X "$DATABASE_URL" -v ON_ERROR_STOP=1 < scripts/provider-cost-budget-measure.sql
--
-- See docs/operations/burst-hot-rows-db-lanes-2026-10-19.md (未做与后续).

BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '1s';
SET LOCAL max_parallel_workers_per_gather = 0;

-- 1. Relation sizes and planner row estimates.
SELECT c.oid::regclass AS relation,
       c.reltuples::bigint AS estimated_rows,
       pg_size_pretty(pg_relation_size(c.oid)) AS heap,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total
  FROM pg_class c
 WHERE c.oid IN (
   'external_platform.provider_calls'::regclass,
   'billing.customer_charges'::regclass,
   'public.usage_requests'::regclass,
   'external_platform.provider_cost_reservations'::regclass
 )
 ORDER BY 1;

-- 2. Planner estimate of current-month calls per provider (plans only, nothing
-- executes). The old admission scanned this many rows of one provider twice
-- per paid dispatch, then hashed every customer charge (section 1) for the
-- subsidy term.
DO $measure$
DECLARE
  provider record;
  plan json;
BEGIN
  FOR provider IN SELECT provider_key FROM external_platform.provider_state ORDER BY 1 LOOP
    EXECUTE format(
      $sql$EXPLAIN (FORMAT JSON)
        SELECT 1 FROM external_platform.provider_calls
         WHERE provider_key = %L
           AND started_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
           AND started_at < (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC'$sql$,
      provider.provider_key) INTO plan;
    RAISE NOTICE 'estimate provider=% month_calls=% plan_cost=%', provider.provider_key,
      plan->0->'Plan'->>'Plan Rows', plan->0->'Plan'->>'Total Cost';
  END LOOP;
END
$measure$;

-- 3. WAL flush cost since the last stats reset (PG 18; fsync_time needs
-- track_wal_io_timing = on, which can be enabled with a reload for the
-- measurement window). Lock hold of a synchronous COMMIT >= one fsync.
SELECT backend_type, context, writes, write_time, fsyncs, fsync_time,
       CASE WHEN fsyncs > 0 THEN round((fsync_time / fsyncs)::numeric, 3) END AS ms_per_fsync,
       stats_reset
  FROM pg_stat_io
 WHERE object = 'wal' AND (writes > 0 OR fsyncs > 0)
 ORDER BY fsyncs DESC NULLS LAST;

-- 4. Live probe; repeat about once a second during a burst. Provider cost
-- locks are pg_advisory_xact_lock(hashtext('external-platform-cost:<key>')).
SELECT provider.provider_key,
       count(*) FILTER (WHERE lock.granted) AS holding,
       count(*) FILTER (WHERE NOT lock.granted) AS waiting
  FROM external_platform.provider_state provider
  JOIN pg_locks lock
    ON lock.locktype = 'advisory'
   AND lock.database = (SELECT oid FROM pg_database WHERE datname = current_database())
   AND lock.objsubid = 1
   AND lock.objid::bigint = (hashtext('external-platform-cost:' || provider.provider_key)::bigint & 4294967295)
 GROUP BY provider.provider_key
 ORDER BY waiting DESC;
SELECT wait_event_type, wait_event, state, count(*) AS sessions
  FROM pg_stat_activity
 WHERE datname = current_database() AND state <> 'idle'
 GROUP BY 1, 2, 3
 ORDER BY sessions DESC;
DO $measure$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') THEN
    RAISE NOTICE 'pg_stat_statements: %', (
      SELECT coalesce(json_agg(row_to_json(statement)), '[]'::json)
        FROM (
          SELECT calls, round(mean_exec_time::numeric, 2) AS mean_ms,
                 round(max_exec_time::numeric, 2) AS max_ms, rows
            FROM pg_stat_statements
           WHERE query LIKE '%monthly_calls AS MATERIALIZED%'
           ORDER BY calls DESC
           LIMIT 5
        ) statement);
  ELSE
    RAISE NOTICE 'pg_stat_statements is not installed; use log_min_duration_statement or section 5 sizes';
  END IF;
END
$measure$;

-- 5. Off-peak: exact current-month volume per provider, one index range per
-- provider (never touches earlier months).
SELECT provider.provider_key, volume.calls, volume.usages, volume.costed_calls,
       volume.anomalous_calls
  FROM external_platform.provider_state provider
  CROSS JOIN LATERAL (
    SELECT count(*) AS calls,
           count(DISTINCT call.usage_request_id) AS usages,
           count(*) FILTER (WHERE call.cost_minor IS NOT NULL) AS costed_calls,
           count(*) FILTER (WHERE (call.cost_kind <> 'unknown'
               AND (call.cost_minor IS NULL OR call.cost_minor <= 0))
             OR (call.cost_minor IS NOT NULL
               AND (call.currency IS NULL OR call.currency !~ '^[A-Z]{3}$'))) AS anomalous_calls
      FROM external_platform.provider_calls call
     WHERE call.provider_key = provider.provider_key
       AND call.started_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  ) volume
 ORDER BY volume.calls DESC;

-- 6. Off-peak: last 24 h burst shape and the share of dispatches that bypass
-- the budget because the customer request is billed (enforced, held charge).
SELECT provider.provider_key, day.calls, day.peak_minute_calls, day.enforced_charge_calls
  FROM external_platform.provider_state provider
  CROSS JOIN LATERAL (
    SELECT coalesce(sum(per_minute.calls), 0) AS calls,
           coalesce(max(per_minute.calls), 0) AS peak_minute_calls,
           coalesce(sum(per_minute.enforced), 0) AS enforced_charge_calls
      FROM (
        SELECT date_trunc('minute', call.started_at) AS minute,
               count(*) AS calls,
               count(*) FILTER (WHERE charge.enforcement_mode = 'enforced') AS enforced
          FROM external_platform.provider_calls call
          LEFT JOIN billing.customer_charges charge
            ON charge.usage_request_id = call.usage_request_id
         WHERE call.provider_key = provider.provider_key
           AND call.started_at >= now() - interval '24 hours'
         GROUP BY 1
      ) per_minute
  ) day
 WHERE day.calls > 0
 ORDER BY day.peak_minute_calls DESC;

ROLLBACK;
