-- Hub-owned, recoverable Agent analysis pipelines.
--
-- The first pipeline classifies the geography of the fixed nationwide public-
-- opinion corpus. Event province, publisher province and geographic scope are
-- separate assertions. Agent output is append-only evidence; it never writes
-- upstream rows, canonical admin1_code, source checkpoints, grants or search
-- indexes directly.

CREATE SCHEMA IF NOT EXISTS agent_center;

-- `source_objects` is the current raw state. This append-only companion keeps
-- every distinct upstream payload so delayed Agent work remains reproducible
-- even when a newer source update arrives before it is processed.
ALTER TABLE ingest.source_objects
  ADD COLUMN IF NOT EXISTS current_revision integer NOT NULL DEFAULT 1
    CHECK (current_revision > 0);

-- Version 0 means the pre-034 payload_sha256 was a canonical/content hash.
-- The first post-034 pull compares JSONB payloads directly before adopting the
-- semantic-raw hash, so an unchanged legacy row is not manufactured as rev 2.
ALTER TABLE ingest.source_objects
  ADD COLUMN IF NOT EXISTS raw_payload_hash_version smallint NOT NULL DEFAULT 0
    CHECK (raw_payload_hash_version IN (0, 1));

CREATE TABLE IF NOT EXISTS ingest.source_object_revisions (
  id bigserial PRIMARY KEY,
  source_object_id uuid NOT NULL
    REFERENCES ingest.source_objects(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  payload_sha256 char(64) NOT NULL,
  payload_hash_version smallint NOT NULL DEFAULT 1
    CHECK (payload_hash_version IN (0, 1)),
  raw_payload jsonb NOT NULL,
  source_updated_at timestamptz,
  ingest_run_id uuid REFERENCES ingest.ingest_runs(id) ON DELETE SET NULL,
  external_import_run_id uuid REFERENCES ingest.import_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_object_id, revision)
);

CREATE INDEX IF NOT EXISTS source_object_revisions_payload_idx
  ON ingest.source_object_revisions (source_object_id, payload_sha256, revision DESC);

-- Existing rows predate a separately computed raw hash. Preserve their latest
-- payload under the existing digest; the next changed pull writes an exact raw
-- digest and revision 2. No historical payload is invented.
INSERT INTO ingest.source_object_revisions
  (source_object_id, revision, payload_sha256, payload_hash_version, raw_payload,
   source_updated_at, ingest_run_id, external_import_run_id)
SELECT
  id, current_revision, payload_sha256, 0, raw_payload,
  source_updated_at, ingest_run_id, external_import_run_id
FROM ingest.source_objects
WHERE raw_payload IS NOT NULL
ON CONFLICT (source_object_id, revision) DO NOTHING;

CREATE TABLE IF NOT EXISTS control.agent_analysis_pipelines (
  pipeline_key text PRIMARY KEY,
  display_name text NOT NULL,
  task_type text NOT NULL,
  status text NOT NULL DEFAULT 'paused'
    CHECK (status IN ('active', 'paused')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  analysis_version text NOT NULL,
  taxonomy_version text NOT NULL,
  rule_version text NOT NULL,
  prompt_version text NOT NULL,
  -- Global dispatch rate. Together with max_in_flight=1 this protects model,
  -- database and downstream indexing services even if several worker replicas
  -- are accidentally started.
  items_per_minute integer NOT NULL DEFAULT 12
    CHECK (items_per_minute BETWEEN 1 AND 60),
  max_in_flight integer NOT NULL DEFAULT 1
    CHECK (max_in_flight = 1),
  next_dispatch_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_center.analysis_tasks (
  id bigserial PRIMARY KEY,
  pipeline_key text NOT NULL
    REFERENCES control.agent_analysis_pipelines(pipeline_key) ON DELETE RESTRICT,
  record_id uuid NOT NULL
    REFERENCES core.canonical_records(id) ON DELETE RESTRICT,
  source_object_revision_id bigint NOT NULL
    REFERENCES ingest.source_object_revisions(id) ON DELETE RESTRICT,
  canonical_revision integer NOT NULL CHECK (canonical_revision > 0),
  input_sha256 char(64) NOT NULL,
  analysis_version text NOT NULL,
  taxonomy_version text NOT NULL,
  rule_version text NOT NULL,
  prompt_version text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'dead', 'superseded')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  claim_generation bigint NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  locked_by text,
  leased_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  provider_id text,
  model text,
  last_error_code text,
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (
    pipeline_key, record_id, source_object_revision_id,
    canonical_revision, analysis_version
  )
);

CREATE INDEX IF NOT EXISTS agent_analysis_tasks_dispatch_idx
  ON agent_center.analysis_tasks
    (pipeline_key, status, next_attempt_at, created_at, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS agent_analysis_tasks_lease_idx
  ON agent_center.analysis_tasks (leased_until)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS agent_analysis_tasks_record_idx
  ON agent_center.analysis_tasks (record_id, source_object_revision_id DESC, id DESC);

CREATE TABLE IF NOT EXISTS agent_center.classification_assertions (
  assertion_id uuid PRIMARY KEY,
  task_id bigint NOT NULL
    REFERENCES agent_center.analysis_tasks(id) ON DELETE RESTRICT,
  pipeline_key text NOT NULL,
  record_id uuid NOT NULL,
  source_object_revision_id bigint NOT NULL,
  canonical_revision integer NOT NULL CHECK (canonical_revision > 0),
  input_sha256 char(64) NOT NULL,
  field_key text NOT NULL,
  proposed_value jsonb NOT NULL,
  method text NOT NULL CHECK (method IN ('source', 'rule', 'agent', 'manual')),
  confidence numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_refs) = 'array'),
  taxonomy_version text NOT NULL,
  rule_version text,
  provider_id text,
  model text,
  prompt_version text,
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'accepted', 'rejected', 'superseded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by text,
  FOREIGN KEY (record_id) REFERENCES core.canonical_records(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_object_revision_id)
    REFERENCES ingest.source_object_revisions(id) ON DELETE RESTRICT,
  UNIQUE (task_id, field_key, method)
);

CREATE INDEX IF NOT EXISTS agent_classification_assertions_review_idx
  ON agent_center.classification_assertions
    (pipeline_key, status, created_at DESC, assertion_id);

CREATE INDEX IF NOT EXISTS agent_classification_assertions_record_idx
  ON agent_center.classification_assertions
    (record_id, source_object_revision_id DESC, created_at DESC);

INSERT INTO control.agent_analysis_pipelines
  (pipeline_key, display_name, task_type, status, analysis_version,
   taxonomy_version, rule_version, prompt_version, items_per_minute,
   max_in_flight, updated_by)
VALUES
  ('province-geography-v1', '全国省份舆情地理分类', 'record.classification',
   'paused', 'province-geography.v1', 'cn-geography.v1',
   'province-evidence.2026-08', 'province-analysis.v1', 12, 1, 'migration-034')
ON CONFLICT (pipeline_key) DO NOTHING;

-- Existing current raw rows become a paused backlog. Activation is an explicit
-- Admin action, so applying the migration never starts Agent or HanLP calls.
INSERT INTO agent_center.analysis_tasks
  (pipeline_key, record_id, source_object_revision_id, canonical_revision,
   input_sha256, analysis_version, taxonomy_version, rule_version, prompt_version)
SELECT
  pipeline.pipeline_key,
  record.id,
  source_revision.id,
  record.current_revision,
  source_revision.payload_sha256,
  pipeline.analysis_version,
  pipeline.taxonomy_version,
  pipeline.rule_version,
  pipeline.prompt_version
FROM control.agent_analysis_pipelines pipeline
JOIN core.canonical_records record
  ON record.dataset_id = 'public-opinion.province.v1'
JOIN ingest.source_objects source_object
  ON source_object.connector_id = 'external:province-opinion-results'
 AND source_object.object_type = record.object_type
 AND source_object.source_key = record.external_id
JOIN ingest.source_object_revisions source_revision
  ON source_revision.source_object_id = source_object.id
 AND source_revision.revision = source_object.current_revision
WHERE pipeline.pipeline_key = 'province-geography-v1'
ON CONFLICT (
  pipeline_key, record_id, source_object_revision_id,
  canonical_revision, analysis_version
)
DO NOTHING;

COMMENT ON TABLE agent_center.classification_assertions IS
  'Append-only, source-revision-anchored Agent/rule evidence. Agent proposals never mutate canonical or upstream facts.';
