-- Twitter comments and replies use the existing Twitter AIO subscription.
-- Preserve reviewed routes, credentials, prices, receipts and existing cursors.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE control.strategy_search_routes
  DROP CONSTRAINT strategy_search_routes_primary_provider_check,
  DROP CONSTRAINT strategy_search_routes_fallback_provider_check,
  ADD CONSTRAINT strategy_search_routes_primary_provider_check CHECK (
    (platform = 'threads' AND primary_provider = 'rapidapi')
    OR (platform = 'threads' AND interface_key <> 'post-detail' AND primary_provider = 'tikhub')
    OR (platform = 'threads' AND interface_key IN ('search','crawl','user-info','post-detail') AND primary_provider = 'rapidapi-threads-scraper')
    OR (interface_key = 'search' AND platform = 'instagram' AND primary_provider IN ('justone','tikhub'))
    OR (interface_key = 'search' AND platform = 'twitter' AND primary_provider IN ('rapidapi','tikhub'))
    OR (interface_key IN ('crawl','user-info') AND platform = 'facebook' AND primary_provider = 'justone')
    OR (interface_key IN ('post-comments','comment-replies') AND platform <> 'threads' AND primary_provider IN ('justone','tikhub'))
    OR (interface_key IN ('post-comments','comment-replies') AND platform = 'twitter' AND primary_provider = 'rapidapi')),
  ADD CONSTRAINT strategy_search_routes_fallback_provider_check CHECK (fallback_provider IS NULL
    OR (platform = 'threads' AND fallback_provider = 'rapidapi')
    OR (platform = 'threads' AND interface_key <> 'post-detail' AND fallback_provider = 'tikhub')
    OR (platform = 'threads' AND interface_key IN ('search','crawl','user-info','post-detail') AND fallback_provider = 'rapidapi-threads-scraper')
    OR (interface_key = 'search' AND platform = 'instagram' AND fallback_provider IN ('justone','tikhub'))
    OR (interface_key = 'search' AND platform = 'twitter' AND fallback_provider IN ('rapidapi','tikhub'))
    OR (interface_key IN ('post-comments','comment-replies') AND platform <> 'threads' AND fallback_provider IN ('justone','tikhub'))
    OR (interface_key IN ('post-comments','comment-replies') AND platform = 'twitter' AND fallback_provider = 'rapidapi'));

-- Only upgrade the untouched migration-181 defaults. An operator's fixed,
-- priority or paused selection keeps its revision and immutable audit history.
WITH switched AS (
  UPDATE control.strategy_search_routes AS route
  SET mode='priority',primary_provider='rapidapi',fallback_provider='tikhub',
    revision=route.revision+1,reason='migration-191: RapidAPI first, TikHub guarantee',updated_at=now()
  WHERE route.platform='twitter' AND route.revision=1 AND route.primary_provider='tikhub'
    AND ((route.interface_key='post-comments' AND route.mode='priority' AND route.fallback_provider='justone'
      AND route.reason='migration-181: TikHub first, JustOne guarantee')
      OR (route.interface_key='comment-replies' AND route.mode='fixed' AND route.fallback_provider IS NULL
        AND route.reason='migration-181: TikHub replies'))
    AND EXISTS (SELECT 1 FROM control.strategy_search_route_events AS event
      WHERE event.interface_key=route.interface_key AND event.platform=route.platform
        AND event.revision=route.revision AND event.actor='migration-181')
  RETURNING route.*
), inserted AS (
  INSERT INTO control.strategy_search_routes(interface_key,platform,mode,primary_provider,fallback_provider,reason)
  SELECT seed.* FROM (VALUES
    ('post-comments','twitter','priority','rapidapi','tikhub','migration-191: RapidAPI first, TikHub guarantee'),
    ('comment-replies','twitter','priority','rapidapi','tikhub','migration-191: RapidAPI first, TikHub guarantee')
  ) AS seed(interface_key,platform,mode,primary_provider,fallback_provider,reason)
  WHERE NOT EXISTS (SELECT 1 FROM control.strategy_search_route_events AS event
    WHERE event.interface_key=seed.interface_key AND event.platform=seed.platform)
  ON CONFLICT (interface_key,platform) DO NOTHING
  RETURNING *
)
INSERT INTO control.strategy_search_route_events(interface_key,platform,revision,actor,policy)
SELECT interface_key,platform,revision,'migration-191',jsonb_build_object(
  'interface',interface_key,'platform',platform,'mode',mode,'primaryProvider',primary_provider,
  'fallbackProvider',fallback_provider,'revision',revision,'reason',reason,'updatedAt',updated_at)
FROM (SELECT * FROM switched UNION ALL SELECT * FROM inserted) AS changed;

WITH released AS (
  INSERT INTO control.external_platform_operation_releases
    (provider_key, operation_key, release_revision, contract_version, endpoint_keys, price_book_version, status)
  VALUES ('rapidapi','native.r.twitter_aio_tweet_replies',1,'mx-insight-hub.native-forwarding.v1',
    ARRAY['native.r.twitter_aio_tweet_replies']::text[],0,'released')
  ON CONFLICT DO NOTHING
), inserted AS (
  INSERT INTO control.external_platform_operation_policies
    (provider_key, operation_key, release_revision, control_source, desired_state, canary_consumer_ids, revision, updated_by)
  VALUES ('rapidapi','native.r.twitter_aio_tweet_replies',1,'database','disabled','{}'::uuid[],1,'migration-191')
  ON CONFLICT DO NOTHING
  RETURNING *
)
INSERT INTO control.external_platform_operation_policy_events
  (event_id, provider_key, operation_key, previous_revision, revision, previous_state, desired_state, canary_consumer_ids, actor, reason)
SELECT gen_random_uuid(), provider_key, operation_key, NULL, revision, NULL, desired_state, canary_consumer_ids,
  updated_by, 'Register separately priced Twitter AIO post comments and replies'
FROM inserted;
