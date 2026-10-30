-- Resource limits protect every Key, independently of financial exemptions.
CREATE TABLE control.resource_admission_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision integer NOT NULL CHECK (revision >= 0),
  configuration jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO control.resource_admission_policy (revision, configuration) VALUES (0,
  '{"defaults":{"maxConcurrency":256,"maxKeyConcurrency":32,"requestsPerSecond":1000,"keyRequestsPerSecond":100},"rules":[]}');
CREATE TABLE control.resource_admission_events (
  id uuid PRIMARY KEY,
  revision integer UNIQUE NOT NULL CHECK (revision > 0),
  previous_configuration jsonb NOT NULL,
  configuration jsonb NOT NULL,
  actor text NOT NULL CHECK (actor='admin-token'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION control.reject_resource_admission_event_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Resource admission events are immutable'; END;
$$;
CREATE TRIGGER resource_admission_events_immutable BEFORE UPDATE OR DELETE ON control.resource_admission_events
FOR EACH ROW EXECUTE FUNCTION control.reject_resource_admission_event_change();
