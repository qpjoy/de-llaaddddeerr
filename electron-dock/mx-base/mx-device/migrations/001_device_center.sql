CREATE SCHEMA IF NOT EXISTS mx_device;
CREATE TABLE IF NOT EXISTS mx_device.devices (
 id uuid PRIMARY KEY, mode text NOT NULL CHECK(mode IN ('sim','real')),
 resource_key text NOT NULL, account_key text NOT NULL, document jsonb NOT NULL,
 UNIQUE(mode,resource_key), UNIQUE(mode,account_key)
);
CREATE TABLE IF NOT EXISTS mx_device.jobs (
 id uuid PRIMARY KEY, mode text NOT NULL CHECK(mode IN ('sim','real')),
 request_key text NOT NULL, status text NOT NULL, created_at bigint NOT NULL, document jsonb NOT NULL,
 UNIQUE(mode,request_key)
);
CREATE INDEX IF NOT EXISTS device_job_queue ON mx_device.jobs(mode,status,created_at);
CREATE TABLE IF NOT EXISTS mx_device.attempts (
 id uuid PRIMARY KEY, mode text NOT NULL, job_id uuid NOT NULL REFERENCES mx_device.jobs(id),
 device_id uuid NOT NULL REFERENCES mx_device.devices(id), status text NOT NULL, created_at bigint NOT NULL,
 document jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS device_one_active_attempt ON mx_device.attempts(device_id) WHERE status='running';
CREATE UNIQUE INDEX IF NOT EXISTS job_one_active_attempt ON mx_device.attempts(job_id) WHERE status='running';
CREATE INDEX IF NOT EXISTS device_attempt_history ON mx_device.attempts(job_id,created_at);
CREATE TABLE IF NOT EXISTS mx_device.events (
 seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, mode text NOT NULL, at bigint NOT NULL, document jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS device_events_history ON mx_device.events(mode,seq DESC);
CREATE TABLE IF NOT EXISTS mx_device.workers (id text PRIMARY KEY, at bigint NOT NULL, document jsonb NOT NULL);
