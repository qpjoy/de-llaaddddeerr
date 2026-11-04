-- Private evidence only: no consumer grants or changes to source subscriptions.
CREATE TABLE catalog.rss_file_snapshots (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  origin_fingerprint text NOT NULL CHECK (origin_fingerprint ~ '^[a-f0-9]{64}$'),
  files jsonb NOT NULL,
  metadata jsonb NOT NULL,
  database_snapshot timestamptz NOT NULL,
  article_count integer NOT NULL CHECK (article_count >= 0),
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE catalog.rss_file_article_lineage (
  snapshot_id text NOT NULL REFERENCES catalog.rss_file_snapshots(id),
  item_hash text NOT NULL,
  identity_hash text NOT NULL,
  raw_hash text NOT NULL,
  raw_payload jsonb NOT NULL,
  feed_key text NOT NULL,
  external_id text NOT NULL,
  canonical_id uuid,
  feed_key_matches boolean NOT NULL,
  PRIMARY KEY (snapshot_id, identity_hash, raw_hash)
);
CREATE INDEX rss_file_article_lineage_external_idx ON catalog.rss_file_article_lineage(external_id);
COMMENT ON TABLE catalog.rss_file_snapshots IS
  'Immutable file metadata/config snapshots. Matched article payloads are preserved in private lineage rows; hashes and bindings prove coverage at database_snapshot. Does not enable fetching.';
COMMENT ON TABLE catalog.rss_file_article_lineage IS
  'Original file feed attribution verified against the selected DB article raw. Adds evidence without replacing DB identity or feed metadata.';
