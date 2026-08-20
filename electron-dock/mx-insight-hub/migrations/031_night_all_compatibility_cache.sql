CREATE SCHEMA IF NOT EXISTS serving;

CREATE UNIQUE INDEX IF NOT EXISTS usage_requests_id_consumer_compat_idx
  ON usage_requests (id, consumer_id);

-- One row is written before every Night-All attempt and completed afterwards.
-- Keeping the evidence separate from usage_requests lets us retain upstream
-- failures even when the public request is ultimately served from a snapshot.
CREATE TABLE IF NOT EXISTS serving.connector_calls (
  id uuid PRIMARY KEY,
  consumer_id uuid NOT NULL REFERENCES consumers(id) ON DELETE RESTRICT,
  usage_request_id uuid,
  operation text NOT NULL
    CHECK (operation ~ '^[a-z][a-z0-9._-]{0,127}$'),
  request_fingerprint char(64) NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  platform text,
  source_mode text NOT NULL DEFAULT 'live'
    CHECK (source_mode IN ('live', 'stale')),
  outcome text CHECK (outcome IN ('complete', 'partial', 'failed', 'unknown')),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  business_status text,
  failure_kind text
    CHECK (failure_kind IN ('network', 'timeout', 'http', 'contract', 'business', 'internal', 'unknown')),
  upstream_latency_ms integer CHECK (upstream_latency_ms >= 0),
  error_code text,
  upstream_request_id text,
  upstream_trace_id text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (outcome IS NULL AND completed_at IS NULL)
    OR (outcome IS NOT NULL AND completed_at IS NOT NULL)
  ),
  FOREIGN KEY (usage_request_id, consumer_id)
    REFERENCES usage_requests(id, consumer_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS connector_calls_request_idx
  ON serving.connector_calls (usage_request_id, started_at DESC);

CREATE INDEX IF NOT EXISTS connector_calls_lookup_idx
  ON serving.connector_calls
    (consumer_id, operation, request_fingerprint, started_at DESC);

ALTER TABLE ingest.ingest_runs
  ADD COLUMN IF NOT EXISTS connector_call_id uuid
    REFERENCES serving.connector_calls(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ingest_runs_connector_call_idx
  ON ingest.ingest_runs (connector_call_id)
  WHERE connector_call_id IS NOT NULL;

-- response_body is the exact Night-All compatibility application payload
-- delivered to the caller. Hub masking is a separate future projection/API;
-- raw-to-canonical lineage continues through the ingest pipeline as well.
CREATE TABLE IF NOT EXISTS serving.compatibility_snapshots (
  id uuid PRIMARY KEY,
  consumer_id uuid NOT NULL REFERENCES consumers(id) ON DELETE RESTRICT,
  operation text NOT NULL
    CHECK (operation ~ '^[a-z][a-z0-9._-]{0,127}$'),
  request_fingerprint char(64) NOT NULL
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  platform text,
  response_body jsonb NOT NULL,
  captured_at timestamptz NOT NULL,
  stale_until timestamptz NOT NULL,
  last_success_call_id uuid NOT NULL
    REFERENCES serving.connector_calls(id) ON DELETE RESTRICT,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (stale_until >= captured_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS compatibility_snapshots_current_key_idx
  ON serving.compatibility_snapshots
    (consumer_id, operation, request_fingerprint)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS compatibility_snapshots_expiry_idx
  ON serving.compatibility_snapshots (stale_until)
  WHERE superseded_at IS NULL;

-- A committed usage row owns the delivery metadata used by idempotent replay.
-- Partial live responses have a captured time but intentionally no snapshot.
ALTER TABLE usage_requests
  ADD COLUMN IF NOT EXISTS delivery_source_mode text
    CHECK (delivery_source_mode IN ('live', 'stale')),
  ADD COLUMN IF NOT EXISTS response_captured_at timestamptz,
  ADD COLUMN IF NOT EXISTS compatibility_snapshot_id uuid
    REFERENCES serving.compatibility_snapshots(id) ON DELETE SET NULL;

COMMENT ON TABLE serving.connector_calls IS
  'Internal evidence for one Night-All compatibility call, including failures later served from a snapshot.';

COMMENT ON TABLE serving.compatibility_snapshots IS
  'Immutable exact consumer/operation/fingerprint public responses; partial responses never replace the current last-good row.';
