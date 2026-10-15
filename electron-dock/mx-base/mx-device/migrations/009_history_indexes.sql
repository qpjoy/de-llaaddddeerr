-- History-bounded reads. Every store transaction and state snapshot reads the
-- live rows plus "the most recent N"; without these indexes those reads scanned
-- all history (measured by scripts/pg-baseline.mjs). Index builds on a large
-- existing table can exceed the migration runner's default 4s statement limit.
SET LOCAL statement_timeout = '600s';
CREATE INDEX IF NOT EXISTS jobs_recent ON mx_device.jobs(mode, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS attempts_recent ON mx_device.attempts(mode, created_at DESC) INCLUDE (status);
-- Event retention deletes by age within a realm (worker, small batches).
CREATE INDEX IF NOT EXISTS events_retention ON mx_device.events(mode, at);
