-- Release keyword account search under both providers that serve it.
--
-- One operation key, two releases: JustOne serves Xiaohongshu and Douyin,
-- TikHub serves Weibo and Kuaishou. Each vendor prices and gates the endpoints
-- it actually calls, so one being blocked never silences the other's platforms.
-- The contract, canonical records and dataset are shared regardless of vendor.
--
-- Seeding a policy authorizes nothing by itself: with no reviewed price for
-- xiaohongshu.account-search.v1 and douyin.account-search.v1 the operation
-- evaluates to `blocked` and keeps serving stored snapshots only.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

INSERT INTO control.external_platform_operation_releases
  (provider_key, operation_key, release_revision, contract_version, endpoint_keys,
   price_book_version, status)
VALUES
  (
    'justone', 'social.accounts.search', 1,
    'mx-insight-hub.social-accounts.v1',
    ARRAY['xiaohongshu.account-search.v1', 'douyin.account-search.v1']::text[],
    0, 'released'
  ),
  (
    'tikhub', 'social.accounts.search', 1,
    'mx-insight-hub.social-accounts.v1',
    ARRAY['weibo.account-search.v1', 'kuaishou.account-search.v1']::text[],
    0, 'released'
  )
ON CONFLICT (provider_key, operation_key, release_revision) DO NOTHING;

INSERT INTO control.external_platform_operation_policies
  (provider_key, operation_key, release_revision, control_source, desired_state,
   canary_consumer_ids, revision, updated_by)
SELECT provider_key, operation_key, release_revision, 'legacy_environment', 'active',
       '{}'::uuid[], 0, 'migration-069'
  FROM control.external_platform_operation_releases
 WHERE provider_key IN ('justone', 'tikhub')
   AND operation_key = 'social.accounts.search'
   AND release_revision = 1
ON CONFLICT (provider_key, operation_key) DO NOTHING;

INSERT INTO control.external_platform_operation_policy_events
  (event_id, provider_key, operation_key, previous_revision, revision,
   previous_state, desired_state, canary_consumer_ids, actor, reason)
SELECT (
         substr(md5(provider_key || ':' || operation_key || ':0'), 1, 8) || '-' ||
         substr(md5(provider_key || ':' || operation_key || ':0'), 9, 4) || '-4' ||
         substr(md5(provider_key || ':' || operation_key || ':0'), 14, 3) || '-8' ||
         substr(md5(provider_key || ':' || operation_key || ':0'), 18, 3) || '-' ||
         substr(md5(provider_key || ':' || operation_key || ':0'), 21, 12)
       )::uuid,
       provider_key, operation_key, NULL, 0, NULL, desired_state,
       canary_consumer_ids, 'migration-069',
       'Seeded in legacy-environment compatibility mode; blocked until a reviewed endpoint price exists'
  FROM control.external_platform_operation_policies
 WHERE provider_key IN ('justone', 'tikhub')
   AND operation_key = 'social.accounts.search'
   AND revision = 0
ON CONFLICT (provider_key, operation_key, revision) DO NOTHING;
