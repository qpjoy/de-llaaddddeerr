-- Independent admin command journal. Never shares tenant billing or Launcher identity.
CREATE TABLE night_all_a_dispatches (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  fingerprint text NOT NULL,
  operation text NOT NULL,
  actor text NOT NULL,
  reason text NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved', 'completed', 'unknown')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX night_all_a_dispatches_created_at_idx ON night_all_a_dispatches (created_at DESC);
REVOKE ALL ON night_all_a_dispatches FROM PUBLIC;
