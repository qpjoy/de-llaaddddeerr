-- DataPort-only employee authentication; enterprise owners retain MX SSO.
-- No Launcher identities, Hub login bindings or platform roles are created.
ALTER TABLE dataport.managed_accounts ADD COLUMN auth_mode text NOT NULL DEFAULT 'mx'
  CHECK (auth_mode IN ('mx','local'));
CREATE TABLE dataport.local_credentials (
  member_id uuid PRIMARY KEY REFERENCES iam.members(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  account text NOT NULL UNIQUE CHECK (account = lower(account) AND account ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  password_hash text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  initial_cipher jsonb,
  initial_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,member_id) REFERENCES dataport.managed_accounts(tenant_id,member_id)
);
CREATE TABLE dataport.local_sessions (
  digest text PRIMARY KEY CHECK (digest ~ '^[a-f0-9]{64}$'),
  member_id uuid NOT NULL REFERENCES dataport.local_credentials(member_id),
  credential_revision integer NOT NULL,
  csrf text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dataport_local_sessions_member ON dataport.local_sessions(member_id);
CREATE TABLE dataport.login_limits (
  bucket text PRIMARY KEY,
  attempts integer NOT NULL,
  expires_at timestamptz NOT NULL
);
REVOKE ALL ON dataport.local_credentials,dataport.local_sessions,dataport.login_limits FROM PUBLIC;
