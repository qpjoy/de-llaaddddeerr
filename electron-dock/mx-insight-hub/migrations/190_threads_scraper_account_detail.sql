-- Separate product subscriptions under the same RapidAPI credential.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE control.strategy_search_routes
  DROP CONSTRAINT strategy_search_routes_interface_key_check,
  DROP CONSTRAINT strategy_search_routes_primary_provider_check,
  DROP CONSTRAINT strategy_search_routes_fallback_provider_check,
  ADD CONSTRAINT strategy_search_routes_interface_key_check CHECK (
    (interface_key = 'search' AND platform IN ('instagram','twitter','threads'))
    OR (interface_key IN ('crawl','user-info') AND platform = 'facebook' AND mode IN ('fixed','paused'))
    OR (interface_key IN ('crawl','user-info','post-detail') AND platform = 'threads')
    OR (interface_key = 'post-comments' AND platform IN ('twitter','reddit','kuaishou','instagram','weibo',
      'douyin','tiktok','zhihu','linkedin','bilibili','facebook','xiaohongshu','youtube','threads'))
    OR (interface_key = 'comment-replies' AND platform IN ('twitter','reddit','xiaohongshu','weibo',
      'instagram','douyin','bilibili','kuaishou','zhihu','threads'))),
  ADD CONSTRAINT strategy_search_routes_primary_provider_check CHECK (
    (platform = 'threads' AND primary_provider = 'rapidapi')
    OR (platform = 'threads' AND interface_key <> 'post-detail' AND primary_provider = 'tikhub')
    OR (platform = 'threads' AND interface_key IN ('search','crawl','user-info','post-detail') AND primary_provider = 'rapidapi-threads-scraper')
    OR (interface_key = 'search' AND platform = 'instagram' AND primary_provider IN ('justone','tikhub'))
    OR (interface_key = 'search' AND platform = 'twitter' AND primary_provider IN ('rapidapi','tikhub'))
    OR (interface_key IN ('crawl','user-info') AND platform = 'facebook' AND primary_provider = 'justone')
    OR (interface_key IN ('post-comments','comment-replies') AND platform <> 'threads' AND primary_provider IN ('justone','tikhub'))),
  ADD CONSTRAINT strategy_search_routes_fallback_provider_check CHECK (fallback_provider IS NULL
    OR (platform = 'threads' AND fallback_provider = 'rapidapi')
    OR (platform = 'threads' AND interface_key <> 'post-detail' AND fallback_provider = 'tikhub')
    OR (platform = 'threads' AND interface_key IN ('search','crawl','user-info','post-detail') AND fallback_provider = 'rapidapi-threads-scraper')
    OR (interface_key = 'search' AND platform = 'instagram' AND fallback_provider IN ('justone','tikhub'))
    OR (interface_key = 'search' AND platform = 'twitter' AND fallback_provider IN ('rapidapi','tikhub'))
    OR (interface_key IN ('post-comments','comment-replies') AND platform <> 'threads' AND fallback_provider IN ('justone','tikhub')));

-- Upgrade only the original, unaudited-by-an-operator default. Each changed
-- route advances its revision so open editors cannot overwrite the switch.
WITH switched AS (
  UPDATE control.strategy_search_routes AS route
  SET mode='fixed',primary_provider='rapidapi-threads-scraper',fallback_provider=NULL,
    revision=route.revision+1,reason='migration-190: use Threads Scraper subscription',updated_at=now()
  WHERE route.platform='threads' AND route.interface_key IN ('search','crawl','user-info')
    AND route.revision=1 AND route.mode='priority' AND route.primary_provider='rapidapi' AND route.fallback_provider='tikhub'
    AND EXISTS (SELECT 1 FROM control.strategy_search_route_events AS event
      WHERE event.interface_key=route.interface_key AND event.platform=route.platform AND event.revision=route.revision AND event.actor='migration-188')
  RETURNING route.*
), inserted AS (
  INSERT INTO control.strategy_search_routes(interface_key,platform,mode,primary_provider,fallback_provider,reason)
  VALUES ('post-detail','threads','fixed','rapidapi-threads-scraper',NULL,'migration-190: use Threads Scraper subscription')
  ON CONFLICT (interface_key,platform) DO NOTHING
  RETURNING *
)
INSERT INTO control.strategy_search_route_events(interface_key,platform,revision,actor,policy)
SELECT interface_key,platform,revision,'migration-190',jsonb_build_object(
  'interface',interface_key,'platform',platform,'mode',mode,'primaryProvider',primary_provider,
  'fallbackProvider',fallback_provider,'revision',revision,'reason',reason,'updatedAt',updated_at)
FROM (SELECT * FROM switched UNION ALL SELECT * FROM inserted) AS changed;

WITH operations AS (
  SELECT 'native.r.threads_scraper_' || suffix AS key FROM unnest(ARRAY[
    'user_detail','user_detail_with_biolink','search_users','user_posts','post_detail','resolve_post','post_media','profiles_batch'
  ]) AS suffix
), released AS (
  INSERT INTO control.external_platform_operation_releases
    (provider_key, operation_key, release_revision, contract_version, endpoint_keys, price_book_version, status)
  SELECT 'rapidapi', key, 1, 'mx-insight-hub.native-forwarding.v1', ARRAY[key], 0, 'released' FROM operations
  ON CONFLICT DO NOTHING
), inserted AS (
  INSERT INTO control.external_platform_operation_policies
    (provider_key, operation_key, release_revision, control_source, desired_state, canary_consumer_ids, revision, updated_by)
  SELECT 'rapidapi', key, 1, 'database', 'disabled', '{}'::uuid[], 1, 'migration-190' FROM operations
  ON CONFLICT DO NOTHING
  RETURNING *
)
INSERT INTO control.external_platform_operation_policy_events
  (event_id, provider_key, operation_key, previous_revision, revision, previous_state, desired_state, canary_consumer_ids, actor, reason)
SELECT gen_random_uuid(), provider_key, operation_key, NULL, revision, NULL, desired_state, canary_consumer_ids,
  updated_by, 'Register separately priced Threads Scraper operations'
FROM inserted;
