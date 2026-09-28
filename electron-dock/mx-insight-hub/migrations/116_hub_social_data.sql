-- Independent Hub-owned operations. No legacy route, grant, credential,
-- customer price or identity is changed; activation requires reviewed costs.
ALTER TABLE control.procurement_price_drafts DROP CONSTRAINT procurement_price_drafts_provider_key_check;
ALTER TABLE control.procurement_price_drafts ADD CONSTRAINT procurement_price_drafts_provider_key_check
  CHECK (provider_key IN ('qixin', 'justone', 'tikhub', 'rapidapi'));

-- Empty bootstrap reference required by the release FK. No rates or reviewed
-- price are seeded; activation still requires a complete reviewed price book.
INSERT INTO control.external_platform_provider_price_books (provider_key, version, source, status)
VALUES ('rapidapi', 0, 'legacy_environment', 'inherited')
ON CONFLICT DO NOTHING;

INSERT INTO control.external_platform_operation_releases
  (provider_key, operation_key, release_revision, contract_version, endpoint_keys, price_book_version, status)
VALUES
  ('rapidapi', 'social.content.search', 1, 'mx-insight-hub.social-data.v1', ARRAY['twitter-aio.search']::text[], 0, 'released'),
  ('rapidapi', 'social.content.crawl', 1, 'mx-insight-hub.social-data.v1', ARRAY['twitter-aio.crawl']::text[], 0, 'released'),
  ('rapidapi', 'social.profile.get', 1, 'mx-insight-hub.social-data.v1', ARRAY['twitter-aio.user-info']::text[], 0, 'released')
ON CONFLICT DO NOTHING;

INSERT INTO control.external_platform_operation_policies
  (provider_key, operation_key, release_revision, control_source, desired_state, canary_consumer_ids, revision, updated_by)
SELECT provider_key, operation_key, 1, 'database', 'disabled', '{}'::uuid[], 1, 'migration-116'
FROM control.external_platform_operation_releases
WHERE provider_key = 'rapidapi' AND contract_version = 'mx-insight-hub.social-data.v1' AND release_revision = 1
ON CONFLICT DO NOTHING;

INSERT INTO control.external_platform_operation_policy_events
  (event_id, provider_key, operation_key, previous_revision, revision, previous_state, desired_state, canary_consumer_ids, actor, reason)
SELECT gen_random_uuid(), provider_key, operation_key, NULL, 1, NULL, desired_state, canary_consumer_ids,
       'migration-116', 'Independent Hub social operations start disabled; no legacy cutover'
FROM control.external_platform_operation_policies policy
WHERE updated_by = 'migration-116' AND revision = 1
  AND NOT EXISTS (SELECT 1 FROM control.external_platform_operation_policy_events event
    WHERE event.provider_key = policy.provider_key AND event.operation_key = policy.operation_key AND event.actor = 'migration-116')
ON CONFLICT DO NOTHING;
