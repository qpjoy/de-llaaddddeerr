-- Forward-only guard change; no corpus rewrite, provider calls or replay changes.
-- New workers select summary/detail independently under the identity lock and
-- compute the canonical hash before upsert. Older workers cannot downgrade it.
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION core.preserve_hub_raw_weibo_full_text()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.deleted_at IS NOT NULL OR OLD.deleted_at IS NOT NULL
     OR NEW.dataset_id IS DISTINCT FROM OLD.dataset_id
     OR NEW.platform IS DISTINCT FROM OLD.platform
     OR NEW.object_type IS DISTINCT FROM OLD.object_type
     OR NEW.external_id IS DISTINCT FROM OLD.external_id
     OR NEW.author_external_id IS DISTINCT FROM OLD.author_external_id THEN
    RETURN NEW;
  END IF;

  -- New worker output has already selected the newest complete detail, even
  -- when the author edited it into a shorter/different body or literal ellipsis.
  IF NEW.extensions #>> '{weiboBody,version}' = 'weibo-body.v1'
     AND NEW.extensions #>> '{rawSearch,bodyCompleteness}' = 'full_text'
     AND NEW.extensions #>> '{weiboBody,fullText}' = NEW.body
     AND length(NEW.body) > 0 THEN
    RETURN NEW;
  END IF;

  IF (OLD.extensions #>> '{weiboBody,version}' = 'weibo-body.v1'
      AND NEW.extensions #>> '{weiboBody,version}' IS DISTINCT FROM 'weibo-body.v1')
     OR NEW.extensions #>> '{rawSearch,bodyCompleteness}' = 'provider_preview'
     OR NEW.extensions ->> 'body_completeness' = 'provider_preview'
     OR core.weibo_long_text_preview_of(OLD.body, NEW.body)
     OR core.weibo_display_preview_of(OLD.body, NEW.body) THEN
    OLD.last_seen_at := GREATEST(OLD.last_seen_at, NEW.last_seen_at);
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$fn$;

-- Include the first, evidence-backed repair which predates rawSearch markers.
DROP TRIGGER IF EXISTS preserve_hub_raw_weibo_full_text ON core.canonical_records;
CREATE TRIGGER preserve_hub_raw_weibo_full_text
BEFORE UPDATE ON core.canonical_records FOR EACH ROW
WHEN (OLD.dataset_id IN ('night-all.compat.v1', 'night-all.search.v1')
  AND OLD.platform = 'weibo' AND OLD.object_type = 'post'
  AND ((OLD.extensions #>> '{rawSearch,version}' = 'mx-insight-hub.raw-search.v1'
      AND OLD.extensions #>> '{rawSearch,bodyCompleteness}' = 'full_text')
    OR (OLD.id = '34c72b79-f291-4ef7-ad9b-fe62eb03912d'::uuid
      AND OLD.extensions #>> '{weiboLongTextRepair,responseSha256}' =
        'b05ecd61c51bb3e51a1fa464e0ffd78e41c10c0b47363a5b07806bee003444dc')))
EXECUTE FUNCTION core.preserve_hub_raw_weibo_full_text();
