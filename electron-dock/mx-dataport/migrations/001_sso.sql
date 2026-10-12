-- Apply in the consuming application's database, through its own migration runner.
-- This library never creates a database or runs migrations at startup.
CREATE SCHEMA IF NOT EXISTS app_auth;
CREATE TABLE IF NOT EXISTS app_auth.browser_sso_records (
  kind text NOT NULL CHECK (kind IN ('login', 'session')),
  id text NOT NULL,
  payload text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS browser_sso_expiry ON app_auth.browser_sso_records (expires_at);
