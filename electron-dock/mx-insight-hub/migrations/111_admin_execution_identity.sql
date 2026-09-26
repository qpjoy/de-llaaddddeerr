-- Explicit Admin-console selection provisions the identity, never deployment.
CREATE TABLE IF NOT EXISTS control.admin_execution_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  api_key_id uuid NOT NULL REFERENCES public.api_keys(id) ON DELETE RESTRICT,
  scope_snapshot jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
