-- The handoff between building and testing.
--
-- Jenkins builds the desktop installer (a Windows build cannot run on the Linux
-- cluster) and publishes it here. MXT then decides on its own schedule when to
-- test it. That direction matters: if Jenkins triggered the test run instead,
-- mx-base would sit on MXT's critical path and break its ADR-0001.
--
-- The sha256 is not optional bookkeeping. A runner downloads this file onto
-- someone's own machine and executes it.

ALTER TABLE mxt_apps ADD COLUMN IF NOT EXISTS latest_package jsonb;
ALTER TABLE mxt_runs ADD COLUMN IF NOT EXISTS app_package    jsonb;

COMMENT ON COLUMN mxt_apps.latest_package IS
  'Most recently published build: {url, sha256, filename, version, gitSha, publishedAt}.';
COMMENT ON COLUMN mxt_runs.app_package IS
  'The build this run tested, snapshotted at dispatch so a later publish cannot rewrite history.';
