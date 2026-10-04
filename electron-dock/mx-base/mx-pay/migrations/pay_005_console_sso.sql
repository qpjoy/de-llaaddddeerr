-- Application-owned session storage; no users, money or role migration.
CREATE SCHEMA IF NOT EXISTS app_auth;
CREATE TABLE IF NOT EXISTS app_auth.browser_sso_records (
  kind text NOT NULL CHECK (kind IN ('login', 'session')),
  id text NOT NULL,
  payload text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS browser_sso_expiry ON app_auth.browser_sso_records (expires_at);
