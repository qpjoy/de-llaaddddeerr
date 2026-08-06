-- Track which revision produced each chunk, so staleness is detectable.
--
-- Without this, "are this record's chunks current?" is unanswerable: a record
-- whose body was edited keeps its old chunks, the embedding worker sees them as
-- already embedded, and retrieval quietly serves text that no longer exists in
-- the source. The chunk table needs to know what it was derived FROM, not just
-- that it exists.

ALTER TABLE core.record_chunks
  ADD COLUMN IF NOT EXISTS source_revision integer,
  -- The embedding itself, kept in PostgreSQL even though kNN happens in
  -- Elasticsearch. Storing it here is what makes rebuilding the search index
  -- free: a projection can be dropped and replayed without paying the model
  -- again. `real[]` rather than pgvector's `vector(N)` because N is a runtime
  -- configuration and a typed column would fix it at DDL time; nothing here
  -- needs a PostgreSQL-side ANN index.
  ADD COLUMN IF NOT EXISTS vector real[],
  -- Set when the chunk has been written to the search projection. Separate from
  -- `embedded_at` because embedding and indexing are different steps that fail
  -- independently: a vector computed but never indexed must be retried at the
  -- indexing step, not recomputed at the model's expense.
  ADD COLUMN IF NOT EXISTS projected_at timestamptz;

-- Finding work: chunks that exist but have no vector yet.
CREATE INDEX IF NOT EXISTS record_chunks_unembedded_idx
  ON core.record_chunks (record_id, chunk_index)
  WHERE embedded_at IS NULL;

-- Finding work: chunks embedded but not yet in the search index.
CREATE INDEX IF NOT EXISTS record_chunks_unprojected_idx
  ON core.record_chunks (embedded_at)
  WHERE embedded_at IS NOT NULL AND projected_at IS NULL;

-- Finding stale chunks after a record's content changed.
CREATE INDEX IF NOT EXISTS record_chunks_revision_idx
  ON core.record_chunks (record_id, source_revision);

-- Records whose text has never been chunked, or was chunked from an older
-- revision. This is the embedding pipeline's work queue, expressed as a view so
-- the worker's claim query stays readable and the definition of "needs work"
-- lives in one place.
CREATE OR REPLACE VIEW core.records_needing_chunks AS
SELECT r.id,
       r.dataset_id,
       r.platform,
       r.external_id,
       r.url,
       r.title,
       r.body,
       r.event_time,
       r.current_revision
  FROM core.canonical_records r
  LEFT JOIN LATERAL (
    SELECT max(c.source_revision) AS chunked_revision
      FROM core.record_chunks c
     WHERE c.record_id = r.id
  ) c ON true
 WHERE r.deleted_at IS NULL
   -- Only records with text worth retrieving. A row whose entire content is a
   -- title of a few characters produces a chunk that matches everything and
   -- discriminates nothing.
   AND coalesce(length(r.body), 0) + coalesce(length(r.title), 0) >= 24
   AND (c.chunked_revision IS NULL OR c.chunked_revision < r.current_revision);
