-- Additive tenant invitations. Existing identities, memberships and billing stay intact.
CREATE TABLE IF NOT EXISTS iam.tenant_invitations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  role text NOT NULL CHECK (role IN ('owner','admin','analyst','viewer','billing')),
  label text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_sealed text NOT NULL,
  creator_id uuid REFERENCES iam.members(id),
  creator_key text NOT NULL,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  allow_registration boolean NOT NULL DEFAULT true,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  accepted_by uuid REFERENCES iam.members(id),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (creator_key,request_id)
);
CREATE INDEX IF NOT EXISTS tenant_invitations_tenant_recent ON iam.tenant_invitations(tenant_id,created_at DESC);
ALTER TABLE iam.browser_sso_records DROP CONSTRAINT IF EXISTS browser_sso_records_kind_check;
ALTER TABLE iam.browser_sso_records ADD CONSTRAINT browser_sso_records_kind_check
  CHECK (kind IN ('login','session','invitation','invitation-registration'));
