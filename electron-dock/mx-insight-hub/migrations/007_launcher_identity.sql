-- P6: federated human identity.
--
-- Implements ADR-0004. The Hub does NOT become a second authentication system:
-- there is no password, no MFA, no session table and no copy of Launcher's user
-- records here. What the Hub owns is *authorization* — which member may act in
-- which tenant with which role — keyed to a verified external identity.
--
-- The admin token keeps working unchanged. It is the break-glass path: if
-- Launcher is unreachable, an operator must still be able to reach the console,
-- and making the only administrative entry depend on another service would turn
-- a Launcher outage into a Hub lockout.

CREATE SCHEMA IF NOT EXISTS iam;

-- A human known to the Hub. Deliberately thin: display name for the console,
-- status for local suspension. Everything identifying lives in Launcher.
CREATE TABLE IF NOT EXISTS iam.members (
  id uuid PRIMARY KEY,
  display_name text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The verified principal tuple from ADR-0004:
--   (trusted issuer, stable subject, hub audience, launcher organization)
--
-- `subject` is Launcher's opaque principal id, never an email. An email is a
-- mutable attribute that can be reassigned to a different human; keying identity
-- on it means a mailbox change silently transfers access.
--
-- Uniqueness is (issuer, subject, audience) rather than subject alone: the same
-- subject reaching a different audience is a different authorization context,
-- and two issuers may legitimately mint the same subject string.
CREATE TABLE IF NOT EXISTS iam.external_identity_bindings (
  id uuid PRIMARY KEY,
  member_id uuid NOT NULL REFERENCES iam.members(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  subject text NOT NULL,
  audience text NOT NULL,
  organization_id text,
  launcher_tenant_id text,
  auth_provider text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject, audience)
);

CREATE INDEX IF NOT EXISTS external_identity_bindings_member_idx
  ON iam.external_identity_bindings (member_id);

-- What a member may do inside one Hub tenant.
--
-- This is a separate lifecycle from the Launcher account on purpose (ADR-0004):
-- deactivating someone in Launcher stops them authenticating, while suspending
-- their membership here stops them acting in this tenant. Conflating the two
-- means an offboarding in one system silently half-applies in the other.
CREATE TABLE IF NOT EXISTS iam.tenant_memberships (
  id uuid PRIMARY KEY,
  member_id uuid NOT NULL REFERENCES iam.members(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- owner   full control of the tenant, including membership
  -- admin   consumers, API keys, platform grants
  -- analyst read plus usage; may not issue credentials
  -- viewer  read only
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'analyst', 'viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  granted_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS tenant_memberships_tenant_idx
  ON iam.tenant_memberships (tenant_id, status);

-- Platform-wide administrators, independent of any tenant.
--
-- Populated only from an explicit Launcher scope allowlist
-- (MX_INSIGHT_LAUNCHER_ADMIN_SCOPES). A first login never self-grants tenant
-- access: an unknown member authenticates successfully and sees nothing until
-- someone with authority grants a membership. Authentication is not entitlement.
CREATE TABLE IF NOT EXISTS iam.platform_admins (
  member_id uuid PRIMARY KEY REFERENCES iam.members(id) ON DELETE CASCADE,
  granted_via text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Audit trail for identity decisions. Kept separate from the request ledger
-- because these events outlive any single request and are read during incident
-- review, not billing.
CREATE TABLE IF NOT EXISTS iam.identity_events (
  id bigserial PRIMARY KEY,
  member_id uuid REFERENCES iam.members(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  issuer text,
  subject text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS identity_events_recent_idx
  ON iam.identity_events (created_at DESC);
