-- Logical cancellation and confirmed process shutdown are separate facts.
ALTER TABLE mxt_runs ADD COLUMN IF NOT EXISTS cancellation jsonb;
COMMENT ON COLUMN mxt_runs.cancellation IS
  'Cancellation request and runner shutdown receipt; cancelled alone does not prove processes stopped.';
