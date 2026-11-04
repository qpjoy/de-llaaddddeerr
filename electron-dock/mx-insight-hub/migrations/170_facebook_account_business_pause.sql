-- Business gates are separate from shared supplier-operation controls.
-- Keep Facebook search's existing policy and every reviewed upstream state.
ALTER TABLE control.strategy_search_routes
  DROP CONSTRAINT strategy_search_routes_interface_key_check,
  DROP CONSTRAINT strategy_search_routes_platform_check,
  DROP CONSTRAINT strategy_search_routes_primary_provider_check,
  ADD CONSTRAINT strategy_search_routes_interface_key_check CHECK (
    (interface_key = 'search' AND platform IN ('instagram','twitter'))
    OR (interface_key IN ('crawl','user-info') AND platform = 'facebook'
      AND mode IN ('fixed','paused'))),
  ADD CONSTRAINT strategy_search_routes_platform_check CHECK (platform IN ('instagram','twitter','facebook')),
  ADD CONSTRAINT strategy_search_routes_primary_provider_check CHECK (
    (platform = 'instagram' AND primary_provider IN ('justone','tikhub'))
    OR (platform = 'twitter' AND primary_provider IN ('rapidapi','tikhub'))
    OR (platform = 'facebook' AND primary_provider = 'justone'));

WITH inserted AS (
  INSERT INTO control.strategy_search_routes(interface_key,platform,mode,primary_provider,fallback_provider,reason)
  VALUES
    ('crawl','facebook','fixed','justone',NULL,'migration-170: preserve enabled account content'),
    ('user-info','facebook','fixed','justone',NULL,'migration-170: preserve enabled account profile')
  ON CONFLICT (interface_key,platform) DO NOTHING
  RETURNING *
)
INSERT INTO control.strategy_search_route_events(interface_key,platform,revision,actor,policy)
SELECT interface_key,platform,revision,'migration-170',jsonb_build_object(
  'interface',interface_key,'platform',platform,'mode',mode,'primaryProvider',primary_provider,
  'fallbackProvider',fallback_provider,'revision',revision,'reason',reason,'updatedAt',updated_at)
FROM inserted;
