-- Rig's own accounts and sessions.
--
-- Until now identity came only from mx-launcher, with the service admin token
-- as the one local way in. Rig has to be usable on its own, so it can now hold
-- password accounts and the sessions it issues for them. Launcher federation
-- keeps working unchanged: its principals simply have no row here.
--
-- Authorization is still mxt_members.role. An account row answers "how does
-- this person prove who they are"; it never grants anything by itself.

CREATE TABLE IF NOT EXISTS mxt_local_accounts (
  account               text PRIMARY KEY,
  principal_id          text NOT NULL UNIQUE REFERENCES mxt_members (principal_id) ON DELETE CASCADE,
  -- scrypt$N$r$p$salt$key; the plaintext is never stored or logged.
  password_hash         text NOT NULL,
  must_change_password  boolean NOT NULL DEFAULT true,
  failed_logins         integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  disabled_at           timestamptz,
  password_changed_at   timestamptz,
  created_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mxt_local_accounts_account_check CHECK (account ~ '^[a-z0-9][a-z0-9._-]{1,39}$'),
  CONSTRAINT mxt_local_accounts_principal_check CHECK (principal_id = 'local:' || account)
);

-- Sessions are opaque bearer tokens. Only their SHA-256 is stored, so a copy of
-- this table does not let anyone sign in.
CREATE TABLE IF NOT EXISTS mxt_sessions (
  token_hash    text PRIMARY KEY,
  principal_id  text NOT NULL REFERENCES mxt_members (principal_id) ON DELETE CASCADE,
  source        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);

CREATE INDEX IF NOT EXISTS mxt_sessions_principal_idx ON mxt_sessions (principal_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS mxt_sessions_expiry_idx ON mxt_sessions (expires_at);
