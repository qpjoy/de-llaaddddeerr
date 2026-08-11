CREATE SCHEMA IF NOT EXISTS control;

CREATE TABLE IF NOT EXISTS control.agent_provider_settings (
  kind text PRIMARY KEY CHECK (kind IN ('chat', 'embedding')),
  source text NOT NULL DEFAULT 'environment'
    CHECK (source IN ('environment', 'database')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  providers jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(providers) = 'array'),
  locked_embedding_model text,
  locked_embedding_dimensions integer CHECK (
    locked_embedding_dimensions IS NULL OR locked_embedding_dimensions > 0
  ),
  CHECK (
    (locked_embedding_model IS NULL) = (locked_embedding_dimensions IS NULL)
  ),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Credentials are intentionally isolated from the routinely queried provider
-- metadata. They remain plaintext by operator policy, but only the Agent
-- runtime's explicit secret query selects api_key.
CREATE TABLE IF NOT EXISTS control.agent_provider_credentials (
  kind text NOT NULL REFERENCES control.agent_provider_settings(kind) ON DELETE CASCADE,
  provider_id text NOT NULL CHECK (provider_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  api_key text NOT NULL CHECK (length(api_key) > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, provider_id)
);

INSERT INTO control.agent_provider_settings (kind, source, revision, providers)
VALUES
  ('chat', 'environment', 0, '[]'::jsonb),
  ('embedding', 'environment', 0, '[]'::jsonb)
ON CONFLICT (kind) DO NOTHING;

COMMENT ON TABLE control.agent_provider_credentials IS
  'Plaintext model-provider credentials; never select from Admin/public response paths.';
