-- Taobao/Tmall product search through the RapidAPI listing of the same
-- backend. Starts disabled; activation still needs a reviewed price and an
-- administrator route change. No route, grant or customer price changes here.
INSERT INTO control.external_platform_operation_releases
  (provider_key, operation_key, release_revision, contract_version, endpoint_keys, price_book_version, status)
VALUES
  ('rapidapi', 'ecommerce.products.search', 1, 'mx-insight-hub.ecommerce-products.v1', ARRAY['taobao-tmall.product-search.v1']::text[], 0, 'released'),
  ('tikhub', 'native.t.xiaohongshu_ec_search_products', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.xiaohongshu_ec_search_products']::text[], 0, 'released'),
  ('tikhub', 'native.t.xiaohongshu_ec_product_detail', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.xiaohongshu_ec_product_detail']::text[], 0, 'released'),
  ('tikhub', 'native.t.xiaohongshu_ec_product_review_overview', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.xiaohongshu_ec_product_review_overview']::text[], 0, 'released'),
  ('tikhub', 'native.t.xiaohongshu_ec_product_reviews', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.xiaohongshu_ec_product_reviews']::text[], 0, 'released'),
  ('tikhub', 'native.t.xiaohongshu_ec_product_recommendations', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.xiaohongshu_ec_product_recommendations']::text[], 0, 'released'),
  ('tikhub', 'native.t.tiktok_shop_search_products', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.tiktok_shop_search_products']::text[], 0, 'released'),
  ('tikhub', 'native.t.tiktok_shop_search_products_v2', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.tiktok_shop_search_products_v2']::text[], 0, 'released'),
  ('tikhub', 'native.t.tiktok_shop_search_word_suggestion', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.tiktok_shop_search_word_suggestion']::text[], 0, 'released'),
  ('tikhub', 'native.t.tiktok_shop_product_detail', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.tiktok_shop_product_detail']::text[], 0, 'released'),
  ('tikhub', 'native.t.tiktok_shop_product_detail_v3', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.tiktok_shop_product_detail_v3']::text[], 0, 'released'),
  ('tikhub', 'native.t.tiktok_shop_product_reviews', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.tiktok_shop_product_reviews']::text[], 0, 'released'),
  ('tikhub', 'native.t.tiktok_shop_seller_products', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.tiktok_shop_seller_products']::text[], 0, 'released'),
  ('tikhub', 'native.t.tiktok_shop_seller_products_v2', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.tiktok_shop_seller_products_v2']::text[], 0, 'released'),
  ('tikhub', 'native.t.tiktok_shop_category_list', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.tiktok_shop_category_list']::text[], 0, 'released'),
  ('tikhub', 'native.t.tiktok_shop_products_by_category', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.tiktok_shop_products_by_category']::text[], 0, 'released'),
  ('tikhub', 'native.t.tiktok_shop_product_id_by_share_link', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.tiktok_shop_product_id_by_share_link']::text[], 0, 'released'),
  ('tikhub', 'native.t.tiktok_shop_shop_id_by_share_link', 1, 'mx-insight-hub.native-forwarding.v1', ARRAY['native.t.tiktok_shop_shop_id_by_share_link']::text[], 0, 'released')
ON CONFLICT DO NOTHING;

INSERT INTO control.external_platform_operation_policies
  (provider_key, operation_key, release_revision, control_source, desired_state, canary_consumer_ids, revision, updated_by)
SELECT provider_key, operation_key, 1, 'database', 'disabled', '{}'::uuid[], 1, 'migration-168'
FROM control.external_platform_operation_releases
WHERE release_revision = 1 AND (
  (provider_key = 'rapidapi' AND operation_key = 'ecommerce.products.search')
  OR (provider_key = 'tikhub' AND operation_key IN ('native.t.xiaohongshu_ec_search_products', 'native.t.xiaohongshu_ec_product_detail', 'native.t.xiaohongshu_ec_product_review_overview', 'native.t.xiaohongshu_ec_product_reviews', 'native.t.xiaohongshu_ec_product_recommendations', 'native.t.tiktok_shop_search_products', 'native.t.tiktok_shop_search_products_v2', 'native.t.tiktok_shop_search_word_suggestion', 'native.t.tiktok_shop_product_detail', 'native.t.tiktok_shop_product_detail_v3', 'native.t.tiktok_shop_product_reviews', 'native.t.tiktok_shop_seller_products', 'native.t.tiktok_shop_seller_products_v2', 'native.t.tiktok_shop_category_list', 'native.t.tiktok_shop_products_by_category', 'native.t.tiktok_shop_product_id_by_share_link', 'native.t.tiktok_shop_shop_id_by_share_link')))
ON CONFLICT DO NOTHING;

INSERT INTO control.external_platform_operation_policy_events
  (event_id, provider_key, operation_key, previous_revision, revision, previous_state, desired_state, canary_consumer_ids, actor, reason)
SELECT gen_random_uuid(), provider_key, operation_key, NULL, 1, NULL, desired_state, canary_consumer_ids,
  'migration-168', 'Ecommerce suppliers: review procurement price and enable through existing operation controls'
FROM control.external_platform_operation_policies policy
WHERE updated_by = 'migration-168' AND revision = 1
  AND NOT EXISTS (SELECT 1 FROM control.external_platform_operation_policy_events event
    WHERE event.provider_key = policy.provider_key AND event.operation_key = policy.operation_key AND event.actor = 'migration-168')
ON CONFLICT DO NOTHING;
