-- Where a build suite leaves the thing it built.
--
-- A glob relative to the suite's working directory, e.g.
-- `dist/electron/Packaged/*.exe`. Declared on the suite rather than fixed by
-- convention so that the repository under test needs no change at all — asking
-- it to copy the installer into a platform-specific directory would put the
-- platform back inside someone else's repo, which ADR-0007 just removed.
--
-- NULL is correct for `kind: test` suites, which produce results rather than
-- artefacts.

ALTER TABLE mxt_suites ADD COLUMN IF NOT EXISTS artifact_path text;

COMMENT ON COLUMN mxt_suites.artifact_path IS
  'Glob for the built artefact, relative to working_dir. Only meaningful for kind = build.';
