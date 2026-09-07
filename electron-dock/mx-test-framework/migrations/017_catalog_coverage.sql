-- Preserve the testing posture declared by a repository catalog.
--
-- A pass/fail result alone cannot say that a capability was intentionally
-- unsupported, requires a human witness, or is blocked on a prerequisite.
-- These fields make those distinctions queryable instead of leaving them in a
-- README that the report and product UI cannot consume.

CREATE TABLE IF NOT EXISTS mxt_catalogs (
  app_id          text NOT NULL REFERENCES mxt_apps(id) ON DELETE CASCADE,
  catalog_file    text NOT NULL,
  schema_version  integer NOT NULL,
  application     text NOT NULL,
  surface         text,
  suite_slug      text,
  execution_mode  text,
  coverage        jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, catalog_file),
  CONSTRAINT mxt_catalogs_schema_version_check CHECK (schema_version IN (1, 2)),
  CONSTRAINT mxt_catalogs_surface_check CHECK (surface IS NULL OR surface IN ('web', 'electron')),
  CONSTRAINT mxt_catalogs_coverage_object_check CHECK (jsonb_typeof(coverage) = 'object')
);

ALTER TABLE mxt_cases
  ADD COLUMN IF NOT EXISTS coverage_mode text,
  ADD COLUMN IF NOT EXISTS automation_state text,
  ADD COLUMN IF NOT EXISTS prerequisites jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON TABLE mxt_catalogs IS
  'Repository catalog metadata and declared capability coverage, keyed by source file.';
COMMENT ON COLUMN mxt_cases.coverage_mode IS
  'How this case is covered: automated surface, manual witness, unsupported, or planned.';
COMMENT ON COLUMN mxt_cases.automation_state IS
  'Declared implementation posture; observed execution remains a separate derived fact.';
