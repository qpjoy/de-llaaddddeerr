-- Release the JustOne Taobao/Tmall resource operations (detail, reviews,
-- questions, shop products) into the existing operation-control plane.
--
-- These share the provider's single contract gate with product search. Their
-- release control is the per-endpoint reviewed price: an operation whose
-- endpoint key carries no positive price evaluates to `blocked` and keeps
-- serving stored snapshots, so seeding a policy row here does not by itself
-- authorize any paid upstream call.
--
-- Price book version 0 delegates price evidence to the retained environment
-- config, exactly as migration 060 did for product search. Publishing a
-- reviewed database price book later binds a new release without rewriting
-- any policy event recorded here.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

INSERT INTO control.external_platform_operation_releases
  (provider_key, operation_key, release_revision, contract_version, endpoint_keys,
   price_book_version, status)
VALUES
  (
    'justone', 'ecommerce.products.detail', 1,
    'mx-insight-hub.ecommerce-resource.v1',
    ARRAY['taobao-tmall.product-detail.v1']::text[],
    0, 'released'
  ),
  (
    'justone', 'ecommerce.products.reviews', 1,
    'mx-insight-hub.ecommerce-resource.v1',
    ARRAY['taobao-tmall.product-reviews.v1']::text[],
    0, 'released'
  ),
  (
    'justone', 'ecommerce.products.questions', 1,
    'mx-insight-hub.ecommerce-resource.v1',
    ARRAY['taobao-tmall.product-questions.v1']::text[],
    0, 'released'
  ),
  (
    'justone', 'ecommerce.shops.products', 1,
    'mx-insight-hub.ecommerce-resource.v1',
    ARRAY['taobao-tmall.shop-products.v1']::text[],
    0, 'released'
  )
ON CONFLICT (provider_key, operation_key, release_revision) DO NOTHING;

INSERT INTO control.external_platform_operation_policies
  (provider_key, operation_key, release_revision, control_source, desired_state,
   canary_consumer_ids, revision, updated_by)
SELECT provider_key, operation_key, release_revision, 'legacy_environment', 'active',
       '{}'::uuid[], 0, 'migration-068'
  FROM control.external_platform_operation_releases
 WHERE provider_key = 'justone'
   AND release_revision = 1
   AND operation_key IN (
     'ecommerce.products.detail',
     'ecommerce.products.reviews',
     'ecommerce.products.questions',
     'ecommerce.shops.products'
   )
ON CONFLICT (provider_key, operation_key) DO NOTHING;

-- The seed event mirrors migration 060's deterministic UUID derivation so a
-- rerun is idempotent and the append-only event ledger never gains a duplicate.
INSERT INTO control.external_platform_operation_policy_events
  (event_id, provider_key, operation_key, previous_revision, revision,
   previous_state, desired_state, canary_consumer_ids, actor, reason)
SELECT (
         substr(md5(provider_key || ':' || operation_key || ':0'), 1, 8) || '-' ||
         substr(md5(provider_key || ':' || operation_key || ':0'), 9, 4) || '-4' ||
         substr(md5(provider_key || ':' || operation_key || ':0'), 14, 3) || '-8' ||
         substr(md5(provider_key || ':' || operation_key || ':0'), 18, 3) || '-' ||
         substr(md5(provider_key || ':' || operation_key || ':0'), 21, 12)
       )::uuid,
       provider_key, operation_key, NULL, 0, NULL, desired_state,
       canary_consumer_ids, 'migration-068',
       'Seeded in legacy-environment compatibility mode; blocked until a reviewed endpoint price exists'
  FROM control.external_platform_operation_policies
 WHERE provider_key = 'justone'
   AND revision = 0
   AND operation_key IN (
     'ecommerce.products.detail',
     'ecommerce.products.reviews',
     'ecommerce.products.questions',
     'ecommerce.shops.products'
   )
ON CONFLICT (provider_key, operation_key, revision) DO NOTHING;
