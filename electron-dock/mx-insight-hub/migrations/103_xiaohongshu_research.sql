-- Add independently governed operations. Never expand existing grants, Key
-- snapshots or customer plans. Procurement prices must be reviewed in Admin.
INSERT INTO control.external_platform_operation_releases
  (provider_key, operation_key, release_revision, contract_version, endpoint_keys, price_book_version, status)
VALUES
  ('tikhub', 'social.posts.analytics', 1, 'mx-insight-hub.xiaohongshu-research.v1', ARRAY['xiaohongshu.pgy.note-detail.v1']::text[], 0, 'released'),
  ('tikhub', 'social.comments.list', 1, 'mx-insight-hub.xiaohongshu-research.v1', ARRAY['xiaohongshu.app-v2.note-comments.v1']::text[], 0, 'released')
ON CONFLICT DO NOTHING;

INSERT INTO control.external_platform_operation_policies
  (provider_key, operation_key, release_revision, control_source, desired_state, canary_consumer_ids, revision, updated_by)
VALUES
  ('tikhub', 'social.posts.analytics', 1, 'database', 'disabled', '{}'::uuid[], 1, 'migration-103'),
  ('tikhub', 'social.comments.list', 1, 'database', 'disabled', '{}'::uuid[], 1, 'migration-103')
ON CONFLICT DO NOTHING;

INSERT INTO control.external_platform_operation_policy_events
  (event_id, provider_key, operation_key, previous_revision, revision, previous_state, desired_state, canary_consumer_ids, actor, reason)
SELECT gen_random_uuid(), provider_key, operation_key, NULL, 1, NULL, desired_state, canary_consumer_ids,
       'migration-103', 'Added independent note analytics/comments; awaiting reviewed prices and explicit activation'
FROM control.external_platform_operation_policies
WHERE updated_by = 'migration-103' AND revision = 1
ON CONFLICT DO NOTHING;
