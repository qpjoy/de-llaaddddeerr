CREATE SCHEMA IF NOT EXISTS control;

-- External-platform credentials are isolated from routinely queried provider
-- metadata and from the external_platform analytics/archive schema. They remain
-- plaintext by operator policy, matching control.agent_provider_credentials.
CREATE TABLE IF NOT EXISTS control.external_platform_provider_settings (
  provider_key text PRIMARY KEY
    CHECK (provider_key ~ '^[a-z][a-z0-9._-]{0,63}$'),
  source text NOT NULL DEFAULT 'environment'
    CHECK (source IN ('environment', 'database')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS control.external_platform_provider_credentials (
  provider_key text PRIMARY KEY
    REFERENCES control.external_platform_provider_settings(provider_key) ON DELETE CASCADE,
  api_key text NOT NULL
    CHECK (length(api_key) > 0 AND length(api_key) <= 4096),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO control.external_platform_provider_settings (provider_key, source, revision)
VALUES ('justone', 'environment', 0)
ON CONFLICT (provider_key) DO NOTHING;

COMMENT ON TABLE control.external_platform_provider_credentials IS
  'Plaintext external-platform credentials; never select from ordinary Admin/public response paths.';
