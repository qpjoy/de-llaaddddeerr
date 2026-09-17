-- Connectivity-probe policy for System Proxy routes.
--
-- The probe deadline used to be a constant compiled into the TikHub fetch
-- wrapper, so a slow but healthy egress was indistinguishable from an
-- unreachable one and could only be diagnosed on the node. Policy now belongs
-- to the route that owns the latency characteristics (the Proxy Sequence),
-- with an optional per-provider override for services whose total request
-- budget differs. Every column is nullable: NULL means "inherit", so existing
-- rows keep resolving to the application defaults and no deployed route
-- changes behaviour because of this migration alone.

ALTER TABLE control.agent_proxy_sequences
  ADD COLUMN IF NOT EXISTS probe_timeout_ms integer
    CHECK (probe_timeout_ms IS NULL OR probe_timeout_ms BETWEEN 1000 AND 60000),
  ADD COLUMN IF NOT EXISTS probe_attempts integer
    CHECK (probe_attempts IS NULL OR probe_attempts BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS probe_cache_ttl_ms integer
    CHECK (probe_cache_ttl_ms IS NULL OR probe_cache_ttl_ms BETWEEN 0 AND 600000);

ALTER TABLE control.external_platform_proxy_bindings
  ADD COLUMN IF NOT EXISTS probe_timeout_ms integer
    CHECK (probe_timeout_ms IS NULL OR probe_timeout_ms BETWEEN 1000 AND 60000),
  ADD COLUMN IF NOT EXISTS probe_attempts integer
    CHECK (probe_attempts IS NULL OR probe_attempts BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS probe_cache_ttl_ms integer
    CHECK (probe_cache_ttl_ms IS NULL OR probe_cache_ttl_ms BETWEEN 0 AND 600000);

COMMENT ON COLUMN control.agent_proxy_sequences.probe_timeout_ms IS
  'Per-probe deadline for this route. NULL inherits the application default.';
COMMENT ON COLUMN control.external_platform_proxy_bindings.probe_timeout_ms IS
  'Provider-level override of the bound sequence probe deadline. NULL inherits the sequence, then the application default.';

-- Why a route was declared unreachable, kept outside the billing ledger.
-- One row per failed business dispatch (not per candidate), so the write rate
-- is bounded by the request rate and an outage cannot amplify it.
CREATE TABLE IF NOT EXISTS control.external_platform_proxy_probe_failures (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_key text NOT NULL,
  route_fingerprint text,
  attempts jsonb NOT NULL CHECK (jsonb_typeof(attempts) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS external_platform_proxy_probe_failures_recent_idx
  ON control.external_platform_proxy_probe_failures (provider_key, id DESC);
