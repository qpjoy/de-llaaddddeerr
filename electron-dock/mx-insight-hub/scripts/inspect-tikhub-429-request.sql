-- Read-only: why one dispatched TikHub call came back 429 — Hub's own burst,
-- Hub traffic that skips the provider bucket, or a limit outside Hub's view.
--
-- Run on the operator host, from electron-dock/mx-insight-hub:
--   kubectl -n mx-common exec -i statefulset/mx-common-postgres -- \
--     psql -X -U mx_common -d mx_insight_hub -v request_id=<Hub request UUID> \
--     < scripts/inspect-tikhub-429-request.sql
--
-- One read-only transaction with a statement timeout. Sections 5-6 scan at
-- most 24 hours on each side of the last LCY switch save. No secrets, request
-- bodies, queries or supplier responses are selected.
\set ON_ERROR_STOP on
\pset pager off
BEGIN READ ONLY;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '2s';

\echo '== 0. LCY switch, saved TikHub limits, bucket and shared provider state now'
SELECT hub_rate_limit_exempt, hub_supplier_admission, hub_rate_limit_revision, hub_rate_limit_updated_at
  FROM api_keys WHERE id = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83';
SELECT provider_key, revision, max_concurrency, max_requests_per_minute, max_wait_ms, updated_at
  FROM control.external_platform_admission_policies WHERE provider_key = 'tikhub';
SELECT provider_key, capacity, window_ms, round(tokens::numeric, 2) AS tokens, refilled_at
  FROM external_platform.provider_rate_buckets WHERE provider_key = 'tikhub';
SELECT provider_key, consecutive_failures, last_error_code, last_failure_at, last_success_at
  FROM external_platform.provider_state WHERE provider_key = 'tikhub';

\echo '== 1. The request (switch_saved_before = false means it ran under the earlier switch state)'
SELECT u.id, u.platform, u.status, u.response_status,
       coalesce(u.error_code, u.response_body #>> '{error,code}') AS code,
       u.response_body #>> '{error,details,reason}' AS reason,
       u.response_body #>> '{error,details,admissionMode}' AS admission_mode,
       u.api_key_id = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83' AS is_lcy,
       u.reserved_at, u.completed_at,
       round(extract(epoch FROM u.completed_at - u.reserved_at) * 1000) AS duration_ms,
       k.hub_rate_limit_updated_at < u.reserved_at AS switch_saved_before
  FROM usage_requests u
  JOIN api_keys k ON k.id = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
 WHERE u.id = :'request_id';

\echo '== 2. Its supplier calls (queued_ms = time from request start to dispatch: Hub waiting or pacing)'
SELECT c.call_ordinal, c.call_role, c.marketplace, c.endpoint_key, c.outcome, c.http_status,
       c.business_code, c.error_code, c.billed, c.started_at, c.latency_ms,
       round(extract(epoch FROM c.started_at - u.reserved_at) * 1000) AS queued_ms
  FROM external_platform.provider_calls c
  JOIN usage_requests u ON u.id = c.usage_request_id
 WHERE c.usage_request_id = :'request_id'
 ORDER BY c.call_ordinal;

\echo '== 3. Every Hub TikHub dispatch per second, 60 s before to 5 s after that call'
\echo '   managed_full keys skip the provider bucket; keys in MX_INSIGHT_INTERNAL_KEY_IDS/TENANT_IDS do too but show as other'
WITH anchor AS (
  SELECT min(started_at) AS at FROM external_platform.provider_calls
   WHERE usage_request_id = :'request_id' AND provider_key = 'tikhub'
)
SELECT date_trunc('second', c.started_at) AS second, count(*) AS calls,
       count(*) FILTER (WHERE c.api_key_id = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83') AS lcy,
       count(*) FILTER (WHERE c.api_key_id <> 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83' AND k.access_profile = 'managed_full') AS managed_full,
       count(*) FILTER (WHERE c.api_key_id <> 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83' AND k.access_profile <> 'managed_full') AS other,
       count(*) FILTER (WHERE c.error_code = 'upstream_rate_limited' OR c.http_status = 429) AS limited,
       string_agg(DISTINCT c.marketplace, ',') AS marketplaces,
       bool_or(c.usage_request_id = :'request_id') AS this_request
  FROM external_platform.provider_calls c
  JOIN api_keys k ON k.id = c.api_key_id, anchor a
 WHERE c.provider_key = 'tikhub'
   AND c.started_at >= a.at - interval '60 seconds' AND c.started_at < a.at + interval '5 seconds'
 GROUP BY 1 ORDER BY 1;

\echo '== 4. Hub TikHub dispatches per minute, 10 min each side of that call'
WITH anchor AS (
  SELECT min(started_at) AS at FROM external_platform.provider_calls
   WHERE usage_request_id = :'request_id' AND provider_key = 'tikhub'
), seconds AS (
  SELECT date_trunc('second', c.started_at) AS second, count(*) AS calls,
         count(*) FILTER (WHERE c.api_key_id = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83') AS lcy,
         count(*) FILTER (WHERE c.error_code = 'upstream_rate_limited' OR c.http_status = 429) AS limited
    FROM external_platform.provider_calls c, anchor a
   WHERE c.provider_key = 'tikhub'
     AND c.started_at >= a.at - interval '10 minutes' AND c.started_at < a.at + interval '10 minutes'
   GROUP BY 1
)
SELECT date_trunc('minute', second) AS minute, sum(calls) AS calls, sum(lcy) AS lcy,
       sum(calls) - sum(lcy) AS not_lcy, sum(limited) AS limited, max(calls) AS max_per_second
  FROM seconds GROUP BY 1 ORDER BY 1;

\echo '== 5. Hub TikHub load before and after the last switch save (up to 24 h each)'
\echo '   after: lcy max_lcy_per_second <= 1-2 means LCY is paced; limited still high means the cause is not LCY bursts'
WITH switch AS (
  SELECT hub_rate_limit_updated_at AS at, least(now() - hub_rate_limit_updated_at, interval '24 hours') AS span
    FROM api_keys WHERE id = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
), calls AS (
  SELECT CASE WHEN c.started_at >= w.at THEN 'after' ELSE 'before' END AS period, c.started_at,
         c.api_key_id = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83' AS lcy,
         (c.error_code IS NOT DISTINCT FROM 'upstream_rate_limited' OR c.http_status IS NOT DISTINCT FROM 429) AS limited
    FROM external_platform.provider_calls c, switch w
   WHERE c.provider_key = 'tikhub' AND c.started_at >= w.at - w.span AND c.started_at < w.at + w.span
), minutes AS (
  SELECT period, count(*) AS calls FROM calls GROUP BY period, date_trunc('minute', started_at)
), seconds AS (
  SELECT period, count(*) AS calls, count(*) FILTER (WHERE lcy) AS lcy_calls
    FROM calls GROUP BY period, date_trunc('second', started_at)
)
SELECT c.period, min(c.started_at) AS from_at, max(c.started_at) AS to_at, count(*) AS calls,
       count(*) FILTER (WHERE c.lcy) AS lcy_calls, count(*) FILTER (WHERE c.limited) AS limited,
       count(*) FILTER (WHERE c.limited AND c.lcy) AS lcy_limited,
       round(100.0 * count(*) FILTER (WHERE c.limited) / nullif(count(*), 0), 1) AS limited_pct,
       (SELECT percentile_disc(0.99) WITHIN GROUP (ORDER BY calls) FROM minutes m WHERE m.period = c.period) AS p99_per_min,
       (SELECT max(calls) FROM minutes m WHERE m.period = c.period) AS max_per_min,
       (SELECT max(calls) FROM seconds s WHERE s.period = c.period) AS max_per_second,
       (SELECT max(lcy_calls) FROM seconds s WHERE s.period = c.period) AS max_lcy_per_second
  FROM calls c GROUP BY c.period ORDER BY c.period DESC;

\echo '== 6. After the switch save: Hub load seen by limited vs accepted calls'
\echo '   similar numbers in both rows mean TikHub refused at a load Hub also got through: a limit outside Hub (shared credential, endpoint)'
WITH switch AS (
  SELECT hub_rate_limit_updated_at AS at FROM api_keys WHERE id = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
), calls AS (
  SELECT c.id, c.started_at,
         -- A call still pending after two minutes is stale evidence, not load.
         least(coalesce(c.completed_at, c.started_at + interval '2 minutes'), c.started_at + interval '2 minutes') AS ended_at,
         (c.error_code IS NOT DISTINCT FROM 'upstream_rate_limited' OR c.http_status IS NOT DISTINCT FROM 429) AS limited
    FROM external_platform.provider_calls c, switch w
   WHERE c.provider_key = 'tikhub' AND c.started_at >= w.at
     AND c.started_at < w.at + interval '24 hours'
), rated AS (
  SELECT id, limited,
         count(*) OVER (ORDER BY started_at RANGE BETWEEN interval '10 seconds' PRECEDING AND CURRENT ROW) AS started_last_10s,
         count(*) OVER (ORDER BY started_at RANGE BETWEEN interval '60 seconds' PRECEDING AND CURRENT ROW) AS started_last_60s
    FROM calls
), events AS (
  SELECT id, started_at AS at, 1 AS delta FROM calls
  UNION ALL
  SELECT NULL, ended_at, -1 FROM calls
), running AS (
  SELECT id, sum(delta) OVER (ORDER BY at, delta DESC ROWS UNBOUNDED PRECEDING) AS in_flight FROM events
)
SELECT r.limited, count(*) AS calls,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY r.started_last_10s) AS p50_started_10s,
       percentile_disc(0.9) WITHIN GROUP (ORDER BY r.started_last_10s) AS p90_started_10s,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY r.started_last_60s) AS p50_started_60s,
       percentile_disc(0.9) WITHIN GROUP (ORDER BY r.started_last_60s) AS p90_started_60s,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY g.in_flight) AS p50_in_flight,
       percentile_disc(0.9) WITHIN GROUP (ORDER BY g.in_flight) AS p90_in_flight
  FROM rated r JOIN running g USING (id)
 GROUP BY r.limited ORDER BY r.limited;

ROLLBACK;
