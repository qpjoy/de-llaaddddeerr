CREATE SCHEMA IF NOT EXISTS dataport;
CREATE TABLE dataport.roles (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id text NOT NULL,
  name text NOT NULL, permissions jsonb NOT NULL, revision integer NOT NULL DEFAULT 1,
  archived boolean NOT NULL DEFAULT false, PRIMARY KEY(tenant_id,id)
);
CREATE TABLE dataport.member_roles (
  tenant_id uuid NOT NULL REFERENCES tenants(id), member_id uuid NOT NULL REFERENCES iam.members(id),
  role_id text NOT NULL, revision integer NOT NULL DEFAULT 1,
  PRIMARY KEY(tenant_id,member_id)
);
CREATE TABLE dataport.owner_codes (
  tenant_id uuid NOT NULL REFERENCES tenants(id), member_id uuid NOT NULL REFERENCES iam.members(id),
  digest text NOT NULL, revision integer NOT NULL DEFAULT 1,
  PRIMARY KEY(tenant_id,member_id)
);
CREATE TABLE dataport.owner_sessions (
  tenant_id uuid NOT NULL, member_id uuid NOT NULL, session_digest text NOT NULL,
  code_revision integer NOT NULL, expires_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,member_id,session_digest)
);
CREATE TABLE dataport.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor uuid REFERENCES iam.members(id), action text NOT NULL, target text NOT NULL DEFAULT '',
  status integer NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dataport_events_tenant_time ON dataport.events(tenant_id,created_at DESC,id DESC);
CREATE TABLE dataport.tickets (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), actor uuid NOT NULL REFERENCES iam.members(id),
  content text NOT NULL, contact text NOT NULL DEFAULT '', category text NOT NULL,
  priority text NOT NULL, status text NOT NULL DEFAULT 'saved', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dataport_tickets_tenant_time ON dataport.tickets(tenant_id,created_at DESC,id);
CREATE TABLE dataport.queries (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), actor uuid NOT NULL REFERENCES iam.members(id),
  intent_key text NOT NULL, fingerprint text NOT NULL, ip inet NOT NULL,
  status integer, payload jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,actor,intent_key)
);
CREATE INDEX dataport_queries_tenant_time ON dataport.queries(tenant_id,created_at DESC,id DESC);
CREATE TABLE dataport.member_commands (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), actor uuid NOT NULL REFERENCES iam.members(id),
  operation text NOT NULL, fingerprint text NOT NULL, document jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dataport.joins (
  digest text PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), role_id text NOT NULL,
  requested_by uuid NOT NULL REFERENCES iam.members(id), account text NOT NULL, issuer text NOT NULL, subject text NOT NULL,
  expires_at timestamptz NOT NULL, consumed_by uuid REFERENCES iam.members(id)
);
CREATE TABLE dataport.managed_accounts (
  tenant_id uuid NOT NULL REFERENCES tenants(id), member_id uuid NOT NULL REFERENCES iam.members(id),
  user_id text NOT NULL, account text NOT NULL, managed boolean NOT NULL,
  PRIMARY KEY(tenant_id,member_id)
);
CREATE TABLE dataport.member_profiles (
  tenant_id uuid NOT NULL REFERENCES tenants(id), member_id uuid NOT NULL REFERENCES iam.members(id),
  display_name text NOT NULL, PRIMARY KEY(tenant_id,member_id)
);
