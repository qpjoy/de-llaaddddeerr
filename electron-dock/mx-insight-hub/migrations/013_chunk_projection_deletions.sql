-- Durable delete propagation for the semantic chunk projection.
--
-- PostgreSQL owns the authoritative chunk set, but removing a row there does
-- not remove the corresponding Elasticsearch document.  Keep the document id
-- and source revision until the embedding worker has acknowledged the delete;
-- a later revision of the same document id resets projected_at and supersedes
-- an older pending or delivered tombstone.

CREATE TABLE IF NOT EXISTS core.chunk_projection_deletes (
  document_id text PRIMARY KEY,
  record_id uuid NOT NULL,
  source_revision bigint NOT NULL CHECK (source_revision > 0),
  projected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chunk_projection_deletes_pending_idx
  ON core.chunk_projection_deletes (updated_at, document_id)
  WHERE projected_at IS NULL;
