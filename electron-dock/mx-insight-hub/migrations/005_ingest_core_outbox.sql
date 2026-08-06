-- P1: authoritative ingest/canonical/outbox tables.
-- Implements ADR-0005 (PostgreSQL authoritative, rebuildable projections) and
-- ADR-0006 (source identity, idempotent ingestion, independent checkpoints).
--
-- Deliberate first-stage scope:
--   * raw payloads live in PG (`raw_payload`) with `raw_uri` reserved for the
--     S3-compatible object store; once that exists, backfill `raw_uri` and drop
--     the inline copy. Field design already matches the target state.
--   * no PostGIS: the runtime image is postgres:16-bookworm. Latitude/longitude
--     and admin codes are stored as plain redundant columns per §3.5; the
--     geography(Point,4326) column is added when PostGIS is available, and
--     spatial predicates must use that column rather than these.
--   * outbox rows are written but not yet consumed; the projector arrives in P2.

CREATE SCHEMA IF NOT EXISTS ingest;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS outbox;

-- One replayable ingest unit. In P1 a run is a single successful upstream search.
CREATE TABLE IF NOT EXISTS ingest.ingest_runs (
  id uuid PRIMARY KEY,
  connector_id text NOT NULL,
  stream_id text NOT NULL,
  trigger text NOT NULL,
  request_id uuid,
  query_fingerprint char(64),
  item_count integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS ingest_runs_stream_idx
  ON ingest.ingest_runs (connector_id, stream_id, started_at DESC);

-- Raw upstream object as delivered, before Hub normalization or redaction.
CREATE TABLE IF NOT EXISTS ingest.source_objects (
  id uuid PRIMARY KEY,
  connector_id text NOT NULL,
  stream_id text NOT NULL,
  object_type text NOT NULL,
  source_key text NOT NULL,
  source_version text,
  payload_sha256 char(64) NOT NULL,
  raw_payload jsonb,
  raw_uri text,
  source_updated_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ingest_run_id uuid REFERENCES ingest.ingest_runs(id) ON DELETE SET NULL,
  UNIQUE (connector_id, stream_id, object_type, source_key)
);

-- Current normalized business object. Uniqueness here is the dedup truth
-- (ADR-0006): never ES _id, never "platform + user + time".
CREATE TABLE IF NOT EXISTS core.canonical_records (
  id uuid PRIMARY KEY,
  dataset_id text NOT NULL,
  platform text NOT NULL,
  object_type text NOT NULL,
  external_id text NOT NULL,
  identity_hash char(64),
  schema_version text NOT NULL,
  -- Hash of the current revision's upstream payload. Lets an upsert decide in
  -- one statement whether content actually changed, so an unchanged re-crawl
  -- does not create a revision or re-emit a projection event.
  payload_sha256 char(64),
  content_type text,
  url text,
  title text,
  body text,
  author_external_id text,
  author_name text,
  event_time timestamptz,
  collected_at timestamptz,
  latitude double precision,
  longitude double precision,
  country_code text,
  admin1_code text,
  admin2_code text,
  stable_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  extensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  projection_revision bigint NOT NULL DEFAULT 1 CHECK (projection_revision > 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (dataset_id, platform, object_type, external_id)
);

CREATE INDEX IF NOT EXISTS canonical_records_feed_idx
  ON core.canonical_records (dataset_id, platform, event_time DESC, id DESC);

CREATE INDEX IF NOT EXISTS canonical_records_author_idx
  ON core.canonical_records (dataset_id, platform, author_external_id)
  WHERE author_external_id IS NOT NULL;

-- Content history. A changed payload adds a revision instead of overwriting,
-- so historical dashboards stay reproducible and parsers can be replayed.
CREATE TABLE IF NOT EXISTS core.record_revisions (
  record_id uuid NOT NULL REFERENCES core.canonical_records(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  payload_sha256 char(64) NOT NULL,
  normalized_payload jsonb NOT NULL,
  raw_uri text,
  parser_version text NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  ingest_run_id uuid REFERENCES ingest.ingest_runs(id) ON DELETE SET NULL,
  PRIMARY KEY (record_id, revision)
);

-- Every sighting of a record. Re-crawling the same post keeps its metric
-- history and collection lineage instead of being discarded as a duplicate.
CREATE TABLE IF NOT EXISTS core.observations (
  id uuid PRIMARY KEY,
  record_id uuid NOT NULL REFERENCES core.canonical_records(id) ON DELETE CASCADE,
  connector_id text NOT NULL,
  source_event_id text,
  query_fingerprint char(64),
  observed_at timestamptz NOT NULL DEFAULT now(),
  rank integer,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  observation_hash char(64) NOT NULL,
  ingest_run_id uuid REFERENCES ingest.ingest_runs(id) ON DELETE SET NULL,
  UNIQUE (record_id, observation_hash)
);

CREATE INDEX IF NOT EXISTS observations_record_idx
  ON core.observations (record_id, observed_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS observations_source_event_idx
  ON core.observations (connector_id, source_event_id)
  WHERE source_event_id IS NOT NULL;

-- Transactional outbox. Written in the same transaction as the canonical
-- upsert; the projector consumes it asynchronously. Application dual-write to
-- Elasticsearch is forbidden.
CREATE TABLE IF NOT EXISTS outbox.projection_events (
  id bigserial PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('upsert', 'delete')),
  projection_revision bigint NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE INDEX IF NOT EXISTS projection_events_pending_idx
  ON outbox.projection_events (id)
  WHERE status = 'pending';

-- One event per aggregate revision: repeated ingestion of unchanged content is
-- absorbed here rather than queueing redundant projection work.
CREATE UNIQUE INDEX IF NOT EXISTS projection_events_revision_idx
  ON outbox.projection_events (aggregate_id, projection_revision);
