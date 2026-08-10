-- Registered database providers and richer import evidence.
--
-- Provider configuration is deliberately split in two: the allowlisted
-- connection coordinates live in `config`, while the password is stored only
-- as an application-encrypted AES-256-GCM envelope.  Keeping the envelope as
-- jsonb makes its version/algorithm/IV/tag explicit and allows key-format
-- migrations without guessing how an opaque byte string was produced.

CREATE TABLE IF NOT EXISTS catalog.source_providers (
  id uuid PRIMARY KEY,
  provider_key text NOT NULL UNIQUE
    CHECK (provider_key ~ '^[a-z0-9]([a-z0-9._-]{0,126}[a-z0-9])?$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 128),
  provider_type text NOT NULL DEFAULT 'postgresql'
    CHECK (provider_type IN ('postgresql')),
  config jsonb NOT NULL CHECK (
    jsonb_typeof(config) = 'object'
    AND config - ARRAY['host', 'port', 'database', 'username', 'sslMode'] = '{}'::jsonb
  ),
  encrypted_secret jsonb NOT NULL CHECK (
    jsonb_typeof(encrypted_secret) = 'object'
    AND encrypted_secret @> '{"version": 1, "algorithm": "aes-256-gcm"}'::jsonb
    AND encrypted_secret ?& ARRAY['iv', 'authTag', 'ciphertext']
  ),
  health_status text NOT NULL DEFAULT 'unknown'
    CHECK (health_status IN ('unknown', 'healthy', 'unhealthy')),
  health_checked_at timestamptz,
  health_error_code text CHECK (
    health_error_code IS NULL OR health_error_code ~ '^[a-z][a-z0-9_]{0,127}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Existing sources stay NULL so this migration does not silently assert a
-- schedule for them. New registrations default to one minute; the scheduler
-- can distinguish an explicitly configured interval from legacy sources.
ALTER TABLE catalog.external_sources
  ADD COLUMN IF NOT EXISTS provider_id uuid
    REFERENCES catalog.source_providers(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS sync_interval_seconds integer;

CREATE INDEX IF NOT EXISTS external_sources_provider_idx
  ON catalog.external_sources (provider_id);

ALTER TABLE catalog.external_sources
  ALTER COLUMN sync_interval_seconds SET DEFAULT 60;

ALTER TABLE catalog.external_sources
  ADD CONSTRAINT external_sources_sync_interval_check
  CHECK (sync_interval_seconds IS NULL OR sync_interval_seconds BETWEEN 60 AND 86400);

ALTER TABLE ingest.import_runs
  ADD COLUMN IF NOT EXISTS changed_count integer NOT NULL DEFAULT 0
    CHECK (changed_count >= 0),
  ADD COLUMN IF NOT EXISTS deleted_count integer NOT NULL DEFAULT 0
    CHECK (deleted_count >= 0),
  ADD COLUMN IF NOT EXISTS cursor_start jsonb,
  ADD COLUMN IF NOT EXISTS cursor_end jsonb;

ALTER TABLE ingest.import_runs
  ADD CONSTRAINT import_runs_cursor_start_check
    CHECK (cursor_start IS NULL OR jsonb_typeof(cursor_start) = 'object'),
  ADD CONSTRAINT import_runs_cursor_end_check
    CHECK (cursor_end IS NULL OR jsonb_typeof(cursor_end) = 'object');
