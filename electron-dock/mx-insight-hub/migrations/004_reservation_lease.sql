ALTER TABLE usage_requests
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

UPDATE usage_requests
SET lease_expires_at = reserved_at + interval '2 minutes'
WHERE status = 'reserved' AND lease_expires_at IS NULL;

CREATE INDEX IF NOT EXISTS usage_requests_stale_reservation_idx
  ON usage_requests (lease_expires_at)
  WHERE status = 'reserved';

