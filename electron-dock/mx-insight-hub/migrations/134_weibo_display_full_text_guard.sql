-- Match the two display differences verified from retained Weibo receipts.
-- Comparison only; no body/replay rewrite, acquisition, permission or billing change.
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION core.weibo_display_comparison_text(body text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $fn$
  SELECT regexp_replace(regexp_replace(regexp_replace(body,
    '#([^#\[\]\r\n]+)\[超话\]#', '\1超话', 'g'),
    '|\[(笑cry|打call)\]', '', 'g'), '[[:space:]​﻿]', '', 'g');
$fn$;

CREATE OR REPLACE FUNCTION core.weibo_display_preview_of(full_body text, preview text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $fn$
  SELECT preview ~ '(展开(全文)?[[:space:]]*[cCＣｃ]?|…|[.]{3})[[:space:]​﻿]*$'
    AND length(prefix) >= 40 AND length(content) > length(prefix)
    AND starts_with(content, prefix)
  FROM (SELECT core.weibo_display_comparison_text(regexp_replace(preview,
      '(展开(全文)?[[:space:]]*[cCＣｃ]?|…|[.]{3})[[:space:]​﻿]*$', '')) AS prefix,
    core.weibo_display_comparison_text(full_body) AS content) normalized;
$fn$;

-- The existing trigger remains scoped to Hub-verified full text in the two
-- original Weibo datasets. Preserve its strict legacy branch as well.
CREATE OR REPLACE FUNCTION core.preserve_hub_raw_weibo_full_text()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.deleted_at IS NULL AND OLD.deleted_at IS NULL
     AND NEW.dataset_id = OLD.dataset_id AND NEW.platform = OLD.platform
     AND NEW.object_type = OLD.object_type AND NEW.external_id = OLD.external_id
     AND NEW.author_external_id IS NOT DISTINCT FROM OLD.author_external_id
     AND (core.weibo_long_text_preview_of(OLD.body, NEW.body)
       OR (NEW.extensions #>> '{rawSearch,bodyCompleteness}' = 'provider_preview'
         AND core.weibo_display_preview_of(OLD.body, NEW.body))) THEN
    OLD.last_seen_at := GREATEST(OLD.last_seen_at, NEW.last_seen_at);
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$fn$;
