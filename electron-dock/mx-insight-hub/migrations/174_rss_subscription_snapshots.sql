-- Admin-only source evidence. No grants, schedules or existing sources change.
CREATE TABLE IF NOT EXISTS catalog.rss_subscription_snapshots (
  feed_id uuid PRIMARY KEY,
  payload jsonb NOT NULL,
  import_run_id uuid NOT NULL REFERENCES ingest.import_runs(id),
  observed_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE catalog.rss_subscription_snapshots IS
  'Latest observed RSS subscription, including disabled feeds. Absence is not a deletion; inspect import run status.';

-- Source rss_item_id can be reassigned by an upstream UPSERT. Refuse such a
-- change after first observation instead of creating a second Hub identity.
CREATE TABLE IF NOT EXISTS catalog.rss_article_identities (
  canonical_id uuid PRIMARY KEY,
  external_id text NOT NULL
);
