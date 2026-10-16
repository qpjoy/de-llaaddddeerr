-- Register only the reviewed comment endpoint. Existing channel lookup/video
-- operations, grants, credentials, prices and policies remain unchanged.
INSERT INTO control.external_platform_operation_releases
  (provider_key, operation_key, release_revision, contract_version, endpoint_keys, price_book_version, status)
VALUES
  ('tikhub', 'native.t.api_4a6f21264dc0b4a1', 1, 'mx-insight-hub.native-forwarding.v1',
   ARRAY['native.t.api_4a6f21264dc0b4a1']::text[], 0, 'released')
ON CONFLICT DO NOTHING;

INSERT INTO control.external_platform_operation_policies
  (provider_key, operation_key, release_revision, control_source, desired_state, canary_consumer_ids, revision, updated_by)
VALUES
  ('tikhub', 'native.t.api_4a6f21264dc0b4a1', 1, 'database', 'disabled', '{}'::uuid[], 1, 'migration-155')
ON CONFLICT DO NOTHING;

INSERT INTO control.external_platform_operation_policy_events
  (event_id, provider_key, operation_key, previous_revision, revision, previous_state,
   desired_state, canary_consumer_ids, actor, reason)
SELECT gen_random_uuid(), provider_key, operation_key, NULL, 1, NULL,
  desired_state, canary_consumer_ids, 'migration-155',
  'YouTube comment contract registered; procurement price and activation use existing operation controls'
FROM control.external_platform_operation_policies
WHERE provider_key = 'tikhub' AND operation_key = 'native.t.api_4a6f21264dc0b4a1'
  AND updated_by = 'migration-155' AND revision = 1
ON CONFLICT DO NOTHING;
