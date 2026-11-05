-- Twitter username/email dictionary (data product "Twitter 用户邮箱").
--
-- PostgreSQL only: rows never enter canonical_records, the outbox, the
-- Elasticsearch projection, HanLP or embeddings. This migration creates only
-- the small control tables. The dictionary worker creates each version's
-- hash-partitioned staging and mapping tables (mappings_v<N>) and builds their
-- indexes outside the startup migration, so deploys stay fast.
CREATE SCHEMA IF NOT EXISTS account_dictionary;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS account_dictionary.datasets (
  dataset_key text PRIMARY KEY CHECK (dataset_key ~ '^[a-z][a-z0-9-]{1,62}$'),
  display_name text NOT NULL CHECK (display_name <> ''),
  owner text,
  purpose text,
  legal_basis text,
  -- Operator-selected source for the next run: a server-file root ID plus a
  -- relative path. Absolute host paths stay in runtime configuration only.
  source_root_id text,
  source_relative_path text,
  expected_sha256 text CHECK (expected_sha256 IS NULL OR expected_sha256 ~ '^[0-9a-f]{64}$'),
  active_version_id integer,
  previous_version_id integer,
  revision integer NOT NULL DEFAULT 0,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_dictionary.versions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dataset_key text NOT NULL REFERENCES account_dictionary.datasets(dataset_key),
  stage text NOT NULL DEFAULT 'pending' CHECK (stage IN (
    'pending', 'verifying', 'importing', 'building', 'validating', 'ready',
    'published', 'retired', 'discarded'
  )),
  desired_state text NOT NULL DEFAULT 'running' CHECK (desired_state IN ('running', 'paused', 'discard')),
  run_state text NOT NULL DEFAULT 'waiting' CHECK (run_state IN ('waiting', 'running', 'paused', 'failed', 'done')),
  source_root_id text NOT NULL,
  source_relative_path text NOT NULL,
  source_filename text NOT NULL,
  source_bytes bigint NOT NULL CHECK (source_bytes > 0),
  -- dev:ino and mtime in nanoseconds; a resumed run refuses a changed file.
  source_identity text NOT NULL,
  source_mtime_ns text NOT NULL,
  expected_sha256 text CHECK (expected_sha256 IS NULL OR expected_sha256 ~ '^[0-9a-f]{64}$'),
  source_sha256 text CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  sha_bytes bigint NOT NULL DEFAULT 0,
  parser_version text NOT NULL,
  partition_count smallint NOT NULL DEFAULT 16 CHECK (partition_count BETWEEN 1 AND 64),
  -- Durable import checkpoint, committed with each batch.
  byte_offset bigint NOT NULL DEFAULT 0,
  parser_state text NOT NULL DEFAULT 'start' CHECK (parser_state IN ('start', 'after_pair', 'end')),
  pairs_read bigint NOT NULL DEFAULT 0,
  pairs_loaded bigint NOT NULL DEFAULT 0,
  pairs_quarantined bigint NOT NULL DEFAULT 0,
  quarantine_reasons jsonb NOT NULL DEFAULT '{}'::jsonb,
  unique_mappings bigint,
  duplicate_pairs bigint,
  sample_rows bigint,
  table_bytes bigint,
  index_bytes bigint,
  recent_rows_per_second numeric(12, 1),
  error_code text,
  error_message text,
  worker_id text,
  heartbeat_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  imported_at timestamptz,
  ready_at timestamptz,
  published_at timestamptz,
  retired_at timestamptz,
  -- Set once a retired version's tables have been dropped.
  data_dropped_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- At most one unpublished version per dataset, including one awaiting publish.
CREATE UNIQUE INDEX IF NOT EXISTS account_dictionary_versions_one_open
  ON account_dictionary.versions (dataset_key)
  WHERE stage NOT IN ('published', 'retired', 'discarded');

ALTER TABLE account_dictionary.datasets
  ADD CONSTRAINT account_dictionary_datasets_active_fk
    FOREIGN KEY (active_version_id) REFERENCES account_dictionary.versions(id),
  ADD CONSTRAINT account_dictionary_datasets_previous_fk
    FOREIGN KEY (previous_version_id) REFERENCES account_dictionary.versions(id);

CREATE TABLE IF NOT EXISTS account_dictionary.version_partitions (
  version_id integer NOT NULL REFERENCES account_dictionary.versions(id),
  partition_no smallint NOT NULL CHECK (partition_no >= 0),
  step text NOT NULL DEFAULT 'staged' CHECK (step IN ('staged', 'deduplicated', 'indexed', 'attached')),
  staged_rows bigint,
  unique_rows bigint,
  sample_rows bigint,
  table_bytes bigint,
  index_bytes bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version_id, partition_no)
);

-- Lower-cased e-mail domains, shared by all versions (append-only).
CREATE TABLE IF NOT EXISTS account_dictionary.domains (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (name <> '')
);

-- Sampled trigram frequencies for the query cost precheck. One row set per
-- partition keeps a re-run of an interrupted partition step idempotent.
CREATE TABLE IF NOT EXISTS account_dictionary.trigram_stats (
  version_id integer NOT NULL REFERENCES account_dictionary.versions(id),
  field char(1) NOT NULL CHECK (field IN ('u', 'l')),
  trigram text NOT NULL,
  partition_no smallint NOT NULL,
  sample_count integer NOT NULL CHECK (sample_count > 0),
  PRIMARY KEY (version_id, field, trigram, partition_no)
);

-- Rejected source pairs, retained as bytes so invalid text can be reviewed.
CREATE TABLE IF NOT EXISTS account_dictionary.quarantine (
  version_id integer NOT NULL REFERENCES account_dictionary.versions(id),
  ordinal bigint NOT NULL,
  reason text NOT NULL,
  key_raw bytea,
  value_raw bytea,
  PRIMARY KEY (version_id, ordinal)
);

-- Access audit. The query itself is stored only as an HMAC.
CREATE TABLE IF NOT EXISTS account_dictionary.access_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dataset_key text NOT NULL,
  version_id integer,
  tenant_id uuid,
  consumer_id uuid,
  api_key_id uuid,
  mode text NOT NULL,
  field text,
  query_hmac text NOT NULL,
  outcome text NOT NULL,
  result_count integer NOT NULL DEFAULT 0,
  revealed_count integer NOT NULL DEFAULT 0,
  took_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_dictionary_access_events_recent
  ON account_dictionary.access_events (dataset_key, created_at DESC);

INSERT INTO account_dictionary.datasets (dataset_key, display_name, purpose, expected_sha256)
VALUES (
  'twitter-user-email',
  'Twitter 用户邮箱',
  '内部授权查询：Twitter 用户名与邮箱的来源文件关联',
  'c63812d32bbd144f210647d3ade3ef7d475e407158e96858b5669ba51555ebda'
)
ON CONFLICT (dataset_key) DO NOTHING;
