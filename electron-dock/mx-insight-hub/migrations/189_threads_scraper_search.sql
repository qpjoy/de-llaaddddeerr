-- The route alias identifies a RapidAPI subscription, and only for Threads
-- content search. Procurement, credentials and price books belong to rapidapi.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE control.strategy_search_routes
  DROP CONSTRAINT strategy_search_routes_primary_provider_check,
  DROP CONSTRAINT strategy_search_routes_fallback_provider_check,
  ADD CONSTRAINT strategy_search_routes_primary_provider_check CHECK (
    (interface_key = 'search' AND platform = 'threads' AND primary_provider = 'rapidapi-threads-scraper')
    OR (platform = 'threads' AND primary_provider IN ('rapidapi','tikhub'))
    OR (interface_key = 'search' AND platform = 'instagram' AND primary_provider IN ('justone','tikhub'))
    OR (interface_key = 'search' AND platform = 'twitter' AND primary_provider IN ('rapidapi','tikhub'))
    OR (interface_key IN ('crawl','user-info') AND platform = 'facebook' AND primary_provider = 'justone')
    OR (interface_key IN ('post-comments','comment-replies') AND platform <> 'threads' AND primary_provider IN ('justone','tikhub'))),
  ADD CONSTRAINT strategy_search_routes_fallback_provider_check CHECK (fallback_provider IS NULL
    OR (interface_key = 'search' AND platform = 'threads' AND fallback_provider = 'rapidapi-threads-scraper')
    OR (platform = 'threads' AND fallback_provider IN ('rapidapi','tikhub'))
    OR (interface_key = 'search' AND platform = 'instagram' AND fallback_provider IN ('justone','tikhub'))
    OR (interface_key = 'search' AND platform = 'twitter' AND fallback_provider IN ('rapidapi','tikhub'))
    OR (interface_key IN ('post-comments','comment-replies') AND platform <> 'threads' AND fallback_provider IN ('justone','tikhub')));

INSERT INTO control.external_platform_operation_releases
  (provider_key, operation_key, release_revision, contract_version, endpoint_keys, price_book_version, status)
VALUES ('rapidapi', 'native.r.threads_scraper_search_posts', 1, 'mx-insight-hub.native-forwarding.v1',
  ARRAY['native.r.threads_scraper_search_posts'], 0, 'released')
ON CONFLICT DO NOTHING;

WITH inserted AS (
  INSERT INTO control.external_platform_operation_policies
    (provider_key, operation_key, release_revision, control_source, desired_state, canary_consumer_ids, revision, updated_by)
  VALUES ('rapidapi', 'native.r.threads_scraper_search_posts', 1, 'database', 'disabled', '{}'::uuid[], 1, 'migration-189')
  ON CONFLICT DO NOTHING
  RETURNING provider_key, operation_key, revision, desired_state, canary_consumer_ids, updated_by
)
INSERT INTO control.external_platform_operation_policy_events
  (event_id, provider_key, operation_key, previous_revision, revision, previous_state, desired_state, canary_consumer_ids, actor, reason)
SELECT gen_random_uuid(), provider_key, operation_key, NULL, revision, NULL, desired_state, canary_consumer_ids,
  updated_by, 'Register Threads Scraper content search as a separately priced RapidAPI operation'
FROM inserted;
