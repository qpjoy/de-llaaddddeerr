-- Independent native operations for two marketplace listings. SHEIN's gateway
-- rejected the existing subscription. Preserve that pause during price seeding.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

WITH seed(operation_key, desired_state, reason) AS (
  VALUES
    ('native.r.pinduoduo_search_products', 'disabled', 'Register Pinduoduo keyword search verified with a live product page'),
    ('native.r.shein_search_products', 'paused', 'Hold SHEIN keyword search pending listing subscription and live response verification')
), released AS (
  INSERT INTO control.external_platform_operation_releases
    (provider_key, operation_key, release_revision, contract_version, endpoint_keys, price_book_version, status)
  SELECT 'rapidapi', operation_key, 1, 'mx-insight-hub.native-forwarding.v1', ARRAY[operation_key], 0, 'released'
  FROM seed
  ON CONFLICT DO NOTHING
), inserted AS (
  INSERT INTO control.external_platform_operation_policies
    (provider_key, operation_key, release_revision, control_source, desired_state, canary_consumer_ids, revision, updated_by)
  SELECT 'rapidapi', operation_key, 1, 'database', desired_state, '{}'::uuid[], 1, 'migration-195'
  FROM seed
  ON CONFLICT DO NOTHING
  RETURNING *
)
INSERT INTO control.external_platform_operation_policy_events
  (event_id, provider_key, operation_key, previous_revision, revision, previous_state, desired_state, canary_consumer_ids, actor, reason)
SELECT gen_random_uuid(), i.provider_key, i.operation_key, NULL, i.revision, NULL, i.desired_state,
  i.canary_consumer_ids, i.updated_by, seed.reason
FROM inserted i JOIN seed USING (operation_key);
