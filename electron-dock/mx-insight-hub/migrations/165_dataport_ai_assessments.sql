-- Derived AI results are independent of immutable IP delivery and billing facts.
CREATE TABLE dataport.ai_assessments (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  query_id uuid NOT NULL REFERENCES dataport.queries(id),
  actor uuid NOT NULL REFERENCES iam.members(id),
  environment text NOT NULL CHECK (environment IN ('prod','dev')),
  credential_fingerprint text NOT NULL,
  input jsonb NOT NULL,
  status text NOT NULL DEFAULT 'submitting',
  run_key uuid,
  result_text text,
  error_code text,
  poll_failures integer NOT NULL DEFAULT 0,
  poll_generation bigint NOT NULL DEFAULT 0,
  poll_after timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,query_id)
);
REVOKE ALL ON dataport.ai_assessments FROM PUBLIC;
