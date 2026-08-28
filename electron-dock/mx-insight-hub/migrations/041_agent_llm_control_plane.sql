CREATE SCHEMA IF NOT EXISTS control;
CREATE SCHEMA IF NOT EXISTS agent_center;

-- Reusable, ordered views over the existing provider catalog. Provider
-- metadata and plaintext credentials remain owned by migration 017; a
-- Sequence never duplicates a key.
CREATE TABLE IF NOT EXISTS control.agent_llm_sequences (
  sequence_key text PRIMARY KEY
    CHECK (sequence_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('chat', 'embedding')),
  provider_ids text[] NOT NULL CHECK (cardinality(provider_ids) BETWEEN 1 AND 32),
  enabled boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'database' CHECK (source IN ('bootstrap', 'database')),
  provider_revision bigint NOT NULL DEFAULT 0 CHECK (provider_revision >= 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  verified_at timestamptz,
  verified_by text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sequence_key, kind),
  CHECK (array_position(provider_ids, NULL) IS NULL)
);

CREATE TABLE IF NOT EXISTS control.agent_consumer_bindings (
  consumer_key text PRIMARY KEY
    CHECK (consumer_key ~ '^[a-z0-9][a-z0-9._-]{0,95}$'),
  kind text NOT NULL CHECK (kind IN ('chat', 'embedding')),
  sequence_key text NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (sequence_key, kind)
    REFERENCES control.agent_llm_sequences(sequence_key, kind)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

-- Append-only, secret-free connectivity evidence. A passing row is useful
-- only for its exact provider settings revision; changing any provider makes
-- the previous evidence stale without deleting its audit trail.
CREATE TABLE IF NOT EXISTS agent_center.agent_provider_probe_results (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('chat', 'embedding')),
  provider_id text NOT NULL,
  settings_revision bigint NOT NULL CHECK (settings_revision >= 0),
  proxy_fingerprint char(64) NOT NULL
    CHECK (proxy_fingerprint ~ '^[0-9a-f]{64}$'),
  model text NOT NULL,
  protocol text NOT NULL,
  ok boolean NOT NULL,
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code text,
  tested_by text,
  tested_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_provider_probe_lookup_idx
  ON agent_center.agent_provider_probe_results
  (kind, provider_id, settings_revision, proxy_fingerprint, tested_at DESC);

-- Application-level proxy catalog. URLs intentionally contain no credentials;
-- authenticated proxies can be added later with a separate credential table
-- without ever placing secrets in routinely returned metadata.
CREATE TABLE IF NOT EXISTS control.agent_proxy_endpoints (
  proxy_key text PRIMARY KEY
    CHECK (proxy_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  proxy_url text NOT NULL CHECK (length(proxy_url) BETWEEN 1 AND 2048),
  enabled boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS control.agent_proxy_sequences (
  sequence_key text PRIMARY KEY
    CHECK (sequence_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  proxy_keys text[] NOT NULL DEFAULT '{}'::text[],
  direct_fallback boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(proxy_keys) <= 16),
  CHECK (array_position(proxy_keys, NULL) IS NULL),
  CHECK (cardinality(proxy_keys) > 0 OR direct_fallback)
);

CREATE TABLE IF NOT EXISTS control.agent_proxy_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  global_sequence_key text REFERENCES control.agent_proxy_sequences(sequence_key)
    ON UPDATE CASCADE ON DELETE SET NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO control.agent_proxy_settings (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

COMMENT ON TABLE control.agent_llm_sequences IS
  'Reusable ordered provider selections. Provider keys remain in control.agent_provider_credentials.';
COMMENT ON TABLE agent_center.agent_provider_probe_results IS
  'Append-only, secret-free provider connectivity evidence; never stores prompts or upstream bodies.';
