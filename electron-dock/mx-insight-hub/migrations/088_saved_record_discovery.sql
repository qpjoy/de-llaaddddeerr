-- Metadata only. Existing sources, mappings, grants and checkpoints are untouched.
CREATE TABLE catalog.saved_record_discovery (
  pipeline_key text PRIMARY KEY,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- An automatic activation intent is committed with each newly discovered source.
-- Manual pause cancels it; rediscovery never re-enables a manually paused task.
CREATE TABLE catalog.saved_record_auto_activation (
  source_key text PRIMARY KEY REFERENCES catalog.external_sources(source_key),
  pending boolean NOT NULL DEFAULT true,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  settled_by text
);
