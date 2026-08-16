CREATE SCHEMA IF NOT EXISTS control;

-- Durable operator evidence for full search projection rebuilds. The work is
-- executed asynchronously by the Admin API, while this row remains the source
-- of truth for polling, incident review, and single-flight admission.
CREATE TABLE IF NOT EXISTS control.search_reindex_operations (
  id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  phase text NOT NULL CHECK (phase IN ('queued', 'preflight', 'content', 'chunks', 'completed', 'failed')),
  requested_by text NOT NULL,
  request_id text,
  preflight jsonb NOT NULL DEFAULT '{}'::jsonb,
  processed bigint NOT NULL DEFAULT 0 CHECK (processed >= 0),
  total bigint CHECK (total IS NULL OR total >= 0),
  progress numeric CHECK (progress IS NULL OR (progress >= 0 AND progress <= 1)),
  logs jsonb NOT NULL DEFAULT '[]'::jsonb,
  result jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  heartbeat_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS search_reindex_one_active_idx
  ON control.search_reindex_operations ((true))
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS search_reindex_operations_recent_idx
  ON control.search_reindex_operations (created_at DESC);
