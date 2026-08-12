-- A byte-identical file may produce different canonical records after either
-- the parser or its approved mapping changes. Keep the input content hash for
-- upload identity, but scope successful-run deduplication to the complete,
-- immutable interpretation that produced those records.

ALTER TABLE ingest.import_runs
  ADD COLUMN IF NOT EXISTS interpretation_key char(64)
    CHECK (interpretation_key IS NULL OR interpretation_key ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN ingest.import_runs.interpretation_key IS
  'Stable direct-file parser/mapping/format identity. NULL denotes a legacy run or a non-file import.';

-- Preserve the old contract for legacy writers that cannot supply an
-- interpretation key. A keyed writer intentionally does not match these rows,
-- so the first deployment after this migration safely re-interprets the file
-- once and all later uploads deduplicate against the keyed success.
CREATE UNIQUE INDEX IF NOT EXISTS import_runs_legacy_input_idx
  ON ingest.import_runs (source_id, input_sha256)
  WHERE input_sha256 IS NOT NULL
    AND interpretation_key IS NULL
    AND status = 'succeeded';

DROP INDEX IF EXISTS ingest.import_runs_input_idx;

CREATE UNIQUE INDEX IF NOT EXISTS import_runs_interpreted_input_idx
  ON ingest.import_runs (source_id, input_sha256, interpretation_key)
  WHERE input_sha256 IS NOT NULL
    AND interpretation_key IS NOT NULL
    AND status = 'succeeded';
