-- Admin-only operational incidents. Collection is asynchronous: no triggers or
-- new dependencies on public dispatch, billing, readiness or identity paths.
CREATE SCHEMA IF NOT EXISTS notifications;

CREATE TABLE notifications.incidents (
  id bigserial PRIMARY KEY,
  category text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('warning', 'critical')),
  source text NOT NULL,
  source_scope text NOT NULL,
  code text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'closed')),
  occurrence_count bigint NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  first_occurred_at timestamptz NOT NULL,
  last_occurred_at timestamptz NOT NULL,
  latest_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX notifications_active_scope_idx
  ON notifications.incidents(source, source_scope, code) WHERE status <> 'closed';
CREATE INDEX notifications_incidents_status_idx ON notifications.incidents(status, id DESC);

CREATE TABLE notifications.events (
  id bigserial PRIMARY KEY,
  incident_id bigint NOT NULL REFERENCES notifications.incidents(id),
  kind text NOT NULL CHECK (kind IN ('observed', 'acknowledged', 'closed')),
  actor text NOT NULL,
  note text,
  source_event_id uuid UNIQUE,
  request_id uuid,
  marketplace text,
  credential_revision text,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_events_incident_idx ON notifications.events(incident_id, id DESC);

COMMENT ON TABLE notifications.incidents IS
  'Admin operational alerts; manual closure is not proof of upstream recovery.';
