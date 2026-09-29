-- WeChat contracts only; preserve prices, grants, keys and all existing policies.
INSERT INTO control.external_platform_operation_releases
  (provider_key, operation_key, release_revision, contract_version, endpoint_keys, price_book_version, status)
VALUES
  ('tikhub', 'native.wechat.channels.channel-info', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.channels.channel-info']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.channels.channel-id-to-username', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.channels.channel-id-to-username']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.channels.user-videos', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.channels.user-videos']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.channels.video-detail', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.channels.video-detail']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.channels.video-comments', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.channels.video-comments']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.channels.video-share-url', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.channels.video-share-url']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.channels.user-profile', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.channels.user-profile']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.channels.user-collections', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.channels.user-collections']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.channels.collection-videos', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.channels.collection-videos']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.channels.live-history', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.channels.live-history']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.channels.live-detail', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.channels.live-detail']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.channels.search-channel-videos', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.channels.search-channel-videos']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.mp.article-detail', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.mp.article-detail']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.mp.article-detail-h5', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.mp.article-detail-h5']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.mp.article-stats-h5', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.mp.article-stats-h5']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.mp.article-stats', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.mp.article-stats']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.mp.article-comments', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.mp.article-comments']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.mp.comment-replies', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.mp.comment-replies']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.mp.related-articles', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.mp.related-articles']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.mp.article-ad', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.mp.article-ad']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.mp.account-profile', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.mp.account-profile']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.mp.account-articles', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.mp.account-articles']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.mp.account-services', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.mp.account-services']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.search.search', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.search.search']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.search.search-videos', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.search.search-videos']::text[], 0, 'released'),
  ('tikhub', 'native.wechat.demo.article-sample', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.wechat.demo.article-sample']::text[], 0, 'released')
ON CONFLICT DO NOTHING;

INSERT INTO control.external_platform_operation_policies
  (provider_key, operation_key, release_revision, control_source, desired_state, canary_consumer_ids, revision, updated_by)
SELECT provider_key, operation_key, 1, 'database', 'disabled', '{}'::uuid[], 1, 'migration-118'
FROM control.external_platform_operation_releases
WHERE operation_key LIKE 'native.wechat.%' AND release_revision = 1
ON CONFLICT DO NOTHING;

INSERT INTO control.external_platform_operation_policy_events
  (event_id, provider_key, operation_key, previous_revision, revision, previous_state, desired_state, canary_consumer_ids, actor, reason)
SELECT gen_random_uuid(), provider_key, operation_key, NULL, 1, NULL, desired_state, canary_consumer_ids,
       'migration-118', 'Native forwarding starts disabled; review endpoint procurement price and activate explicitly'
FROM control.external_platform_operation_policies
WHERE updated_by = 'migration-118' AND revision = 1
ON CONFLICT DO NOTHING;
