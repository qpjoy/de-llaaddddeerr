CREATE TABLE api_key_scope_events (
  id bigserial PRIMARY KEY,
  api_key_id uuid NOT NULL REFERENCES api_keys(id),
  actor text NOT NULL,
  previous_scopes jsonb NOT NULL,
  next_scopes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_key_scope_events_key_idx ON api_key_scope_events(api_key_id, id);
