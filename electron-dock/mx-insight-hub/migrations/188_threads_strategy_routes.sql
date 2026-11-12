-- Threads joins Strategy Search on all five business interfaces, RapidAPI first
-- with TikHub as its guarantee. The RapidAPI read routes start disabled: they
-- still need a subscribed key, a reviewed price and an operation state.
-- Existing routes, grants, credentials and prices are not touched.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE control.strategy_search_routes
  DROP CONSTRAINT strategy_search_routes_interface_key_check,
  DROP CONSTRAINT strategy_search_routes_platform_check,
  DROP CONSTRAINT strategy_search_routes_primary_provider_check,
  DROP CONSTRAINT strategy_search_routes_fallback_provider_check,
  ADD CONSTRAINT strategy_search_routes_interface_key_check CHECK (
    (interface_key = 'search' AND platform IN ('instagram','twitter','threads'))
    OR (interface_key IN ('crawl','user-info') AND platform = 'facebook'
      AND mode IN ('fixed','paused'))
    OR (interface_key IN ('crawl','user-info') AND platform = 'threads')
    OR (interface_key = 'post-comments' AND platform IN ('twitter','reddit','kuaishou','instagram','weibo',
      'douyin','tiktok','zhihu','linkedin','bilibili','facebook','xiaohongshu','youtube','threads'))
    OR (interface_key = 'comment-replies' AND platform IN ('twitter','reddit','xiaohongshu','weibo',
      'instagram','douyin','bilibili','kuaishou','zhihu','threads'))),
  ADD CONSTRAINT strategy_search_routes_platform_check CHECK (platform IN ('instagram','twitter','facebook',
    'reddit','kuaishou','weibo','douyin','tiktok','zhihu','linkedin','bilibili','xiaohongshu','youtube','threads')),
  ADD CONSTRAINT strategy_search_routes_primary_provider_check CHECK (
    (platform = 'threads' AND primary_provider IN ('rapidapi','tikhub'))
    OR (interface_key = 'search' AND platform = 'instagram' AND primary_provider IN ('justone','tikhub'))
    OR (interface_key = 'search' AND platform = 'twitter' AND primary_provider IN ('rapidapi','tikhub'))
    OR (interface_key IN ('crawl','user-info') AND platform = 'facebook' AND primary_provider = 'justone')
    OR (interface_key IN ('post-comments','comment-replies') AND platform <> 'threads' AND primary_provider IN ('justone','tikhub'))),
  ADD CONSTRAINT strategy_search_routes_fallback_provider_check CHECK (fallback_provider IS NULL
    OR (platform = 'threads' AND fallback_provider IN ('rapidapi','tikhub'))
    OR (interface_key = 'search' AND platform = 'instagram' AND fallback_provider IN ('justone','tikhub'))
    OR (interface_key = 'search' AND platform = 'twitter' AND fallback_provider IN ('rapidapi','tikhub'))
    OR (interface_key IN ('post-comments','comment-replies') AND platform <> 'threads' AND fallback_provider IN ('justone','tikhub')));

WITH inserted AS (
  INSERT INTO control.strategy_search_routes(interface_key,platform,mode,primary_provider,fallback_provider,reason)
  VALUES
    ('search','threads','priority','rapidapi','tikhub','migration-188: RapidAPI first, TikHub guarantee'),
    ('crawl','threads','priority','rapidapi','tikhub','migration-188: RapidAPI first, TikHub guarantee'),
    ('user-info','threads','priority','rapidapi','tikhub','migration-188: RapidAPI first, TikHub guarantee'),
    ('post-comments','threads','priority','rapidapi','tikhub','migration-188: RapidAPI first, TikHub guarantee'),
    ('comment-replies','threads','priority','rapidapi','tikhub','migration-188: RapidAPI first, TikHub guarantee')
  ON CONFLICT (interface_key,platform) DO NOTHING
  RETURNING *
)
INSERT INTO control.strategy_search_route_events(interface_key,platform,revision,actor,policy)
SELECT interface_key,platform,revision,'migration-188',jsonb_build_object(
  'interface',interface_key,'platform',platform,'mode',mode,'primaryProvider',primary_provider,
  'fallbackProvider',fallback_provider,'revision',revision,'reason',reason,'updatedAt',updated_at)
FROM inserted;

INSERT INTO control.external_platform_operation_releases
  (provider_key, operation_key, release_revision, contract_version, endpoint_keys, price_book_version, status)
SELECT 'rapidapi', 'native.' || key, 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.' || key]::text[], 0, 'released'
FROM unnest(ARRAY['r.threads_user_info','r.threads_user_posts','r.threads_user_reposts','r.threads_user_replies',
  'r.threads_post_get_id','r.threads_post_detail','r.threads_post_related','r.threads_post_comments',
  'r.threads_search_top','r.threads_search_recent','r.threads_search_profiles']) AS key
ON CONFLICT DO NOTHING;

INSERT INTO control.external_platform_operation_policies
  (provider_key, operation_key, release_revision, control_source, desired_state, canary_consumer_ids, revision, updated_by)
SELECT provider_key, operation_key, 1, 'database', 'disabled', '{}'::uuid[], 1, 'migration-188'
FROM control.external_platform_operation_releases
WHERE release_revision = 1 AND provider_key = 'rapidapi' AND operation_key LIKE 'native.r.threads\_%'
ON CONFLICT DO NOTHING;

INSERT INTO control.external_platform_operation_policy_events
  (event_id, provider_key, operation_key, previous_revision, revision, previous_state, desired_state, canary_consumer_ids, actor, reason)
SELECT gen_random_uuid(), provider_key, operation_key, NULL, 1, NULL, desired_state, canary_consumer_ids,
  'migration-188', 'Threads RapidAPI listing: subscribe the key, review the price and enable through operation controls'
FROM control.external_platform_operation_policies policy
WHERE updated_by = 'migration-188' AND revision = 1
  AND NOT EXISTS (SELECT 1 FROM control.external_platform_operation_policy_events event
    WHERE event.provider_key = policy.provider_key AND event.operation_key = policy.operation_key AND event.actor = 'migration-188')
ON CONFLICT DO NOTHING;
