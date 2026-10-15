-- Preserve all existing behavior until the administrator explicitly saves a switch.
ALTER TABLE api_keys
  ADD COLUMN hub_rate_limit_exempt boolean,
  ADD COLUMN hub_rate_limit_revision integer NOT NULL DEFAULT 0 CHECK (hub_rate_limit_revision >= 0),
  ADD COLUMN hub_rate_limit_updated_at timestamptz,
  ADD CONSTRAINT api_key_hub_limit_identity CHECK (
    hub_rate_limit_exempt IS NULL OR (
      id = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
      AND tenant_id = '277bf8a4-5ed5-414d-b429-d72fcd7d36b6'
      AND consumer_id = 'be7d07fe-3d98-4db3-b00d-e5cbe5a76190'
    )
  );

CREATE TABLE control.api_key_hub_limit_events (
  id bigserial PRIMARY KEY,
  api_key_id uuid NOT NULL REFERENCES api_keys(id),
  previous_exempt boolean,
  next_exempt boolean NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  actor text NOT NULL CHECK (actor = 'admin-token'),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (api_key_id, revision)
);

CREATE FUNCTION control.reject_api_key_hub_limit_event_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'API key Hub limit audit events are immutable';
END;
$$;
CREATE TRIGGER api_key_hub_limit_events_immutable
  BEFORE UPDATE OR DELETE ON control.api_key_hub_limit_events
  FOR EACH ROW EXECUTE FUNCTION control.reject_api_key_hub_limit_event_change();
