-- Register TweetDetail separately after the RapidAPI /tweet/{id}/replies
-- route returned an archived endpoint-not-found response. Keep the old
-- operation and all reviewed routing decisions intact. Traffic stays on
-- the operator's fixed TikHub routes until compatibility is verified.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

WITH released AS (
  INSERT INTO control.external_platform_operation_releases
    (provider_key, operation_key, release_revision, contract_version, endpoint_keys, price_book_version, status)
  VALUES ('rapidapi','native.r.twitter_aio_tweet_thread',1,'mx-insight-hub.native-forwarding.v1',
    ARRAY['native.r.twitter_aio_tweet_thread']::text[],0,'released')
  ON CONFLICT DO NOTHING
), inserted AS (
  INSERT INTO control.external_platform_operation_policies
    (provider_key, operation_key, release_revision, control_source, desired_state, canary_consumer_ids, revision, updated_by)
  VALUES ('rapidapi','native.r.twitter_aio_tweet_thread',1,'database','disabled','{}'::uuid[],1,'migration-192')
  ON CONFLICT DO NOTHING
  RETURNING *
)
INSERT INTO control.external_platform_operation_policy_events
  (event_id, provider_key, operation_key, previous_revision, revision, previous_state, desired_state, canary_consumer_ids, actor, reason)
SELECT gen_random_uuid(), provider_key, operation_key, NULL, revision, NULL, desired_state, canary_consumer_ids,
  updated_by, 'Register separately priced Twitter AIO TweetDetail reply thread; preserve reviewed routing'
FROM inserted;
