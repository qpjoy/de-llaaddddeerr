-- Hub-issued public API keys have a bounded lifetime. Existing keys receive a
-- fresh 180-day window at rollout rather than expiring immediately because
-- they may have been issued more than six months before this migration.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

UPDATE api_keys
   SET expires_at = now() + interval '180 days'
 WHERE expires_at IS NULL;

ALTER TABLE api_keys
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '180 days'),
  ALTER COLUMN expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS api_keys_active_expiry_idx
  ON api_keys (expires_at)
  WHERE status = 'active';

COMMENT ON COLUMN api_keys.expires_at IS
  'Exclusive authentication expiry for the Hub-issued key; new keys default to 180 days.';
