-- Product registration only: no credentials, consumer/Key scopes, customer
-- prices, balances, existing operation policies or Launcher state are changed.
INSERT INTO control.external_platform_operation_releases
  (provider_key, operation_key, release_revision, contract_version, endpoint_keys, price_book_version, status)
VALUES
  ('justone', 'social.posts.hot_search', 1, 'mx-insight-hub.xiaohongshu-discovery.v1', ARRAY['xiaohongshu.hot-search.v1']::text[], 0, 'released'),
  ('tikhub', 'social.inspiration.list', 1, 'mx-insight-hub.xiaohongshu-discovery.v1', ARRAY['xiaohongshu.app-v2.creator-inspiration.v1']::text[], 0, 'released')
ON CONFLICT DO NOTHING;

INSERT INTO control.external_platform_operation_policies
  (provider_key, operation_key, release_revision, control_source, desired_state, canary_consumer_ids, revision, updated_by)
VALUES
  ('justone', 'social.posts.hot_search', 1, 'database', 'disabled', '{}'::uuid[], 1, 'migration-106'),
  ('tikhub', 'social.inspiration.list', 1, 'database', 'disabled', '{}'::uuid[], 1, 'migration-106')
ON CONFLICT DO NOTHING;

INSERT INTO control.external_platform_operation_policy_events
  (event_id, provider_key, operation_key, previous_revision, revision, previous_state, desired_state, canary_consumer_ids, actor, reason)
SELECT gen_random_uuid(), provider_key, operation_key, NULL, 1, NULL, desired_state, canary_consumer_ids,
       'migration-106', 'Independent Xiaohongshu discovery product; review procurement price and activate explicitly'
FROM control.external_platform_operation_policies
WHERE updated_by = 'migration-106' AND revision = 1
ON CONFLICT DO NOTHING;
