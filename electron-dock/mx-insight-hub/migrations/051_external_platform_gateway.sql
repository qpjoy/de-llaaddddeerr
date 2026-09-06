-- Native external data-platform gateway.
--
-- Provider credentials deliberately do not belong in these tables.  The Hub
-- keeps one provider-neutral public contract while retaining the internal
-- evidence needed to answer: what was dispatched, what was billed, which
-- snapshot was served, and where the raw observation was archived.

CREATE SCHEMA IF NOT EXISTS external_platform;

-- The provider-call ledger must not be able to combine the tenant, consumer,
-- API key or fingerprint of different usage rows.  PostgreSQL requires the
-- referenced column set to be unique before it may back the composite FK.
CREATE UNIQUE INDEX IF NOT EXISTS usage_requests_external_platform_scope_idx
  ON usage_requests (id, tenant_id, consumer_id, api_key_id, fingerprint);

CREATE TABLE IF NOT EXISTS external_platform.provider_calls (
  id uuid PRIMARY KEY,
  provider_key text NOT NULL
    CHECK (provider_key ~ '^[a-z][a-z0-9._-]{0,63}$'),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  consumer_id uuid NOT NULL REFERENCES consumers(id) ON DELETE RESTRICT,
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE RESTRICT,
  usage_request_id uuid NOT NULL REFERENCES usage_requests(id) ON DELETE RESTRICT,
  operation text NOT NULL
    CHECK (operation ~ '^[a-z][a-z0-9._-]{0,127}$'),
  contract_version text NOT NULL,
  endpoint_key text NOT NULL,
  endpoint_version text NOT NULL,
  marketplace text NOT NULL,
  request_fingerprint char(64) NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending', 'succeeded', 'succeeded_unusable', 'rejected', 'unknown')),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  business_code integer,
  upstream_request_id text,
  upstream_record_time text,
  billed boolean,
  cost_minor bigint CHECK (cost_minor >= 0),
  cost_kind text NOT NULL DEFAULT 'unknown'
    CHECK (cost_kind IN ('unknown', 'estimated', 'provider_reported')),
  currency char(3),
  latency_ms integer CHECK (latency_ms >= 0),
  item_count integer CHECK (item_count >= 0),
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (
    (outcome = 'pending' AND completed_at IS NULL)
    OR (outcome <> 'pending' AND completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS external_platform_provider_calls_usage_idx
  ON external_platform.provider_calls (usage_request_id);
CREATE INDEX IF NOT EXISTS external_platform_provider_calls_time_idx
  ON external_platform.provider_calls (provider_key, started_at DESC);
CREATE INDEX IF NOT EXISTS external_platform_provider_calls_tenant_idx
  ON external_platform.provider_calls (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS external_platform_provider_calls_dispatch_guard_idx
  ON external_platform.provider_calls
    (provider_key, consumer_id, operation, request_fingerprint, completed_at DESC);
-- A code=0 response that the Hub cannot normalize is an endpoint-contract
-- failure, not a tenant-local failure.  Index that quarantine globally so a
-- second consumer cannot immediately pay to rediscover the same drift.
CREATE INDEX IF NOT EXISTS external_platform_provider_calls_global_endpoint_guard_idx
  ON external_platform.provider_calls
    (provider_key, operation, endpoint_key, outcome, completed_at DESC);

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'external_platform_provider_calls_usage_scope_fk'
       AND conrelid = 'external_platform.provider_calls'::regclass
  ) THEN
    ALTER TABLE external_platform.provider_calls
      ADD CONSTRAINT external_platform_provider_calls_usage_scope_fk
      FOREIGN KEY (usage_request_id, tenant_id, consumer_id, api_key_id, request_fingerprint)
      REFERENCES usage_requests (id, tenant_id, consumer_id, api_key_id, fingerprint)
      ON DELETE RESTRICT;
  END IF;
END
$migration$;

-- One secret-free response envelope per actual dispatch.  This is deliberately
-- separate from item archives: empty pages and rejected/invalid responses are
-- still evidence, and a provider code=0 response may be billed even when a new
-- response shape cannot yet be normalized by the Hub.
CREATE TABLE IF NOT EXISTS external_platform.response_archives (
  id uuid PRIMARY KEY,
  provider_call_id uuid NOT NULL UNIQUE
    REFERENCES external_platform.provider_calls(id) ON DELETE RESTRICT,
  contract_state text NOT NULL
    CHECK (contract_state ~ '^[a-z][a-z0-9._-]{0,127}$'),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  business_code integer,
  content_type text,
  body_size integer CHECK (body_size >= 0),
  payload_sha256 char(64)
    CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[0-9a-f]{64}$'),
  raw_payload jsonb,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS external_platform_response_archives_time_idx
  ON external_platform.response_archives (captured_at DESC);

CREATE TABLE IF NOT EXISTS external_platform.response_snapshots (
  id uuid PRIMARY KEY,
  provider_key text NOT NULL,
  consumer_id uuid NOT NULL REFERENCES consumers(id) ON DELETE RESTRICT,
  operation text NOT NULL,
  request_fingerprint char(64) NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  response_body jsonb NOT NULL,
  captured_at timestamptz NOT NULL,
  fresh_until timestamptz NOT NULL,
  stale_until timestamptz NOT NULL,
  last_success_call_id uuid NOT NULL
    REFERENCES external_platform.provider_calls(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (fresh_until >= captured_at),
  CHECK (stale_until >= fresh_until),
  UNIQUE (consumer_id, operation, request_fingerprint)
);

CREATE INDEX IF NOT EXISTS external_platform_snapshots_expiry_idx
  ON external_platform.response_snapshots (stale_until);

-- Logical source-directory archive.  archive_path is a stable taxonomy, not a
-- host filesystem path: it survives replicas and can later become an object
-- store prefix without changing the query contract.
CREATE TABLE IF NOT EXISTS external_platform.archive_objects (
  id uuid PRIMARY KEY,
  provider_key text NOT NULL,
  object_kind text NOT NULL CHECK (object_kind IN ('response', 'item')),
  marketplace text NOT NULL,
  operation text NOT NULL,
  endpoint_version text NOT NULL,
  captured_date date NOT NULL,
  archive_path text NOT NULL,
  response_pointer text NOT NULL,
  source_key text NOT NULL,
  payload_sha256 char(64) NOT NULL
    CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  raw_payload jsonb NOT NULL,
  provider_call_id uuid NOT NULL
    REFERENCES external_platform.provider_calls(id) ON DELETE RESTRICT,
  item_ordinal integer NOT NULL CHECK (item_ordinal >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_call_id, item_ordinal)
);

CREATE INDEX IF NOT EXISTS external_platform_archive_directory_idx
  ON external_platform.archive_objects
    (provider_key, marketplace, operation, captured_date DESC);
CREATE INDEX IF NOT EXISTS external_platform_archive_source_idx
  ON external_platform.archive_objects
    (provider_key, marketplace, source_key, created_at DESC);

-- Every Hub request is separate from an actual provider call.  This is what
-- lets the management plane show avoided spend without pretending a cache hit
-- or idempotent replay was another upstream dispatch.
CREATE TABLE IF NOT EXISTS external_platform.gateway_requests (
  id uuid PRIMARY KEY,
  provider_key text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  consumer_id uuid NOT NULL REFERENCES consumers(id) ON DELETE RESTRICT,
  usage_request_id uuid REFERENCES usage_requests(id) ON DELETE RESTRICT,
  request_fingerprint char(64) NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  source_mode text NOT NULL
    CHECK (source_mode IN (
      'live', 'fresh_cache', 'stored_fallback', 'idempotent_replay',
      'duplicate_suppressed', 'circuit_rejected', 'unavailable'
    )),
  succeeded boolean NOT NULL,
  response_status integer CHECK (response_status BETWEEN 100 AND 599),
  provider_call_id uuid
    REFERENCES external_platform.provider_calls(id) ON DELETE RESTRICT,
  snapshot_id uuid
    REFERENCES external_platform.response_snapshots(id) ON DELETE SET NULL,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS external_platform_gateway_requests_time_idx
  ON external_platform.gateway_requests (provider_key, created_at DESC);
CREATE INDEX IF NOT EXISTS external_platform_gateway_requests_tenant_idx
  ON external_platform.gateway_requests (tenant_id, created_at DESC);

-- A short database lease suppresses equal paid dispatches that use different
-- caller idempotency keys or arrive on different Hub replicas.
CREATE TABLE IF NOT EXISTS external_platform.dispatch_leases (
  consumer_id uuid NOT NULL REFERENCES consumers(id) ON DELETE CASCADE,
  operation text NOT NULL,
  request_fingerprint char(64) NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  owner_request_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_id, operation, request_fingerprint)
);
CREATE INDEX IF NOT EXISTS external_platform_dispatch_leases_expiry_idx
  ON external_platform.dispatch_leases (expires_at);

-- Circuit state is provider-local and optional.  It must never participate in
-- Hub/Launcher readiness or prevent stored Hub data from being read.
CREATE TABLE IF NOT EXISTS external_platform.provider_state (
  provider_key text PRIMARY KEY,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  circuit_open_until timestamptz,
  last_call_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO external_platform.provider_state (provider_key)
VALUES ('justone')
ON CONFLICT (provider_key) DO NOTHING;

-- Reserved for a future provider account/quota API.  Until one is verified,
-- values are either explicit operator snapshots or remain unknown; zero never
-- means unknown.
CREATE TABLE IF NOT EXISTS external_platform.quota_snapshots (
  id uuid PRIMARY KEY,
  provider_key text NOT NULL,
  source text NOT NULL CHECK (source IN ('manual', 'provider_api')),
  free_daily_limit integer CHECK (free_daily_limit >= 0),
  free_daily_used integer CHECK (free_daily_used >= 0),
  balance_minor bigint CHECK (balance_minor >= 0),
  currency char(3),
  reset_at timestamptz,
  captured_at timestamptz NOT NULL,
  raw_evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS external_platform_quota_snapshots_time_idx
  ON external_platform.quota_snapshots (provider_key, captured_at DESC);

-- Canonical ingest runs retain the paid API call that produced their source
-- objects and observations.  Elasticsearch remains only an outbox projection.
ALTER TABLE ingest.ingest_runs
  ADD COLUMN IF NOT EXISTS external_platform_call_id uuid
    REFERENCES external_platform.provider_calls(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ingest_runs_external_platform_call_idx
  ON ingest.ingest_runs (external_platform_call_id)
  WHERE external_platform_call_id IS NOT NULL;

COMMENT ON SCHEMA external_platform IS
  'Hub-owned gateway evidence for optional external data API platforms.';
COMMENT ON TABLE external_platform.archive_objects IS
  'Secret-free raw provider observations arranged by a stable logical source directory; captured_date and archive_path both use UTC.';
COMMENT ON TABLE external_platform.response_archives IS
  'Secret-free complete response evidence, including empty, rejected, and unusable billed responses.';
COMMENT ON TABLE external_platform.gateway_requests IS
  'Hub demand ledger kept distinct from actual paid provider calls.';
