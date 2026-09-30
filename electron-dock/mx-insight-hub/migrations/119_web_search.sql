-- Optional Web Search: no credentials, grants, prices or login changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
ALTER TABLE api_keys ADD COLUMN web_search_order text[] NOT NULL DEFAULT '{}';
CREATE TABLE control.web_search_request_routes (
  api_key_id uuid NOT NULL REFERENCES api_keys(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  provider_key text NOT NULL CHECK (provider_key IN ('baidu', 'exa', 'tavily', 'serper', 'you', 'searchapi', 'firecrawl', 'serpapi')),
  route_order text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(api_key_id, idempotency_key)
);
ALTER TABLE control.external_platform_proxy_bindings DROP CONSTRAINT external_platform_proxy_bindings_provider_key_check;
ALTER TABLE control.external_platform_proxy_bindings ADD CONSTRAINT external_platform_proxy_bindings_provider_key_check CHECK (provider_key IN ('tikhub','rapidapi','baidu', 'exa', 'tavily', 'serper', 'you', 'searchapi', 'firecrawl', 'serpapi'));
ALTER TABLE control.procurement_price_drafts DROP CONSTRAINT procurement_price_drafts_provider_key_check;
ALTER TABLE control.procurement_price_drafts ADD CONSTRAINT procurement_price_drafts_provider_key_check CHECK (provider_key IN ('qixin','justone','tikhub','rapidapi','baidu', 'exa', 'tavily', 'serper', 'you', 'searchapi', 'firecrawl', 'serpapi'));
WITH seeded AS (
 INSERT INTO control.external_platform_proxy_bindings(provider_key,egress_mode,sequence_key,reason)
 SELECT key,'system-egress',NULL,'Web Search default direct egress; explicit per-supplier proxy binding is optional'
 FROM unnest(ARRAY['baidu', 'exa', 'tavily', 'serper', 'you', 'searchapi', 'firecrawl', 'serpapi']) AS key ON CONFLICT DO NOTHING RETURNING *
)
INSERT INTO control.external_platform_proxy_events(provider_key,revision,egress_mode,sequence_key,actor,reason)
 SELECT provider_key,revision,egress_mode,sequence_key,'migration-119',reason FROM seeded;
INSERT INTO control.external_platform_provider_price_books(provider_key,version,source,status)
 SELECT key,0,'legacy_environment','inherited' FROM unnest(ARRAY['baidu', 'exa', 'tavily', 'serper', 'you', 'searchapi', 'firecrawl', 'serpapi']) AS key ON CONFLICT DO NOTHING;
INSERT INTO control.external_platform_operation_releases(provider_key,operation_key,release_revision,contract_version,endpoint_keys,price_book_version,status)
 SELECT key,'web.search',1,'mx-insight-hub.web-search.v1',ARRAY[key||'.web-search'],0,'released' FROM unnest(ARRAY['baidu', 'exa', 'tavily', 'serper', 'you', 'searchapi', 'firecrawl', 'serpapi']) AS key ON CONFLICT DO NOTHING;
INSERT INTO control.external_platform_operation_policies(provider_key,operation_key,release_revision,control_source,desired_state,canary_consumer_ids,revision,updated_by)
 SELECT key,'web.search',1,'database','disabled','{}'::uuid[],1,'migration-119' FROM unnest(ARRAY['baidu', 'exa', 'tavily', 'serper', 'you', 'searchapi', 'firecrawl', 'serpapi']) AS key ON CONFLICT DO NOTHING;
INSERT INTO control.external_platform_operation_policy_events(event_id,provider_key,operation_key,previous_revision,revision,previous_state,desired_state,canary_consumer_ids,actor,reason)
 SELECT gen_random_uuid(),key,'web.search',NULL,1,NULL,'disabled','{}'::uuid[],'migration-119','Web Search starts disabled; procurement review and explicit authorization required'
 FROM unnest(ARRAY['baidu', 'exa', 'tavily', 'serper', 'you', 'searchapi', 'firecrawl', 'serpapi']) AS key;
