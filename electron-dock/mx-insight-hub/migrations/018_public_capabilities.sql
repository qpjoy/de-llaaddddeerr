-- Generic public capabilities are deliberately separate from source platforms.
-- A consumer may be allowed to tokenize text without receiving access to any
-- Night-All or Hub dataset, so modelling `nlp.tokenize` as a platform grant
-- would couple two unrelated authority boundaries.

CREATE TABLE IF NOT EXISTS capability_grants (
  consumer_id uuid NOT NULL REFERENCES consumers(id) ON DELETE CASCADE,
  capability text NOT NULL CHECK (capability <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_id, capability)
);

CREATE TABLE IF NOT EXISTS consumer_capability_policies (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  consumer_id uuid NOT NULL REFERENCES consumers(id) ON DELETE CASCADE,
  capability text NOT NULL CHECK (capability <> ''),
  max_requests integer NOT NULL CHECK (max_requests > 0),
  window_seconds integer NOT NULL CHECK (window_seconds > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_id, capability)
);

CREATE INDEX IF NOT EXISTS consumer_capability_policies_tenant_idx
  ON consumer_capability_policies (tenant_id, consumer_id);

-- Usage evidence keeps its original platform dimension for every existing
-- request while allowing exactly one generic capability dimension for tools.
ALTER TABLE usage_requests
  ADD COLUMN IF NOT EXISTS capability text;

ALTER TABLE usage_requests
  ALTER COLUMN platform DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'usage_requests_single_scope_check'
       AND conrelid = 'usage_requests'::regclass
  ) THEN
    ALTER TABLE usage_requests
      ADD CONSTRAINT usage_requests_single_scope_check
      CHECK ((platform IS NOT NULL)::integer + (capability IS NOT NULL)::integer = 1)
      NOT VALID;
  END IF;
END $$;

ALTER TABLE usage_requests
  VALIDATE CONSTRAINT usage_requests_single_scope_check;

CREATE INDEX IF NOT EXISTS usage_requests_capability_quota_idx
  ON usage_requests (tenant_id, consumer_id, capability, reserved_at DESC)
  WHERE capability IS NOT NULL
    AND status IN ('reserved', 'committed', 'unknown');
