-- Durable topic-insight report tasks.
--
-- Reports are derived only from PostgreSQL canonical truth. Elasticsearch and
-- HanLP remain optional serving accelerators and are deliberately absent from
-- this workflow, so creating a report never starts or requires a full index
-- rebuild. Public tasks retain the exact platform-grant snapshot admitted at
-- creation time; Admin-created tasks use the same provider-neutral platform
-- identifiers with nullable customer ownership.

CREATE SCHEMA IF NOT EXISTS insights;

CREATE TABLE IF NOT EXISTS insights.topic_reports (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT,
  consumer_id uuid REFERENCES consumers(id) ON DELETE RESTRICT,
  api_key_id uuid REFERENCES api_keys(id) ON DELETE RESTRICT,
  created_by text NOT NULL,
  topic text NOT NULL CHECK (char_length(topic) BETWEEN 2 AND 300),
  language text NOT NULL CHECK (language IN ('zh-CN', 'en')),
  range_start timestamptz NOT NULL,
  range_end timestamptz NOT NULL,
  source_scope text NOT NULL CHECK (source_scope IN ('all_granted', 'selected')),
  authorized_platforms text[] NOT NULL,
  sample_limit integer NOT NULL DEFAULT 240 CHECK (sample_limit BETWEEN 20 AND 500),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  phase text NOT NULL DEFAULT 'queued'
    CHECK (phase IN ('queued', 'selecting_evidence', 'building_associations', 'complete', 'failed')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  locked_by text,
  leased_until timestamptz,
  result jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (range_start < range_end),
  CHECK (cardinality(authorized_platforms) BETWEEN 1 AND 13),
  CHECK (
    (tenant_id IS NULL AND consumer_id IS NULL AND api_key_id IS NULL)
    OR (tenant_id IS NOT NULL AND consumer_id IS NOT NULL AND api_key_id IS NOT NULL)
  ),
  CHECK (result IS NULL OR jsonb_typeof(result) = 'object')
);

CREATE INDEX IF NOT EXISTS topic_reports_claim_idx
  ON insights.topic_reports (created_at, id)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS topic_reports_lease_idx
  ON insights.topic_reports (leased_until)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS topic_reports_admin_feed_idx
  ON insights.topic_reports (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS topic_reports_consumer_feed_idx
  ON insights.topic_reports (consumer_id, created_at DESC, id DESC)
  WHERE consumer_id IS NOT NULL;

COMMENT ON TABLE insights.topic_reports IS
  'Durable, tenant-scoped topic insight tasks derived from public-safe PostgreSQL canonical records.';

COMMENT ON COLUMN insights.topic_reports.authorized_platforms IS
  'Immutable provider-neutral platform grant snapshot captured when the task is created.';

COMMENT ON COLUMN insights.topic_reports.result IS
  'Allowlisted report projection containing aggregates, associations and bounded canonical evidence; no raw payload or connector lineage.';
