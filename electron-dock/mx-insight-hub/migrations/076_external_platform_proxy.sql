-- Reuse the existing proxy registry without changing LLM routes or credentials.
CREATE TABLE IF NOT EXISTS control.external_platform_proxy_bindings (
  provider_key text PRIMARY KEY CHECK (provider_key = 'tikhub'),
  egress_mode text NOT NULL CHECK (egress_mode IN ('inherit','system-egress','proxy-sequence')),
  sequence_key text REFERENCES control.agent_proxy_sequences(sequence_key) ON UPDATE CASCADE,
  revision bigint NOT NULL DEFAULT 1,
  reason text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((egress_mode = 'proxy-sequence') = (sequence_key IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS control.external_platform_proxy_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_key text NOT NULL,
  revision bigint NOT NULL,
  egress_mode text NOT NULL,
  sequence_key text,
  actor text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO control.agent_proxy_endpoints(proxy_key, display_name, proxy_url, updated_by)
VALUES ('tikhub-internal-7788','Internal 7788 · TikHub','http://127.0.0.1:7788','migration-076')
ON CONFLICT DO NOTHING;
INSERT INTO control.agent_proxy_sequences(sequence_key, display_name, proxy_keys, direct_fallback, updated_by)
VALUES ('tikhub-internal-7788','TikHub · Internal 7788',ARRAY['tikhub-internal-7788'],false,'migration-076')
ON CONFLICT DO NOTHING;
WITH seeded AS (
 INSERT INTO control.external_platform_proxy_bindings(provider_key,egress_mode,sequence_key,reason)
 VALUES ('tikhub','proxy-sequence','tikhub-internal-7788','User-verified Internal 7788 HTTPS/API authentication reachability')
 ON CONFLICT DO NOTHING RETURNING *
)
INSERT INTO control.external_platform_proxy_events(provider_key,revision,egress_mode,sequence_key,actor,reason)
SELECT provider_key,revision,egress_mode,sequence_key,'migration-076',reason FROM seeded;
