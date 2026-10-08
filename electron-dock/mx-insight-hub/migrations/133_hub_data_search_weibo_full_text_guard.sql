-- Extend the existing verified-full-text guard to the original data/search
-- dataset. No history, credentials, grants, prices or customer limits change.
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';

DROP TRIGGER IF EXISTS preserve_hub_raw_weibo_full_text ON core.canonical_records;
CREATE TRIGGER preserve_hub_raw_weibo_full_text
BEFORE UPDATE ON core.canonical_records FOR EACH ROW
WHEN (OLD.dataset_id IN ('night-all.compat.v1', 'night-all.search.v1')
  AND OLD.platform = 'weibo' AND OLD.object_type = 'post'
  AND OLD.extensions #>> '{rawSearch,version}' = 'mx-insight-hub.raw-search.v1'
  AND OLD.extensions #>> '{rawSearch,bodyCompleteness}' = 'full_text')
EXECUTE FUNCTION core.preserve_hub_raw_weibo_full_text();
