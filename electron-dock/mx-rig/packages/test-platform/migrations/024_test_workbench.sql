-- A project may be registered before any engine, suite or model is configured.
-- Paths are descriptive metadata, not permission to access a server's filesystem.
ALTER TABLE mxt_apps ADD COLUMN IF NOT EXISTS source_directory text;
ALTER TABLE rig_missions DROP CONSTRAINT rig_missions_status_check;
ALTER TABLE rig_missions ADD CONSTRAINT rig_missions_status_check CHECK (
  status IN ('draft', 'queued', 'running', 'awaiting_approval', 'completed', 'failed', 'blocked', 'cancelled')
);
