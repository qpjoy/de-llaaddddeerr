-- Hub raw-search cutover. No historical rewrite, acquisition, grants or prices.
-- Deploy migrates before API/worker rollout, also covering old ingest workers.
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION core.preserve_hub_raw_weibo_full_text()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.deleted_at IS NULL AND OLD.deleted_at IS NULL
     AND NEW.dataset_id = OLD.dataset_id AND NEW.platform = OLD.platform
     AND NEW.object_type = OLD.object_type AND NEW.external_id = OLD.external_id
     AND NEW.author_external_id IS NOT DISTINCT FROM OLD.author_external_id
     AND core.weibo_long_text_preview_of(OLD.body, NEW.body) THEN
    -- The original revision/hash is returned to the writer. Revision/outbox
    -- inserts remain no-ops, while raw receipts and observations are retained.
    OLD.last_seen_at := GREATEST(OLD.last_seen_at, NEW.last_seen_at);
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS preserve_hub_raw_weibo_full_text ON core.canonical_records;
CREATE TRIGGER preserve_hub_raw_weibo_full_text
BEFORE UPDATE ON core.canonical_records FOR EACH ROW
WHEN (OLD.dataset_id = 'night-all.compat.v1' AND OLD.platform = 'weibo'
  AND OLD.object_type = 'post'
  AND OLD.extensions #>> '{rawSearch,version}' = 'mx-insight-hub.raw-search.v1'
  AND OLD.extensions #>> '{rawSearch,bodyCompleteness}' = 'full_text')
EXECUTE FUNCTION core.preserve_hub_raw_weibo_full_text();
