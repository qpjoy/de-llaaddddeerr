-- Immutable user-reviewed case + execution snapshots. Existing runs remain unchanged.
ALTER TABLE mxt_runs ADD COLUMN IF NOT EXISTS workbench jsonb;
CREATE INDEX IF NOT EXISTS mxt_runs_workbench_mission_idx
  ON mxt_runs ((workbench->>'missionId'), queued_at DESC) WHERE workbench IS NOT NULL;
