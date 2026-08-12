-- Server-side files remain immutable source evidence while their structure is
-- catalogued independently from any one path.  An absolute host path is never
-- stored: observations use an operator-configured root id plus a normalized
-- relative path.

-- Older browser-upload sources predate the explicit file-mode contract and
-- stored an empty object.  Preserve their behaviour while bringing returned
-- records onto the current response schema.
UPDATE catalog.external_sources
   SET connection = jsonb_build_object('fileMode', 'upload'),
       updated_at = now()
 WHERE source_kind = 'file'
   AND connection = '{}'::jsonb;

CREATE TABLE IF NOT EXISTS catalog.file_format_rules (
  id uuid PRIMARY KEY,
  rule_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  dataset_id text NOT NULL,
  platform text NOT NULL,
  object_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog.file_format_rule_versions (
  id uuid PRIMARY KEY,
  rule_id uuid NOT NULL REFERENCES catalog.file_format_rules(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  schema_fingerprint char(64) NOT NULL
    CHECK (schema_fingerprint ~ '^[0-9a-f]{64}$'),
  parser_family text NOT NULL,
  input_format text NOT NULL,
  file_structure jsonb NOT NULL CHECK (jsonb_typeof(file_structure) = 'object'),
  field_map jsonb NOT NULL CHECK (jsonb_typeof(field_map) = 'object'),
  origin text NOT NULL DEFAULT 'manual'
    CHECK (origin IN ('manual', 'agent', 'inferred')),
  agent_model text,
  agent_confidence numeric CHECK (
    agent_confidence IS NULL OR agent_confidence BETWEEN 0 AND 1
  ),
  approved_at timestamptz NOT NULL,
  approved_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, version)
);

CREATE INDEX IF NOT EXISTS file_format_rule_match_idx
  ON catalog.file_format_rule_versions (schema_fingerprint, approved_at DESC);

CREATE INDEX IF NOT EXISTS file_format_rules_scope_idx
  ON catalog.file_format_rules (dataset_id, platform, object_type);

ALTER TABLE catalog.source_mappings
  ADD COLUMN IF NOT EXISTS schema_fingerprint char(64)
    CHECK (schema_fingerprint IS NULL OR schema_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS file_structure jsonb,
  ADD COLUMN IF NOT EXISTS format_rule_version_id uuid
    REFERENCES catalog.file_format_rule_versions(id);

ALTER TABLE catalog.source_mappings
  DROP CONSTRAINT IF EXISTS source_mappings_origin_check;

ALTER TABLE catalog.source_mappings
  DROP CONSTRAINT IF EXISTS source_mappings_file_structure_check;

ALTER TABLE catalog.source_mappings
  ADD CONSTRAINT source_mappings_origin_check
  CHECK (origin IN ('manual', 'agent', 'inferred', 'format_rule'));

ALTER TABLE catalog.source_mappings
  ADD CONSTRAINT source_mappings_file_structure_check CHECK (
    (schema_fingerprint IS NULL AND file_structure IS NULL AND format_rule_version_id IS NULL)
    OR (
      schema_fingerprint IS NOT NULL
      AND file_structure IS NOT NULL
      AND jsonb_typeof(file_structure) = 'object'
    )
  );

CREATE TABLE IF NOT EXISTS ingest.file_observations (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES catalog.external_sources(id) ON DELETE CASCADE,
  root_id text NOT NULL
    CHECK (root_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  relative_path text NOT NULL CHECK (
    length(relative_path) BETWEEN 1 AND 4096
    AND relative_path !~ '(^/|(^|/)\.\.(/|$))'
    AND position(E'\\' in relative_path) = 0
  ),
  path_hash char(64) NOT NULL CHECK (path_hash ~ '^[0-9a-f]{64}$'),
  input_sha256 char(64) NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  input_bytes bigint NOT NULL CHECK (input_bytes > 0),
  source_mtime timestamptz NOT NULL,
  schema_fingerprint char(64)
    CHECK (schema_fingerprint IS NULL OR schema_fingerprint ~ '^[0-9a-f]{64}$'),
  format_rule_version_id uuid REFERENCES catalog.file_format_rule_versions(id),
  import_run_id uuid REFERENCES ingest.import_runs(id),
  status text NOT NULL CHECK (status IN ('previewed', 'imported')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CHECK (format_rule_version_id IS NULL OR schema_fingerprint IS NOT NULL),
  UNIQUE (source_id, root_id, relative_path, input_sha256)
);

CREATE INDEX IF NOT EXISTS file_observations_source_idx
  ON ingest.file_observations (source_id, last_seen_at DESC);

COMMENT ON TABLE catalog.file_format_rules IS
  'Logical rules shared by files with the same structure inside one dataset/platform/object-type scope.';
COMMENT ON TABLE ingest.file_observations IS
  'Content-addressed server-file evidence. Absolute host paths are deliberately not persisted.';
