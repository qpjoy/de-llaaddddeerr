-- Empty by design: deployment defaults remain effective until an explicit save.
-- Separate from operation releases and price books, and never reset live counters.
CREATE TABLE control.external_platform_admission_policies (
  provider_key text PRIMARY KEY CHECK (provider_key ~ '^[a-z][a-z0-9._-]{0,127}$'),
  revision integer NOT NULL CHECK (revision > 0),
  max_concurrency integer NOT NULL CHECK (max_concurrency BETWEEN 1 AND 256),
  max_consumer_concurrency integer NOT NULL CHECK (max_consumer_concurrency BETWEEN 1 AND max_concurrency),
  max_requests_per_minute integer NOT NULL CHECK (max_requests_per_minute BETWEEN 1 AND 60000),
  max_wait_ms integer NOT NULL CHECK (max_wait_ms BETWEEN 1 AND 60000),
  max_pending integer NOT NULL CHECK (max_pending BETWEEN 1 AND 256),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE control.external_platform_admission_policy_events (
  event_id uuid PRIMARY KEY,
  provider_key text NOT NULL REFERENCES control.external_platform_admission_policies(provider_key),
  previous_revision integer NOT NULL CHECK (previous_revision >= 0),
  revision integer NOT NULL CHECK (revision = previous_revision + 1),
  previous_source text NOT NULL CHECK (previous_source IN ('deployment','database')),
  previous_limits jsonb NOT NULL CHECK (jsonb_typeof(previous_limits) = 'object'),
  limits jsonb NOT NULL CHECK (jsonb_typeof(limits) = 'object'),
  actor text NOT NULL CHECK (actor = 'admin-token'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider_key, revision)
);

CREATE FUNCTION control.reject_external_admission_event_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'External admission audit events are immutable';
END;
$$;
CREATE TRIGGER external_admission_events_immutable
  BEFORE UPDATE OR DELETE ON control.external_platform_admission_policy_events
  FOR EACH ROW EXECUTE FUNCTION control.reject_external_admission_event_change();

REVOKE ALL ON control.external_platform_admission_policies, control.external_platform_admission_policy_events FROM PUBLIC;
