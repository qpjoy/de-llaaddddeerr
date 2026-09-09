-- Paid acquisition operations are separate public authority boundaries.
-- Preserve every currently effective Xiaohongshu/App V2 and ecommerce caller
-- that could use these paths before the boundary existed, without widening
-- image-note detail: social.posts.resolve was already required and remains
-- independently granted.

-- The deploy freezes the sole Admin writer before this transaction. Public
-- traffic still updates api_keys.last_used_at, so avoid a broad table lock and
-- keep every lock-taking/backfill statement bounded.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

INSERT INTO capability_grants (consumer_id, capability)
SELECT platform_grant.consumer_id, capability.capability
  FROM platform_grants platform_grant
 CROSS JOIN (VALUES
   ('xiaohongshu', 'compat.xiaohongshu.app_v2'),
   ('xiaohongshu', 'social.posts.search'),
   ('xiaohongshu', 'social.users.resolve'),
   ('xiaohongshu', 'social.users.posts'),
   ('ecommerce', 'ecommerce.products.search')
 ) AS capability(platform, capability)
 WHERE platform_grant.platform = capability.platform
   AND NOT EXISTS (
     SELECT 1
       FROM consumer_capability_policies existing_policy
      WHERE existing_policy.consumer_id = platform_grant.consumer_id
        AND existing_policy.capability = capability.capability
   )
ON CONFLICT (consumer_id, capability) DO NOTHING;

INSERT INTO consumer_capability_policies
  (tenant_id, consumer_id, capability, max_requests, window_seconds)
SELECT consumer.tenant_id,
       platform_grant.consumer_id,
       capability.capability,
       coalesce(platform_policy.max_requests, 1000),
       coalesce(platform_policy.window_seconds, 3600)
  FROM platform_grants platform_grant
  JOIN consumers consumer ON consumer.id = platform_grant.consumer_id
 LEFT JOIN consumer_platform_policies platform_policy
    ON platform_policy.consumer_id = platform_grant.consumer_id
   AND platform_policy.platform = platform_grant.platform
 CROSS JOIN (VALUES
   ('xiaohongshu', 'compat.xiaohongshu.app_v2'),
   ('xiaohongshu', 'social.posts.search'),
   ('xiaohongshu', 'social.users.resolve'),
   ('xiaohongshu', 'social.users.posts'),
   ('ecommerce', 'ecommerce.products.search')
 ) AS capability(platform, capability)
 WHERE platform_grant.platform = capability.platform
ON CONFLICT (consumer_id, capability) DO NOTHING;

INSERT INTO api_key_capability_entitlements
  (api_key_id, capability, max_requests, window_seconds)
SELECT api_key_record.id,
       capability_grant.capability,
       capability_policy.max_requests,
       capability_policy.window_seconds
  FROM api_keys api_key_record
  JOIN api_key_platform_entitlements platform_entitlement
    ON platform_entitlement.api_key_id = api_key_record.id
  JOIN (VALUES
    ('xiaohongshu', 'compat.xiaohongshu.app_v2'),
    ('xiaohongshu', 'social.posts.search'),
    ('xiaohongshu', 'social.users.resolve'),
    ('xiaohongshu', 'social.users.posts'),
    ('ecommerce', 'ecommerce.products.search')
  ) AS capability_mapping(platform, capability)
    ON capability_mapping.platform = platform_entitlement.platform
  JOIN capability_grants capability_grant
    ON capability_grant.consumer_id = api_key_record.consumer_id
   AND capability_grant.capability = capability_mapping.capability
  JOIN consumer_capability_policies capability_policy
    ON capability_policy.consumer_id = api_key_record.consumer_id
   AND capability_policy.capability = capability_mapping.capability
 WHERE api_key_record.scope_mode = 'snapshot'
ON CONFLICT (api_key_id, capability) DO NOTHING;
