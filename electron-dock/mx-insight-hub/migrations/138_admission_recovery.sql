-- Manual recovery is separate from immutable usage, supplier receipts and money.
CREATE TABLE control.admission_recoveries (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  target text NOT NULL,
  scope_type text NOT NULL DEFAULT '',
  scope_key text NOT NULL DEFAULT '',
  generation text NOT NULL,
  previous_state jsonb NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  actor text NOT NULL,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (kind, target, scope_type, scope_key, generation)
);
CREATE INDEX admission_recovery_lookup ON control.admission_recoveries
  (kind, target, scope_type, scope_key, created_at DESC);
CREATE INDEX admission_recovery_history ON control.admission_recoveries (created_at DESC);

REVOKE ALL ON control.admission_recoveries FROM PUBLIC;
