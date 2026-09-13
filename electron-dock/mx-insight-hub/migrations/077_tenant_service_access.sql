-- Empty by default. Existing consumer grants remain explicit operator grants.
CREATE TABLE tenant_service_access (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  revision integer NOT NULL,
  configuration jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tenant_service_access_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  revision integer NOT NULL,
  actor text NOT NULL,
  reason text NOT NULL,
  configuration jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
