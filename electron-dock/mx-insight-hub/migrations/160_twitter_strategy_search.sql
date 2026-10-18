-- Twitter standard data/search v1/v2 joins the existing audited strategy editor.
-- Raw/social/account routing and Facebook's separate quota policy are unchanged.
ALTER TABLE control.strategy_search_routes
  DROP CONSTRAINT strategy_search_routes_platform_check,
  DROP CONSTRAINT strategy_search_routes_primary_provider_check,
  DROP CONSTRAINT strategy_search_routes_fallback_provider_check,
  ADD CONSTRAINT strategy_search_routes_platform_check CHECK (platform IN ('instagram','twitter')),
  ADD CONSTRAINT strategy_search_routes_primary_provider_check CHECK (
    (platform = 'instagram' AND primary_provider IN ('justone','tikhub'))
    OR (platform = 'twitter' AND primary_provider IN ('rapidapi','tikhub'))),
  ADD CONSTRAINT strategy_search_routes_fallback_provider_check CHECK (fallback_provider IS NULL
    OR (platform = 'instagram' AND fallback_provider IN ('justone','tikhub'))
    OR (platform = 'twitter' AND fallback_provider IN ('rapidapi','tikhub')));

-- Seed only the absent route and its corresponding audit in one statement.
-- A repeated migration never overwrites a reviewed or paused policy.
WITH inserted AS (
  INSERT INTO control.strategy_search_routes(interface_key,platform,mode,primary_provider,fallback_provider,reason)
  VALUES('search','twitter','priority','rapidapi','tikhub','migration-160: RapidAPI first with TikHub pre-dispatch fallback')
  ON CONFLICT (interface_key,platform) DO NOTHING
  RETURNING *
)
INSERT INTO control.strategy_search_route_events(interface_key,platform,revision,actor,policy)
SELECT interface_key,platform,revision,'migration-160',jsonb_build_object(
  'interface',interface_key,'platform',platform,'mode',mode,'primaryProvider',primary_provider,
  'fallbackProvider',fallback_provider,'revision',revision,'reason',reason,'updatedAt',updated_at)
FROM inserted;
