-- Apify collection engines reach api.apify.com through System Proxy
-- (docs/architecture/spider_man/07-collect-engines.md, decision D19).
--
-- Adds `apify` to the provider bindings and binds it to the Internal 7788
-- sequence that migration 076 seeded and the operator verified for TikHub.
-- TikHub, RapidAPI, Qixin, web-search, LLM and global routes are untouched.
-- If that sequence is missing or disabled the binding stays on system egress
-- and the operator selects a sequence on the engine page.
--
-- Probe results are cached for five minutes: an Apify job is polled every few
-- seconds, and probing before every status read would double the traffic.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE control.external_platform_proxy_bindings
  DROP CONSTRAINT external_platform_proxy_bindings_provider_key_check;
ALTER TABLE control.external_platform_proxy_bindings
  ADD CONSTRAINT external_platform_proxy_bindings_provider_key_check
  CHECK (provider_key IN ('tikhub','rapidapi','qixin','baidu','exa','tavily',
    'serper','you','searchapi','firecrawl','serpapi','apify'));

WITH target AS (
  SELECT sequence_key FROM control.agent_proxy_sequences
  WHERE sequence_key = 'tikhub-internal-7788' AND enabled
), seeded AS (
  INSERT INTO control.external_platform_proxy_bindings(provider_key, egress_mode, sequence_key, reason, probe_cache_ttl_ms)
  SELECT 'apify',
    CASE WHEN EXISTS (SELECT 1 FROM target) THEN 'proxy-sequence' ELSE 'system-egress' END,
    (SELECT sequence_key FROM target),
    CASE WHEN EXISTS (SELECT 1 FROM target)
      THEN 'D19: overseas egress through the Internal 7788 System Proxy sequence'
      ELSE 'D19: 7788 sequence not found or disabled; select a sequence on the engine page' END,
    300000
  ON CONFLICT DO NOTHING RETURNING *
)
INSERT INTO control.external_platform_proxy_events(provider_key, revision, egress_mode, sequence_key, actor, reason)
SELECT provider_key, revision, egress_mode, sequence_key, 'migration-184', reason FROM seeded;
