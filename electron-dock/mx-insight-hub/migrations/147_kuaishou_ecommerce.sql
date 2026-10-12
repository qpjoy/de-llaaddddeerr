-- Separate ecommerce grants; preserve the existing social operations and prices.
INSERT INTO control.external_platform_operation_releases
  (provider_key, operation_key, release_revision, contract_version, endpoint_keys, price_book_version, status)
VALUES
  ('tikhub', 'native.t.kuaishou_ecommerce_shopping_top_list', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.kuaishou_ecommerce_shopping_top_list']::text[], 0, 'released'),
  ('tikhub', 'native.t.kuaishou_ecommerce_brand_top_list', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.kuaishou_ecommerce_brand_top_list']::text[], 0, 'released')
ON CONFLICT DO NOTHING;

INSERT INTO control.external_platform_operation_policies
  (provider_key, operation_key, release_revision, control_source, desired_state, canary_consumer_ids, revision, updated_by)
SELECT provider_key, operation_key, 1, 'database', 'disabled', '{}'::uuid[], 1, 'migration-147'
FROM control.external_platform_operation_releases
WHERE provider_key = 'tikhub' AND release_revision = 1
  AND operation_key IN ('native.t.kuaishou_ecommerce_shopping_top_list', 'native.t.kuaishou_ecommerce_brand_top_list')
ON CONFLICT DO NOTHING;

INSERT INTO control.external_platform_operation_policy_events
  (event_id, provider_key, operation_key, previous_revision, revision, previous_state, desired_state, canary_consumer_ids, actor, reason)
SELECT gen_random_uuid(), provider_key, operation_key, NULL, 1, NULL, desired_state, canary_consumer_ids,
  'migration-147', 'Kuaishou ecommerce rankings: review procurement price and enable through existing operation controls'
FROM control.external_platform_operation_policies
WHERE updated_by = 'migration-147' AND revision = 1
ON CONFLICT DO NOTHING;
