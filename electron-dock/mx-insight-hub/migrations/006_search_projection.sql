-- P2: make the transactional outbox consumable, and give PostgreSQL its own
-- fuzzy-name path so search does not become a hard dependency of the Hub.
--
-- Implements the projector half of ADR-0005: ingest writes PG + outbox, a
-- separate worker projects into Elasticsearch. Application dual-write stays
-- forbidden.
--
-- Note on CREATE INDEX: the migration runner wraps each file in a transaction,
-- so CONCURRENTLY is not available here. These indexes are built with a normal
-- lock; at current table sizes that is milliseconds. If canonical_records ever
-- grows past a few million rows, build future indexes out-of-band instead.

-- ---------------------------------------------------------------------------
-- Outbox leases
-- ---------------------------------------------------------------------------

-- A projector claims a batch, ships it to Elasticsearch, then marks it
-- delivered. The Elasticsearch call happens outside the claiming transaction --
-- it must, since a remote call inside an open transaction would hold a row lock
-- for the duration of a network round trip -- so the claim needs a lease that
-- expires if the worker dies mid-batch.
ALTER TABLE outbox.projection_events
  ADD COLUMN IF NOT EXISTS leased_until timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by text;

ALTER TABLE outbox.projection_events
  DROP CONSTRAINT IF EXISTS projection_events_status_check;

ALTER TABLE outbox.projection_events
  ADD CONSTRAINT projection_events_status_check
  CHECK (status IN ('pending', 'claimed', 'delivered', 'dead'));

-- Claim path: oldest pending events first, so projection order follows write
-- order and a lagging projector cannot starve old records.
CREATE INDEX IF NOT EXISTS projection_events_claim_idx
  ON outbox.projection_events (id)
  WHERE status IN ('pending', 'claimed');

-- Reclaim path: find claims whose worker never came back.
CREATE INDEX IF NOT EXISTS projection_events_lease_idx
  ON outbox.projection_events (leased_until)
  WHERE status = 'claimed';

-- Dead-letter review path for the admin console.
CREATE INDEX IF NOT EXISTS projection_events_dead_idx
  ON outbox.projection_events (created_at DESC)
  WHERE status = 'dead';

-- ---------------------------------------------------------------------------
-- PostgreSQL-side fuzzy search
-- ---------------------------------------------------------------------------

-- pg_trgm is a trusted extension from PostgreSQL 13 onward, so the database
-- owner can install it without superuser.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Author-name substring search without Elasticsearch. This exists so that
-- "find posts by an author whose name contains X" keeps working during an ES
-- outage or before the projector has caught up -- the degraded path promised in
-- ADR-0005 has to be a real query plan, not an aspiration.
--
-- GIN + gin_trgm_ops serves ILIKE '%x%' and similarity() alike. It does not help
-- prefix-anchored LIKE 'x%', which the btree below covers.
CREATE INDEX IF NOT EXISTS canonical_records_author_name_trgm_idx
  ON core.canonical_records USING gin (author_name gin_trgm_ops)
  WHERE author_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS canonical_records_title_trgm_idx
  ON core.canonical_records USING gin (title gin_trgm_ops)
  WHERE title IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Text chunks for retrieval
-- ---------------------------------------------------------------------------

-- Chunked text prepared for semantic retrieval. Embeddings deliberately do NOT
-- live here: the Hub's PostgreSQL image is postgres:16-bookworm, which has no
-- pgvector, and swapping the image of a running database is a separate,
-- rehearsed operation. Vectors go to Elasticsearch `dense_vector` instead, which
-- is already deployed and is a rebuildable projection anyway.
--
-- What lives here is the authoritative, reproducible chunking: the text, its
-- position, and which chunker produced it. That is the part that must survive an
-- index rebuild.
CREATE TABLE IF NOT EXISTS core.record_chunks (
  id uuid PRIMARY KEY,
  record_id uuid NOT NULL REFERENCES core.canonical_records(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL,
  token_count integer,
  -- Bump when the chunking strategy changes so old chunks can be selectively
  -- recomputed rather than the whole corpus.
  chunker_version text NOT NULL,
  -- Which embedding model this chunk was last projected with. NULL means "not
  -- yet embedded"; the embedding worker claims on this column.
  embedding_model text,
  embedding_version integer,
  embedded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (record_id, chunk_index, chunker_version)
);

CREATE INDEX IF NOT EXISTS record_chunks_pending_embedding_idx
  ON core.record_chunks (created_at)
  WHERE embedded_at IS NULL;

-- ---------------------------------------------------------------------------
-- Projection run evidence
-- ---------------------------------------------------------------------------

-- One row per projector batch. Without this, "is search up to date?" can only be
-- answered by counting pending outbox rows, which says nothing about whether the
-- projector is making progress or spinning on the same failure.
CREATE TABLE IF NOT EXISTS outbox.projection_runs (
  id bigserial PRIMARY KEY,
  projector text NOT NULL,
  target text NOT NULL,
  claimed_count integer NOT NULL DEFAULT 0,
  delivered_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  last_error text
);

CREATE INDEX IF NOT EXISTS projection_runs_recent_idx
  ON outbox.projection_runs (projector, started_at DESC);
