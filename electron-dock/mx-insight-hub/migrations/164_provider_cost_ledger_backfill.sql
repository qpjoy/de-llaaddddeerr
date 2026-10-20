-- Open every usage request that already has calls in the months admission can
-- still read. This is deliberately a separate migration (transaction) from
-- 163: once 163 has committed, each new call opens its own row through the
-- trigger, and every call committed before the trigger existed is visible to
-- this snapshot, so no call can fall between the two. The scan takes no lock
-- that blocks provider-call writers. Nothing is folded here; the first
-- background folds move finished requests into the monthly totals.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

INSERT INTO external_platform.provider_cost_open_usages
  (provider_key, month, usage_request_id)
SELECT DISTINCT call.provider_key,
       date_trunc('month', call.started_at AT TIME ZONE 'UTC')::date,
       call.usage_request_id
  FROM external_platform.provider_calls call
 WHERE call.started_at >= (
         date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month'
       ) AT TIME ZONE 'UTC'
ON CONFLICT DO NOTHING;
