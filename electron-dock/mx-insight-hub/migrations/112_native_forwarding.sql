-- Fixed single-call contracts only. No grants, prices, credentials or legacy route changes.
INSERT INTO control.external_platform_operation_releases
  (provider_key, operation_key, release_revision, contract_version, endpoint_keys, price_book_version, status)
VALUES
  ('tikhub', 'native.t.douyin_search_fetch_video_search_v1', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.douyin_search_fetch_video_search_v1']::text[], 0, 'released'),
  ('tikhub', 'native.t.tiktok_web_fetch_general_search', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.tiktok_web_fetch_general_search']::text[], 0, 'released'),
  ('tikhub', 'native.t.weibo_web_v2_fetch_realtime_search', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.weibo_web_v2_fetch_realtime_search']::text[], 0, 'released'),
  ('tikhub', 'native.t.zhihu_web_fetch_article_search_v3', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.zhihu_web_fetch_article_search_v3']::text[], 0, 'released'),
  ('tikhub', 'native.t.twitter_web_fetch_search_timeline', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.twitter_web_fetch_search_timeline']::text[], 0, 'released'),
  ('tikhub', 'native.t.reddit_app_fetch_dynamic_search', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.reddit_app_fetch_dynamic_search']::text[], 0, 'released'),
  ('tikhub', 'native.t.instagram_v3_general_search', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.instagram_v3_general_search']::text[], 0, 'released'),
  ('tikhub', 'native.t.bilibili_web_fetch_general_search', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.bilibili_web_fetch_general_search']::text[], 0, 'released'),
  ('tikhub', 'native.t.kuaishou_app_search_comprehensive', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.kuaishou_app_search_comprehensive']::text[], 0, 'released'),
  ('tikhub', 'native.t.youtube_web_v2_get_general_search_v2', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.youtube_web_v2_get_general_search_v2']::text[], 0, 'released'),
  ('tikhub', 'native.t.douyin_search_fetch_general_search_v2', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.douyin_search_fetch_general_search_v2']::text[], 0, 'released'),
  ('tikhub', 'native.t.instagram_v3_search_users', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.instagram_v3_search_users']::text[], 0, 'released'),
  ('tikhub', 'native.t.instagram_v3_search_hashtags', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.instagram_v3_search_hashtags']::text[], 0, 'released'),
  ('tikhub', 'native.t.instagram_v2_search_locations', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.instagram_v2_search_locations']::text[], 0, 'released'),
  ('tikhub', 'native.t.instagram_v3_get_explore', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.instagram_v3_get_explore']::text[], 0, 'released'),
  ('tikhub', 'native.t.instagram_v3_get_recommended_reels', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.instagram_v3_get_recommended_reels']::text[], 0, 'released'),
  ('tikhub', 'native.t.instagram_v3_get_user_reels', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.instagram_v3_get_user_reels']::text[], 0, 'released'),
  ('tikhub', 'native.t.instagram_v3_get_user_stories', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.instagram_v3_get_user_stories']::text[], 0, 'released'),
  ('tikhub', 'native.t.instagram_v3_get_user_tagged_posts', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.instagram_v3_get_user_tagged_posts']::text[], 0, 'released'),
  ('tikhub', 'native.t.instagram_v3_get_user_highlights', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.instagram_v3_get_user_highlights']::text[], 0, 'released'),
  ('tikhub', 'native.t.instagram_v3_get_user_followers', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.instagram_v3_get_user_followers']::text[], 0, 'released'),
  ('tikhub', 'native.t.instagram_v3_get_user_following', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.instagram_v3_get_user_following']::text[], 0, 'released'),
  ('tikhub', 'native.t.instagram_v3_get_location_posts', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.instagram_v3_get_location_posts']::text[], 0, 'released'),
  ('tikhub', 'native.t.instagram_v3_get_location_info', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.instagram_v3_get_location_info']::text[], 0, 'released'),
  ('tikhub', 'native.t.instagram_v3_get_location_nearby', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.instagram_v3_get_location_nearby']::text[], 0, 'released'),
  ('tikhub', 'native.t.xiaohongshu_app_v2_search_users', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.xiaohongshu_app_v2_search_users']::text[], 0, 'released'),
  ('tikhub', 'native.t.xiaohongshu_app_v2_get_user_posted_notes', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.xiaohongshu_app_v2_get_user_posted_notes']::text[], 0, 'released'),
  ('tikhub', 'native.t.xiaohongshu_app_v2_get_image_note_detail', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.xiaohongshu_app_v2_get_image_note_detail']::text[], 0, 'released'),
  ('tikhub', 'native.t.instagram_v3_get_user_profile', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.instagram_v3_get_user_profile']::text[], 0, 'released'),
  ('tikhub', 'native.t.instagram_v3_get_user_posts', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.instagram_v3_get_user_posts']::text[], 0, 'released'),
  ('tikhub', 'native.t.instagram_v3_get_user_id_by_username', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.instagram_v3_get_user_id_by_username']::text[], 0, 'released'),
  ('tikhub', 'native.t.linkedin_web_v2_get_user_profile_by_url', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.linkedin_web_v2_get_user_profile_by_url']::text[], 0, 'released'),
  ('tikhub', 'native.t.linkedin_web_v2_get_company_profile_by_url', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.linkedin_web_v2_get_company_profile_by_url']::text[], 0, 'released'),
  ('tikhub', 'native.t.linkedin_web_v2_get_user_posts_by_url', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.linkedin_web_v2_get_user_posts_by_url']::text[], 0, 'released'),
  ('tikhub', 'native.t.linkedin_web_v2_get_company_posts_by_url', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.linkedin_web_v2_get_company_posts_by_url']::text[], 0, 'released'),
  ('tikhub', 'native.t.linkedin_web_v2_get_post_detail_by_url', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.linkedin_web_v2_get_post_detail_by_url']::text[], 0, 'released'),
  ('tikhub', 'native.t.linkedin_web_v2_get_post_comments', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.linkedin_web_v2_get_post_comments']::text[], 0, 'released'),
  ('tikhub', 'native.t.wechat_search_v2_fetch_search', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.wechat_search_v2_fetch_search']::text[], 0, 'released'),
  ('tikhub', 'native.t.xiaohongshu_app_v2_search_notes', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.xiaohongshu_app_v2_search_notes']::text[], 0, 'released'),
  ('justone', 'native.j.douyin_search_video_v4', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.j.douyin_search_video_v4']::text[], 0, 'released'),
  ('justone', 'native.j.social_cross_platform_search_v1_weibo', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.j.social_cross_platform_search_v1_weibo']::text[], 0, 'released'),
  ('justone', 'native.j.social_cross_platform_search_v1_zhihu', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.j.social_cross_platform_search_v1_zhihu']::text[], 0, 'released'),
  ('justone', 'native.j.social_cross_platform_search_v1_xiaohongshu', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.j.social_cross_platform_search_v1_xiaohongshu']::text[], 0, 'released'),
  ('justone', 'native.j.social_cross_platform_search_v1_bilibili', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.j.social_cross_platform_search_v1_bilibili']::text[], 0, 'released'),
  ('justone', 'native.j.social_cross_platform_search_v1_kuaishou', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.j.social_cross_platform_search_v1_kuaishou']::text[], 0, 'released'),
  ('justone', 'native.j.social_cross_platform_search_v1_wechat_mp', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.j.social_cross_platform_search_v1_wechat_mp']::text[], 0, 'released'),
  ('justone', 'native.j.facebook_post_search_v1', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.j.facebook_post_search_v1']::text[], 0, 'released'),
  ('justone', 'native.j.facebook_get_profile_id_v1', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.j.facebook_get_profile_id_v1']::text[], 0, 'released'),
  ('justone', 'native.j.facebook_get_profile_posts_v1', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.j.facebook_get_profile_posts_v1']::text[], 0, 'released'),
  ('justone', 'native.j.xianyu_search_v1', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.j.xianyu_search_v1']::text[], 0, 'released')
ON CONFLICT DO NOTHING;

INSERT INTO control.external_platform_operation_policies
  (provider_key, operation_key, release_revision, control_source, desired_state, canary_consumer_ids, revision, updated_by)
SELECT provider_key, operation_key, 1, 'database', 'disabled', '{}'::uuid[], 1, 'migration-112'
FROM control.external_platform_operation_releases
WHERE contract_version = 'mx-insight-hub.native-forwarding.v1' AND release_revision = 1
ON CONFLICT DO NOTHING;

INSERT INTO control.external_platform_operation_policy_events
  (event_id, provider_key, operation_key, previous_revision, revision, previous_state, desired_state, canary_consumer_ids, actor, reason)
SELECT gen_random_uuid(), provider_key, operation_key, NULL, 1, NULL, desired_state, canary_consumer_ids,
       'migration-112', 'Native forwarding starts disabled; review endpoint procurement price and activate explicitly'
FROM control.external_platform_operation_policies
WHERE updated_by = 'migration-112' AND revision = 1
ON CONFLICT DO NOTHING;
