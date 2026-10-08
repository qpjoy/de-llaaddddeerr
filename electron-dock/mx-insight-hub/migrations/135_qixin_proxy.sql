-- Optional Qixin forward proxy. Preserve the existing fixed-IP relay, all
-- other provider bindings, global settings, credentials and customer grants.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE control.external_platform_proxy_bindings
  DROP CONSTRAINT external_platform_proxy_bindings_provider_key_check;
ALTER TABLE control.external_platform_proxy_bindings
  ADD CONSTRAINT external_platform_proxy_bindings_provider_key_check
  CHECK (provider_key IN ('tikhub','rapidapi','qixin','baidu','exa','tavily',
    'serper','you','searchapi','firecrawl','serpapi'));

WITH seeded AS (
  INSERT INTO control.external_platform_proxy_bindings(provider_key, egress_mode, sequence_key, reason)
  VALUES ('qixin', 'system-egress', NULL, 'Preserve system egress and existing fixed-IP relay; proxy requires explicit selection')
  ON CONFLICT DO NOTHING RETURNING *
)
INSERT INTO control.external_platform_proxy_events(provider_key, revision, egress_mode, sequence_key, actor, reason)
SELECT provider_key, revision, egress_mode, sequence_key, 'migration-135', reason FROM seeded;
