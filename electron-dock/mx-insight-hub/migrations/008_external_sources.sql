-- P4: heterogeneous external sources (spreadsheets, text, foreign databases).
--
-- The schema question this answers: when an outside source has columns the
-- canonical model does not, do we widen the table with spare columns, or do we
-- migrate?
--
-- Neither, exactly. Three layers, each with one job:
--
--   1. `ingest.source_objects.raw_payload`  the row exactly as received, forever
--   2. `core.canonical_records.extensions`  unmapped fields, queryable as jsonb
--   3. real canonical columns                promoted deliberately, by migration
--
-- Reserved generic columns (`col_1 .. col_20`) are explicitly rejected. They
-- start as flexibility and end as a table nobody can read without a decoder
-- ring, where the meaning of `col_7` depends on which source wrote the row.
-- `extensions` gives the same flexibility while keeping the field's real name
-- attached to its value, and promoting a field to a column stays a reviewed
-- migration plus a backfill from the raw copy that layer 1 guarantees exists.

CREATE SCHEMA IF NOT EXISTS catalog;

-- A registered external source: one spreadsheet family, one upstream table, one
-- feed. Identified by a stable operator-chosen key, because a filename or a
-- table name is not stable enough to key ingest history on.
CREATE TABLE IF NOT EXISTS catalog.external_sources (
  id uuid PRIMARY KEY,
  source_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  -- 'file' (xlsx/csv/jsonl/text upload) or 'database' (pull from a foreign DSN)
  source_kind text NOT NULL CHECK (source_kind IN ('file', 'database')),
  -- Which canonical dataset these records join. Defaults to a dedicated
  -- dataset so external data never silently merges into the Night-All corpus
  -- and skews platform analytics.
  dataset_id text NOT NULL,
  platform text NOT NULL,
  object_type text NOT NULL DEFAULT 'record',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  -- Connection details for source_kind='database'. Never contains a password:
  -- credentials live in the runtime Secret and are referenced by name.
  connection jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Field mapping, versioned.
--
-- Versioning is not bookkeeping. A mapping decides how a raw field becomes a
-- canonical one, so "why does this 2026-03 row have an empty title" is only
-- answerable if the mapping in force at the time is still on record. It also
-- makes an agent-proposed mapping reviewable and revertible rather than an
-- invisible change in behaviour.
CREATE TABLE IF NOT EXISTS catalog.source_mappings (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES catalog.external_sources(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  -- { "<canonicalField>": { "from": "<column>"|[...], "type": "text|number|timestamp|boolean" } }
  field_map jsonb NOT NULL,
  -- Where the mapping came from. An LLM suggestion is recorded as such and
  -- must be confirmed before it can be applied; see `approved_at`.
  origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'agent', 'inferred')),
  agent_model text,
  agent_confidence numeric,
  notes text,
  -- An unapproved mapping is never used for ingestion. Letting a model change
  -- the shape of stored data without a human in the loop makes the data model
  -- unreproducible.
  approved_at timestamptz,
  approved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, version)
);

CREATE INDEX IF NOT EXISTS source_mappings_active_idx
  ON catalog.source_mappings (source_id, version DESC)
  WHERE approved_at IS NOT NULL;

-- One import: a file upload or a database pull.
CREATE TABLE IF NOT EXISTS ingest.import_runs (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES catalog.external_sources(id) ON DELETE CASCADE,
  mapping_version integer,
  -- Content hash of the input. Re-importing an identical file is detected here
  -- and skipped, which is cheaper than relying on per-row dedup for a
  -- 50,000-row spreadsheet somebody uploaded twice.
  input_sha256 char(64),
  input_name text,
  input_bytes bigint,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  row_count integer NOT NULL DEFAULT 0,
  ingested_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  last_error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS import_runs_source_idx
  ON ingest.import_runs (source_id, started_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS import_runs_input_idx
  ON ingest.import_runs (source_id, input_sha256)
  WHERE input_sha256 IS NOT NULL AND status = 'succeeded';

-- Rows that could not be mapped, kept with the reason.
--
-- These are evidence, not garbage. A row rejected for a missing external id is
-- how you discover that a spreadsheet gained a header row, or that an upstream
-- column was renamed. Dropping them silently is how an import "succeeds" at
-- 60% coverage and nobody notices for a month.
CREATE TABLE IF NOT EXISTS ingest.rejected_rows (
  id bigserial PRIMARY KEY,
  import_run_id uuid NOT NULL REFERENCES ingest.import_runs(id) ON DELETE CASCADE,
  row_index integer NOT NULL,
  reason text NOT NULL,
  raw_row jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rejected_rows_run_idx
  ON ingest.rejected_rows (import_run_id, row_index);
