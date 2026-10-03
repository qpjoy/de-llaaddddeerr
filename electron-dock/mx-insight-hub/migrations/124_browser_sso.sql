-- Additive browser sessions. Original members, memberships and wallets remain authoritative.
CREATE TABLE IF NOT EXISTS iam.browser_sso_records (
  kind text NOT NULL CHECK (kind IN ('login', 'session')),
  id text NOT NULL,
  payload text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS browser_sso_expiry ON iam.browser_sso_records (expires_at);
