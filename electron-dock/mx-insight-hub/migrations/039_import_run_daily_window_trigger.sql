-- Telegram SQLite's scheduled previous-day sweep persists `daily_window` as
-- the import-run trigger. Migration 012 predates that scheduler mode, so its
-- check constraint must be widened before the first such run is inserted.

ALTER TABLE ingest.import_runs
  DROP CONSTRAINT IF EXISTS import_runs_trigger_check;

ALTER TABLE ingest.import_runs
  ADD CONSTRAINT import_runs_trigger_check
  CHECK (trigger IN ('manual', 'schedule', 'file', 'daily_window'));
