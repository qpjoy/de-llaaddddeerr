-- Read-only: LCY-delta supplier load, to size the data-product supplier limits
-- before switching its Hub limit switch to supplier "priority".
--
-- Run on the operator host, from electron-dock/mx-insight-hub:
--   kubectl -n mx-common exec -i statefulset/mx-common-postgres -- \
--     psql -X -U mx_common -d mx_insight_hub < scripts/inspect-lcy-supplier-load.sql
--
-- One read-only transaction with a statement timeout. It scans the last
-- 7 days of provider_calls and usage_requests for one Key; run it off-peak.
-- No secrets, request bodies or supplier responses are selected.
\set ON_ERROR_STOP on
\pset pager off
BEGIN READ ONLY;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '2s';

\echo '== 0. Migration 172 (supplier priority) applied?'
SELECT filename, applied_at FROM schema_migrations WHERE filename = '172_api_key_supplier_priority.sql';
SELECT hub_rate_limit_exempt, hub_supplier_admission, hub_rate_limit_revision
  FROM api_keys WHERE id = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83';

\echo '== 1. Saved supplier limits (a provider without a row uses its deployment default)'
SELECT provider_key, revision, max_concurrency, max_consumer_concurrency,
       max_requests_per_minute, max_wait_ms, max_pending, updated_at
  FROM control.external_platform_admission_policies ORDER BY provider_key;

\echo '== 2. LCY supplier calls per minute and latency, last 7 days'
\echo '   needed_concurrency ~ p99_per_min x p95 latency / 60 s: set the saved concurrency at least this high'
WITH calls AS (
  SELECT provider_key, started_at, latency_ms
    FROM external_platform.provider_calls
   WHERE api_key_id = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
     AND started_at >= now() - interval '7 days'
), minutes AS (
  SELECT provider_key, date_trunc('minute', started_at) AS minute, count(*) AS calls
    FROM calls GROUP BY 1, 2
), latency AS (
  SELECT provider_key,
         percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50_latency_ms,
         percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency_ms
    FROM calls WHERE latency_ms IS NOT NULL GROUP BY 1
)
SELECT m.provider_key, sum(m.calls) AS calls, count(*) AS active_minutes,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY m.calls) AS p50_per_min,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY m.calls) AS p95_per_min,
       percentile_disc(0.99) WITHIN GROUP (ORDER BY m.calls) AS p99_per_min,
       max(m.calls) AS max_per_min,
       max(l.p50_latency_ms) AS p50_latency_ms, max(l.p95_latency_ms) AS p95_latency_ms,
       ceil(percentile_disc(0.99) WITHIN GROUP (ORDER BY m.calls) * coalesce(max(l.p95_latency_ms), 0) / 60000.0)
         AS needed_concurrency
  FROM minutes m LEFT JOIN latency l USING (provider_key)
 GROUP BY m.provider_key ORDER BY calls DESC;

\echo '== 3. Peak LCY supplier calls in flight at once, last 7 days'
WITH calls AS (
  SELECT provider_key, started_at,
         -- A call still pending after two minutes is stale evidence, not load.
         least(coalesce(completed_at, started_at + interval '2 minutes'), started_at + interval '2 minutes') AS ended_at
    FROM external_platform.provider_calls
   WHERE api_key_id = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
     AND started_at >= now() - interval '7 days'
), events AS (
  SELECT provider_key, started_at AS at, 1 AS delta FROM calls
  UNION ALL
  SELECT provider_key, ended_at, -1 FROM calls
), running AS (
  SELECT provider_key, sum(delta) OVER (PARTITION BY provider_key ORDER BY at, delta
                                        ROWS UNBOUNDED PRECEDING) AS in_flight
    FROM events
)
SELECT provider_key, max(in_flight) AS peak_in_flight,
       percentile_disc(0.99) WITHIN GROUP (ORDER BY in_flight) AS p99_in_flight
  FROM running GROUP BY 1 ORDER BY 2 DESC;

\echo '== 4. Supplier rate refusals: do they come in busy minutes (pacing helps) or quiet ones (supplier side)?'
WITH per_minute AS (
  SELECT provider_key, date_trunc('minute', started_at) AS minute, count(*) AS calls,
         -- RapidAPI social refusals keep their own code; their HTTP 429 is the signal.
         count(*) FILTER (WHERE error_code = 'upstream_rate_limited' OR http_status = 429) AS limited,
         count(*) FILTER (WHERE (error_code = 'upstream_rate_limited' OR http_status = 429) AND billed IS FALSE) AS limited_unbilled
    FROM external_platform.provider_calls
   WHERE api_key_id = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
     AND started_at >= now() - interval '7 days'
   GROUP BY 1, 2
)
SELECT provider_key, sum(limited) AS rate_limited_calls, sum(limited_unbilled) AS unbilled_rate_limited,
       count(*) FILTER (WHERE limited > 0) AS minutes_with_429,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY calls) FILTER (WHERE limited > 0) AS median_calls_in_429_minutes,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY calls) AS median_calls_all_minutes
  FROM per_minute GROUP BY 1 HAVING sum(limited) > 0 ORDER BY 2 DESC;

\echo '== 5. LCY HTTP requests in flight (resource limit: 32 per Key per API process, 4 processes)'
WITH requests AS (
  SELECT reserved_at AS started_at,
         least(coalesce(completed_at, reserved_at + interval '2 minutes'), reserved_at + interval '2 minutes') AS ended_at
    FROM usage_requests
   WHERE api_key_id = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
     AND reserved_at >= now() - interval '7 days'
), events AS (
  SELECT started_at AS at, 1 AS delta FROM requests
  UNION ALL
  SELECT ended_at, -1 FROM requests
), running AS (
  SELECT sum(delta) OVER (ORDER BY at, delta ROWS UNBOUNDED PRECEDING) AS in_flight FROM events
)
SELECT max(in_flight) AS peak_in_flight,
       percentile_disc(0.99) WITHIN GROUP (ORDER BY in_flight) AS p99_in_flight
  FROM running;

\echo '== 6. LCY failures by platform and code, last 7 days'
SELECT platform, response_status,
       coalesce(error_code, response_body #>> '{error,code}') AS code,
       response_body #>> '{error,details,layer}' AS layer,
       response_body #>> '{error,details,reason}' AS reason,
       count(*) AS requests
  FROM usage_requests
 WHERE api_key_id = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
   AND created_at >= now() - interval '7 days'
   AND (response_status >= 400 OR status = 'unknown')
 GROUP BY 1, 2, 3, 4, 5
 ORDER BY requests DESC
 LIMIT 40;

\echo '== 7. LCY failures in equal windows before and after the last switch save (up to 24 h each)'
WITH switch AS (
  SELECT hub_rate_limit_updated_at AS at, least(now() - hub_rate_limit_updated_at, interval '24 hours') AS span
    FROM api_keys WHERE id = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
), scoped AS (
  SELECT CASE WHEN u.created_at >= w.at THEN 'after' ELSE 'before' END AS period, u.*
    FROM usage_requests u, switch w
   WHERE u.api_key_id = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
     AND u.created_at >= w.at - w.span AND u.created_at < w.at + w.span
)
SELECT period, min(created_at) AS from_at, max(created_at) AS to_at, count(*) AS requests,
       count(*) FILTER (WHERE response_status >= 400 OR status = 'unknown') AS failed,
       count(*) FILTER (WHERE response_body #>> '{error,details,reason}' = 'upstream_rate_limited') AS upstream_rate_limited,
       count(*) FILTER (WHERE response_body #>> '{error,details,admissionMode}' = 'priority'
                          OR coalesce(error_code, response_body #>> '{error,code}') = 'external_platform_rate_limited') AS hub_priority_wait_refused
  FROM scoped GROUP BY 1 ORDER BY 1 DESC;

\echo '== 8. Rate-refusal shape: what each supplier accepted per minute and per second, last 7 days'
\echo '   accepted_per_min_when_429 ~ the supplier minute limit; ok_per_sec ~ bursts it took without refusing'
WITH calls AS (
  SELECT provider_key, started_at,
         (error_code IS NOT DISTINCT FROM 'upstream_rate_limited' OR http_status IS NOT DISTINCT FROM 429) AS limited
    FROM external_platform.provider_calls
   WHERE api_key_id = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
     AND started_at >= now() - interval '7 days'
), minutes AS (
  SELECT provider_key, count(*) - count(*) FILTER (WHERE limited) AS accepted, count(*) FILTER (WHERE limited) AS limited
    FROM calls GROUP BY provider_key, date_trunc('minute', started_at)
), seconds AS (
  SELECT provider_key, count(*) AS calls, bool_or(limited) AS limited
    FROM calls GROUP BY provider_key, date_trunc('second', started_at)
), by_minute AS (
  SELECT provider_key,
         percentile_disc(0.5) WITHIN GROUP (ORDER BY accepted) FILTER (WHERE limited > 0) AS p50_accepted_per_min_when_429,
         percentile_disc(0.9) WITHIN GROUP (ORDER BY accepted) FILTER (WHERE limited > 0) AS p90_accepted_per_min_when_429
    FROM minutes GROUP BY 1 HAVING sum(limited) > 0
), by_second AS (
  SELECT provider_key,
         percentile_disc(0.5) WITHIN GROUP (ORDER BY calls) FILTER (WHERE limited) AS p50_calls_per_sec_when_429,
         percentile_disc(0.99) WITHIN GROUP (ORDER BY calls) FILTER (WHERE NOT limited) AS p99_ok_per_sec,
         max(calls) FILTER (WHERE NOT limited) AS max_ok_per_sec
    FROM seconds GROUP BY 1
)
SELECT * FROM by_minute JOIN by_second USING (provider_key) ORDER BY provider_key;

ROLLBACK;
