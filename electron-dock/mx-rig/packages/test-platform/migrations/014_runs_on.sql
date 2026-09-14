-- Where a task runs, as a choice rather than as a side effect.
--
-- Until now "server or somebody's laptop" was decided implicitly by
-- `mxt_suites.runner_kind`: the same suite could not be run headless on the
-- server one afternoon and on a real Windows machine the next, and nobody
-- creating a task was ever asked. See docs/25-live-runs-and-runner-onboarding.md §13.
--
-- Three values, and the third one carries a machine:
--   server         — a container on the platform's own cluster
--   any-runner     — the first registered machine that is capable and free
--   pinned-runner  — that machine and no other (runner_id / assigned_runner_id)

ALTER TABLE mxt_tasks ADD COLUMN IF NOT EXISTS runs_on text;
ALTER TABLE mxt_tasks ADD COLUMN IF NOT EXISTS runner_id text
  REFERENCES mxt_runners(id) ON DELETE SET NULL;

ALTER TABLE mxt_runs ADD COLUMN IF NOT EXISTS runs_on text;
-- Deliberately *not* `runner_id`: that column already means "the machine that
-- claimed this run". Which machine was asked for and which one answered are
-- different facts, and a run pinned to a machine that never came online has the
-- first without the second.
ALTER TABLE mxt_runs ADD COLUMN IF NOT EXISTS assigned_runner_id text
  REFERENCES mxt_runners(id) ON DELETE SET NULL;

-- Existing rows keep behaving exactly as they did: the suite's runner_kind was
-- the decision, so it becomes the recorded decision.
UPDATE mxt_tasks t SET runs_on = CASE
  WHEN s.runner_kind = 'local' THEN 'any-runner' ELSE 'server' END
  FROM mxt_suites s WHERE s.id = t.suite_id AND t.runs_on IS NULL;

UPDATE mxt_runs r SET runs_on = CASE
  WHEN s.runner_kind = 'local' THEN 'any-runner' ELSE 'server' END
  FROM mxt_suites s WHERE s.id = r.suite_id AND r.runs_on IS NULL;

-- A run with no suite left (the suite was deleted) still has to say something.
UPDATE mxt_runs SET runs_on = 'server' WHERE runs_on IS NULL;

-- Dropped first so re-applying this file is safe, the way 012 does it:
-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS.
ALTER TABLE mxt_tasks DROP CONSTRAINT IF EXISTS mxt_tasks_runs_on_check;
ALTER TABLE mxt_tasks ADD CONSTRAINT mxt_tasks_runs_on_check CHECK (
  runs_on IS NULL OR (
    runs_on IN ('server','any-runner','pinned-runner')
    -- A pin with no machine is not a pin; it would silently widen to "anyone".
    AND (runs_on <> 'pinned-runner' OR runner_id IS NOT NULL)
  )
);

ALTER TABLE mxt_runs DROP CONSTRAINT IF EXISTS mxt_runs_runs_on_check;
ALTER TABLE mxt_runs ADD CONSTRAINT mxt_runs_runs_on_check CHECK (
  runs_on IS NULL OR (
    runs_on IN ('server','any-runner','pinned-runner')
    AND (runs_on <> 'pinned-runner' OR assigned_runner_id IS NOT NULL)
  )
);

COMMENT ON COLUMN mxt_runs.assigned_runner_id IS
  'The machine this run was pinned to. Only that runner may claim it.';
