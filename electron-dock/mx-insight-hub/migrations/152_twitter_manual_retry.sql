-- An operator acknowledgement belongs to one successor delivery. Record it at
-- the first provider call, or atomically with a delivery using only paid carry.
-- Pre-dispatch admission refusals do not consume the acknowledgement.
CREATE TABLE IF NOT EXISTS external_platform.twitter_manual_retries (
  original_usage_request_id uuid PRIMARY KEY REFERENCES usage_requests(id) ON DELETE RESTRICT,
  successor_usage_request_id uuid NOT NULL UNIQUE REFERENCES usage_requests(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL,
  consumer_id uuid NOT NULL,
  api_key_id uuid NOT NULL,
  request_fingerprint char(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (original_usage_request_id <> successor_usage_request_id)
);
