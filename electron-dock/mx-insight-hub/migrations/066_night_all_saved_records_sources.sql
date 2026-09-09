-- Night-All saved-record leaf-partition intake.
--
-- Installs thirteen credential-free PostgreSQL sources and their unapproved
-- mapping candidates. Every source remains paused: migration success does not
-- attest the upstream last_seen_at writer/delete contract, build the required
-- source-database indexes, approve a mapping, or grant a Public API platform.
-- Internal source keys retain operational lineage; datasets and authorization
-- platforms use provider-neutral Data Center names in public contracts.

DO $$
DECLARE
  existing_source_id uuid;
  existing_source_key text;
  existing_dataset_id text;
  existing_platform text;
BEGIN
  SELECT id, source_key, dataset_id, platform
    INTO existing_source_id, existing_source_key, existing_dataset_id, existing_platform
    FROM catalog.external_sources
   WHERE id = ANY (ARRAY[
     'e367cc11-81af-5615-9a74-fc55004a55b1'::uuid,
     'ce09c232-ec86-5ebc-9966-ca52d0d34c4c'::uuid,
     '1ecb7a63-b2e4-5adf-baa1-192628f00bfc'::uuid,
     'b8be8442-6404-504a-a2cc-e922168e8b29'::uuid,
     '18e6aad2-02cc-5359-93e0-e731cbda76a7'::uuid,
     '9f1ba402-1509-5c61-9d5a-d3528be18151'::uuid,
     'b7401a46-d327-5a22-bb81-f4a5b6aad83b'::uuid,
     'c6f588d0-3d3a-5f2a-a57b-ee5d27177571'::uuid,
     '3a1f65ed-0f76-58fc-a445-680b2f47f84d'::uuid,
     '2c5681d8-6126-575a-b978-db4806e5d64a'::uuid,
     'c0593cb0-08a4-5802-9792-09d8f6d73b6b'::uuid,
     '417bab60-fab3-523d-a1df-8e2bf7e6ae1e'::uuid,
     '5e378a73-09da-5724-8e56-d608d2e2e006'::uuid
   ])
      OR source_key = ANY (ARRAY[
     'night-all-saved-records-automotive',
     'night-all-saved-records-finance',
     'night-all-saved-records-forum',
     'night-all-saved-records-hotspot',
     'night-all-saved-records-local-news',
     'night-all-saved-records-media',
     'night-all-saved-records-news',
     'night-all-saved-records-other',
     'night-all-saved-records-recruitment',
     'night-all-saved-records-research',
     'night-all-saved-records-social',
     'night-all-saved-records-technology',
     'night-all-saved-records-web'
   ])
      OR dataset_id = ANY (ARRAY[
     'data-center.saved-records.automotive.v1',
     'data-center.saved-records.finance.v1',
     'data-center.saved-records.forum.v1',
     'data-center.saved-records.hotspot.v1',
     'data-center.saved-records.local_news.v1',
     'data-center.saved-records.media.v1',
     'data-center.saved-records.news.v1',
     'data-center.saved-records.other.v1',
     'data-center.saved-records.recruitment.v1',
     'data-center.saved-records.research.v1',
     'data-center.saved-records.social.v1',
     'data-center.saved-records.technology.v1',
     'data-center.saved-records.web.v1'
   ])
      OR platform = ANY (ARRAY[
     'data_center_saved_records_automotive',
     'data_center_saved_records_finance',
     'data_center_saved_records_forum',
     'data_center_saved_records_hotspot',
     'data_center_saved_records_local_news',
     'data_center_saved_records_media',
     'data_center_saved_records_news',
     'data_center_saved_records_other',
     'data_center_saved_records_recruitment',
     'data_center_saved_records_research',
     'data_center_saved_records_social',
     'data_center_saved_records_technology',
     'data_center_saved_records_web'
   ])
   ORDER BY source_key
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'reserved crawler scope conflicts with source % (%), dataset %, platform %; rename or migrate it before installing the fixed pipeline',
      existing_source_id,
      existing_source_key,
      existing_dataset_id,
      existing_platform;
  END IF;
END
$$;

-- A pre-existing consumer grant would make a grandfathered legacy_dynamic key
-- inherit this newly reserved data product without an explicit crawler rollout
-- decision.  A still-live snapshot entitlement is also latent authority: it
-- becomes effective again if its consumer grant is recreated.  Stop before
-- registering or activating any fixed source so operators can review and
-- rotate those scopes deliberately.
--
-- The migration runner owns one transaction for this file. SHARE prevents an
-- Admin grant or snapshot-key write from crossing the authorization probe and
-- migration commit while preserving ordinary reads.
SET LOCAL lock_timeout = '5s';
LOCK TABLE platform_grants, api_key_platform_entitlements IN SHARE MODE;

DO $$
DECLARE
  reserved_platforms text[] := ARRAY[
    'data_center_saved_records_automotive',
    'data_center_saved_records_finance',
    'data_center_saved_records_forum',
    'data_center_saved_records_hotspot',
    'data_center_saved_records_local_news',
    'data_center_saved_records_media',
    'data_center_saved_records_news',
    'data_center_saved_records_other',
    'data_center_saved_records_recruitment',
    'data_center_saved_records_research',
    'data_center_saved_records_social',
    'data_center_saved_records_technology',
    'data_center_saved_records_web'
  ]::text[];
  grant_count bigint;
  live_snapshot_count bigint;
  effective_key_count bigint;
BEGIN
  SELECT count(*)
    INTO grant_count
    FROM platform_grants grant_record
   WHERE lower(btrim(normalize(grant_record.platform, NFKC))) = ANY (reserved_platforms);

  SELECT count(*)
    INTO live_snapshot_count
    FROM api_key_platform_entitlements entitlement
    JOIN api_keys api_key_record ON api_key_record.id = entitlement.api_key_id
   WHERE lower(btrim(normalize(entitlement.platform, NFKC))) = ANY (reserved_platforms)
     AND api_key_record.scope_mode = 'snapshot'
     AND api_key_record.status = 'active'
     AND api_key_record.expires_at > now();

  SELECT count(*)
    INTO effective_key_count
    FROM platform_grants grant_record
    JOIN api_keys api_key_record ON api_key_record.consumer_id = grant_record.consumer_id
    JOIN consumers consumer
      ON consumer.id = api_key_record.consumer_id
     AND consumer.status = 'active'
    JOIN tenants tenant
      ON tenant.id = api_key_record.tenant_id
     AND tenant.status = 'active'
    LEFT JOIN api_key_platform_entitlements entitlement
      ON entitlement.api_key_id = api_key_record.id
     AND entitlement.platform = grant_record.platform
   WHERE lower(btrim(normalize(grant_record.platform, NFKC))) = ANY (reserved_platforms)
     AND api_key_record.status = 'active'
     AND api_key_record.expires_at > now()
     AND (
       api_key_record.scope_mode = 'legacy_dynamic'
       OR (
         api_key_record.scope_mode = 'snapshot'
         AND entitlement.api_key_id IS NOT NULL
       )
     );

  IF grant_count <> 0 OR live_snapshot_count <> 0 THEN
    RAISE EXCEPTION 'reserved crawler public authorization scope already exists'
      USING ERRCODE = '23514',
            DETAIL = format(
              'platform_grants=%s, live_snapshot_entitlements=%s, currently_effective_keys=%s',
              grant_count,
              live_snapshot_count,
              effective_key_count
            ),
            HINT = 'Audit and explicitly remove or rotate these scopes before installing migration 066.';
  END IF;
END
$$;

INSERT INTO catalog.external_sources
  (id, source_key, display_name, source_kind, dataset_id, platform, object_type,
   status, connection, sync_interval_seconds)
VALUES
  (
    'e367cc11-81af-5615-9a74-fc55004a55b1',
    'night-all-saved-records-automotive',
    'Night-All 汽车数据',
    'database',
    'data-center.saved-records.automotive.v1',
    'data_center_saved_records_automotive',
    'saved_record',
    'paused',
    '{"schema":"public","table":"saved_records_automotive","cursorColumn":"last_seen_at","idColumn":"id"}'::jsonb,
    300
  ),
  (
    'ce09c232-ec86-5ebc-9966-ca52d0d34c4c',
    'night-all-saved-records-finance',
    'Night-All 财经数据',
    'database',
    'data-center.saved-records.finance.v1',
    'data_center_saved_records_finance',
    'saved_record',
    'paused',
    '{"schema":"public","table":"saved_records_finance","cursorColumn":"last_seen_at","idColumn":"id"}'::jsonb,
    300
  ),
  (
    '1ecb7a63-b2e4-5adf-baa1-192628f00bfc',
    'night-all-saved-records-forum',
    'Night-All 论坛数据',
    'database',
    'data-center.saved-records.forum.v1',
    'data_center_saved_records_forum',
    'saved_record',
    'paused',
    '{"schema":"public","table":"saved_records_forum","cursorColumn":"last_seen_at","idColumn":"id"}'::jsonb,
    300
  ),
  (
    'b8be8442-6404-504a-a2cc-e922168e8b29',
    'night-all-saved-records-hotspot',
    'Night-All 热点数据',
    'database',
    'data-center.saved-records.hotspot.v1',
    'data_center_saved_records_hotspot',
    'saved_record',
    'paused',
    '{"schema":"public","table":"saved_records_hotspot","cursorColumn":"last_seen_at","idColumn":"id"}'::jsonb,
    300
  ),
  (
    '18e6aad2-02cc-5359-93e0-e731cbda76a7',
    'night-all-saved-records-local-news',
    'Night-All 地方新闻',
    'database',
    'data-center.saved-records.local_news.v1',
    'data_center_saved_records_local_news',
    'saved_record',
    'paused',
    '{"schema":"public","table":"saved_records_local_news","cursorColumn":"last_seen_at","idColumn":"id"}'::jsonb,
    300
  ),
  (
    '9f1ba402-1509-5c61-9d5a-d3528be18151',
    'night-all-saved-records-media',
    'Night-All 媒体数据',
    'database',
    'data-center.saved-records.media.v1',
    'data_center_saved_records_media',
    'saved_record',
    'paused',
    '{"schema":"public","table":"saved_records_media","cursorColumn":"last_seen_at","idColumn":"id"}'::jsonb,
    300
  ),
  (
    'b7401a46-d327-5a22-bb81-f4a5b6aad83b',
    'night-all-saved-records-news',
    'Night-All 新闻资讯',
    'database',
    'data-center.saved-records.news.v1',
    'data_center_saved_records_news',
    'saved_record',
    'paused',
    '{"schema":"public","table":"saved_records_news","cursorColumn":"last_seen_at","idColumn":"id"}'::jsonb,
    300
  ),
  (
    'c6f588d0-3d3a-5f2a-a57b-ee5d27177571',
    'night-all-saved-records-other',
    'Night-All 其他数据',
    'database',
    'data-center.saved-records.other.v1',
    'data_center_saved_records_other',
    'saved_record',
    'paused',
    '{"schema":"public","table":"saved_records_other","cursorColumn":"last_seen_at","idColumn":"id"}'::jsonb,
    300
  ),
  (
    '3a1f65ed-0f76-58fc-a445-680b2f47f84d',
    'night-all-saved-records-recruitment',
    'Night-All 招聘数据',
    'database',
    'data-center.saved-records.recruitment.v1',
    'data_center_saved_records_recruitment',
    'saved_record',
    'paused',
    '{"schema":"public","table":"saved_records_recruitment","cursorColumn":"last_seen_at","idColumn":"id"}'::jsonb,
    300
  ),
  (
    '2c5681d8-6126-575a-b978-db4806e5d64a',
    'night-all-saved-records-research',
    'Night-All 研究数据',
    'database',
    'data-center.saved-records.research.v1',
    'data_center_saved_records_research',
    'saved_record',
    'paused',
    '{"schema":"public","table":"saved_records_research","cursorColumn":"last_seen_at","idColumn":"id"}'::jsonb,
    300
  ),
  (
    'c0593cb0-08a4-5802-9792-09d8f6d73b6b',
    'night-all-saved-records-social',
    'Night-All 社交媒体',
    'database',
    'data-center.saved-records.social.v1',
    'data_center_saved_records_social',
    'saved_record',
    'paused',
    '{"schema":"public","table":"saved_records_social","cursorColumn":"last_seen_at","idColumn":"id"}'::jsonb,
    300
  ),
  (
    '417bab60-fab3-523d-a1df-8e2bf7e6ae1e',
    'night-all-saved-records-technology',
    'Night-All 科技数据',
    'database',
    'data-center.saved-records.technology.v1',
    'data_center_saved_records_technology',
    'saved_record',
    'paused',
    '{"schema":"public","table":"saved_records_technology","cursorColumn":"last_seen_at","idColumn":"id"}'::jsonb,
    300
  ),
  (
    '5e378a73-09da-5724-8e56-d608d2e2e006',
    'night-all-saved-records-web',
    'Night-All 网页数据',
    'database',
    'data-center.saved-records.web.v1',
    'data_center_saved_records_web',
    'saved_record',
    'paused',
    '{"schema":"public","table":"saved_records_web","cursorColumn":"last_seen_at","idColumn":"id"}'::jsonb,
    300
  );

-- The shared candidate maps only stable scalar content. published_at and the
-- structured author/metrics/media/attributes payloads require the fixed
-- crawler cleaner. Consume source-private and potentially large JSON values so
-- they remain in restricted raw lineage rather than canonical extensions or
-- the customer-safe Elasticsearch projection.
WITH mapping_specs(mapping_id, source_key) AS (
  VALUES
    ('a37ef80d-58b2-531b-b222-f045c451d6fa', 'night-all-saved-records-automotive'),
    ('3b0e9f93-f8d1-5f9e-bdc7-a7718b4746e7', 'night-all-saved-records-finance'),
    ('22285b5e-b60e-58e1-93fe-165ab9da82b9', 'night-all-saved-records-forum'),
    ('0525f183-d51a-5586-b6ec-598b09649e0e', 'night-all-saved-records-hotspot'),
    ('bab9f729-8730-578e-a111-48c96ad3ef47', 'night-all-saved-records-local-news'),
    ('7b13d483-2801-5377-9cab-d6ddeeed0e0a', 'night-all-saved-records-media'),
    ('6ebf66f9-cd35-5df0-b321-0cb05e6bd8fe', 'night-all-saved-records-news'),
    ('8182fa52-aed4-5026-b17e-c48750246ed4', 'night-all-saved-records-other'),
    ('d428912d-8c4e-5236-8a6a-02f58a6ca4e4', 'night-all-saved-records-recruitment'),
    ('60b929c1-34ba-5e29-be33-e998dd17cff5', 'night-all-saved-records-research'),
    ('0b3fea27-2d9c-5f1b-a07d-ec5da495c2d7', 'night-all-saved-records-social'),
    ('f221060d-7a3d-55ca-9622-fb0e290dc013', 'night-all-saved-records-technology'),
    ('239adecc-c99d-5ad7-814e-ce5240bf0e60', 'night-all-saved-records-web')
)
INSERT INTO catalog.source_mappings
  (id, source_id, version, field_map, origin, notes)
SELECT
  mapping_specs.mapping_id::uuid,
  source.id,
  1,
  '{
    "externalId":{"from":"record_key"},
    "contentType":{"from":"record_type"},
    "url":{"from":"source_url"},
    "title":{"from":"title"},
    "body":{"from":"text"},
    "collectedAt":{"from":"first_seen_at","type":"timestamp"},
    "attributes.sourceType":{"from":"source_type"},
    "_drop":{"from":[
      "id","connector_id","run_id","source_family","collection_mode",
      "evidence","quality_status","source_id","author","published_at",
      "metrics","media","attributes","raw","last_seen_at","created_at"
    ]}
  }'::jsonb,
  'manual',
  'Night-All saved_records v1 candidate. Keep unapproved until the fixed cleaner, source-type publication policy, last_seen_at writer contract, no-hard-delete contract, and source index are verified.'
FROM mapping_specs
JOIN catalog.external_sources AS source
  ON source.source_key = mapping_specs.source_key;

-- The four populated canonical-record catalog indexes are intentionally not
-- built in this transactional migration. Reconcile them online with
-- scripts/night-all-saved-records-hub-indexes.sql after this migration.
