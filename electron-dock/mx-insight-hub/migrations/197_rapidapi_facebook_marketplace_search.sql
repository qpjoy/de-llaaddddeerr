-- The subscribed gateway returned a valid empty page. Keep this operation on
-- hold until a non-empty listing has been checked against a Marketplace search.
SET LOCAL lock_timeout = '5s';

INSERT INTO control.external_platform_operation_releases
  (provider_key, operation_key, release_revision, contract_version, endpoint_keys, price_book_version, status)
VALUES
  ('rapidapi', 'native.r.facebook_marketplace_search', 1, 'mx-insight-hub.native-forwarding.v1',
   ARRAY['native.r.facebook_marketplace_search'], 0, 'released')
ON CONFLICT DO NOTHING;

WITH inserted AS (
  INSERT INTO control.external_platform_operation_policies
    (provider_key, operation_key, release_revision, control_source, desired_state, canary_consumer_ids, revision, updated_by)
  VALUES ('rapidapi', 'native.r.facebook_marketplace_search', 1, 'database', 'paused', '{}'::uuid[], 1, 'migration-197')
  ON CONFLICT DO NOTHING
  RETURNING *
)
INSERT INTO control.external_platform_operation_policy_events
  (event_id, provider_key, operation_key, previous_revision, revision, previous_state, desired_state, canary_consumer_ids, actor, reason)
SELECT gen_random_uuid(), provider_key, operation_key, NULL, revision, NULL, desired_state,
       canary_consumer_ids, updated_by, 'Marketplace gateway returned an empty list; verify a non-empty page before enabling'
FROM inserted;
