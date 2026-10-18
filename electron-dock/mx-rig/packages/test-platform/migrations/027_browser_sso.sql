-- Browser SSO through the platform's unified authentication (mx-rig docs/25 P4).
--
-- A sign-in through Auth (auth.minsight-ai.com) becomes an ordinary Rig
-- session row, marked `auth = 'sso'`. Its `sso_ref` names a record in
-- rig_auth.browser_sso_records — the verified upstream session, sealed with the
-- profile's sessionKey by @qpjoy/mx-common/identity/postgres — which Rig checks
-- against Auth again while the session is used, so an account disabled there
-- stops working here. The reference is a database key, never sent to a client.
--
-- The table is the shape of @qpjoy/mx-common/identity/schema.sql, in Rig's own
-- schema. Authentication never grants a role: mxt_members still decides.

ALTER TABLE mxt_sessions ADD COLUMN IF NOT EXISTS auth text NOT NULL DEFAULT 'local';
ALTER TABLE mxt_sessions ADD COLUMN IF NOT EXISTS sso_ref text;

CREATE SCHEMA IF NOT EXISTS rig_auth;
CREATE TABLE IF NOT EXISTS rig_auth.browser_sso_records (
  kind text NOT NULL CHECK (kind IN ('login', 'session')),
  id text NOT NULL,
  payload text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS rig_browser_sso_expiry ON rig_auth.browser_sso_records (expires_at);
