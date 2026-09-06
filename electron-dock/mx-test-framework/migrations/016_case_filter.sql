-- Running part of a suite instead of all of it.
--
-- `MXT_CASE_FILTER` has been in the runner contract since docs/04 was written
-- and was implemented nowhere: the platform could only ever run a whole suite.
-- The case it exists for is the obvious one — a case failed, you changed one
-- line, and you want that case back in twenty seconds rather than the whole
-- regression in six minutes.
--
-- A comma-separated list of Case IDs or spec globs. Case IDs are resolved to
-- spec paths through the catalog before the run starts, because that is the
-- form every engine understands and the platform is the only thing that knows
-- the mapping.

ALTER TABLE mxt_tasks ADD COLUMN IF NOT EXISTS case_filter text;
ALTER TABLE mxt_runs ADD COLUMN IF NOT EXISTS case_filter text;

COMMENT ON COLUMN mxt_runs.case_filter IS
  'Case IDs or spec globs this run was restricted to. NULL means the whole suite.';

-- Coverage of a filtered run is measured against the filtered subset, not the
-- whole catalog — see server/app.mjs. Without that, a deliberate one-case rerun
-- would report the other twenty-two as "registered but never ran", and the
-- notRun signal would stop meaning anything.
