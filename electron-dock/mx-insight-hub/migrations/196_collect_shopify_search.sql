-- Existing installations may already have the standard native engine. Match
-- setup for a new installation without creating an engine or overriding an
-- operator's route, enablement, billing or API key settings.
SET LOCAL lock_timeout = '5s';

WITH target AS (
  SELECT id FROM collect.engines WHERE id = 'native.main' AND kind = 'native' FOR UPDATE
), added AS (
  INSERT INTO collect.routes (capability, route_key, engine_id, updated_by)
  SELECT 'collect.ecommerce.shopify.search', '', id, 'migration:196' FROM target
  ON CONFLICT (capability, route_key) DO NOTHING
  RETURNING engine_id
), revised AS (
  UPDATE collect.engines e SET revision = e.revision + 1, updated_at = clock_timestamp(),
    updated_by = 'migration:196', update_reason = '添加 Shopify 店内商品搜索路由'
  FROM added WHERE e.id = added.engine_id
  RETURNING e.id, e.revision, e.updated_by, e.update_reason
)
INSERT INTO collect.engine_events (engine_id, action, revision, actor, reason, details)
SELECT id, 'configured', revision, updated_by, update_reason,
  '{"addedRoute":"collect.ecommerce.shopify.search"}'::jsonb FROM revised;
