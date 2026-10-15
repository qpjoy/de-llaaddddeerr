-- DataPort administration is an explicit MX application scope, independent of
-- iam.platform_admins and enterprise permissions. No account is granted here.
CREATE TABLE dataport.platform_enterprises (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  actor uuid NOT NULL REFERENCES iam.members(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE dataport.joins ADD COLUMN platform_authorizer jsonb;
