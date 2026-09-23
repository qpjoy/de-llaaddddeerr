\set ON_ERROR_STOP on

-- Optional Hub-only online indexes. Inspect existing definitions and query plans
-- first; run separately from migrations, never in a transaction or on the source DB.
-- No existing index, source data, authorization or checkpoint is changed.
SET lock_timeout = '2s';
SET statement_timeout = '30min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS canonical_news_collected_feed_idx
  ON core.canonical_records (platform, collected_at DESC, id DESC)
  WHERE deleted_at IS NULL AND content_type IN ('news', 'news.article', 'news.resolved', 'bbc.article');

CREATE INDEX CONCURRENTLY IF NOT EXISTS canonical_news_published_feed_idx
  ON core.canonical_records (platform, event_time DESC, id DESC)
  WHERE deleted_at IS NULL AND content_type IN ('news', 'news.article', 'news.resolved', 'bbc.article');

-- IF NOT EXISTS is not a definition/validity proof. Inspect results after execution;
-- resolve an invalid or conflicting prior index explicitly instead of deleting it.
SELECT indexrelid::regclass AS index_name, indisvalid, indisready, pg_get_indexdef(indexrelid)
  FROM pg_index
 WHERE indexrelid IN (to_regclass('core.canonical_news_collected_feed_idx'),
                      to_regclass('core.canonical_news_published_feed_idx'));
