-- Hub-owned publication and quality state for public-opinion records.
--
-- Night-All remains an upstream collection source.  This table is the Hub's
-- current, revision-fenced decision about whether a canonical row is formal,
-- pending review, qualified for candidate-aware reads, rejected, or failed.
-- It deliberately contains no provider credential, endpoint or upstream
-- availability fields.

CREATE TABLE IF NOT EXISTS core.public_opinion_current_state (
  record_id uuid PRIMARY KEY
    REFERENCES core.canonical_records(id) ON DELETE RESTRICT,
  canonical_revision integer NOT NULL CHECK (canonical_revision > 0),
  source_object_revision_id bigint
    REFERENCES ingest.source_object_revisions(id) ON DELETE RESTRICT,
  source_stage text NOT NULL DEFAULT 'formal'
    CHECK (source_stage IN ('formal', 'candidate')),
  status text NOT NULL DEFAULT 'formal'
    CHECK (status IN ('formal', 'pending', 'qualified', 'rejected', 'failed')),
  quality_score smallint CHECK (quality_score BETWEEN 0 AND 100),
  qualification_threshold smallint NOT NULL DEFAULT 80
    CHECK (qualification_threshold BETWEEN 0 AND 100),
  quality_flags jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(quality_flags) = 'array'),
  rejection_codes jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(rejection_codes) = 'array'),
  event_admin1_code text,
  publisher_admin1_code text,
  display_admin1_code text,
  geography_verified boolean NOT NULL DEFAULT false,
  geo_scope text NOT NULL DEFAULT 'unknown'
    CHECK (geo_scope IN (
      'province', 'multi_province', 'national', 'maritime', 'overseas', 'unknown'
    )),
  country_code text,
  location_label text,
  location_type text NOT NULL DEFAULT 'unknown'
    CHECK (location_type IN ('province', 'country', 'region', 'city', 'maritime', 'unknown')),
  country_name text,
  analysis_version text,
  taxonomy_version text,
  rule_version text,
  prompt_version text,
  materialized_from_task_id bigint
    REFERENCES agent_center.analysis_tasks(id) ON DELETE RESTRICT,
  assessed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (source_stage = 'formal' AND status = 'formal')
    OR source_stage = 'candidate'
  )
);

CREATE INDEX IF NOT EXISTS public_opinion_current_state_serving_idx
  ON core.public_opinion_current_state
    (source_stage, status, display_admin1_code, updated_at DESC, record_id DESC);

CREATE INDEX IF NOT EXISTS public_opinion_current_state_quality_idx
  ON core.public_opinion_current_state
    (display_admin1_code, quality_score DESC, updated_at DESC, record_id DESC)
  WHERE source_stage = 'candidate' AND status = 'qualified';

-- Rows that predate a candidate source contract are existing formal facts.
-- Applying the migration does not start workers or change their public shape.
INSERT INTO core.public_opinion_current_state
  (record_id, canonical_revision, source_object_revision_id,
   source_stage, status, event_admin1_code, display_admin1_code,
   geography_verified, geo_scope, country_code,
   location_label, location_type, country_name)
SELECT
  record.id,
  record.current_revision,
  source_revision.id,
  'formal',
  'formal',
  record.admin1_code,
  record.admin1_code,
  record.admin1_code IS NOT NULL,
  CASE WHEN record.admin1_code IS NOT NULL THEN 'province' ELSE 'unknown' END,
  CASE
    WHEN event_location.country_code ~ '^[A-Za-z]{2}$'
      THEN upper(event_location.country_code)
    ELSE record.country_code
  END,
  event_location.label,
  CASE
    WHEN event_location.location_type IN ('province', 'country', 'region', 'city', 'maritime')
      THEN event_location.location_type
    WHEN record.admin1_code IS NOT NULL THEN 'province'
    ELSE 'unknown'
  END,
  event_location.country_name
FROM core.canonical_records record
LEFT JOIN ingest.source_objects source_object
  ON source_object.connector_id = 'external:province-opinion-results'
 AND source_object.object_type = record.object_type
 AND source_object.source_key = record.external_id
LEFT JOIN ingest.source_object_revisions source_revision
  ON source_revision.source_object_id = source_object.id
 AND source_revision.revision = source_object.current_revision
LEFT JOIN LATERAL (
  SELECT
    nullif(left(coalesce(
      source_revision.raw_payload #>> '{eventLocation,label}',
      source_revision.raw_payload #>> '{politicalTerrorEventLocation,label}',
      source_revision.raw_payload #>> '{raw,politicalTerrorEventLocation,label}'
    ), 160), '') AS label,
    coalesce(
      source_revision.raw_payload #>> '{eventLocation,type}',
      source_revision.raw_payload #>> '{politicalTerrorEventLocation,type}',
      source_revision.raw_payload #>> '{raw,politicalTerrorEventLocation,type}'
    ) AS location_type,
    nullif(left(coalesce(
      source_revision.raw_payload #>> '{eventLocation,country}',
      source_revision.raw_payload #>> '{politicalTerrorEventLocation,country}',
      source_revision.raw_payload #>> '{raw,politicalTerrorEventLocation,country}'
    ), 120), '') AS country_name,
    coalesce(
      source_revision.raw_payload #>> '{eventLocation,countryCode}',
      source_revision.raw_payload #>> '{politicalTerrorEventLocation,countryCode}',
      source_revision.raw_payload #>> '{raw,politicalTerrorEventLocation,countryCode}'
    ) AS country_code
) event_location ON true
WHERE record.dataset_id = 'public-opinion.province.v1'
ON CONFLICT (record_id) DO NOTHING;

COMMENT ON TABLE core.public_opinion_current_state IS
  'Hub-owned revision-fenced publication, quality and geography state; upstream raw evidence remains append-only.';
