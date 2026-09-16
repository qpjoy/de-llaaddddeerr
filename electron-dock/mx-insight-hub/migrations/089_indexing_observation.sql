-- Observation only: does not enable, enqueue or replay any maintenance work.
SET LOCAL lock_timeout = '2s';
ALTER TABLE control.search_reindex_operations ADD COLUMN telemetry jsonb;
ALTER TABLE retrieval.workers ADD COLUMN telemetry jsonb;
