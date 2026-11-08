-- Single-post comments and comment replies join the audited Strategy Search
-- routing (server/contracts/comment-routes.mjs). Search, account and Facebook
-- policies keep their saved values; no grants, credentials or prices change.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE control.strategy_search_routes
  DROP CONSTRAINT strategy_search_routes_interface_key_check,
  DROP CONSTRAINT strategy_search_routes_platform_check,
  DROP CONSTRAINT strategy_search_routes_primary_provider_check,
  DROP CONSTRAINT strategy_search_routes_fallback_provider_check,
  ADD CONSTRAINT strategy_search_routes_interface_key_check CHECK (
    (interface_key = 'search' AND platform IN ('instagram','twitter'))
    OR (interface_key IN ('crawl','user-info') AND platform = 'facebook'
      AND mode IN ('fixed','paused'))
    OR (interface_key = 'post-comments' AND platform IN ('twitter','reddit','kuaishou','instagram','weibo',
      'douyin','tiktok','zhihu','linkedin','bilibili','facebook','xiaohongshu','youtube'))
    OR (interface_key = 'comment-replies' AND platform IN ('twitter','reddit','xiaohongshu','weibo',
      'instagram','douyin','bilibili','kuaishou','zhihu'))),
  ADD CONSTRAINT strategy_search_routes_platform_check CHECK (platform IN ('instagram','twitter','facebook',
    'reddit','kuaishou','weibo','douyin','tiktok','zhihu','linkedin','bilibili','xiaohongshu','youtube')),
  ADD CONSTRAINT strategy_search_routes_primary_provider_check CHECK (
    (interface_key = 'search' AND platform = 'instagram' AND primary_provider IN ('justone','tikhub'))
    OR (interface_key = 'search' AND platform = 'twitter' AND primary_provider IN ('rapidapi','tikhub'))
    OR (interface_key IN ('crawl','user-info') AND platform = 'facebook' AND primary_provider = 'justone')
    OR (interface_key IN ('post-comments','comment-replies') AND primary_provider IN ('justone','tikhub'))),
  ADD CONSTRAINT strategy_search_routes_fallback_provider_check CHECK (fallback_provider IS NULL
    OR (interface_key = 'search' AND platform = 'instagram' AND fallback_provider IN ('justone','tikhub'))
    OR (interface_key = 'search' AND platform = 'twitter' AND fallback_provider IN ('rapidapi','tikhub'))
    OR (interface_key IN ('post-comments','comment-replies') AND fallback_provider IN ('justone','tikhub')));

-- Deployment defaults: TikHub first, JustOne as the guarantee where both have a
-- reviewed parser. Seed only absent rows; a repeated run never overwrites a
-- reviewed or paused policy.
WITH inserted AS (
  INSERT INTO control.strategy_search_routes(interface_key,platform,mode,primary_provider,fallback_provider,reason)
  VALUES
    ('post-comments','twitter','priority','tikhub','justone','migration-181: TikHub first, JustOne guarantee'),
    ('post-comments','reddit','priority','tikhub','justone','migration-181: TikHub first, JustOne guarantee'),
    ('post-comments','kuaishou','priority','tikhub','justone','migration-181: TikHub first, JustOne guarantee'),
    ('post-comments','instagram','fixed','tikhub',NULL,'migration-181: preserve TikHub comments'),
    ('post-comments','weibo','priority','tikhub','justone','migration-181: TikHub first, JustOne guarantee'),
    ('post-comments','douyin','priority','tikhub','justone','migration-181: TikHub first, JustOne guarantee'),
    ('post-comments','tiktok','fixed','justone',NULL,'migration-181: preserve JustOne comments'),
    ('post-comments','zhihu','priority','tikhub','justone','migration-181: TikHub first, JustOne guarantee'),
    ('post-comments','linkedin','fixed','justone',NULL,'migration-181: preserve JustOne comments'),
    ('post-comments','bilibili','fixed','justone',NULL,'migration-181: TikHub list pending calibration'),
    ('post-comments','facebook','fixed','justone',NULL,'migration-181: preserve JustOne comments'),
    ('post-comments','xiaohongshu','fixed','tikhub',NULL,'migration-181: preserve TikHub comments'),
    ('post-comments','youtube','fixed','tikhub',NULL,'migration-181: preserve TikHub comments'),
    ('comment-replies','twitter','fixed','tikhub',NULL,'migration-181: TikHub replies'),
    ('comment-replies','reddit','fixed','tikhub',NULL,'migration-181: TikHub replies'),
    ('comment-replies','xiaohongshu','fixed','tikhub',NULL,'migration-181: TikHub replies'),
    ('comment-replies','weibo','fixed','tikhub',NULL,'migration-181: TikHub replies'),
    ('comment-replies','instagram','fixed','tikhub',NULL,'migration-181: TikHub replies'),
    ('comment-replies','douyin','fixed','tikhub',NULL,'migration-181: TikHub replies'),
    ('comment-replies','bilibili','fixed','tikhub',NULL,'migration-181: TikHub replies'),
    ('comment-replies','kuaishou','fixed','tikhub',NULL,'migration-181: TikHub replies'),
    ('comment-replies','zhihu','fixed','tikhub',NULL,'migration-181: TikHub replies')
  ON CONFLICT (interface_key,platform) DO NOTHING
  RETURNING *
)
INSERT INTO control.strategy_search_route_events(interface_key,platform,revision,actor,policy)
SELECT interface_key,platform,revision,'migration-181',jsonb_build_object(
  'interface',interface_key,'platform',platform,'mode',mode,'primaryProvider',primary_provider,
  'fallbackProvider',fallback_provider,'revision',revision,'reason',reason,'updatedAt',updated_at)
FROM inserted;
