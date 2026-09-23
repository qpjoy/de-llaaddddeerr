-- Additive, Hub-only classification evidence. No grants, checkpoints or source rows change.
CREATE TABLE IF NOT EXISTS catalog.record_classification_runs (
  id uuid PRIMARY KEY,
  record_id uuid NOT NULL REFERENCES core.canonical_records(id) ON DELETE RESTRICT,
  record_revision integer NOT NULL,
  request_key text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('running', 'proposed', 'unmatched', 'accepted', 'rejected', 'unknown')),
  entry_id uuid REFERENCES catalog.source_catalog_entries(id) ON DELETE RESTRICT,
  entry_revision integer,
  confidence double precision CHECK (confidence BETWEEN 0 AND 1),
  explanation text,
  method text NOT NULL CHECK (method IN ('rule', 'agent')),
  requested_agent boolean NOT NULL DEFAULT false,
  rule_version text NOT NULL,
  catalog_digest text NOT NULL,
  sequence_key text,
  model text,
  actor text NOT NULL,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS record_classification_record_idx
  ON catalog.record_classification_runs (record_id, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS catalog.record_catalog_bindings (
  record_id uuid PRIMARY KEY REFERENCES core.canonical_records(id) ON DELETE RESTRICT,
  record_revision integer NOT NULL,
  entry_id uuid NOT NULL REFERENCES catalog.source_catalog_entries(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL REFERENCES catalog.record_classification_runs(id) ON DELETE RESTRICT,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS record_catalog_bindings_entry_idx
  ON catalog.record_catalog_bindings (entry_id, record_id);
