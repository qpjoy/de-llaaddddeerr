CREATE TABLE api_key_vault (
  api_key_id uuid PRIMARY KEY REFERENCES api_keys(id),
  envelope text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE api_key_reveal_events (
  id bigserial PRIMARY KEY,
  api_key_id uuid NOT NULL REFERENCES api_keys(id),
  member_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
