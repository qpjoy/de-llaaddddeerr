-- Optional Admin-only physical resources; no identity, billing or provider changes.
CREATE SCHEMA IF NOT EXISTS peripherals;
CREATE TABLE peripherals.devices (
  id uuid PRIMARY KEY,
  serial text NOT NULL UNIQUE,
  account_key text NOT NULL UNIQUE,
  origin text NOT NULL UNIQUE,
  document jsonb NOT NULL
);
CREATE TABLE peripherals.jobs (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES peripherals.devices(id),
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','unknown','cancelled','expired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  document jsonb NOT NULL,
  UNIQUE(device_id, idempotency_key)
);
CREATE INDEX peripheral_jobs_history ON peripherals.jobs(device_id, created_at DESC, id DESC);
CREATE INDEX peripheral_jobs_active ON peripherals.jobs(device_id, created_at, id) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX peripheral_one_running ON peripherals.jobs(device_id) WHERE status = 'running';
CREATE TABLE peripherals.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES peripherals.devices(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  document jsonb NOT NULL
);
CREATE INDEX peripheral_events_history ON peripherals.events(device_id, id DESC);
