-- Additive queue state; no identity, grant, balance or price changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
CREATE TABLE IF NOT EXISTS external_platform.dispatch_queues (
  scope text PRIMARY KEY CHECK (length(scope) = 64),
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE external_platform.provider_calls DROP CONSTRAINT IF EXISTS external_platform_provider_calls_role_check;
ALTER TABLE external_platform.provider_calls ADD CONSTRAINT external_platform_provider_calls_role_check
  CHECK (call_role IN ('primary', 'enrichment', 'retry')) NOT VALID;
CREATE INDEX IF NOT EXISTS response_snapshots_shared_detail_idx
  ON external_platform.response_snapshots (provider_key, operation, request_fingerprint, captured_at DESC)
  WHERE operation = 'social.posts.analytics';
