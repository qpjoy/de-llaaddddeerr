-- Persist the existing Instagram default for data/search and both raw aliases.
-- Facebook keeps its separate quota policy. No grants, credentials or prices change.
CREATE TABLE control.strategy_search_routes (
  interface_key text NOT NULL CHECK (interface_key = 'search'),
  platform text NOT NULL CHECK (platform = 'instagram'),
  mode text NOT NULL CHECK (mode IN ('fixed','priority','paused')),
  primary_provider text NOT NULL CHECK (primary_provider IN ('justone','tikhub')),
  fallback_provider text CHECK (fallback_provider IN ('justone','tikhub')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0 AND length(reason) <= 1000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (interface_key,platform),
  CHECK ((mode = 'priority' AND fallback_provider IS NOT NULL AND fallback_provider <> primary_provider)
    OR (mode IN ('fixed','paused') AND fallback_provider IS NULL))
);
CREATE TABLE control.strategy_search_route_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  interface_key text NOT NULL,
  platform text NOT NULL,
  revision integer NOT NULL,
  actor text NOT NULL,
  policy jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (interface_key,platform,revision)
);
INSERT INTO control.strategy_search_routes(interface_key,platform,mode,primary_provider,fallback_provider,reason)
VALUES('search','instagram','fixed','justone',NULL,'migration-150: preserve existing Instagram default');
INSERT INTO control.strategy_search_route_events(interface_key,platform,revision,actor,policy)
SELECT interface_key,platform,revision,'migration-150',jsonb_build_object(
  'interface',interface_key,'platform',platform,'mode',mode,'primaryProvider',primary_provider,
  'fallbackProvider',fallback_provider,'revision',revision,'reason',reason,'updatedAt',updated_at)
FROM control.strategy_search_routes;
