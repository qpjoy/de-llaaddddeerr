-- Google Play (package 193) runs in mx-crawler-runner, which shares the Hub
-- node's network. Hub chooses the proxy from this binding and passes it with
-- each invocation (docs/architecture/spider_man/07-collect-engines.md §12,
-- decision D19). Domestic app markets keep direct egress and need no binding.
--
-- Same shape as migrations 184 and 185: add `googleplay` to the provider
-- bindings and bind it to the Internal 7788 sequence when that sequence exists
-- and is enabled; otherwise system egress until the operator selects one on
-- the engine page. Every other binding is untouched. Probe verdicts are cached
-- for five minutes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE control.external_platform_proxy_bindings
  DROP CONSTRAINT external_platform_proxy_bindings_provider_key_check;
ALTER TABLE control.external_platform_proxy_bindings
  ADD CONSTRAINT external_platform_proxy_bindings_provider_key_check
  CHECK (provider_key IN ('tikhub','rapidapi','qixin','baidu','exa','tavily',
    'serper','you','searchapi','firecrawl','serpapi','apify','shodan','googleplay'));

WITH target AS (
  SELECT sequence_key FROM control.agent_proxy_sequences
  WHERE sequence_key = 'tikhub-internal-7788' AND enabled
), seeded AS (
  INSERT INTO control.external_platform_proxy_bindings(provider_key, egress_mode, sequence_key, reason, probe_cache_ttl_ms)
  SELECT 'googleplay',
    CASE WHEN EXISTS (SELECT 1 FROM target) THEN 'proxy-sequence' ELSE 'system-egress' END,
    (SELECT sequence_key FROM target),
    CASE WHEN EXISTS (SELECT 1 FROM target)
      THEN 'D19: overseas egress through the Internal 7788 System Proxy sequence'
      ELSE 'D19: 7788 sequence not found or disabled; select a sequence on the engine page' END,
    300000
  ON CONFLICT DO NOTHING RETURNING *
)
INSERT INTO control.external_platform_proxy_events(provider_key, revision, egress_mode, sequence_key, actor, reason)
SELECT provider_key, revision, egress_mode, sequence_key, 'migration-186', reason FROM seeded;
