-- Fixed mobile-device commerce collection intake.
--
-- Installs a paused, credential-free physical source and a reviewed mapping
-- candidate.  Activation remains an operator action because collected_at is a
-- safe incremental watermark only while the upstream writer honors the
-- append-only contract exposed by the pipeline.

DO $$
DECLARE
  existing_source_id uuid;
BEGIN
  SELECT id INTO existing_source_id
    FROM catalog.external_sources
   WHERE source_key = 'mobile-commerce-collected-items';
  IF FOUND THEN
    RAISE EXCEPTION
      'reserved source key mobile-commerce-collected-items already exists as source %; rename it before installing the fixed pipeline',
      existing_source_id;
  END IF;
END
$$;

INSERT INTO catalog.external_sources
  (id, source_key, display_name, source_kind, dataset_id, platform, object_type,
   status, connection, sync_interval_seconds)
VALUES
  (
    'd3ab86a9-bbbf-423b-8b74-dec1fd728a6e',
    'mobile-commerce-collected-items',
    '手机端商家商品采集',
    'database',
    'mobile-commerce.collected-items.v1',
    'mobile_commerce',
    'commerce_capture',
    'paused',
    '{
      "schema":"public",
      "table":"mb_collected_items",
      "cursorColumn":"collected_at",
      "idColumn":"id"
    }'::jsonb,
    300
  );

-- This fixed mapping intentionally does not treat product_link/shop_link as
-- URLs: the supplied rows contain app share text and opaque copy tokens.  It
-- also does not promote collected_at to eventTime because collection time is
-- not a product publication time.  Source-internal run/device/report metadata
-- remains available in raw_payload but is consumed before public projections.
INSERT INTO catalog.source_mappings
  (id, source_id, version, field_map, origin, notes)
SELECT
  '2900ddcf-a7d9-4714-92df-28148c70459f',
  id,
  1,
  '{
    "externalId":{"from":"id"},
    "title":{"from":"title"},
    "authorExternalId":{"from":"shop_id"},
    "authorName":{"from":"shop_name"},
    "collectedAt":{"from":"collected_at","type":"timestamp","timezoneOffsetMinutes":480},
    "attributes.sourcePlatform":{"from":"platform"},
    "metrics.comments":{"from":"comment_count","type":"number"},
    "_drop":{"from":["task_run_id","product_link","shop_link","metadata_json","device_serial","is_reported"]}
  }'::jsonb,
  'manual',
  'Fixed mb_collected_items v1 mapping. Keep unapproved until the append-only writer contract and (collected_at, id) total-order index are verified.'
FROM catalog.external_sources
WHERE source_key = 'mobile-commerce-collected-items';

-- Directory-driven reads use the governed catalog entry identity, not a
-- best-effort comparison against the authorization platform. The projector
-- still consumes the ordinary canonical outbox and therefore sends these rows
-- through the same PostgreSQL -> chunk -> Elasticsearch path as other plans.
CREATE INDEX IF NOT EXISTS canonical_mobile_commerce_collected_idx
  ON core.canonical_records (collected_at DESC, id DESC)
  WHERE dataset_id = 'mobile-commerce.collected-items.v1'
    AND platform = 'mobile_commerce'
    AND object_type = 'commerce_capture'
    AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS canonical_mobile_commerce_catalog_collected_idx
  ON core.canonical_records (
    (stable_fields #>> '{commerce,marketplace,entryId}'),
    collected_at DESC,
    id DESC
  )
  WHERE dataset_id = 'mobile-commerce.collected-items.v1'
    AND platform = 'mobile_commerce'
    AND object_type = 'commerce_capture'
    AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS canonical_mobile_commerce_source_collected_idx
  ON core.canonical_records (
    (stable_fields #>> '{commerce,marketplace,sourceValue}'),
    collected_at DESC,
    id DESC
  )
  WHERE dataset_id = 'mobile-commerce.collected-items.v1'
    AND platform = 'mobile_commerce'
    AND object_type = 'commerce_capture'
    AND deleted_at IS NULL;
