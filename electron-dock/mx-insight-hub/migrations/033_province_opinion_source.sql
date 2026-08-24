-- Fixed nationwide province-opinion intake.
--
-- This migration intentionally installs only a paused, unconfigured source.
-- The supplied upstream table has no change watermark: created_at is an insert
-- timestamp and cannot reveal later province/source/heat/LLM enrichment.  The
-- fixed contract therefore names the required future `updated_at` column and
-- fails closed at schema probe time until the upstream writer advances it for
-- every relevant change and provides an `(updated_at, id)` index.

ALTER TABLE core.canonical_records
  ADD COLUMN IF NOT EXISTS heat_score numeric;

-- Never adopt an older generic source that happened to choose the reserved
-- key.  Its connection, state and mapping history are operator-owned, and a
-- partial match is not enough to prove that it is safe to turn into this fixed
-- pipeline.  The operator must rename that source before applying this
-- migration; a failed migration leaves the existing source untouched.
DO $$
DECLARE
  existing_source_id uuid;
BEGIN
  SELECT id INTO existing_source_id
    FROM catalog.external_sources
   WHERE source_key = 'province-opinion-results';
  IF FOUND THEN
    RAISE EXCEPTION
      'reserved source key province-opinion-results already exists as source %; rename it before installing the fixed pipeline',
      existing_source_id;
  END IF;
END
$$;

INSERT INTO catalog.external_sources
  (id, source_key, display_name, source_kind, dataset_id, platform, object_type,
   status, connection, sync_interval_seconds)
VALUES
  (
    '746b8134-6da7-4d09-b097-e9a355715c58',
    'province-opinion-results',
    '全国省份舆情结果',
    'database',
    'public-opinion.province.v1',
    'public_opinion',
    'opinion_item',
    'paused',
    '{
      "schema":"public",
      "table":"monitor_strategy_results",
      "cursorColumn":"updated_at",
      "idColumn":"id"
    }'::jsonb,
    300
  );

-- The mapping is a reviewed built-in candidate, not an active mapping.  It is
-- approved atomically only when an operator activates the fixed pipeline under
-- the current writer contract.  Sensitive strategy, model-reasoning and raw
-- lineage fields stay in ingest.source_objects.raw_payload and revisions; they
-- are deliberately consumed from canonical extensions so public search cannot
-- acquire them by accident.
INSERT INTO catalog.source_mappings
  (id, source_id, version, field_map, origin, notes)
SELECT
  'e373f0f5-2042-4b34-bce9-bb4d668e5429',
  id,
  1,
  '{
    "externalId":{"from":"id"},
    "contentType":{"from":"source_type"},
    "url":{"from":"link"},
    "title":{"from":"title"},
    "body":{"from":["summary","title"]},
    "authorName":{"from":"source_name"},
    "eventTime":{"from":"published_at","type":"timestamp"},
    "collectedAt":{"from":"updated_at","type":"timestamp"},
    "admin1Code":{"from":"province","type":"province_code"},
    "attributes.province":{"from":"province"},
    "attributes.sourcePlatform":{"from":"platform"},
    "attributes.sourceType":{"from":"source_type"},
    "attributes.llmLabel":{"from":"llm_label"},
    "metrics.heatScore":{"from":"heat_score","type":"number"},
    "_drop":{"from":[
      "strategy_id","run_id","item_hash","source_id",
      "target_keywords","negative_keywords","heat_metrics",
      "llm_confidence","llm_reason","raw",
      "source_table","source_item_id","created_at"
    ]}
  }'::jsonb,
  'manual',
  'Fixed province-opinion mapping. Keep unapproved until upstream adds a reliable updated_at writer contract and (updated_at, id) index.'
FROM catalog.external_sources
WHERE source_key = 'province-opinion-results';

-- Serving indexes are intentionally not built in this transactional migration.
-- Even when this new dataset has no rows, PostgreSQL must scan the shared
-- canonical table to evaluate a partial-index predicate; the ALTER TABLE lock
-- above would then be retained until both builds completed.  Install the two
-- indexes online with scripts/province-opinion-serving-indexes.sql before
-- activation.  The fixed pipeline fails closed until both indexes are valid.
