-- What a suite produces.
--
-- Only `test` exists today. The column is added now rather than when the second
-- kind arrives because by then every stored suite would need backfilling, and
-- every query that assumed "a suite is a test" would need finding.
--
-- `build` runs a command on a capability-matched machine and keeps the artefact
-- instead of a result — which is what a Windows Electron installer needs, and
-- the only capability missing across MXT and mx-launcher's Release Center.
-- See specs/adr/0006-mxt-absorbs-builds-jenkins-deferred.md.

ALTER TABLE mxt_suites ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'test';

COMMENT ON COLUMN mxt_suites.kind IS
  'test = produces results (JUnit or summary.json); build = produces an artefact.';
