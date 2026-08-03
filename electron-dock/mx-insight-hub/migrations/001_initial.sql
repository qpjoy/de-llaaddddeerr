CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS consumers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  business_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS consumers_tenant_idx ON consumers (tenant_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  consumer_id uuid NOT NULL REFERENCES consumers(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_digest char(64) NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  last_four char(4) NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);

CREATE INDEX IF NOT EXISTS api_keys_consumer_idx ON api_keys (consumer_id);

CREATE TABLE IF NOT EXISTS platform_grants (
  consumer_id uuid NOT NULL REFERENCES consumers(id) ON DELETE CASCADE,
  platform text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_id, platform)
);

CREATE TABLE IF NOT EXISTS platform_policies (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform text NOT NULL,
  max_requests integer NOT NULL CHECK (max_requests > 0),
  window_seconds integer NOT NULL CHECK (window_seconds > 0),
  max_page_size integer NOT NULL CHECK (max_page_size > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, platform)
);

CREATE TABLE IF NOT EXISTS usage_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  consumer_id uuid NOT NULL REFERENCES consumers(id) ON DELETE RESTRICT,
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  fingerprint char(64) NOT NULL,
  platform text NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved', 'committed', 'released', 'unknown')),
  units_reserved integer NOT NULL DEFAULT 1 CHECK (units_reserved >= 0),
  units_actual integer CHECK (units_actual >= 0),
  response_status integer,
  response_body jsonb,
  error_code text,
  upstream_latency_ms integer CHECK (upstream_latency_ms >= 0),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (consumer_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS usage_requests_quota_idx
  ON usage_requests (tenant_id, consumer_id, platform, reserved_at DESC)
  WHERE status IN ('reserved', 'committed', 'unknown');

CREATE INDEX IF NOT EXISTS usage_requests_created_idx
  ON usage_requests (created_at DESC);
