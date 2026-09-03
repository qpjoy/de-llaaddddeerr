import { randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { CANONICAL_CONTEXT_DATASETS } from '../data/canonical-context.mjs'
import { VIRTUAL_SUPERMARKET_DEFAULT_CATEGORY_ID } from '../data/virtual-supermarket.mjs'
import {
  CONNECTOR_ID,
  DATASET_ID,
  PARSER_VERSION,
  SCHEMA_VERSION,
  normalizeSearchPayload,
  observationHash,
  streamId,
} from '../ingest/normalizers.mjs'

function iso(value) {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function sourceCatalogComparableName(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
}

function sourceCatalogOwnedNames(entry) {
  const names = new Map()
  const add = (displayName, nameKind) => {
    const normalizedName = sourceCatalogComparableName(displayName)
    if (!normalizedName || names.has(normalizedName)) return
    names.set(normalizedName, {
      normalizedName,
      displayName: String(displayName).normalize('NFKC').trim(),
      nameKind,
    })
  }
  add(entry.canonicalName, 'canonical')
  entry.aliases?.forEach((alias) => add(alias, 'alias'))
  return [...names.values()]
}

function sourceCatalogEntryTaxonomyValues(entry, kind) {
  if (kind === 'major_category') return [entry.majorCategory]
  if (kind === 'scenario') return entry.scenarios || []
  if (kind === 'region') return entry.regions || []
  return entry.tags || []
}

function sourceCatalogEntryUsesTerm(entry, term) {
  const normalizedTerm = sourceCatalogComparableName(term.displayName)
  return sourceCatalogEntryTaxonomyValues(entry, term.kind)
    .some((value) => sourceCatalogComparableName(value) === normalizedTerm)
}

const connectorCallOutcomes = new Set(['complete', 'partial', 'failed', 'unknown'])
const connectorSourceModes = new Set(['live', 'stale'])
const connectorFailureKinds = new Set(['network', 'timeout', 'http', 'contract', 'business', 'internal', 'unknown'])
const transientHttpStatuses = new Set([502, 503, 504])
const publicOpinionDatasets = new Set([
  'public-opinion.province.v1',
])

const ADMIN_TELEGRAM_CHAT_KIND_SQL = `(CASE
  WHEN lower(btrim(coalesce(chat.stable_fields #>> '{attributes,chatType}', chat.content_type, '')))
       IN ('broadcast', 'channel', 'public_channel') THEN 'channel'
  WHEN lower(btrim(coalesce(chat.stable_fields #>> '{attributes,chatType}', chat.content_type, '')))
       IN ('group', 'megagroup', 'public_group', 'supergroup') THEN 'group'
  ELSE 'unknown'
END)`

const ADMIN_TELEGRAM_DATASETS = Object.freeze({
  monitor: Object.freeze({
    chats: 'telegram.monitor.chats.v1',
    messages: 'telegram.monitor.messages.v1',
  }),
  sqlite: Object.freeze({
    chats: 'telegram.sqlite.chats.v1',
    messages: 'telegram.sqlite.messages.v1',
  }),
})

function adminTelegramDatasets(sourceScope = 'all', role) {
  if (sourceScope === 'monitor' || sourceScope === 'sqlite') {
    return [ADMIN_TELEGRAM_DATASETS[sourceScope][role]]
  }
  return [ADMIN_TELEGRAM_DATASETS.monitor[role], ADMIN_TELEGRAM_DATASETS.sqlite[role]]
}

function adminTelegramChatSelector(chatId, sourceScope = 'all') {
  const qualified = /^(monitor|sqlite):([0-9a-f-]{36})$/i.exec(chatId)
  return {
    value: qualified?.[2] ?? chatId,
    datasets: adminTelegramDatasets(qualified?.[1]?.toLowerCase() ?? sourceScope, 'chats'),
  }
}

const ADMIN_PUBLIC_OPINION_BROWSE_SELECT = `SELECT record.id, record.title, record.body,
       record.url, record.content_type, record.author_name, record.event_time,
       record.collected_at, record.heat_score,
       publication.record_id AS publication_record_id,
       (publication.record_id IS NOT NULL) AS has_publication_state,
       publication.source_stage,
       publication.status AS quality_status,
       publication.quality_score,
       publication.qualification_threshold,
       publication.quality_flags,
       publication.rejection_codes,
       publication.display_admin1_code AS admin1_code,
       publication.geography_verified,
       publication.geo_scope,
       publication.country_code,
       publication.country_name,
       publication.location_label,
       publication.location_type,
       record.stable_fields #>> '{attributes,sourceType}' AS source_type,
       record.stable_fields #>> '{attributes,sourcePlatform}' AS source_platform,
       coalesce(record.event_time, record.collected_at, to_timestamp(0)) AS sort_time
  FROM core.canonical_records record
  LEFT JOIN core.public_opinion_current_state publication
    ON publication.record_id = record.id
   AND publication.canonical_revision = record.current_revision`

const VIRTUAL_SUPERMARKET_ITEM_SELECT = `SELECT record.id,
       record.external_id,
       record.title,
       record.author_name,
       record.collected_at,
       record.current_revision,
       record.stable_fields,
       (listing.record_id IS NOT NULL) AS listing_explicit,
       listing.publication_id,
       coalesce(listing.status, 'off_shelf') AS listing_status,
       coalesce(listing.category_id, '${VIRTUAL_SUPERMARKET_DEFAULT_CATEGORY_ID}'::uuid) AS listing_category_id,
       listing.display_title,
       listing.specification,
       listing.price_amount,
       listing.currency,
       listing.shelf_position,
       coalesce(listing.revision, 0) AS listing_revision,
       listing.created_by,
       listing.updated_by,
       listing.created_at AS listing_created_at,
       listing.updated_at AS listing_updated_at,
       category.id AS category_id,
       category.category_key,
       category.display_name AS category_display_name,
       category.department_key,
       category.department_name,
       category.department_sort_order,
       category.aisle_key,
       category.aisle_name,
       category.aisle_sort_order,
       category.shelf_key,
       category.shelf_name,
       category.shelf_sort_order,
       category.sort_order AS category_sort_order,
       category.revision AS category_revision,
       category.archived_at AS category_archived_at,
       category.created_at AS category_created_at,
       category.updated_at AS category_updated_at,
       coalesce(listing.display_title,
                record.stable_fields #>> '{commerce,product,title}',
                record.title) AS effective_title,
       CASE
         WHEN listing.price_amount IS NOT NULL THEN listing.price_amount
         WHEN (record.stable_fields #>> '{commerce,product,price}')
              ~ '^(0|[1-9][0-9]{0,17})(\\.[0-9]{1,2})?$'
           THEN (record.stable_fields #>> '{commerce,product,price}')::numeric
         ELSE NULL
       END AS effective_price
  FROM core.canonical_records record
  LEFT JOIN serving.virtual_supermarket_listing_state listing
    ON listing.record_id = record.id
  JOIN serving.virtual_supermarket_categories category
    ON category.id = coalesce(listing.category_id, '${VIRTUAL_SUPERMARKET_DEFAULT_CATEGORY_ID}'::uuid)`

async function assertVirtualSupermarketCategoryHierarchy(client, candidate, excludedId = null) {
  const { rows } = await client.query(
    `SELECT category.id,
            CASE
              WHEN category.department_key = $1
               AND (category.department_name IS DISTINCT FROM $2
                    OR category.department_sort_order IS DISTINCT FROM $3)
                THEN 'department'
              WHEN category.department_key = $1 AND category.aisle_key = $4
               AND (category.aisle_name IS DISTINCT FROM $5
                    OR category.aisle_sort_order IS DISTINCT FROM $6)
                THEN 'aisle'
              ELSE 'shelf'
            END AS conflict_level
       FROM serving.virtual_supermarket_categories category
      WHERE ($10::uuid IS NULL OR category.id <> $10::uuid)
        AND (
          (category.department_key = $1
           AND (category.department_name IS DISTINCT FROM $2
                OR category.department_sort_order IS DISTINCT FROM $3))
          OR
          (category.department_key = $1 AND category.aisle_key = $4
           AND (category.aisle_name IS DISTINCT FROM $5
                OR category.aisle_sort_order IS DISTINCT FROM $6))
          OR
          (category.department_key = $1 AND category.aisle_key = $4
           AND category.shelf_key = $7
           AND (category.shelf_name IS DISTINCT FROM $8
                OR category.shelf_sort_order IS DISTINCT FROM $9))
        )
      ORDER BY CASE
                 WHEN category.department_key = $1
                  AND (category.department_name IS DISTINCT FROM $2
                       OR category.department_sort_order IS DISTINCT FROM $3) THEN 1
                 WHEN category.department_key = $1 AND category.aisle_key = $4
                  AND (category.aisle_name IS DISTINCT FROM $5
                       OR category.aisle_sort_order IS DISTINCT FROM $6) THEN 2
                 ELSE 3
               END,
               category.id
      LIMIT 1`,
    [
      candidate.departmentKey, candidate.departmentName, candidate.departmentSortOrder,
      candidate.aisleKey, candidate.aisleName, candidate.aisleSortOrder,
      candidate.shelfKey, candidate.shelfName, candidate.shelfSortOrder,
      excludedId,
    ],
  )
  if (!rows[0]) return
  const level = rows[0].conflict_level
  const key = level === 'department'
    ? candidate.departmentKey
    : level === 'aisle' ? candidate.aisleKey : candidate.shelfKey
  throw new AppError(
    409,
    'virtual_supermarket_category_hierarchy_conflict',
    'Virtual-supermarket hierarchy key is already bound to different metadata',
    { level, key, conflictingCategoryId: rows[0].id },
  )
}

export function publicOpinionSourceStage(datasetId, rawItem) {
  if (!publicOpinionDatasets.has(datasetId)) return null
  const raw = rawItem && typeof rawItem === 'object' && !Array.isArray(rawItem)
    ? rawItem
    : {}
  const hubCandidate = raw.hub_candidate && typeof raw.hub_candidate === 'object'
    ? raw.hub_candidate
    : raw.hubCandidate && typeof raw.hubCandidate === 'object'
      ? raw.hubCandidate
      : {}
  const value = raw.source_stage
    ?? raw.sourceStage
    ?? hubCandidate.source_stage
    ?? hubCandidate.sourceStage
  if (value === 'formal' || value === 'candidate') return value
  throw new AppError(
    400,
    'invalid_public_opinion_source_stage',
    'public-opinion source_stage must be explicitly formal or candidate',
  )
}

function boundedText(value, maximum) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maximum)
    : null
}

export function publicOpinionLocation(rawItem) {
  const raw = rawItem && typeof rawItem === 'object' && !Array.isArray(rawItem)
    ? rawItem
    : {}
  const nested = raw.raw && typeof raw.raw === 'object' && !Array.isArray(raw.raw)
    ? raw.raw
    : {}
  const hubCandidate = raw.hub_candidate && typeof raw.hub_candidate === 'object'
    ? raw.hub_candidate
    : raw.hubCandidate && typeof raw.hubCandidate === 'object'
      ? raw.hubCandidate
      : {}
  const location = [
    raw.eventLocation,
    raw.politicalTerrorEventLocation,
    nested.politicalTerrorEventLocation,
    hubCandidate.eventLocation,
  ].find((value) => value && typeof value === 'object' && !Array.isArray(value)) || {}
  const allowedTypes = new Set(['province', 'country', 'region', 'city', 'maritime'])
  const locationType = allowedTypes.has(location.type) ? location.type : 'unknown'
  const code = boundedText(location.countryCode ?? raw.country_code ?? raw.countryCode, 2)
  return {
    label: boundedText(location.label, 160),
    type: locationType,
    countryName: boundedText(location.country ?? location.countryName, 120),
    countryCode: code && /^[A-Za-z]{2}$/.test(code) ? code.toUpperCase() : null,
  }
}

function countMap(value, requiredKeys = []) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return Object.fromEntries([
    ...requiredKeys.map((key) => [key, Number(source[key] || 0)]),
    ...Object.entries(source)
      .filter(([key]) => !requiredKeys.includes(key))
      .map(([key, count]) => [key, Number(count || 0)]),
  ])
}

export function publicOpinionQualitySummaryRow(row = {}) {
  const canonicalTotal = Number(row.canonical_total || 0)
  const active = Number(row.active_count || 0)
  const sourceObjects = Number(row.source_object_count || 0)
  const sourceRevisions = Number(row.source_revision_count || 0)
  const canonicalRevisions = Number(row.canonical_revision_count || 0)
  return {
    contractVersion: 'mx-insight-hub.public-opinion.quality-summary.v1',
    canonical: {
      total: canonicalTotal,
      active,
      deleted: Number(row.deleted_count || 0),
      withPublicationState: Number(row.publication_state_count || 0),
      missingPublicationState: Number(row.missing_publication_state_count || 0),
    },
    publication: {
      stages: countMap(row.stage_counts, ['formal', 'candidate']),
      statuses: countMap(row.status_counts, ['formal', 'pending', 'qualified', 'rejected', 'failed']),
      assessed: Number(row.assessed_count || 0),
      unassessed: Number(row.unassessed_count || 0),
      candidates: {
        total: Number(row.candidate_count || 0),
        scored: Number(row.candidate_scored_count || 0),
        unscored: Number(row.candidate_unscored_count || 0),
        qualifiedAtThreshold: Number(row.candidate_qualified_count || 0),
        averageQualityScore: row.average_candidate_quality_score == null
          ? null
          : Number(row.average_candidate_quality_score),
        scoreBuckets: countMap(row.candidate_score_buckets, [
          'unscored', '0-59', '60-79', '80-100',
        ]),
        qualityFlags: countMap(row.candidate_quality_flags),
        rejectionCodes: countMap(row.candidate_rejection_codes),
      },
    },
    geography: {
      withProvince: Number(row.with_province_count || 0),
      withoutProvince: Number(row.without_province_count || 0),
      verified: Number(row.verified_count || 0),
      withLocation: Number(row.with_location_count || 0),
      scopes: countMap(row.scope_counts, [
        'province', 'multi_province', 'national', 'maritime', 'overseas', 'unknown',
      ]),
      countries: countMap(row.country_counts),
      provinces: countMap(row.province_counts),
    },
    completeness: {
      missingTitle: Number(row.missing_title_count || 0),
      missingUrl: Number(row.missing_url_count || 0),
      missingEventTime: Number(row.missing_event_time_count || 0),
    },
    analysis: {
      tasks: countMap(row.task_counts, ['pending', 'running', 'succeeded', 'dead', 'superseded']),
      errors: countMap(row.task_error_counts),
      assertions: countMap(row.assertion_counts, ['proposed', 'accepted', 'rejected', 'superseded']),
    },
    archive: {
      sourceObjects,
      sourceRevisionRows: sourceRevisions,
      priorSourceRevisions: Math.max(0, sourceRevisions - sourceObjects),
      canonicalRevisionRows: canonicalRevisions,
      priorCanonicalRevisions: Math.max(0, canonicalRevisions - canonicalTotal),
    },
    time: {
      oldestRecordAt: iso(row.oldest_record_at),
      latestRecordAt: iso(row.latest_record_at),
      latestPublicationAt: iso(row.latest_publication_at),
    },
  }
}
// pg_get_indexdef(indexOid, columnNo, pretty) returns only the key expression.
// PostgreSQL stores DESC (bit 0) and NULLS FIRST (bit 1) separately in
// pg_index.indoption, so both pieces are required for an exact index contract.
function canonicalContextDatasetEntries(datasets) {
  if (!datasets || typeof datasets !== 'object' || Array.isArray(datasets)) {
    throw new Error('Canonical context dataset registry must be an object')
  }
  const entries = Object.entries(datasets)
  if (entries.length === 0) throw new Error('Canonical context dataset registry must not be empty')
  const indexNames = new Set()
  for (const [datasetId, dataset] of entries) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(datasetId)) {
      throw new Error(`Canonical context dataset id is unsafe: ${datasetId}`)
    }
    if (dataset?.objectType !== 'message') {
      throw new Error(`Canonical context dataset must contain messages: ${datasetId}`)
    }
    if (!/^[a-z][a-z0-9_]*$/.test(dataset.servingIndexName ?? '')) {
      throw new Error(`Canonical context serving index name is unsafe: ${datasetId}`)
    }
    if (indexNames.has(dataset.servingIndexName)) {
      throw new Error(`Canonical context serving index name is duplicated: ${dataset.servingIndexName}`)
    }
    indexNames.add(dataset.servingIndexName)
  }
  return entries
}

function canonicalContextQueryBranch(datasetId, position, side) {
  const before = side === 'before'
  const comparison = before ? '<' : '>'
  const direction = before ? 'DESC' : 'ASC'
  const limit = before ? '$2' : '$3'
  return {
    name: `context_${position}_${side}`,
    sql: `context_${position}_${side} AS (
         SELECT '${side}'::text AS side,
                row_number() OVER (ORDER BY r.event_time ${direction}, r.id ${direction}) AS side_position,
                r.id, r.dataset_id, r.platform, r.object_type, r.content_type,
                r.external_id, r.url, r.title, r.body, r.author_external_id, r.author_name,
                r.event_time, r.event_time_cursor, r.collected_at, r.stable_fields,
                r.stable_fields #>> '{relations,chatId}' AS context_id
           FROM anchor a
           CROSS JOIN LATERAL (
             SELECT id, dataset_id, platform, object_type, content_type,
                    external_id, url, title, body, author_external_id, author_name,
                    event_time,
                    to_char(event_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS event_time_cursor,
                    collected_at, stable_fields
               FROM core.canonical_records r
              WHERE a.dataset_id = '${datasetId}'
                AND a.object_type = 'message'
                AND a.event_time IS NOT NULL
                AND a.context_id IS NOT NULL
                AND r.dataset_id = '${datasetId}'
                AND r.platform = 'telegram'
                AND r.object_type = 'message'
                AND r.deleted_at IS NULL
                AND r.event_time IS NOT NULL
                AND r.stable_fields #>> '{relations,chatId}' IS NOT NULL
                AND r.stable_fields #>> '{relations,chatId}' = a.context_id
                AND (r.event_time, r.id) ${comparison} (a.event_time, a.id)
              ORDER BY r.event_time ${direction}, r.id ${direction}
              LIMIT ${limit}
           ) r
       )`,
  }
}

export function buildCanonicalContextStoragePlan(datasets = CANONICAL_CONTEXT_DATASETS) {
  const entries = canonicalContextDatasetEntries(datasets)
  const indexContracts = entries.map(([datasetId, dataset]) => Object.freeze({
    datasetId,
    name: dataset.servingIndexName,
    keys: Object.freeze([
      Object.freeze({ expression: "stable_fields #>> '{relations,chatId}'", options: 0 }),
      Object.freeze({ expression: 'event_time', options: 3 }),
      Object.freeze({ expression: 'id', options: 3 }),
    ]),
    predicate: Object.freeze([
      `dataset_id = '${datasetId}'`,
      "platform = 'telegram'",
      "object_type = 'message'",
      'deleted_at IS NULL',
    ]),
  }))
  const branches = entries.flatMap(([datasetId], position) => [
    canonicalContextQueryBranch(datasetId, position, 'before'),
    canonicalContextQueryBranch(datasetId, position, 'after'),
  ])
  const querySql = `WITH anchor AS MATERIALIZED (
         SELECT 'current'::text AS side,
                0::bigint AS side_position,
                id, dataset_id, platform, object_type, content_type,
                external_id, url, title, body, author_external_id, author_name,
                event_time,
                to_char(event_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS event_time_cursor,
                collected_at, stable_fields,
                stable_fields #>> '{relations,chatId}' AS context_id
           FROM core.canonical_records
          WHERE id = $1::uuid
            AND platform = 'telegram'
            AND deleted_at IS NULL
       ), ${branches.map((branch) => branch.sql).join(', ')}
       SELECT * FROM anchor
       ${branches.map((branch) => `UNION ALL SELECT * FROM ${branch.name}`).join('\n       ')}
       ORDER BY side, side_position`
  return Object.freeze({
    indexContracts: Object.freeze(indexContracts),
    querySql,
  })
}

const CANONICAL_CONTEXT_STORAGE_PLAN = buildCanonicalContextStoragePlan()
const CANONICAL_CONTEXT_SERVING_INDEX_CONTRACTS = CANONICAL_CONTEXT_STORAGE_PLAN.indexContracts
const CANONICAL_CONTEXT_QUERY_SQL = CANONICAL_CONTEXT_STORAGE_PLAN.querySql

export function buildCanonicalTimelineStoragePlan(datasets = CANONICAL_CONTEXT_DATASETS) {
  const entries = canonicalContextDatasetEntries(datasets)
  return Object.freeze(Object.fromEntries(entries.map(([datasetId]) => [
    datasetId,
    Object.freeze(Object.fromEntries(['older', 'newer'].map((direction) => {
      const older = direction === 'older'
      const comparison = older ? '<' : '>'
      const order = older ? 'DESC' : 'ASC'
      return [direction, `SELECT r.id, r.dataset_id, r.platform, r.object_type, r.content_type,
              r.external_id, r.url, r.title, r.body, r.author_external_id, r.author_name,
              r.event_time,
              to_char(r.event_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS event_time_cursor,
              r.collected_at, r.stable_fields,
              r.stable_fields #>> '{relations,chatId}' AS context_id
         FROM core.canonical_records r
        WHERE r.dataset_id = '${datasetId}'
          AND r.platform = 'telegram'
          AND r.object_type = 'message'
          AND r.deleted_at IS NULL
          AND r.event_time IS NOT NULL
          AND r.stable_fields #>> '{relations,chatId}' = $1
          AND (r.event_time, r.id) ${comparison} ($2::timestamptz, $3::uuid)
        ORDER BY r.event_time ${order}, r.id ${order}
        LIMIT $4`]
    }))),
  ])))
}

const CANONICAL_TIMELINE_PAGE_SQL = buildCanonicalTimelineStoragePlan()
const PUBLIC_OPINION_SERVING_INDEX_CONTRACTS = Object.freeze([
  {
    name: 'canonical_province_opinion_hot_idx',
    keys: [
      { expression: 'admin1_code', options: 0 },
      { expression: 'heat_score', options: 1 },
      { expression: 'coalesce(event_time, collected_at)', options: 1 },
      { expression: 'id', options: 3 },
    ],
    predicate: [
      "dataset_id = 'public-opinion.province.v1'",
      "platform = 'public_opinion'",
      "object_type = 'opinion_item'",
      'deleted_at IS NULL',
      'admin1_code IS NOT NULL',
      'heat_score IS NOT NULL',
      'collected_at IS NOT NULL',
    ],
  },
  {
    name: 'canonical_province_opinion_latest_idx',
    keys: [
      { expression: 'admin1_code', options: 0 },
      { expression: 'coalesce(event_time, collected_at)', options: 1 },
      { expression: 'collected_at', options: 1 },
      { expression: 'id', options: 3 },
    ],
    predicate: [
      "dataset_id = 'public-opinion.province.v1'",
      "platform = 'public_opinion'",
      "object_type = 'opinion_item'",
      'deleted_at IS NULL',
      'admin1_code IS NOT NULL',
      'collected_at IS NOT NULL',
    ],
  },
])
const PUBLIC_OPINION_REGION_SERVING_INDEX_CONTRACTS = Object.freeze([
  {
    name: 'canonical_public_opinion_region_latest_idx',
    table: 'canonical_records',
    keys: [
      { expression: 'coalesce(event_time, collected_at)', options: 1 },
      { expression: 'collected_at', options: 1 },
      { expression: 'id', options: 3 },
    ],
    predicate: [
      "dataset_id = 'public-opinion.province.v1'",
      "platform = 'public_opinion'",
      "object_type = 'opinion_item'",
      'deleted_at IS NULL',
      'collected_at IS NOT NULL',
    ],
  },
  {
    name: 'public_opinion_current_state_region_idx',
    table: 'public_opinion_current_state',
    keys: [
      { expression: 'display_admin1_code', options: 0 },
      { expression: 'record_id', options: 0 },
      { expression: 'canonical_revision', options: 0 },
    ],
    predicate: ['display_admin1_code IS NOT NULL'],
  },
])

function lowerSqlOutsideLiterals(value) {
  const input = String(value ?? '')
  let output = ''
  let inLiteral = false
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]
    if (character === "'") {
      output += character
      if (inLiteral && input[index + 1] === "'") {
        output += input[index + 1]
        index += 1
      } else {
        inLiteral = !inLiteral
      }
    } else {
      output += inLiteral ? character : character.toLowerCase()
    }
  }
  return output
}

function normalizeIndexFragment(value) {
  return lowerSqlOutsideLiterals(value)
    .replace(/::(?:text(?:\[\])?|character varying)/g, '')
    .replace(/[()"\s]/g, '')
}

function normalizedPredicateTerms(value) {
  return normalizeIndexFragment(value).split('and').filter(Boolean).sort()
}

function servingIndexMatches(row, contract) {
  if (
    row?.indisready !== true
    || row?.indisvalid !== true
    || row?.indislive !== true
    || row?.access_method !== 'btree'
    || Number(row?.key_count) !== contract.keys.length
  ) return false
  const actualKeys = [row.key_1, row.key_2, row.key_3, row.key_4]
    .slice(0, contract.keys.length)
    .map(normalizeIndexFragment)
  const expectedKeys = contract.keys.map((key) => normalizeIndexFragment(key.expression))
  if (!actualKeys.every((key, index) => key === expectedKeys[index])) return false
  const actualOptions = [
    row.key_1_options,
    row.key_2_options,
    row.key_3_options,
    row.key_4_options,
  ].slice(0, contract.keys.length).map(Number)
  if (!actualOptions.every((options, index) => options === contract.keys[index].options)) return false
  const actualPredicate = normalizedPredicateTerms(row.predicate)
  const expectedPredicate = contract.predicate.map(normalizeIndexFragment).sort()
  return actualPredicate.length === expectedPredicate.length
    && actualPredicate.every((term, index) => term === expectedPredicate[index])
}

function compatibilityTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) {
    throw new AppError(400, 'invalid_compatibility_timestamp', 'Compatibility timestamp is invalid')
  }
  return date
}

function assertConnectorOutcome(outcome) {
  if (!connectorCallOutcomes.has(outcome)) {
    throw new AppError(400, 'invalid_connector_outcome', 'Connector outcome is invalid')
  }
}

function assertConnectorSourceMode(sourceMode) {
  if (!connectorSourceModes.has(sourceMode)) {
    throw new AppError(400, 'invalid_connector_source_mode', 'Connector source mode is invalid')
  }
}

function assertConnectorFailureKind(failureKind) {
  if (failureKind != null && !connectorFailureKinds.has(failureKind)) {
    throw new AppError(400, 'invalid_connector_failure_kind', 'Connector failure kind is invalid')
  }
}

function assertTransientFallback({ failureKind, httpStatus }) {
  const eligible = ((failureKind === 'network' || failureKind === 'timeout') && httpStatus == null)
    || (failureKind === 'contract' && httpStatus == null)
    || (failureKind === 'http' && transientHttpStatuses.has(httpStatus))
  if (!eligible) {
    throw new AppError(
      409,
      'compatibility_fallback_not_allowed',
      'Only network, timeout, invalid-success-contract, or HTTP 502/503/504 failures may use a compatibility snapshot',
    )
  }
}

// Format rules are shared across files whose concrete header spelling may
// differ only by case, Unicode width or whitespace.  Source mappings retain
// the concrete parser column names used for that source; rule versions store
// this canonical form so semantic equality does not depend on those spellings.
function canonicalFileFieldMap(fieldMap) {
  const canonical = {}
  for (const [target, rule] of Object.entries(fieldMap || {})) {
    const normalizeColumn = (column) => String(column)
      .normalize('NFKC')
      .trim()
      .replace(/\s+/gu, ' ')
      .toLowerCase()
    canonical[target] = {
      ...rule,
      from: Array.isArray(rule.from)
        ? rule.from.map(normalizeColumn)
        : normalizeColumn(rule.from),
    }
  }
  return canonical
}

function tenant(row) {
  return row && {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function consumer(row) {
  return row && {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    status: row.status,
    businessId: row.business_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function apiKey(row) {
  const expired = row?.status === 'active'
    && row.expires_at != null
    && new Date(row.expires_at).getTime() <= Date.now()
  return row && {
    id: row.id,
    tenantId: row.tenant_id,
    consumerId: row.consumer_id,
    name: row.name,
    prefix: row.key_prefix,
    lastFour: row.last_four,
    environment: row.environment,
    status: row.status,
    effectiveStatus: expired ? 'expired' : row.status,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
    lastUsedAt: iso(row.last_used_at),
  }
}

function requestRecord(row) {
  return row && {
    id: row.id,
    tenantId: row.tenant_id,
    consumerId: row.consumer_id,
    apiKeyId: row.api_key_id,
    idempotencyKey: row.idempotency_key,
    fingerprint: row.fingerprint,
    platform: row.platform,
    status: row.status,
    unitsReserved: row.units_reserved,
    unitsActual: row.units_actual,
    responseStatus: row.response_status,
    responseBody: row.response_body,
    errorCode: row.error_code,
    capability: row.capability,
    upstreamLatencyMs: row.upstream_latency_ms,
    deliverySourceMode: row.delivery_source_mode,
    capturedAt: iso(row.response_captured_at),
    snapshotId: row.compatibility_snapshot_id,
    reservedAt: iso(row.reserved_at),
    leaseExpiresAt: iso(row.lease_expires_at),
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at),
  }
}

function connectorCallRecord(row) {
  return row && {
    id: row.id,
    consumerId: row.consumer_id,
    requestId: row.usage_request_id,
    operation: row.operation,
    fingerprint: row.request_fingerprint,
    platform: row.platform,
    sourceMode: row.source_mode,
    outcome: row.outcome,
    httpStatus: row.http_status,
    businessStatus: row.business_status,
    failureKind: row.failure_kind,
    upstreamLatencyMs: row.upstream_latency_ms,
    errorCode: row.error_code,
    nightAllRequestId: row.upstream_request_id,
    nightAllTraceId: row.upstream_trace_id,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at),
  }
}

function compatibilitySnapshotRecord(row) {
  return row && {
    id: row.id,
    consumerId: row.consumer_id,
    operation: row.operation,
    fingerprint: row.request_fingerprint,
    platform: row.platform,
    responseBody: row.response_body,
    capturedAt: iso(row.captured_at),
    staleUntil: iso(row.stale_until),
    lastSuccessCallId: row.last_success_call_id,
    supersededAt: iso(row.superseded_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function policy(row) {
  return row && {
    tenantId: row.tenant_id,
    consumerId: row.consumer_id,
    platform: row.platform,
    maxRequests: row.max_requests,
    windowSeconds: row.window_seconds,
    maxPageSize: row.max_page_size,
    updatedAt: iso(row.updated_at),
  }
}

function capabilityPolicy(row) {
  return row && {
    tenantId: row.tenant_id,
    consumerId: row.consumer_id,
    capability: row.capability,
    maxRequests: row.max_requests,
    windowSeconds: row.window_seconds,
    updatedAt: iso(row.updated_at),
  }
}

/**
 * Decide whether a committed request may still be replayed verbatim.
 *
 * An Idempotency-Key exists to make a retry safe, and a retry happens within
 * seconds. Replaying forever quietly turns the key into a cache: a caller that
 * reuses one keeps receiving a frozen answer while the data underneath moves,
 * which is wrong for a search over a corpus that ingests continuously.
 *
 * A null window keeps the unbounded behaviour, which is what the `stable`
 * result type is for -- there it is the point, not an accident.
 */
function replayExpired(existing, replayWindowMs) {
  if (replayWindowMs == null) return false
  if (!existing.completedAt) return false
  return Date.now() - new Date(existing.completedAt).getTime() > replayWindowMs
}

export class PostgresStore {
  constructor(pool) {
    this.pool = pool
  }

  async close() {
    await this.pool.end()
  }

  async ping() {
    await this.pool.query('SELECT 1')
    return true
  }

  async reapStaleReservations() {
    const { rows } = await this.pool.query(
      `WITH reaped AS (
         UPDATE usage_requests SET
           status = 'unknown', error_code = 'reservation_lease_expired', completed_at = now()
         WHERE status = 'reserved' AND lease_expires_at IS NOT NULL AND lease_expires_at <= now()
         RETURNING id
       ), closed_calls AS (
         UPDATE serving.connector_calls call SET
           outcome = 'unknown', business_status = 'unknown', failure_kind = 'unknown',
           error_code = 'reservation_lease_expired', completed_at = now()
         FROM reaped
         WHERE call.usage_request_id = reaped.id AND call.outcome IS NULL
         RETURNING call.id
       ), closed_external_platform_calls AS (
         UPDATE external_platform.provider_calls call SET
           outcome = 'unknown', error_code = 'reservation_lease_expired',
           completed_at = now()
         FROM reaped
         WHERE call.usage_request_id = reaped.id AND call.outcome = 'pending'
         RETURNING call.id
       )
       SELECT count(*)::integer AS reaped FROM reaped`,
    )
    return Number(rows[0]?.reaped || 0)
  }

  async createTenant({ name, status = 'active' }) {
    const { rows } = await this.pool.query(
      `INSERT INTO tenants (id, name, status) VALUES ($1, $2, $3) RETURNING *`,
      [randomUUID(), name, status],
    )
    return tenant(rows[0])
  }

  async listTenants() {
    const { rows } = await this.pool.query('SELECT * FROM tenants ORDER BY created_at DESC')
    return rows.map(tenant)
  }

  async getTenant(id) {
    const { rows } = await this.pool.query('SELECT * FROM tenants WHERE id = $1', [id])
    return tenant(rows[0]) || null
  }

  async renameTenant(id, name) {
    const { rows } = await this.pool.query(
      'UPDATE tenants SET name = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [id, name],
    )
    return tenant(rows[0]) || null
  }

  async createConsumer({ tenantId, name, status = 'active', businessId, defaultCapabilityPolicy = null }) {
    const id = randomUUID()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `INSERT INTO consumers (id, tenant_id, name, status, business_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [id, tenantId, name, status, businessId || `mxih:${tenantId}:${id}`],
      )
      if (defaultCapabilityPolicy) {
        const { capability, maxRequests, windowSeconds } = defaultCapabilityPolicy
        await client.query(
          'INSERT INTO capability_grants (consumer_id, capability) VALUES ($1, $2)',
          [id, capability],
        )
        await client.query(
          `INSERT INTO consumer_capability_policies
             (tenant_id, consumer_id, capability, max_requests, window_seconds)
           VALUES ($1, $2, $3, $4, $5)`,
          [tenantId, id, capability, maxRequests, windowSeconds],
        )
      }
      await client.query('COMMIT')
      return consumer(rows[0])
    } catch (error) {
      await client.query('ROLLBACK')
      if (error?.code === '23505' && /business_id/i.test(error?.constraint || error?.detail || '')) {
        throw new AppError(409, 'business_id_conflict', 'businessId is already assigned to another consumer')
      }
      throw error
    } finally {
      client.release()
    }
  }

  async listConsumers(tenantId) {
    const { rows } = tenantId
      ? await this.pool.query('SELECT * FROM consumers WHERE tenant_id = $1 ORDER BY created_at DESC', [tenantId])
      : await this.pool.query('SELECT * FROM consumers ORDER BY created_at DESC')
    return rows.map(consumer)
  }

  async getConsumer(id) {
    const { rows } = await this.pool.query('SELECT * FROM consumers WHERE id = $1', [id])
    return consumer(rows[0]) || null
  }

  async createApiKey({ id, tenantId, consumerId, name, digest, prefix, lastFour, environment = 'live', status = 'active', expiresAt }) {
    const { rows } = await this.pool.query(
      `INSERT INTO api_keys
         (id, tenant_id, consumer_id, name, key_digest, key_prefix, last_four, environment, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [id, tenantId, consumerId, name, digest, prefix, lastFour, environment, status, expiresAt],
    )
    return apiKey(rows[0])
  }

  async listApiKeys(consumerId) {
    const { rows } = consumerId
      ? await this.pool.query('SELECT * FROM api_keys WHERE consumer_id = $1 ORDER BY created_at DESC', [consumerId])
      : await this.pool.query('SELECT * FROM api_keys ORDER BY created_at DESC')
    return rows.map(apiKey)
  }

  async findApiKeyByDigest(digest) {
    const { rows } = await this.pool.query(
      `SELECT
         k.*,
         row_to_json(c) AS consumer_record,
         row_to_json(t) AS tenant_record
       FROM api_keys k
       JOIN consumers c ON c.id = k.consumer_id AND c.status = 'active'
       JOIN tenants t ON t.id = k.tenant_id AND t.status = 'active'
       WHERE k.key_digest = $1
         AND k.status = 'active'
         AND k.expires_at > now()`,
      [digest],
    )
    if (!rows[0]) return null
    await this.pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [rows[0].id])
    return {
      apiKey: apiKey(rows[0]),
      consumer: consumer(rows[0].consumer_record),
      tenant: tenant(rows[0].tenant_record),
    }
  }

  async revokeApiKey(id) {
    const { rows } = await this.pool.query(
      `UPDATE api_keys SET status = 'revoked', revoked_at = now()
       WHERE id = $1 RETURNING *`,
      [id],
    )
    if (!rows[0]) throw new AppError(404, 'api_key_not_found', 'API key not found')
    return apiKey(rows[0])
  }

  async replaceGrants(consumerId, platforms) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM platform_grants WHERE consumer_id = $1', [consumerId])
      for (const platformName of [...new Set(platforms)]) {
        await client.query(
          'INSERT INTO platform_grants (consumer_id, platform) VALUES ($1, $2)',
          [consumerId, platformName],
        )
      }
      await client.query('COMMIT')
      return [...new Set(platforms)].sort()
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async setPlatformGrant(consumerId, platformName, enabled) {
    if (enabled) {
      await this.pool.query(
        `INSERT INTO platform_grants (consumer_id, platform) VALUES ($1, $2)
         ON CONFLICT (consumer_id, platform) DO NOTHING`,
        [consumerId, platformName],
      )
      return
    }
    await this.pool.query(
      'DELETE FROM platform_grants WHERE consumer_id = $1 AND platform = $2',
      [consumerId, platformName],
    )
  }

  async listGrants(consumerId) {
    const { rows } = await this.pool.query(
      'SELECT platform FROM platform_grants WHERE consumer_id = $1 ORDER BY platform',
      [consumerId],
    )
    return rows.map((row) => row.platform)
  }

  async listCapabilityGrants(consumerId) {
    const { rows } = await this.pool.query(
      'SELECT capability FROM capability_grants WHERE consumer_id = $1 ORDER BY capability',
      [consumerId],
    )
    return rows.map((row) => row.capability)
  }

  async putCapabilityConfiguration({
    tenantId,
    consumerId,
    capability,
    enabled,
    maxRequests,
    windowSeconds,
  }) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      if (enabled) {
        await client.query(
          `INSERT INTO capability_grants (consumer_id, capability) VALUES ($1, $2)
           ON CONFLICT (consumer_id, capability) DO NOTHING`,
          [consumerId, capability],
        )
      } else {
        await client.query(
          'DELETE FROM capability_grants WHERE consumer_id = $1 AND capability = $2',
          [consumerId, capability],
        )
      }
      const { rows } = await client.query(
        `INSERT INTO consumer_capability_policies
           (tenant_id, consumer_id, capability, max_requests, window_seconds)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (consumer_id, capability) DO UPDATE SET
           tenant_id = EXCLUDED.tenant_id,
           max_requests = EXCLUDED.max_requests,
           window_seconds = EXCLUDED.window_seconds,
           updated_at = now()
         RETURNING *`,
        [tenantId, consumerId, capability, maxRequests, windowSeconds],
      )
      await client.query('COMMIT')
      return capabilityPolicy(rows[0])
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async putPolicy({ tenantId, consumerId, platform: platformName, maxRequests, windowSeconds, maxPageSize }) {
    const { rows } = await this.pool.query(
      `INSERT INTO consumer_platform_policies
         (tenant_id, consumer_id, platform, max_requests, window_seconds, max_page_size)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (consumer_id, platform) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         max_requests = EXCLUDED.max_requests,
         window_seconds = EXCLUDED.window_seconds,
         max_page_size = EXCLUDED.max_page_size,
         updated_at = now()
       RETURNING *`,
      [tenantId, consumerId, platformName, maxRequests, windowSeconds, maxPageSize],
    )
    return policy(rows[0])
  }

  async getPolicy(consumerId, platformName) {
    const { rows } = await this.pool.query(
      'SELECT * FROM consumer_platform_policies WHERE consumer_id = $1 AND platform = $2',
      [consumerId, platformName],
    )
    return policy(rows[0]) || null
  }

  async listPolicies(consumerId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM consumer_platform_policies WHERE consumer_id = $1 ORDER BY platform',
      [consumerId],
    )
    return rows.map(policy)
  }

  async getCapabilityPolicy(consumerId, capability) {
    const { rows } = await this.pool.query(
      'SELECT * FROM consumer_capability_policies WHERE consumer_id = $1 AND capability = $2',
      [consumerId, capability],
    )
    return capabilityPolicy(rows[0]) || null
  }

  async listCapabilityPolicies(consumerId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM consumer_capability_policies WHERE consumer_id = $1 ORDER BY capability',
      [consumerId],
    )
    return rows.map(capabilityPolicy)
  }

  async getUsageRequestByIdempotencyKey(consumerId, idempotencyKey) {
    const { rows } = await this.pool.query(
      `SELECT * FROM usage_requests
       WHERE consumer_id = $1 AND idempotency_key = $2`,
      [consumerId, idempotencyKey],
    )
    return requestRecord(rows[0]) || null
  }

  async reserve(input) {
    if (Boolean(input.platform) === Boolean(input.capability)) {
      throw new AppError(500, 'invalid_usage_scope', 'Usage reservation requires exactly one scope')
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${input.tenantId}:${input.consumerId}:${input.capability ? `capability:${input.capability}` : `platform:${input.platform}`}`,
      ])
      const { rows } = await client.query(
        `SELECT * FROM usage_requests
         WHERE consumer_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [input.consumerId, input.idempotencyKey],
      )
      const existing = requestRecord(rows[0])
      if (existing) {
        let kind
        if (existing.fingerprint !== input.fingerprint) kind = 'conflict'
        else if (existing.status === 'committed' && !replayExpired(existing, input.replayWindowMs)) {
          kind = 'replay'
        } else if (existing.status === 'reserved') kind = 'in_progress'
        else if (existing.status === 'unknown') kind = 'unknown'
        else {
          await this.#assertQuota(client, input)
          const updated = await client.query(
            `UPDATE usage_requests SET
               status = 'reserved', api_key_id = $2, units_reserved = $3,
               reserved_at = now(), lease_expires_at = $4,
               units_actual = NULL, response_status = NULL, response_body = NULL,
               upstream_latency_ms = NULL, delivery_source_mode = NULL,
               response_captured_at = NULL, compatibility_snapshot_id = NULL,
               completed_at = NULL, error_code = NULL
             WHERE id = $1 RETURNING *`,
            [existing.id, input.apiKeyId, input.unitsReserved, input.leaseExpiresAt],
          )
          await client.query('COMMIT')
          return { kind: 'reserved', request: requestRecord(updated.rows[0]) }
        }
        await client.query('COMMIT')
        return { kind, request: existing }
      }

      await this.#assertQuota(client, input)
      const inserted = await client.query(
        `INSERT INTO usage_requests
           (id, tenant_id, consumer_id, api_key_id, idempotency_key, fingerprint,
            platform, capability, status, units_reserved, lease_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'reserved', $9, $10)
         RETURNING *`,
        [
          input.requestId,
          input.tenantId,
          input.consumerId,
          input.apiKeyId,
          input.idempotencyKey,
          input.fingerprint,
          input.platform ?? null,
          input.capability ?? null,
          input.unitsReserved,
          input.leaseExpiresAt,
        ],
      )
      await client.query('COMMIT')
      return { kind: 'reserved', request: requestRecord(inserted.rows[0]) }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async #assertQuota(client, input) {
    const { rows } = await client.query(
      `SELECT count(*)::integer AS count
       FROM usage_requests
       WHERE tenant_id = $1 AND consumer_id = $2
         AND platform IS NOT DISTINCT FROM $3
         AND capability IS NOT DISTINCT FROM $4
         AND status IN ('reserved', 'committed', 'unknown')
         AND reserved_at >= $5`,
      [input.tenantId, input.consumerId, input.platform ?? null, input.capability ?? null, input.windowStart],
    )
    if (rows[0].count >= input.maxRequests) {
      throw new AppError(429, 'quota_exceeded', 'Request quota exceeded', {
        ...(input.platform ? { platform: input.platform } : { capability: input.capability }),
        maxRequests: input.maxRequests,
      })
    }
  }

  async commitRequest(id, { responseStatus, responseBody, unitsActual, upstreamLatencyMs }) {
    return this.#updateRequest(
      `UPDATE usage_requests SET
         status = 'committed', response_status = $2, response_body = $3,
         units_actual = $4, upstream_latency_ms = $5, completed_at = now()
       WHERE id = $1 AND status = 'reserved' RETURNING *`,
      [id, responseStatus, responseBody, unitsActual, upstreamLatencyMs],
    )
  }

  async beginConnectorCall({
    id = randomUUID(),
    consumerId,
    requestId = null,
    operation,
    fingerprint,
    platform = null,
    sourceMode = 'live',
  }) {
    if (!/^[a-z][a-z0-9._-]{0,127}$/.test(operation || '')) {
      throw new AppError(400, 'invalid_connector_operation', 'Connector operation is invalid')
    }
    if (!/^[0-9a-f]{64}$/.test(fingerprint || '')) {
      throw new AppError(400, 'invalid_connector_fingerprint', 'Connector fingerprint is invalid')
    }
    assertConnectorSourceMode(sourceMode)
    const { rows } = await this.pool.query(
      `INSERT INTO serving.connector_calls
         (id, consumer_id, usage_request_id, operation, request_fingerprint,
          platform, source_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [id, consumerId, requestId, operation, fingerprint, platform, sourceMode],
    )
    return connectorCallRecord(rows[0])
  }

  async finishConnectorCall(id, {
    outcome,
    httpStatus = null,
    businessStatus = null,
    failureKind = null,
    upstreamLatencyMs = null,
    errorCode = null,
    sourceMode = 'live',
    nightAllRequestId = null,
    nightAllTraceId = null,
  }) {
    assertConnectorOutcome(outcome)
    assertConnectorSourceMode(sourceMode)
    assertConnectorFailureKind(failureKind)
    const { rows } = await this.pool.query(
      `UPDATE serving.connector_calls SET
         outcome = $2, http_status = $3, business_status = $4,
         failure_kind = $5, upstream_latency_ms = $6, error_code = $7,
         source_mode = $8, upstream_request_id = $9, upstream_trace_id = $10,
         completed_at = now()
       WHERE id = $1 AND outcome IS NULL
       RETURNING *`,
      [
        id, outcome, httpStatus, businessStatus, failureKind, upstreamLatencyMs,
        errorCode, sourceMode, nightAllRequestId, nightAllTraceId,
      ],
    )
    if (!rows[0]) throw new AppError(404, 'connector_call_not_found', 'Connector call not found')
    return connectorCallRecord(rows[0])
  }

  async commitCompatibilityLiveDelivery(id, {
    outcome,
    responseStatus = 200,
    responseBody,
    unitsActual = 1,
    httpStatus = 200,
    businessStatus = null,
    failureKind = null,
    upstreamLatencyMs = null,
    errorCode = null,
    nightAllRequestId = null,
    nightAllTraceId = null,
    capturedAt = new Date(),
    staleUntil = null,
    job = null,
  }) {
    if (!['complete', 'partial'].includes(outcome)) {
      throw new AppError(400, 'invalid_live_delivery_outcome', 'Live delivery must be complete or partial')
    }
    if (responseBody === undefined) {
      throw new AppError(400, 'compatibility_response_required', 'Live delivery requires a response body')
    }
    assertConnectorFailureKind(failureKind)
    const captured = compatibilityTimestamp(capturedAt)
    let stale = null
    if (outcome === 'complete') {
      if (staleUntil == null) {
        throw new AppError(400, 'compatibility_stale_until_required', 'Complete live delivery requires staleUntil')
      }
      stale = compatibilityTimestamp(staleUntil)
      if (stale < captured) {
        throw new AppError(400, 'invalid_compatibility_stale_until', 'staleUntil must not precede capturedAt')
      }
    }

    return withPgTransaction(this.pool, async (client) => {
      const locked = await client.query(
        `SELECT * FROM serving.connector_calls
         WHERE id = $1 AND outcome IS NULL
         FOR UPDATE`,
        [id],
      )
      const call = locked.rows[0]
      if (!call) throw new AppError(404, 'connector_call_not_found', 'Connector call not found')

      let snapshot = null
      if (outcome === 'complete') {
        const snapshotLockKey = `${call.consumer_id}:${call.operation}:${call.request_fingerprint}`
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [snapshotLockKey],
        )
        const current = await client.query(
          `SELECT * FROM serving.compatibility_snapshots
           WHERE consumer_id = $1 AND operation = $2 AND request_fingerprint = $3
             AND superseded_at IS NULL
           FOR UPDATE`,
          [call.consumer_id, call.operation, call.request_fingerprint],
        )
        const currentSnapshot = current.rows[0] || null
        if (!currentSnapshot || new Date(currentSnapshot.captured_at) <= captured) {
          if (currentSnapshot) {
            await client.query(
              `UPDATE serving.compatibility_snapshots
               SET superseded_at = now(), updated_at = now()
               WHERE id = $1 AND superseded_at IS NULL`,
              [currentSnapshot.id],
            )
          }
          const stored = await client.query(
            `INSERT INTO serving.compatibility_snapshots
               (id, consumer_id, operation, request_fingerprint, platform,
                response_body, captured_at, stale_until, last_success_call_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [
              randomUUID(), call.consumer_id, call.operation, call.request_fingerprint,
              call.platform, responseBody, captured, stale, id,
            ],
          )
          snapshot = stored.rows[0] || null
        }
      }

      const committed = await client.query(
        `UPDATE usage_requests SET
           status = 'committed', response_status = $2, response_body = $3,
           units_actual = $4, upstream_latency_ms = $5,
           delivery_source_mode = 'live', response_captured_at = $6,
           compatibility_snapshot_id = $7, completed_at = now()
         WHERE id = $1 AND consumer_id = $8 AND status = 'reserved'
         RETURNING *`,
        [
          call.usage_request_id, responseStatus, responseBody, unitsActual,
          upstreamLatencyMs, captured, snapshot?.id || null, call.consumer_id,
        ],
      )
      if (!committed.rows[0]) throw new AppError(404, 'request_not_found', 'Request not found')

      const completed = await client.query(
        `UPDATE serving.connector_calls SET
           outcome = $2, http_status = $3, business_status = $4,
           failure_kind = $5, upstream_latency_ms = $6, error_code = $7,
           source_mode = 'live', upstream_request_id = $8, upstream_trace_id = $9,
           completed_at = now()
         WHERE id = $1 AND outcome IS NULL
         RETURNING *`,
        [
          id, outcome, httpStatus, businessStatus, failureKind, upstreamLatencyMs,
          errorCode, nightAllRequestId, nightAllTraceId,
        ],
      )
      if (!completed.rows[0]) {
        throw new AppError(409, 'connector_call_state_conflict', 'Connector call is already complete')
      }

      if (job) {
        await client.query(
          `INSERT INTO mxq.jobs (queue, payload, dedupe_key, priority)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (queue, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running')
           DO NOTHING`,
          [job.queue, job.payload, job.dedupeKey, job.priority ?? 100],
        )
      }

      return {
        request: requestRecord(committed.rows[0]),
        call: connectorCallRecord(completed.rows[0]),
        snapshot: compatibilitySnapshotRecord(snapshot),
      }
    }, { outcomeUnknownCode: 'compatibility_delivery_outcome_unknown' })
  }

  async findUsableCompatibilitySnapshot({ consumerId, operation, fingerprint, at = new Date() }) {
    const { rows } = await this.pool.query(
      `SELECT * FROM serving.compatibility_snapshots
       WHERE consumer_id = $1 AND operation = $2 AND request_fingerprint = $3
         AND superseded_at IS NULL AND stale_until >= $4`,
      [consumerId, operation, fingerprint, compatibilityTimestamp(at)],
    )
    return compatibilitySnapshotRecord(rows[0]) || null
  }

  async commitCompatibilityStaleDelivery(id, {
    snapshotId,
    responseStatus = 200,
    unitsActual = 1,
    httpStatus = null,
    businessStatus = null,
    failureKind,
    upstreamLatencyMs = null,
    errorCode = null,
    nightAllRequestId = null,
    nightAllTraceId = null,
    at = new Date(),
  }) {
    assertTransientFallback({ failureKind, httpStatus })
    const deliveredAt = compatibilityTimestamp(at)
    return withPgTransaction(this.pool, async (client) => {
      const locked = await client.query(
        `SELECT * FROM serving.connector_calls
         WHERE id = $1 AND outcome IS NULL
         FOR UPDATE`,
        [id],
      )
      const call = locked.rows[0]
      if (!call) throw new AppError(404, 'connector_call_not_found', 'Connector call not found')

      const found = await client.query(
        `SELECT * FROM serving.compatibility_snapshots
         WHERE id = $1 AND consumer_id = $2 AND operation = $3
           AND request_fingerprint = $4 AND stale_until >= $5
         FOR SHARE`,
        [
          snapshotId, call.consumer_id, call.operation, call.request_fingerprint,
          deliveredAt,
        ],
      )
      const snapshot = found.rows[0]
      if (!snapshot) {
        throw new AppError(409, 'compatibility_snapshot_unavailable', 'Compatibility snapshot is unavailable')
      }

      const committed = await client.query(
        `UPDATE usage_requests SET
           status = 'committed', response_status = $2, response_body = $3,
           units_actual = $4, upstream_latency_ms = $5,
           delivery_source_mode = 'stale', response_captured_at = $6,
           compatibility_snapshot_id = $7, completed_at = $8
         WHERE id = $1 AND consumer_id = $9 AND status = 'reserved'
         RETURNING *`,
        [
          call.usage_request_id, responseStatus, snapshot.response_body, unitsActual,
          upstreamLatencyMs, snapshot.captured_at, snapshot.id, deliveredAt,
          call.consumer_id,
        ],
      )
      if (!committed.rows[0]) throw new AppError(404, 'request_not_found', 'Request not found')

      const completed = await client.query(
        `UPDATE serving.connector_calls SET
           outcome = $2, http_status = $3, business_status = $4,
           failure_kind = $5, upstream_latency_ms = $6, error_code = $7,
           source_mode = 'stale', upstream_request_id = $8, upstream_trace_id = $9,
           completed_at = $10
         WHERE id = $1 AND outcome IS NULL
         RETURNING *`,
        [
          id, failureKind === 'http' ? 'failed' : 'unknown',
          httpStatus, businessStatus, failureKind, upstreamLatencyMs, errorCode,
          nightAllRequestId, nightAllTraceId, deliveredAt,
        ],
      )
      if (!completed.rows[0]) {
        throw new AppError(409, 'connector_call_state_conflict', 'Connector call is already complete')
      }

      return {
        request: requestRecord(committed.rows[0]),
        call: connectorCallRecord(completed.rows[0]),
        snapshot: compatibilitySnapshotRecord(snapshot),
      }
    }, { outcomeUnknownCode: 'compatibility_delivery_outcome_unknown' })
  }

  releaseRequest(id, errorCode) {
    return this.#updateRequest(
      `UPDATE usage_requests SET status = 'released', error_code = $2, completed_at = now()
       WHERE id = $1 AND status = 'reserved' RETURNING *`,
      [id, errorCode],
    )
  }

  markRequestUnknown(id, errorCode) {
    return this.#updateRequest(
      `UPDATE usage_requests SET status = 'unknown', error_code = $2, completed_at = now()
       WHERE id = $1 AND status IN ('reserved', 'committed') RETURNING *`,
      [id, errorCode],
    )
  }

  // Persist an upstream search result as authoritative Hub data.
  //
  // Ordering follows ADR-0006: the ingest run, raw source object, canonical
  // upsert, revision, observation and outbox event all commit together, so a
  // crash can only lose the whole batch and a replay is idempotent:
  //   * unchanged content keeps its revision, writes no new revision row and
  //     enqueues no projection event;
  //   * a repeated batch collides on the observation hash and is ignored;
  //   * changed content bumps current/projection revision and emits one event.
  //
  // `rawPayload` must be the pre-redaction upstream payload: provider and
  // endpoint identifiers are lineage evidence and never reach public responses.
  async ingestSearchResult({ platform, rawPayload, queryFingerprint = null, requestId = null }) {
    const { records, skipped } = normalizeSearchPayload(rawPayload, platform)
    if (records.length === 0) return { ingested: 0, changed: 0, skipped, runId: null }

    const stream = streamId(platform)
    const runId = randomUUID()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO ingest.ingest_runs
           (id, connector_id, stream_id, trigger, request_id, query_fingerprint)
         VALUES ($1, $2, $3, 'api_search', $4, $5)`,
        [runId, CONNECTOR_ID, stream, requestId, queryFingerprint],
      )

      let changed = 0
      for (const record of records) {
        await client.query(
          `INSERT INTO ingest.source_objects
             (id, connector_id, stream_id, object_type, source_key,
              payload_sha256, raw_payload, source_updated_at, ingest_run_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (connector_id, stream_id, object_type, source_key) DO UPDATE SET
             payload_sha256 = EXCLUDED.payload_sha256,
             raw_payload = EXCLUDED.raw_payload,
             source_updated_at = EXCLUDED.source_updated_at,
             last_seen_at = now(),
             ingest_run_id = EXCLUDED.ingest_run_id`,
          [
            randomUUID(), CONNECTOR_ID, stream, record.objectType, record.externalId,
            record.payloadSha256, record.rawItem, record.eventTime, runId,
          ],
        )

        const upserted = await client.query(
          `INSERT INTO core.canonical_records
             (id, dataset_id, platform, object_type, external_id, schema_version,
              payload_sha256, content_type, url, title, body,
              author_external_id, author_name, event_time, collected_at,
              latitude, longitude, country_code, admin1_code, admin2_code,
              stable_fields, extensions)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                   $16, $17, $18, $19, $20, $21, $22)
           ON CONFLICT (dataset_id, platform, object_type, external_id) DO UPDATE SET
             payload_sha256 = EXCLUDED.payload_sha256,
             content_type = EXCLUDED.content_type,
             url = EXCLUDED.url,
             title = EXCLUDED.title,
             body = EXCLUDED.body,
             author_external_id = EXCLUDED.author_external_id,
             author_name = EXCLUDED.author_name,
             event_time = EXCLUDED.event_time,
             collected_at = EXCLUDED.collected_at,
             latitude = EXCLUDED.latitude,
             longitude = EXCLUDED.longitude,
             country_code = EXCLUDED.country_code,
             admin1_code = EXCLUDED.admin1_code,
             admin2_code = EXCLUDED.admin2_code,
             stable_fields = EXCLUDED.stable_fields,
             extensions = EXCLUDED.extensions,
             last_seen_at = now(),
             current_revision = core.canonical_records.current_revision
               + (core.canonical_records.payload_sha256 IS DISTINCT FROM EXCLUDED.payload_sha256)::int,
             projection_revision = core.canonical_records.projection_revision
               + (core.canonical_records.payload_sha256 IS DISTINCT FROM EXCLUDED.payload_sha256)::int
           RETURNING id, current_revision, projection_revision`,
          [
            randomUUID(), DATASET_ID, record.platform, record.objectType, record.externalId,
            SCHEMA_VERSION, record.payloadSha256, record.contentType, record.url,
            record.title, record.body, record.authorExternalId, record.authorName,
            record.eventTime, record.collectedAt, record.latitude, record.longitude,
            record.countryCode, record.admin1Code, record.admin2Code,
            record.stableFields, record.extensions,
          ],
        )
        const { id, current_revision: revision, projection_revision: projection } = upserted.rows[0]

        // Unchanged content collides on (record_id, revision) and is skipped.
        const revisionInsert = await client.query(
          `INSERT INTO core.record_revisions
             (record_id, revision, payload_sha256, normalized_payload, parser_version, ingest_run_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (record_id, revision) DO NOTHING`,
          [id, revision, record.payloadSha256, record.rawItem, PARSER_VERSION, runId],
        )
        if (revisionInsert.rowCount > 0) changed += 1

        await client.query(
          `INSERT INTO core.observations
             (id, record_id, connector_id, query_fingerprint, rank, metrics,
              observation_hash, ingest_run_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (record_id, observation_hash) DO NOTHING`,
          [
            randomUUID(), id, CONNECTOR_ID, queryFingerprint, record.rank ?? null,
            record.metrics || {}, observationHash(record, queryFingerprint), runId,
          ],
        )

        await client.query(
          `INSERT INTO outbox.projection_events
             (aggregate_type, aggregate_id, event_type, projection_revision, payload)
           VALUES ('canonical_record', $1, 'upsert', $2, $3)
           ON CONFLICT (aggregate_id, projection_revision) DO NOTHING`,
          [id, projection, { datasetId: DATASET_ID, platform: record.platform, objectType: record.objectType }],
        )
      }

      await client.query(
        `UPDATE ingest.ingest_runs SET item_count = $2, finished_at = now() WHERE id = $1`,
        [runId, records.length],
      )
      await client.query('COMMIT')
      return { ingested: records.length, changed, skipped, runId }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  /**
   * Commit a billed request and queue its ingestion in ONE transaction.
   *
   * This is the property the PostgreSQL queue driver exists for. Committing the
   * request and then enqueueing separately leaves a window where the caller has
   * a billed, committed response and the follow-up ingest job does not exist —
   * a silent data hole that nothing would ever detect. Here, if the request row
   * says committed, the job is in `mxq.jobs` by the same COMMIT.
   *
   * The payload travels inside the job rather than being re-fetched later,
   * because the upstream call was billed and is not repeatable.
   */
  async commitRequestAndEnqueueIngest(id, { responseStatus, responseBody, unitsActual, upstreamLatencyMs }, job) {
    return withPgTransaction(this.pool, async (client) => {
      const { rows } = await client.query(
          `UPDATE usage_requests
            SET status = 'committed', response_status = $2, response_body = $3,
                units_actual = $4, upstream_latency_ms = $5, completed_at = now()
          WHERE id = $1 AND status = 'reserved'
          RETURNING *`,
        [id, responseStatus, responseBody, unitsActual, upstreamLatencyMs],
      )
      if (!rows[0]) throw new AppError(404, 'request_not_found', 'Request not found')

      if (job) {
        await client.query(
          `INSERT INTO mxq.jobs (queue, payload, dedupe_key, priority)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (queue, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running')
           DO NOTHING`,
          [job.queue, job.payload, job.dedupeKey, job.priority ?? 100],
        )
      }
      return requestRecord(rows[0])
    }, { outcomeUnknownCode: 'usage_commit_outcome_unknown' })
  }

  /**
   * Write mapped external records through the same canonical path as Night-All
   * content.
   *
   * Sharing `core.canonical_records` rather than giving external data its own
   * table is what makes a spreadsheet row and a scraped post searchable by the
   * same query and projectable by the same worker. They are separated by
   * `dataset_id`, not by physical schema, so external data never silently
   * merges into platform analytics while still living in one queryable model.
   */
  async ingestExternalRecords({
    datasetId,
    platform,
    records,
    importRunId,
    sourceId = null,
    connectorId,
    batch = null,
    sessionClient = null,
    apiSearchLineage = null,
    externalPlatformLineage = null,
  }) {
    if (apiSearchLineage && externalPlatformLineage) {
      throw new AppError(400, 'ambiguous_api_lineage', 'Only one API call lineage may be supplied')
    }
    const apiLineage = apiSearchLineage || externalPlatformLineage
    const externalPlatformCall = Boolean(externalPlatformLineage)
    if (records.length === 0 && !apiLineage) return { ingested: 0, changed: 0 }
    if (apiLineage && importRunId) {
      throw new AppError(400, 'ambiguous_ingest_lineage', 'API search and external import lineage cannot be combined')
    }
    if (apiLineage && (
      !apiLineage.requestId
      || !apiLineage.queryFingerprint
      || !(externalPlatformCall ? apiLineage.providerCallId : apiLineage.connectorCallId)
    )) {
      throw new AppError(400, 'incomplete_api_search_lineage', 'API search lineage is incomplete')
    }
    const stream = apiLineage
      ? externalPlatformCall
        ? `${platform}.external-platform.v1`
        : `${platform}.night-all-compat.v1`
      : `${platform}.external.v1`
    const client = sessionClient ?? await this.pool.connect()
    let changed = 0
    let deleted = 0
    let ingestRunId = null
    let commitStarted = false
    let committed = false
    let releaseError = null
    try {
      await client.query('BEGIN')
      if (apiLineage) {
        const runId = randomUUID()
        const callId = externalPlatformCall ? apiLineage.providerCallId : apiLineage.connectorCallId
        const callColumn = externalPlatformCall ? 'external_platform_call_id' : 'connector_call_id'
        const callTable = externalPlatformCall
          ? 'external_platform.provider_calls'
          : 'serving.connector_calls'
        const acceptedOutcome = externalPlatformCall
          ? "call.outcome = 'succeeded'"
          : "call.outcome IN ('complete', 'partial')"
        const externalPlatformBinding = externalPlatformCall
          ? `AND $2 = 'external-platform:' || call.provider_key
              AND $3 = split_part(call.operation, '.', 1) || '.external-platform.v1'`
          : ''
        const inserted = await client.query(
          `INSERT INTO ingest.ingest_runs
             (id, connector_id, stream_id, trigger, request_id, query_fingerprint,
              ${callColumn})
           SELECT $1, $2, $3, 'api_search', $4, $5, $6
             FROM ${callTable} call
            WHERE call.id = $6
              AND call.usage_request_id = $4
              AND call.request_fingerprint = $5
              AND ${acceptedOutcome}
              ${externalPlatformBinding}
           ON CONFLICT (${callColumn}) WHERE ${callColumn} IS NOT NULL
           DO NOTHING
           RETURNING id`,
          [
            runId, connectorId, stream, apiLineage.requestId,
            apiLineage.queryFingerprint, callId,
          ],
        )
        ingestRunId = inserted.rows[0]?.id || null
        if (!ingestRunId) {
          const existingResult = await client.query(
            `SELECT id, connector_id, stream_id, request_id, query_fingerprint,
                    item_count, finished_at
               FROM ingest.ingest_runs
              WHERE ${callColumn} = $1`,
            [callId],
          )
          const existing = existingResult.rows[0]
          if (!existing
            || existing.request_id !== apiLineage.requestId
            || existing.query_fingerprint !== apiLineage.queryFingerprint
            || (externalPlatformCall && (
              existing.connector_id !== connectorId
              || existing.stream_id !== stream
            ))) {
            throw new AppError(
              409,
              'api_search_lineage_mismatch',
              'Connector call does not match this API search lineage',
            )
          }
          if (!existing.finished_at) {
            throw new AppError(409, 'api_search_ingest_in_progress', 'API search ingestion is already in progress')
          }
          commitStarted = true
          await client.query('COMMIT')
          committed = true
          return {
            ingested: Number(existing.item_count),
            changed: 0,
            deleted: 0,
            rowCount: Number(existing.item_count),
            replayed: true,
            runId: existing.id,
          }
        }
      }
      if (importRunId) {
        const runResult = await client.query(
          `SELECT id, source_id, status
             FROM ingest.import_runs
            WHERE id = $1
            FOR UPDATE`,
          [importRunId],
        )
        const run = runResult.rows[0]
        if (!run || run.status !== 'running' || (sourceId && run.source_id !== sourceId)) {
          throw new AppError(
            409,
            'import_run_not_running',
            'External records can only be written to the running import run that owns this source',
          )
        }
      }

      // A reclaimed worker must detect a committed page before touching
      // canonical state. Locking the run row above serializes this check with
      // another worker that is committing the same logical run.
      if (importRunId && batch?.key) {
        const existing = await client.query(
          `SELECT batch_key, cursor_end, row_count, ingested_count,
                  changed_count, deleted_count, rejected_count, status,
                  page_fingerprint
             FROM ingest.import_run_batches
            WHERE import_run_id = $1 AND batch_key = $2`,
          [importRunId, batch.key],
        )
        if (existing.rows[0]) {
          const replay = existing.rows[0]
          if (replay.status !== 'succeeded') {
            throw new AppError(409, 'import_batch_failed', 'This import batch previously failed and must be reset')
          }
          commitStarted = true
          await client.query('COMMIT')
          committed = true
          return {
            ingested: Number(replay.ingested_count),
            changed: Number(replay.changed_count),
            deleted: Number(replay.deleted_count),
            cursorEnd: replay.cursor_end,
            rowCount: Number(replay.row_count),
            replayed: true,
            pageDrifted: Boolean(
              replay.page_fingerprint
              && batch.pageFingerprint
              && replay.page_fingerprint !== batch.pageFingerprint,
            ),
          }
        }
      }

      const sourceRunColumn = apiLineage ? 'ingest_run_id' : 'external_import_run_id'
      const sourceRunId = apiLineage ? ingestRunId : importRunId
      for (const record of records) {
        if (record.deletedAt != null) deleted += 1
        const rawPayloadSha256 = record.rawPayloadSha256 || record.payloadSha256
        const sourceObjectResult = await client.query(
          `INSERT INTO ingest.source_objects
             (id, connector_id, stream_id, object_type, source_key,
              payload_sha256, raw_payload_hash_version, raw_payload,
              source_updated_at, ${sourceRunColumn})
           VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9)
           ON CONFLICT (connector_id, stream_id, object_type, source_key) DO UPDATE SET
             payload_sha256 = EXCLUDED.payload_sha256,
             raw_payload_hash_version = 1,
             raw_payload = EXCLUDED.raw_payload,
             source_updated_at = EXCLUDED.source_updated_at,
             ${sourceRunColumn} = EXCLUDED.${sourceRunColumn},
             current_revision = ingest.source_objects.current_revision
               + CASE
                   WHEN ingest.source_objects.raw_payload_hash_version = 0 THEN
                     ((CASE
                         WHEN ingest.source_objects.connector_id = 'external:province-opinion-results'
                           THEN ingest.source_objects.raw_payload - 'updated_at'
                         ELSE ingest.source_objects.raw_payload
                       END) IS DISTINCT FROM
                      (CASE
                         WHEN EXCLUDED.connector_id = 'external:province-opinion-results'
                           THEN EXCLUDED.raw_payload - 'updated_at'
                         ELSE EXCLUDED.raw_payload
                       END))::int
                   ELSE (ingest.source_objects.payload_sha256
                     IS DISTINCT FROM EXCLUDED.payload_sha256)::int
                 END,
             last_seen_at = now()
           RETURNING id, current_revision, raw_payload_hash_version`,
          [
            randomUUID(), connectorId, stream, record.objectType, record.externalId,
            rawPayloadSha256, record.rawItem, record.collectedAt, sourceRunId,
          ],
        )

        // Preserve every distinct raw payload independently from canonical
        // revisions. Province/source/model evidence may change without changing
        // public text, and delayed Agent work must still read the exact source
        // revision that justified it.
        const sourceObject = sourceObjectResult.rows[0]
        const sourceRevisionResult = await client.query(
          `WITH inserted AS (
             INSERT INTO ingest.source_object_revisions
               (source_object_id, revision, payload_sha256, payload_hash_version, raw_payload,
                source_updated_at, ${sourceRunColumn})
             VALUES ($1, $2, $3, 1, $4, $5, $6)
             ON CONFLICT (source_object_id, revision) DO NOTHING
             RETURNING id
           )
           SELECT id FROM inserted
           UNION ALL
           SELECT id FROM ingest.source_object_revisions
            WHERE source_object_id = $1 AND revision = $2
           LIMIT 1`,
          [
            sourceObject.id, Number(sourceObject.current_revision), rawPayloadSha256,
            record.rawItem, record.collectedAt, sourceRunId,
          ],
        )

        const sourceStage = publicOpinionSourceStage(datasetId, record.rawItem)
        // Candidate public-opinion records and real-time external-platform
        // records use collection time when no upstream event time exists.
        // Re-project only those bounded cases when a newer observation moves
        // freshness forward; generic batch re-imports must not churn ES.
        const refreshCollectedAtProjection = externalPlatformCall || sourceStage === 'candidate'
        const upserted = await client.query(
          `INSERT INTO core.canonical_records
             (id, dataset_id, platform, object_type, external_id, schema_version,
              payload_sha256, content_type, url, title, body,
              author_external_id, author_name, event_time, collected_at,
              latitude, longitude, country_code, admin1_code, admin2_code,
              stable_fields, extensions, deleted_at, heat_score)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                   $16, $17, $18, $19, $20, $21, $22, $23, $24)
           ON CONFLICT (dataset_id, platform, object_type, external_id) DO UPDATE SET
             payload_sha256 = EXCLUDED.payload_sha256,
             content_type = EXCLUDED.content_type,
             url = EXCLUDED.url,
             title = EXCLUDED.title,
             body = EXCLUDED.body,
             author_external_id = EXCLUDED.author_external_id,
             author_name = EXCLUDED.author_name,
             event_time = EXCLUDED.event_time,
             collected_at = GREATEST(
               core.canonical_records.collected_at,
               EXCLUDED.collected_at
             ),
             latitude = EXCLUDED.latitude,
             longitude = EXCLUDED.longitude,
             country_code = EXCLUDED.country_code,
             admin1_code = EXCLUDED.admin1_code,
             admin2_code = EXCLUDED.admin2_code,
             stable_fields = EXCLUDED.stable_fields,
             extensions = EXCLUDED.extensions,
             deleted_at = EXCLUDED.deleted_at,
             heat_score = EXCLUDED.heat_score,
             last_seen_at = now(),
             current_revision = core.canonical_records.current_revision
               + (core.canonical_records.payload_sha256 IS DISTINCT FROM EXCLUDED.payload_sha256)::int,
             projection_revision = core.canonical_records.projection_revision
               + (
                   core.canonical_records.payload_sha256 IS DISTINCT FROM EXCLUDED.payload_sha256
                   OR (
                     $25::boolean
                     AND core.canonical_records.event_time IS NULL
                     AND EXCLUDED.event_time IS NULL
                     AND core.canonical_records.collected_at IS DISTINCT FROM GREATEST(
                       core.canonical_records.collected_at,
                       EXCLUDED.collected_at
                     )
                   )
                 )::int
           RETURNING id, current_revision, projection_revision`,
          [
            randomUUID(), datasetId, platform, record.objectType, record.externalId,
            'external.v1', record.payloadSha256, record.contentType, record.url,
            record.title, record.body, record.authorExternalId, record.authorName,
            record.eventTime, record.collectedAt, record.latitude, record.longitude,
            record.countryCode, record.admin1Code, record.admin2Code,
            record.stableFields, record.extensions, record.deletedAt, record.heatScore,
            refreshCollectedAtProjection,
          ],
        )
        const { id, current_revision: revision } = upserted.rows[0]
        let projection = upserted.rows[0].projection_revision

        const revisionInsert = await client.query(
          `INSERT INTO core.record_revisions
             (record_id, revision, payload_sha256, normalized_payload, parser_version, ${sourceRunColumn})
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (record_id, revision) DO NOTHING`,
          [id, revision, record.payloadSha256, record.rawItem, record.parserVersion, sourceRunId],
        )
        if (revisionInsert.rowCount > 0) changed += 1

        const sourceRevisionId = sourceRevisionResult.rows[0]?.id
        if (sourceStage) {
          if (!sourceRevisionId) {
            throw new Error('current source object revision was not materialized')
          }
          const formal = sourceStage === 'formal'
          const location = publicOpinionLocation(record.rawItem)
          const stateResult = await client.query(
            `INSERT INTO core.public_opinion_current_state
               (record_id, canonical_revision, source_object_revision_id,
                source_stage, status, event_admin1_code, display_admin1_code,
                geography_verified, geo_scope, country_code,
                location_label, location_type, country_name)
             VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (record_id) DO UPDATE SET
               canonical_revision = EXCLUDED.canonical_revision,
               source_object_revision_id = EXCLUDED.source_object_revision_id,
               source_stage = EXCLUDED.source_stage,
               status = EXCLUDED.status,
               quality_score = NULL,
               quality_flags = '[]'::jsonb,
               rejection_codes = '[]'::jsonb,
               event_admin1_code = EXCLUDED.event_admin1_code,
               publisher_admin1_code = NULL,
               display_admin1_code = EXCLUDED.display_admin1_code,
               geography_verified = EXCLUDED.geography_verified,
               geo_scope = EXCLUDED.geo_scope,
               country_code = EXCLUDED.country_code,
               location_label = EXCLUDED.location_label,
               location_type = EXCLUDED.location_type,
               country_name = EXCLUDED.country_name,
               analysis_version = NULL,
               taxonomy_version = NULL,
               rule_version = NULL,
               prompt_version = NULL,
               materialized_from_task_id = NULL,
               assessed_at = NULL,
               updated_at = now()
             WHERE core.public_opinion_current_state.canonical_revision
                     IS DISTINCT FROM EXCLUDED.canonical_revision
                OR core.public_opinion_current_state.source_object_revision_id
                     IS DISTINCT FROM EXCLUDED.source_object_revision_id
                OR core.public_opinion_current_state.source_stage
                     IS DISTINCT FROM EXCLUDED.source_stage
             RETURNING record_id`,
            [
              id, Number(revision), sourceRevisionId, sourceStage,
              formal ? 'formal' : 'pending',
              record.admin1Code,
              record.admin1Code != null,
              record.admin1Code != null ? 'province' : 'unknown',
              location.countryCode ?? record.countryCode,
              location.label,
              location.type,
              location.countryName,
            ],
          )
          if (stateResult.rowCount > 0) {
            const bumped = await client.query(
              `UPDATE core.canonical_records
                  SET projection_revision = projection_revision + 1
                WHERE id = $1
                RETURNING projection_revision`,
              [id],
            )
            projection = bumped.rows[0].projection_revision
          }

          // Domain work is created in the same transaction as its immutable raw
          // evidence. The canonical revision is part of task identity, so a
          // mapping/normalizer change over unchanged raw evidence is analyzed
          // again instead of being swallowed by the old task's unique key.
          // Model availability never blocks this commit; a dedicated classifier
          // claims the task later under its own lease/rate policy.
          await client.query(
            `INSERT INTO agent_center.analysis_tasks
               (pipeline_key, record_id, source_object_revision_id,
                canonical_revision, input_sha256, analysis_version,
                taxonomy_version, rule_version, prompt_version)
             SELECT pipeline_key, $1, $2, $3, $4, analysis_version,
                    taxonomy_version, rule_version, prompt_version
               FROM control.agent_analysis_pipelines
              WHERE pipeline_key = 'province-geography-v1'
             ON CONFLICT
               (pipeline_key, record_id, source_object_revision_id,
                canonical_revision, analysis_version)
             DO NOTHING`,
            [id, sourceRevisionId, Number(revision), rawPayloadSha256],
          )
        }

        if (apiLineage) {
          const callId = externalPlatformCall
            ? apiLineage.providerCallId
            : apiLineage.connectorCallId
          const sourceEventId = `${callId}:${record.objectType}:${record.externalId}`
          await client.query(
            `INSERT INTO core.observations
               (id, record_id, connector_id, source_event_id, query_fingerprint,
                rank, metrics, observation_hash, ingest_run_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (record_id, observation_hash) DO NOTHING`,
            [
              randomUUID(), id, connectorId, sourceEventId,
              apiLineage.queryFingerprint, record.rank ?? null,
              record.metrics || {},
              observationHash(record, apiLineage.queryFingerprint, sourceEventId),
              ingestRunId,
            ],
          )
        }

        // Same outbox contract as the Night-All path: the projector cannot tell
        // (and must not care) which ingest route produced the event.
        await client.query(
          `INSERT INTO outbox.projection_events
             (aggregate_type, aggregate_id, event_type, projection_revision, payload)
           VALUES ('canonical_record', $1, $3, $2, $4)
           ON CONFLICT (aggregate_id, projection_revision) DO NOTHING`,
          [
            id,
            projection,
            record.deletedAt ? 'delete' : 'upsert',
            { datasetId, platform, objectType: record.objectType },
          ],
        )
      }

      if (ingestRunId) {
        const completedRun = await client.query(
          `UPDATE ingest.ingest_runs
              SET item_count = $2, finished_at = now()
            WHERE id = $1
            RETURNING id`,
          [ingestRunId, records.length],
        )
        if (completedRun.rowCount !== 1) {
          throw new AppError(409, 'api_search_ingest_run_missing', 'API search ingest run no longer exists')
        }
      }

      if (importRunId && batch?.key) {
        await client.query(
          `INSERT INTO ingest.import_run_batches
             (import_run_id, batch_key, cursor_start, cursor_end, row_count,
              ingested_count, changed_count, deleted_count, rejected_count, status,
              page_fingerprint)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 'succeeded', $9)`,
          [
            importRunId, batch.key, batch.cursorStart ?? null, batch.cursorEnd ?? null,
            batch.rowCount ?? records.length, records.length, changed, deleted,
            batch.pageFingerprint ?? null,
          ],
        )
      }

      if (importRunId) {
        const updated = await client.query(
          `UPDATE ingest.import_runs
              SET row_count = row_count + $2,
                  ingested_count = ingested_count + $3,
                  changed_count = changed_count + $4,
                  deleted_count = deleted_count + $5
            WHERE id = $1 AND status = 'running'
            RETURNING id`,
          [importRunId, batch?.rowCount ?? 0, records.length, changed, deleted],
        )
        if (updated.rowCount === 0) {
          throw new AppError(409, 'import_run_not_running', 'The import run stopped before this batch could commit')
        }
      }
      commitStarted = true
      await client.query('COMMIT')
      committed = true
      return {
        ingested: records.length,
        changed,
        deleted,
        cursorEnd: batch?.cursorEnd ?? null,
        rowCount: batch?.rowCount ?? records.length,
        ...(ingestRunId ? { runId: ingestRunId } : {}),
      }
    } catch (error) {
      if (commitStarted && !committed) {
        releaseError = error
        const unknown = new AppError(
          503,
          apiLineage ? 'api_search_ingest_outcome_unknown' : 'external_commit_outcome_unknown',
          apiLineage
            ? 'The API search ingest outcome is unknown; retry the same connector call'
            : 'The external batch commit outcome is unknown; retry the same run and batch',
        )
        unknown.cause = error
        throw unknown
      }
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      if (!sessionClient) client.release(releaseError)
    }
  }

  /**
   * Keyset page over a fixed canonical dataset.
   *
   * Only explicitly selected customer-safe columns leave the store. Raw source
   * objects, `extensions`, connector ids and lineage remain inside PostgreSQL.
   */
  async listCanonicalRecords({
    datasetId,
    platform,
    objectType,
    pageSize,
    cursor = null,
    chatId = null,
    from = null,
    to = null,
  }) {
    const chatPredicate = objectType === 'chat'
      ? 'external_id = $4'
      : `(stable_fields #>> '{relations,chatId}') = $4`
    const { rows } = await this.pool.query(
      `SELECT id, dataset_id, external_id, object_type, content_type, url, title, body,
              author_external_id, author_name, event_time, collected_at,
              stable_fields, current_revision, event_time AS sort_time
         FROM core.canonical_records
        WHERE dataset_id = $1
          AND platform = $2
          AND object_type = $3
          AND deleted_at IS NULL
          AND event_time IS NOT NULL
          AND ($4::text IS NULL OR ${chatPredicate})
          AND ($5::timestamptz IS NULL OR event_time >= $5::timestamptz)
          AND ($6::timestamptz IS NULL OR event_time <= $6::timestamptz)
          AND ($7::timestamptz IS NULL OR (event_time, id) < ($7::timestamptz, $8::uuid))
        ORDER BY event_time DESC, id DESC
        LIMIT $9`,
      [
        datasetId, platform, objectType, chatId, from, to,
        cursor?.sortTime ?? null, cursor?.id ?? null, pageSize + 1,
      ],
    )
    return rows
  }

  async listMobileCommerceItems({
    sourcePlatform = null,
    catalogEntryId = null,
    keyword = null,
    brand = null,
    taskId = null,
    from = null,
    to = null,
    pageSize = 50,
    cursor = null,
  } = {}) {
    const values = []
    const conditions = [
      `record.dataset_id = 'mobile-commerce.collected-items.v1'`,
      `record.platform = 'mobile_commerce'`,
      `record.object_type = 'commerce_capture'`,
      'record.deleted_at IS NULL',
    ]
    const bind = (value) => {
      values.push(value)
      return `$${values.length}`
    }
    if (sourcePlatform) {
      conditions.push(`record.stable_fields #>> '{commerce,marketplace,sourceValue}' = ${bind(sourcePlatform)}`)
    }
    if (catalogEntryId) {
      conditions.push(`record.stable_fields #>> '{commerce,marketplace,entryId}' = ${bind(catalogEntryId)}`)
    }
    if (keyword) conditions.push(`record.stable_fields #>> '{commerce,task,keyword}' = ${bind(keyword)}`)
    if (brand) conditions.push(`record.stable_fields #>> '{commerce,task,sourceBrandLabel}' = ${bind(brand)}`)
    if (taskId) conditions.push(`record.stable_fields #>> '{commerce,task,id}' = ${bind(taskId)}`)
    if (from) conditions.push(`record.collected_at >= ${bind(from)}::timestamptz`)
    if (to) conditions.push(`record.collected_at <= ${bind(to)}::timestamptz`)
    if (cursor) {
      const sortTime = bind(cursor.sortTime)
      const id = bind(cursor.id)
      conditions.push(`(record.collected_at, record.id) < (${sortTime}::timestamptz, ${id}::uuid)`)
    }
    const limit = bind(pageSize + 1)
    const { rows } = await this.pool.query(
      `SELECT record.id,
              record.external_id,
              record.title,
              record.author_name,
              record.collected_at,
              record.stable_fields,
              record.current_revision,
              record.collected_at AS sort_time
         FROM core.canonical_records record
        WHERE ${conditions.join('\n          AND ')}
        ORDER BY record.collected_at DESC, record.id DESC
        LIMIT ${limit}`,
      values,
    )
    return rows
  }

  // ---- virtual supermarket ---------------------------------------------

  async getVirtualSupermarketStorefrontRevision() {
    const { rows } = await this.pool.query(
      'SELECT revision FROM serving.virtual_supermarket_storefront WHERE id = true',
    )
    if (!rows[0]) {
      throw new AppError(503, 'storefront_revision_unavailable', 'Virtual-supermarket storefront revision is unavailable')
    }
    return Number(rows[0].revision)
  }

  async getVirtualSupermarketInventoryRevision() {
    const { rows } = await this.pool.query(
      'SELECT inventory_revision FROM serving.virtual_supermarket_storefront WHERE id = true',
    )
    if (rows[0]?.inventory_revision == null) {
      throw new AppError(503, 'inventory_revision_unavailable', 'Virtual-supermarket inventory revision is unavailable')
    }
    return `revision:${rows[0].inventory_revision}`
  }

  async #bumpVirtualSupermarketStorefront(client) {
    const { rows } = await client.query(
      `UPDATE serving.virtual_supermarket_storefront
          SET revision = revision + 1, updated_at = now()
        WHERE id = true
        RETURNING revision`,
    )
    if (!rows[0]) {
      throw new AppError(503, 'storefront_revision_unavailable', 'Virtual-supermarket storefront revision is unavailable')
    }
    return Number(rows[0].revision)
  }

  async listVirtualSupermarketCategories({ includeArchived = false } = {}) {
    const { rows } = await this.pool.query(
      `SELECT *
         FROM serving.virtual_supermarket_categories
        ${includeArchived ? '' : 'WHERE archived_at IS NULL'}
        ORDER BY department_sort_order, department_key,
                 aisle_sort_order, aisle_key,
                 shelf_sort_order, shelf_key,
                 sort_order, category_key`,
    )
    return rows.map(virtualSupermarketCategory)
  }

  async getVirtualSupermarketCategory(id) {
    const { rows } = await this.pool.query(
      'SELECT * FROM serving.virtual_supermarket_categories WHERE id = $1::uuid',
      [id],
    )
    return virtualSupermarketCategory(rows[0])
  }

  async createVirtualSupermarketCategory(input, { actor = 'admin-token' } = {}) {
    try {
      return await withPgTransaction(this.pool, async (client) => {
        await client.query('LOCK TABLE serving.virtual_supermarket_categories IN SHARE ROW EXCLUSIVE MODE')
        const duplicate = await client.query(
          'SELECT id FROM serving.virtual_supermarket_categories WHERE category_key = $1 LIMIT 1',
          [input.categoryKey],
        )
        if (duplicate.rows[0]) {
          throw new AppError(409, 'virtual_supermarket_category_exists', 'A virtual-supermarket category with this key already exists')
        }
        const candidate = {
          id: randomUUID(),
          categoryKey: input.categoryKey,
          displayName: input.displayName,
          departmentKey: input.department.key,
          departmentName: input.department.name,
          departmentSortOrder: input.department.sortOrder,
          aisleKey: input.aisle.key,
          aisleName: input.aisle.name,
          aisleSortOrder: input.aisle.sortOrder,
          shelfKey: input.shelf.key,
          shelfName: input.shelf.name,
          shelfSortOrder: input.shelf.sortOrder,
          sortOrder: input.sortOrder,
        }
        await assertVirtualSupermarketCategoryHierarchy(client, candidate)
        const { rows } = await client.query(
          `INSERT INTO serving.virtual_supermarket_categories
             (id, category_key, display_name,
              department_key, department_name, department_sort_order,
              aisle_key, aisle_name, aisle_sort_order,
              shelf_key, shelf_name, shelf_sort_order, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          RETURNING *`,
          [
            candidate.id, candidate.categoryKey, candidate.displayName,
            candidate.departmentKey, candidate.departmentName, candidate.departmentSortOrder,
            candidate.aisleKey, candidate.aisleName, candidate.aisleSortOrder,
            candidate.shelfKey, candidate.shelfName, candidate.shelfSortOrder, candidate.sortOrder,
          ],
        )
        const category = virtualSupermarketCategory(rows[0])
        const storefrontRevision = await this.#bumpVirtualSupermarketStorefront(client)
        await client.query(
          `INSERT INTO serving.virtual_supermarket_events
             (id, aggregate_type, aggregate_id, event_type, actor,
              from_revision, to_revision, storefront_revision, changes)
           VALUES ($1, 'category', $2, 'create', $3, NULL, 1, $4, $5)`,
          [randomUUID(), category.id, actor, storefrontRevision, { after: category }],
        )
        return { item: category, storefrontRevision }
      })
    } catch (error) {
      if (error?.code === '23505') {
        throw new AppError(409, 'virtual_supermarket_category_exists', 'A virtual-supermarket category with this key already exists')
      }
      throw error
    }
  }

  async updateVirtualSupermarketCategory(id, patch, {
    expectedRevision,
    actor = 'admin-token',
  } = {}) {
    return withPgTransaction(this.pool, async (client) => {
      await client.query('LOCK TABLE serving.virtual_supermarket_categories IN SHARE ROW EXCLUSIVE MODE')
      const currentResult = await client.query(
        'SELECT * FROM serving.virtual_supermarket_categories WHERE id = $1::uuid FOR UPDATE',
        [id],
      )
      const before = virtualSupermarketCategory(currentResult.rows[0])
      if (!before) {
        throw new AppError(404, 'virtual_supermarket_category_not_found', 'Virtual-supermarket category was not found')
      }
      if (before.revision !== expectedRevision) {
        throw new AppError(
          409,
          'virtual_supermarket_category_revision_conflict',
          'Virtual-supermarket category changed; reload before saving',
          { expectedRevision, currentRevision: before.revision },
        )
      }
      const merged = {
        ...before,
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        ...(patch.department ? {
          departmentKey: patch.department.key,
          departmentName: patch.department.name,
          departmentSortOrder: patch.department.sortOrder,
        } : {}),
        ...(patch.aisle ? {
          aisleKey: patch.aisle.key,
          aisleName: patch.aisle.name,
          aisleSortOrder: patch.aisle.sortOrder,
        } : {}),
        ...(patch.shelf ? {
          shelfKey: patch.shelf.key,
          shelfName: patch.shelf.name,
          shelfSortOrder: patch.shelf.sortOrder,
        } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
      }
      await assertVirtualSupermarketCategoryHierarchy(client, merged, id)
      const { rows } = await client.query(
        `UPDATE serving.virtual_supermarket_categories
            SET display_name = $3,
                department_key = $4,
                department_name = $5,
                department_sort_order = $6,
                aisle_key = $7,
                aisle_name = $8,
                aisle_sort_order = $9,
                shelf_key = $10,
                shelf_name = $11,
                shelf_sort_order = $12,
                sort_order = $13,
                revision = revision + 1,
                updated_at = now()
          WHERE id = $1::uuid AND revision = $2
          RETURNING *`,
        [
          id, expectedRevision, merged.displayName,
          merged.departmentKey, merged.departmentName, merged.departmentSortOrder,
          merged.aisleKey, merged.aisleName, merged.aisleSortOrder,
          merged.shelfKey, merged.shelfName, merged.shelfSortOrder, merged.sortOrder,
        ],
      )
      const category = virtualSupermarketCategory(rows[0])
      const storefrontRevision = await this.#bumpVirtualSupermarketStorefront(client)
      await client.query(
        `INSERT INTO serving.virtual_supermarket_events
           (id, aggregate_type, aggregate_id, event_type, actor,
            from_revision, to_revision, storefront_revision, changes)
         VALUES ($1, 'category', $2, 'update', $3, $4, $5, $6, $7)`,
        [
          randomUUID(), id, actor, before.revision, category.revision,
          storefrontRevision, { before, after: category },
        ],
      )
      return { item: category, storefrontRevision }
    })
  }

  async listVirtualSupermarketCategoryEvents(id, limit = 50) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200))
    const { rows } = await this.pool.query(
      `SELECT * FROM serving.virtual_supermarket_events
        WHERE aggregate_type = 'category' AND aggregate_id = $1::uuid
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [id, safeLimit],
    )
    return rows.map(virtualSupermarketEvent)
  }

  async listVirtualSupermarketProducts({
    status = 'all',
    categoryId = null,
    department = null,
    aisle = null,
    shelf = null,
    marketplace = null,
    query = null,
    sort = 'newest',
    pageSize = 24,
    offset = 0,
    includeGovernanceEvidence = false,
  } = {}) {
    const values = []
    const conditions = [
      `record.dataset_id = 'mobile-commerce.collected-items.v1'`,
      `record.platform = 'mobile_commerce'`,
      `record.object_type = 'commerce_capture'`,
      'record.deleted_at IS NULL',
      'category.archived_at IS NULL',
    ]
    const bind = (value) => {
      values.push(value)
      return `$${values.length}`
    }
    if (status !== 'all') conditions.push(`coalesce(listing.status, 'off_shelf') = ${bind(status)}`)
    if (categoryId) conditions.push(`category.id = ${bind(categoryId)}::uuid`)
    if (department) conditions.push(`category.department_key = ${bind(department)}`)
    if (aisle) conditions.push(`category.aisle_key = ${bind(aisle)}`)
    if (shelf) conditions.push(`category.shelf_key = ${bind(shelf)}`)
    if (marketplace) {
      const value = bind(marketplace)
      conditions.push(includeGovernanceEvidence
        ? `(
            record.stable_fields #>> '{commerce,marketplace,sourceValue}' = ${value}
            OR record.stable_fields #>> '{commerce,marketplace,entryId}' = ${value}
            OR record.stable_fields #>> '{commerce,marketplace,sourceKey}' = ${value}
            OR record.stable_fields #>> '{commerce,marketplace,canonicalName}' = ${value}
          )`
        : `(
            record.stable_fields #>> '{commerce,marketplace,status}' = 'mapped'
            AND (
              record.stable_fields #>> '{commerce,marketplace,entryId}' = ${value}
              OR record.stable_fields #>> '{commerce,marketplace,canonicalName}' = ${value}
            )
          )`)
    }
    if (query) {
      const escaped = `%${String(query).replace(/[\\%_]/gu, '\\$&')}%`
      const value = bind(escaped)
      conditions.push(`(
        coalesce(listing.display_title, record.stable_fields #>> '{commerce,product,title}', record.title, '') ILIKE ${value} ESCAPE '\\'
        OR coalesce(listing.specification, '') ILIKE ${value} ESCAPE '\\'
        OR coalesce(record.stable_fields #>> '{commerce,shop,name}', record.author_name, '') ILIKE ${value} ESCAPE '\\'
        ${includeGovernanceEvidence
          ? `OR coalesce(record.stable_fields #>> '{commerce,product,title}', '') ILIKE ${value} ESCAPE '\\'
            OR coalesce(record.title, '') ILIKE ${value} ESCAPE '\\'
            OR coalesce(record.stable_fields #>> '{commerce,shop,name}', '') ILIKE ${value} ESCAPE '\\'
            OR coalesce(record.author_name, '') ILIKE ${value} ESCAPE '\\'
            OR coalesce(record.stable_fields #>> '{commerce,signals,tagsText}', '') ILIKE ${value} ESCAPE '\\'`
          : ''}
      )`)
    }
    const orderBy = {
      newest: 'record.collected_at DESC, record.id DESC',
      title_asc: 'effective_title ASC NULLS LAST, record.id ASC',
      price_asc: 'effective_price ASC NULLS LAST, record.id ASC',
      price_desc: 'effective_price DESC NULLS LAST, record.id ASC',
    }[sort] || 'record.collected_at DESC, record.id DESC'
    const limit = bind(pageSize + 1)
    const skip = bind(offset)
    const { rows } = await this.pool.query(
      `${VIRTUAL_SUPERMARKET_ITEM_SELECT}
        WHERE ${conditions.join('\n          AND ')}
        ORDER BY ${orderBy}
        LIMIT ${limit} OFFSET ${skip}`,
      values,
    )
    return rows.map(virtualSupermarketItem)
  }

  async getVirtualSupermarketProduct(id, { onShelfOnly = false } = {}) {
    return virtualSupermarketItemById(this.pool, id, { onShelfOnly })
  }

  async getVirtualSupermarketProductByPublicationId(publicationId) {
    const { rows } = await this.pool.query(
      `${VIRTUAL_SUPERMARKET_ITEM_SELECT}
        WHERE listing.publication_id = $1::uuid
          AND listing.status = 'on_shelf'
          AND category.archived_at IS NULL
          AND record.dataset_id = 'mobile-commerce.collected-items.v1'
          AND record.platform = 'mobile_commerce'
          AND record.object_type = 'commerce_capture'
          AND record.deleted_at IS NULL`,
      [publicationId],
    )
    return virtualSupermarketItem(rows[0])
  }

  async updateVirtualSupermarketProduct(id, patch, {
    expectedRevision,
    actor = 'admin-token',
    eventType = 'update',
    reason = null,
  } = {}) {
    return withPgTransaction(this.pool, async (client) => {
      const canonical = await client.query(
        `SELECT id FROM core.canonical_records
          WHERE id = $1::uuid
            AND dataset_id = 'mobile-commerce.collected-items.v1'
            AND platform = 'mobile_commerce'
            AND object_type = 'commerce_capture'
            AND deleted_at IS NULL
          FOR SHARE`,
        [id],
      )
      if (canonical.rowCount !== 1) {
        throw new AppError(404, 'virtual_supermarket_product_not_found', 'Virtual-supermarket product was not found')
      }
      const currentResult = await client.query(
        'SELECT * FROM serving.virtual_supermarket_listing_state WHERE record_id = $1::uuid FOR UPDATE',
        [id],
      )
      const row = currentResult.rows[0]
      const before = row ? {
        explicit: true,
        publicationId: row.publication_id,
        status: row.status,
        categoryId: row.category_id,
        displayTitle: row.display_title,
        specification: row.specification,
        priceAmount: row.price_amount == null ? null : String(row.price_amount),
        currency: row.currency,
        shelfPosition: row.shelf_position == null ? null : Number(row.shelf_position),
        revision: Number(row.revision),
      } : {
        explicit: false,
        publicationId: null,
        status: 'off_shelf',
        categoryId: VIRTUAL_SUPERMARKET_DEFAULT_CATEGORY_ID,
        displayTitle: null,
        specification: null,
        priceAmount: null,
        currency: null,
        shelfPosition: null,
        revision: 0,
      }
      if (before.revision !== expectedRevision) {
        throw new AppError(
          409,
          'virtual_supermarket_listing_revision_conflict',
          'Virtual-supermarket listing changed; reload before saving',
          { expectedRevision, currentRevision: before.revision },
        )
      }
      const merged = {
        ...before,
        publicationId: before.publicationId
          || (patch.status === 'on_shelf' ? randomUUID() : null),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.categoryId !== undefined
          ? { categoryId: patch.categoryId || VIRTUAL_SUPERMARKET_DEFAULT_CATEGORY_ID }
          : {}),
        ...(patch.displayTitle !== undefined ? { displayTitle: patch.displayTitle } : {}),
        ...(patch.specification !== undefined ? { specification: patch.specification } : {}),
        ...(patch.shelfPosition !== undefined ? { shelfPosition: patch.shelfPosition } : {}),
        ...(patch.price !== undefined ? {
          priceAmount: patch.price?.amount ?? null,
          currency: patch.price?.currency ?? null,
        } : {}),
      }
      const category = await client.query(
        `SELECT id FROM serving.virtual_supermarket_categories
          WHERE id = $1::uuid AND archived_at IS NULL`,
        [merged.categoryId],
      )
      if (category.rowCount !== 1) {
        throw new AppError(404, 'virtual_supermarket_category_not_found', 'Virtual-supermarket category was not found')
      }
      const nextRevision = before.revision + 1
      const listingWrite = await client.query(
        `INSERT INTO serving.virtual_supermarket_listing_state
           (record_id, publication_id, status, category_id, display_title, specification,
            price_amount, currency, shelf_position, revision,
            created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10, $11, $11)
         ON CONFLICT (record_id) DO UPDATE
           SET publication_id = EXCLUDED.publication_id,
               status = EXCLUDED.status,
               category_id = EXCLUDED.category_id,
               display_title = EXCLUDED.display_title,
               specification = EXCLUDED.specification,
               price_amount = EXCLUDED.price_amount,
               currency = EXCLUDED.currency,
               shelf_position = EXCLUDED.shelf_position,
               revision = EXCLUDED.revision,
               updated_by = EXCLUDED.updated_by,
               updated_at = now()
         WHERE serving.virtual_supermarket_listing_state.revision = $12
         RETURNING revision`,
        [
          id, merged.publicationId, merged.status, merged.categoryId, merged.displayTitle, merged.specification,
          merged.priceAmount, merged.currency, merged.shelfPosition, nextRevision, actor,
          expectedRevision,
        ],
      )
      if (listingWrite.rowCount !== 1) {
        const latest = await client.query(
          'SELECT revision FROM serving.virtual_supermarket_listing_state WHERE record_id = $1::uuid',
          [id],
        )
        throw new AppError(
          409,
          'virtual_supermarket_listing_revision_conflict',
          'Virtual-supermarket listing changed; reload before saving',
          { expectedRevision, currentRevision: Number(latest.rows[0]?.revision ?? expectedRevision + 1) },
        )
      }
      const storefrontRevision = await this.#bumpVirtualSupermarketStorefront(client)
      const after = { ...merged, explicit: true, revision: nextRevision }
      await client.query(
        `INSERT INTO serving.virtual_supermarket_events
           (id, aggregate_type, aggregate_id, event_type, actor,
            from_revision, to_revision, storefront_revision, reason, changes)
         VALUES ($1, 'product', $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          randomUUID(), id, eventType, actor, before.revision, nextRevision,
          storefrontRevision, reason, { before, after },
        ],
      )
      return {
        item: await virtualSupermarketItemById(client, id),
        storefrontRevision,
      }
    })
  }

  async listVirtualSupermarketProductEvents(id, limit = 50) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200))
    const { rows } = await this.pool.query(
      `SELECT * FROM serving.virtual_supermarket_events
        WHERE aggregate_type = 'product' AND aggregate_id = $1::uuid
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [id, safeLimit],
    )
    return rows.map(virtualSupermarketEvent)
  }

  /**
   * Admin-only Telegram product facade. It intentionally exposes governed
   * canonical business rows from both ingestors without applying a public-chat
   * gate; the response projection remains an allowlist.
   */
  async listAdminTelegramChats({
    kind = 'all',
    sourceScope = 'all',
    query = null,
    pageSize,
    cursor = null,
  }) {
    const datasets = adminTelegramDatasets(sourceScope, 'chats')
    const { rows } = await this.pool.query(
      `SELECT chat.id, chat.dataset_id, chat.external_id, chat.object_type,
              chat.content_type, chat.url, chat.title, chat.body,
              chat.author_external_id, chat.author_name, chat.event_time,
              chat.collected_at, chat.stable_fields, chat.current_revision,
              coalesce(chat.event_time, chat.collected_at, chat.first_seen_at) AS sort_time
         FROM core.canonical_records chat
        WHERE chat.dataset_id = ANY($1::text[])
          AND chat.platform = 'telegram'
          AND chat.object_type = 'chat'
          AND chat.deleted_at IS NULL
          AND ($2::text = 'all' OR ${ADMIN_TELEGRAM_CHAT_KIND_SQL} = $2)
          AND (
            $3::text IS NULL
            OR chat.title ILIKE '%' || $3 || '%'
            OR chat.stable_fields #>> '{attributes,username}' ILIKE '%' || $3 || '%'
          )
          AND (
            $4::timestamptz IS NULL
            OR (coalesce(chat.event_time, chat.collected_at, chat.first_seen_at), chat.id) < ($4::timestamptz, $5::uuid)
          )
        ORDER BY coalesce(chat.event_time, chat.collected_at, chat.first_seen_at) DESC, chat.id DESC
        LIMIT $6`,
      [datasets, kind, query, cursor?.sortTime ?? null, cursor?.id ?? null, pageSize + 1],
    )
    return rows
  }

  async getAdminTelegramChat(chatId, sourceScope = 'all') {
    const selector = adminTelegramChatSelector(chatId, sourceScope)
    const { rows } = await this.pool.query(
      `SELECT chat.id, chat.dataset_id, chat.external_id, chat.object_type,
              chat.content_type, chat.url, chat.title, chat.body,
              chat.author_external_id, chat.author_name, chat.event_time,
              chat.collected_at, chat.stable_fields, chat.current_revision,
              coalesce(chat.event_time, chat.collected_at, chat.first_seen_at) AS sort_time
         FROM core.canonical_records chat
        WHERE chat.dataset_id = ANY($2::text[])
          AND chat.platform = 'telegram'
          AND chat.object_type = 'chat'
          AND chat.deleted_at IS NULL
          AND (
            chat.id::text = $1
            OR chat.external_id = $1
            OR ltrim(chat.stable_fields #>> '{attributes,username}', '@') = ltrim($1, '@')
          )
        ORDER BY (chat.dataset_id = 'telegram.monitor.chats.v1') DESC, chat.id DESC
        LIMIT 1`,
      [selector.value, selector.datasets],
    )
    return rows[0] ?? null
  }

  async listAdminTelegramMessages({
    chatExternalId,
    sourceScope = 'all',
    pageSize,
    cursor = null,
    from = null,
    to = null,
  }) {
    const datasets = adminTelegramDatasets(sourceScope, 'messages')
    const values = [
      datasets,
      chatExternalId,
      cursor?.sortTime ?? null,
      cursor?.id ?? null,
    ]
    const sortExpression = 'coalesce(message.event_time, message.collected_at, message.first_seen_at)'
    const predicates = [
      'message.dataset_id = ANY($1::text[])',
      "message.platform = 'telegram'",
      "message.object_type = 'message'",
      'message.deleted_at IS NULL',
      "($2::text IS NULL OR message.stable_fields #>> '{relations,chatId}' = $2)",
      `(
        $3::timestamptz IS NULL
        OR (${sortExpression}, message.id) < ($3::timestamptz, $4::uuid)
      )`,
    ]
    const parameter = (value) => {
      values.push(value)
      return `$${values.length}`
    }
    if (from) predicates.push(`${sortExpression} >= ${parameter(from)}::timestamptz`)
    if (to) predicates.push(`${sortExpression} <= ${parameter(to)}::timestamptz`)
    const limit = parameter(pageSize + 1)
    const { rows } = await this.pool.query(
      `SELECT message.id, message.dataset_id, message.external_id,
              message.object_type, message.content_type, message.url,
              message.title, message.body, message.author_external_id,
              message.author_name, message.event_time, message.collected_at,
              message.stable_fields, message.current_revision,
              ${sortExpression} AS sort_time
         FROM core.canonical_records message
        WHERE ${predicates.join('\n          AND ')}
        ORDER BY ${sortExpression} DESC, message.id DESC
        LIMIT ${limit}`,
      values,
    )
    return rows
  }

  async searchAdminTelegramMessages({
    query,
    chatExternalId = null,
    kind = 'all',
    sourceScope = 'all',
    pageSize,
    cursor = null,
  }) {
    const messageDatasets = adminTelegramDatasets(sourceScope, 'messages')
    const { rows } = await this.pool.query(
      `SELECT message.id, message.dataset_id, message.external_id,
              message.object_type, message.content_type, message.url,
              message.title, message.body, message.author_external_id,
              message.author_name, message.event_time, message.collected_at,
              message.stable_fields, message.current_revision,
              coalesce(message.event_time, message.collected_at, message.first_seen_at) AS sort_time,
              CASE
                WHEN lower(coalesce(message.body, '')) = lower($2) THEN 1.0
                ELSE 0.5
              END::double precision AS score
         FROM core.canonical_records message
        WHERE message.dataset_id = ANY($1::text[])
          AND message.platform = 'telegram'
          AND message.object_type = 'message'
          AND message.deleted_at IS NULL
          AND ($3::text IS NULL OR message.stable_fields #>> '{relations,chatId}' = $3)
          AND (
            $3::text IS NOT NULL
            OR $4::text = 'all'
            OR EXISTS (
              SELECT 1
                FROM core.canonical_records chat
               WHERE chat.platform = 'telegram'
                 AND chat.object_type = 'chat'
                 AND chat.deleted_at IS NULL
                 AND chat.external_id = message.stable_fields #>> '{relations,chatId}'
                 AND (
                   (message.dataset_id = 'telegram.monitor.messages.v1'
                    AND chat.dataset_id = 'telegram.monitor.chats.v1')
                   OR
                   (message.dataset_id = 'telegram.sqlite.messages.v1'
                    AND chat.dataset_id = 'telegram.sqlite.chats.v1')
                 )
                 AND ${ADMIN_TELEGRAM_CHAT_KIND_SQL} = $4
            )
          )
          AND (
            message.body ILIKE '%' || $2 || '%'
            OR message.title ILIKE '%' || $2 || '%'
            OR message.author_name ILIKE '%' || $2 || '%'
          )
          AND (
            $5::timestamptz IS NULL
            OR (coalesce(message.event_time, message.collected_at, message.first_seen_at), message.id) < ($5::timestamptz, $6::uuid)
          )
        ORDER BY coalesce(message.event_time, message.collected_at, message.first_seen_at) DESC, message.id DESC
        LIMIT $7`,
      [
        messageDatasets, query, chatExternalId, kind,
        cursor?.sortTime ?? null, cursor?.id ?? null, pageSize + 1,
      ],
    )
    return rows
  }

  async getAdminTelegramMessage(id, sourceScope = 'all') {
    const datasets = adminTelegramDatasets(sourceScope, 'messages')
    const { rows } = await this.pool.query(
      `SELECT message.id
         FROM core.canonical_records message
        WHERE message.id = $1::uuid
          AND message.dataset_id = ANY($2::text[])
          AND message.platform = 'telegram'
          AND message.object_type = 'message'
          AND message.deleted_at IS NULL
        LIMIT 1`,
      [id, datasets],
    )
    return rows[0] ?? null
  }

  async getCanonicalContextServingIndexStatus() {
    const required = CANONICAL_CONTEXT_SERVING_INDEX_CONTRACTS.map((contract) => contract.name)
    const { rows } = await this.pool.query(
      `SELECT index_rel.relname AS name,
              index_meta.indisready,
              index_meta.indisvalid,
              index_meta.indislive,
              access_method.amname AS access_method,
              index_meta.indnkeyatts AS key_count,
              pg_get_indexdef(index_rel.oid, 1, true) AS key_1,
              pg_get_indexdef(index_rel.oid, 2, true) AS key_2,
              pg_get_indexdef(index_rel.oid, 3, true) AS key_3,
              index_meta.indoption[0]::integer AS key_1_options,
              index_meta.indoption[1]::integer AS key_2_options,
              index_meta.indoption[2]::integer AS key_3_options,
              pg_get_expr(index_meta.indpred, index_meta.indrelid, true) AS predicate
         FROM pg_class index_rel
         JOIN pg_namespace index_ns ON index_ns.oid = index_rel.relnamespace
         JOIN pg_index index_meta ON index_meta.indexrelid = index_rel.oid
         JOIN pg_am access_method ON access_method.oid = index_rel.relam
         JOIN pg_class table_rel ON table_rel.oid = index_meta.indrelid
         JOIN pg_namespace table_ns ON table_ns.oid = table_rel.relnamespace
        WHERE index_ns.nspname = 'core'
          AND table_ns.nspname = 'core'
          AND table_rel.relname = 'canonical_records'
          AND index_rel.relname = ANY($1::text[])`,
      [required],
    )
    const byName = new Map(rows.map((row) => [row.name, row]))
    const indexes = CANONICAL_CONTEXT_SERVING_INDEX_CONTRACTS.map((contract) => ({
      name: contract.name,
      ready: servingIndexMatches(byName.get(contract.name), contract),
    }))
    return {
      ready: indexes.every((index) => index.ready),
      required,
      indexes,
      missing: indexes.filter((index) => !index.ready).map((index) => index.name),
    }
  }

  /**
   * Resolve one canonical anchor and its nearest stored neighbors in a single
   * PostgreSQL snapshot. Each dataset branch names its partial-index predicate
   * literally so PostgreSQL can use the matching chat/time serving index.
  */
  async getCanonicalContext({ id, before, after }) {
    const { rows } = await this.pool.query(
      CANONICAL_CONTEXT_QUERY_SQL,
      [id, before + 1, after + 1],
    )
    const current = rows.find((row) => row.side === 'current') ?? null
    if (!current) return null
    const dataset = CANONICAL_CONTEXT_DATASETS[current.dataset_id]
    const contextSupported = Boolean(
      dataset
      && current.object_type === dataset.objectType
      && current.event_time
      && current.context_id,
    )
    if (!contextSupported) {
      return {
        current,
        before: [],
        after: [],
        hasMoreStoredBefore: false,
        hasMoreStoredAfter: false,
        contextSupported: false,
      }
    }
    const beforeRows = rows.filter((row) => row.side === 'before')
    const afterRows = rows.filter((row) => row.side === 'after')
    return {
      current,
      before: beforeRows.slice(0, before).reverse(),
      after: afterRows.slice(0, after),
      hasMoreStoredBefore: beforeRows.length > before,
      hasMoreStoredAfter: afterRows.length > after,
      contextSupported: true,
    }
  }

  /**
   * Continue a canonical chat timeline from a cursor-contained exclusive
   * boundary. The original anchor row is deliberately not consulted here.
   */
  async getCanonicalTimelinePage({
    datasetId,
    contextId,
    direction,
    boundary,
    pageSize,
  }) {
    const sql = CANONICAL_TIMELINE_PAGE_SQL[datasetId]?.[direction]
    if (!sql) {
      throw new AppError(409, 'context_not_supported', 'Canonical item does not support message timeline')
    }
    const { rows } = await this.pool.query(
      sql,
      [contextId, boundary.eventTime, boundary.id, pageSize + 1],
    )
    const page = rows.slice(0, pageSize)
    return {
      items: direction === 'older' ? page.reverse() : page,
      hasMore: rows.length > pageSize,
    }
  }

  /**
   * Customer-safe province feed over the current canonical PostgreSQL state.
   *
   * The SELECT is intentionally explicit and separate from Admin Data Center:
   * raw payloads, extensions, strategy ids, model reasoning and lineage never
   * cross this store boundary.
   */
  async getPublicOpinionServingIndexStatus() {
    const required = PUBLIC_OPINION_SERVING_INDEX_CONTRACTS.map((contract) => contract.name)
    const { rows } = await this.pool.query(
      `SELECT index_rel.relname AS name,
              index_meta.indisready,
              index_meta.indisvalid,
              index_meta.indislive,
              access_method.amname AS access_method,
              index_meta.indnkeyatts AS key_count,
              pg_get_indexdef(index_rel.oid, 1, true) AS key_1,
              pg_get_indexdef(index_rel.oid, 2, true) AS key_2,
              pg_get_indexdef(index_rel.oid, 3, true) AS key_3,
              pg_get_indexdef(index_rel.oid, 4, true) AS key_4,
              index_meta.indoption[0]::integer AS key_1_options,
              index_meta.indoption[1]::integer AS key_2_options,
              index_meta.indoption[2]::integer AS key_3_options,
              index_meta.indoption[3]::integer AS key_4_options,
              pg_get_expr(index_meta.indpred, index_meta.indrelid, true) AS predicate
         FROM pg_class index_rel
         JOIN pg_namespace index_ns ON index_ns.oid = index_rel.relnamespace
         JOIN pg_index index_meta ON index_meta.indexrelid = index_rel.oid
         JOIN pg_am access_method ON access_method.oid = index_rel.relam
         JOIN pg_class table_rel ON table_rel.oid = index_meta.indrelid
         JOIN pg_namespace table_ns ON table_ns.oid = table_rel.relnamespace
        WHERE index_ns.nspname = 'core'
          AND table_ns.nspname = 'core'
          AND table_rel.relname = 'canonical_records'
          AND index_rel.relname = ANY($1::text[])`,
      [required],
    )
    const byName = new Map(rows.map((row) => [row.name, row]))
    const indexes = PUBLIC_OPINION_SERVING_INDEX_CONTRACTS.map((contract) => ({
      name: contract.name,
      ready: servingIndexMatches(byName.get(contract.name), contract),
    }))
    return {
      ready: indexes.every((index) => index.ready),
      required,
      indexes,
      missing: indexes.filter((index) => !index.ready).map((index) => index.name),
    }
  }

  async getPublicOpinionRegionServingIndexStatus() {
    const required = PUBLIC_OPINION_REGION_SERVING_INDEX_CONTRACTS.map((contract) => contract.name)
    const { rows } = await this.pool.query(
      `SELECT index_rel.relname AS name,
              table_rel.relname AS table_name,
              index_meta.indisready,
              index_meta.indisvalid,
              index_meta.indislive,
              access_method.amname AS access_method,
              index_meta.indnkeyatts AS key_count,
              pg_get_indexdef(index_rel.oid, 1, true) AS key_1,
              pg_get_indexdef(index_rel.oid, 2, true) AS key_2,
              pg_get_indexdef(index_rel.oid, 3, true) AS key_3,
              pg_get_indexdef(index_rel.oid, 4, true) AS key_4,
              index_meta.indoption[0]::integer AS key_1_options,
              index_meta.indoption[1]::integer AS key_2_options,
              index_meta.indoption[2]::integer AS key_3_options,
              index_meta.indoption[3]::integer AS key_4_options,
              pg_get_expr(index_meta.indpred, index_meta.indrelid, true) AS predicate
         FROM pg_class index_rel
         JOIN pg_namespace index_ns ON index_ns.oid = index_rel.relnamespace
         JOIN pg_index index_meta ON index_meta.indexrelid = index_rel.oid
         JOIN pg_am access_method ON access_method.oid = index_rel.relam
         JOIN pg_class table_rel ON table_rel.oid = index_meta.indrelid
         JOIN pg_namespace table_ns ON table_ns.oid = table_rel.relnamespace
        WHERE index_ns.nspname = 'core'
          AND table_ns.nspname = 'core'
          AND table_rel.relname IN ('canonical_records', 'public_opinion_current_state')
          AND index_rel.relname = ANY($1::text[])`,
      [required],
    )
    const byName = new Map(rows.map((row) => [row.name, row]))
    const indexes = PUBLIC_OPINION_REGION_SERVING_INDEX_CONTRACTS.map((contract) => {
      const row = byName.get(contract.name)
      return {
        name: contract.name,
        ready: row?.table_name === contract.table && servingIndexMatches(row, contract),
      }
    })
    return {
      ready: indexes.every((index) => index.ready),
      required,
      indexes,
      missing: indexes.filter((index) => !index.ready).map((index) => index.name),
    }
  }

  /**
   * Admin-only inventory for separating source volume, publication quality,
   * geography coverage and retained history. It intentionally aggregates the
   * current Hub projection instead of returning restricted raw evidence.
   */
  async getPublicOpinionQualitySummary() {
    const { rows } = await this.pool.query(
      `WITH current_records AS MATERIALIZED (
         SELECT record.id,
                record.deleted_at,
                record.title,
                record.url,
                record.event_time,
                record.first_seen_at,
                record.last_seen_at,
                publication.record_id AS publication_record_id,
                publication.source_stage,
                publication.status AS publication_status,
                publication.quality_score,
                publication.qualification_threshold,
                publication.quality_flags,
                publication.rejection_codes,
                publication.display_admin1_code,
                publication.geography_verified,
                publication.geo_scope,
                publication.country_code,
                publication.location_label,
                publication.updated_at AS publication_updated_at
           FROM core.canonical_records record
           LEFT JOIN core.public_opinion_current_state publication
             ON publication.record_id = record.id
            AND publication.canonical_revision = record.current_revision
          WHERE record.dataset_id = 'public-opinion.province.v1'
            AND record.platform = 'public_opinion'
            AND record.object_type = 'opinion_item'
       ), stage_counts AS (
         SELECT source_stage AS key, count(*)::integer AS value
           FROM current_records
          WHERE deleted_at IS NULL AND publication_record_id IS NOT NULL
          GROUP BY source_stage
       ), status_counts AS (
         SELECT publication_status AS key, count(*)::integer AS value
           FROM current_records
          WHERE deleted_at IS NULL AND publication_record_id IS NOT NULL
          GROUP BY publication_status
       ), scope_counts AS (
         SELECT coalesce(geo_scope, 'unknown') AS key, count(*)::integer AS value
           FROM current_records
          WHERE deleted_at IS NULL
          GROUP BY coalesce(geo_scope, 'unknown')
       ), country_counts AS (
         SELECT coalesce(country_code, 'unclassified') AS key, count(*)::integer AS value
           FROM current_records
          WHERE deleted_at IS NULL
          GROUP BY coalesce(country_code, 'unclassified')
       ), province_counts AS (
         SELECT display_admin1_code AS key, count(*)::integer AS value
           FROM current_records
          WHERE deleted_at IS NULL AND display_admin1_code IS NOT NULL
          GROUP BY display_admin1_code
       ), candidate_score_buckets AS (
         SELECT CASE
                  WHEN quality_score IS NULL THEN 'unscored'
                  WHEN quality_score < 60 THEN '0-59'
                  WHEN quality_score < 80 THEN '60-79'
                  ELSE '80-100'
                END AS key,
                count(*)::integer AS value
          FROM current_records
          WHERE deleted_at IS NULL AND source_stage = 'candidate'
          GROUP BY 1
       ), candidate_quality_flags AS (
         SELECT flag AS key, count(*)::integer AS value
           FROM current_records
          CROSS JOIN LATERAL jsonb_array_elements_text(quality_flags) AS flags(flag)
          WHERE deleted_at IS NULL AND source_stage = 'candidate'
          GROUP BY 1
       ), candidate_rejection_codes AS (
         SELECT code AS key, count(*)::integer AS value
           FROM current_records
          CROSS JOIN LATERAL jsonb_array_elements_text(rejection_codes) AS codes(code)
          WHERE deleted_at IS NULL AND source_stage = 'candidate'
          GROUP BY 1
       ), task_counts AS (
         SELECT status AS key, count(*)::integer AS value
           FROM agent_center.analysis_tasks
          WHERE pipeline_key = 'province-geography-v1'
          GROUP BY status
       ), task_error_counts AS (
         SELECT last_error_code AS key, count(*)::integer AS value
           FROM agent_center.analysis_tasks
          WHERE pipeline_key = 'province-geography-v1'
            AND last_error_code IS NOT NULL
          GROUP BY last_error_code
       ), assertion_counts AS (
         SELECT status AS key, count(*)::integer AS value
           FROM agent_center.classification_assertions
          WHERE pipeline_key = 'province-geography-v1'
          GROUP BY status
       )
       SELECT count(*)::bigint AS canonical_total,
              count(*) FILTER (WHERE deleted_at IS NULL)::bigint AS active_count,
              count(*) FILTER (WHERE deleted_at IS NOT NULL)::bigint AS deleted_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND publication_record_id IS NOT NULL
              )::bigint AS publication_state_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND publication_record_id IS NULL
              )::bigint AS missing_publication_state_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND quality_score IS NOT NULL
              )::bigint AS assessed_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND quality_score IS NULL
              )::bigint AS unassessed_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND source_stage = 'candidate'
              )::bigint AS candidate_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND source_stage = 'candidate'
                  AND quality_score IS NOT NULL
              )::bigint AS candidate_scored_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND source_stage = 'candidate'
                  AND quality_score IS NULL
              )::bigint AS candidate_unscored_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND source_stage = 'candidate'
                  AND publication_status = 'qualified'
                  AND quality_score >= qualification_threshold
              )::bigint AS candidate_qualified_count,
              round((avg(quality_score) FILTER (
                WHERE deleted_at IS NULL AND source_stage = 'candidate'
                  AND quality_score IS NOT NULL
              ))::numeric, 2) AS average_candidate_quality_score,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND display_admin1_code IS NOT NULL
              )::bigint AS with_province_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND display_admin1_code IS NULL
              )::bigint AS without_province_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND geography_verified = true
              )::bigint AS verified_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL
                  AND (location_label IS NOT NULL OR country_code IS NOT NULL)
              )::bigint AS with_location_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND nullif(btrim(title), '') IS NULL
              )::bigint AS missing_title_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND nullif(btrim(url), '') IS NULL
              )::bigint AS missing_url_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND event_time IS NULL
              )::bigint AS missing_event_time_count,
              min(first_seen_at) FILTER (WHERE deleted_at IS NULL) AS oldest_record_at,
              max(last_seen_at) FILTER (WHERE deleted_at IS NULL) AS latest_record_at,
              max(publication_updated_at) FILTER (WHERE deleted_at IS NULL) AS latest_publication_at,
              coalesce((SELECT jsonb_object_agg(key, value) FROM stage_counts), '{}'::jsonb) AS stage_counts,
              coalesce((SELECT jsonb_object_agg(key, value) FROM status_counts), '{}'::jsonb) AS status_counts,
              coalesce((SELECT jsonb_object_agg(key, value) FROM scope_counts), '{}'::jsonb) AS scope_counts,
              coalesce((SELECT jsonb_object_agg(key, value) FROM country_counts), '{}'::jsonb) AS country_counts,
              coalesce((SELECT jsonb_object_agg(key, value) FROM province_counts), '{}'::jsonb) AS province_counts,
              coalesce((SELECT jsonb_object_agg(key, value) FROM candidate_score_buckets), '{}'::jsonb) AS candidate_score_buckets,
              coalesce((SELECT jsonb_object_agg(key, value) FROM candidate_quality_flags), '{}'::jsonb) AS candidate_quality_flags,
              coalesce((SELECT jsonb_object_agg(key, value) FROM candidate_rejection_codes), '{}'::jsonb) AS candidate_rejection_codes,
              coalesce((SELECT jsonb_object_agg(key, value) FROM task_counts), '{}'::jsonb) AS task_counts,
              coalesce((SELECT jsonb_object_agg(key, value) FROM task_error_counts), '{}'::jsonb) AS task_error_counts,
              coalesce((SELECT jsonb_object_agg(key, value) FROM assertion_counts), '{}'::jsonb) AS assertion_counts,
              (SELECT count(*)::bigint
                 FROM ingest.source_objects source_object
                WHERE source_object.connector_id = 'external:province-opinion-results'
                  AND source_object.object_type = 'opinion_item') AS source_object_count,
              (SELECT count(*)::bigint
                 FROM ingest.source_object_revisions source_revision
                 JOIN ingest.source_objects source_object
                   ON source_object.id = source_revision.source_object_id
                WHERE source_object.connector_id = 'external:province-opinion-results'
                  AND source_object.object_type = 'opinion_item') AS source_revision_count,
              (SELECT count(*)::bigint
                 FROM core.record_revisions revision
                 JOIN core.canonical_records record ON record.id = revision.record_id
                WHERE record.dataset_id = 'public-opinion.province.v1'
                  AND record.platform = 'public_opinion'
                  AND record.object_type = 'opinion_item') AS canonical_revision_count
         FROM current_records`,
    )
    return publicOpinionQualitySummaryRow(rows[0])
  }

  async listPublicOpinionRecords({
    provinceCode,
    sort,
    pageSize,
    cursor = null,
    from = null,
    to = null,
    candidateMode = 'formal',
    minQualityScore = null,
  }) {
    const select = `SELECT record.id, record.title, record.body, record.url,
                           record.content_type, record.author_name,
                           record.event_time, record.collected_at,
                           publication.display_admin1_code AS admin1_code,
                           record.heat_score, record.stable_fields,
                           publication.source_stage,
                           publication.status AS quality_status,
                           publication.quality_score,
                           publication.qualification_threshold,
                           publication.geography_verified,
                           publication.geo_scope,
                           publication.country_code,
                           publication.location_label,
                           publication.location_type,
                           publication.country_name,
                           coalesce(record.event_time, record.collected_at) AS sort_time`
    const scope = `FROM core.canonical_records record
                    JOIN core.public_opinion_current_state publication
                      ON publication.record_id = record.id
                     AND publication.canonical_revision = record.current_revision
                    WHERE record.dataset_id = 'public-opinion.province.v1'
                      AND record.platform = 'public_opinion'
                      AND record.object_type = 'opinion_item'
                      AND record.deleted_at IS NULL
                      AND publication.display_admin1_code = $1
                      AND record.collected_at IS NOT NULL
                      AND ($2::timestamptz IS NULL OR (
                        CASE WHEN publication.source_stage = 'candidate'
                          THEN coalesce(record.event_time, record.collected_at)
                          ELSE record.event_time
                        END
                      ) >= $2::timestamptz)
                      AND ($3::timestamptz IS NULL OR (
                        CASE WHEN publication.source_stage = 'candidate'
                          THEN coalesce(record.event_time, record.collected_at)
                          ELSE record.event_time
                        END
                      ) <= $3::timestamptz)
                      AND (
                        (publication.source_stage = 'formal' AND publication.status = 'formal')
                        OR (
                          $4::text = 'qualified'
                          AND publication.source_stage = 'candidate'
                          AND publication.status = 'qualified'
                          AND publication.quality_score >= greatest(
                            publication.qualification_threshold,
                            coalesce($5::smallint, 80)
                          )
                        )
                        OR (
                          $4::text = 'all'
                          AND publication.source_stage = 'candidate'
                          AND ($5::smallint IS NULL OR publication.quality_score >= $5::smallint)
                        )
                      )`
    if (sort === 'hot') {
      const { rows } = await this.pool.query(
        `${select}
           ${scope}
              AND record.heat_score IS NOT NULL
              AND ($6::numeric IS NULL OR (record.heat_score, coalesce(record.event_time, record.collected_at), record.id) < ($6::numeric, $7::timestamptz, $8::uuid))
            ORDER BY record.heat_score DESC, coalesce(record.event_time, record.collected_at) DESC, record.id DESC
            LIMIT $9`,
        [
          provinceCode, from, to,
          candidateMode, minQualityScore,
          cursor?.heatScore ?? null, cursor?.sortTime ?? null, cursor?.id ?? null,
          pageSize + 1,
        ],
      )
      return rows
    }
    const { rows } = await this.pool.query(
      `${select}
         ${scope}
            AND ($6::uuid IS NULL OR (coalesce(record.event_time, record.collected_at), record.collected_at, record.id) < ($7::timestamptz, $8::timestamptz, $6::uuid))
          ORDER BY coalesce(record.event_time, record.collected_at) DESC, record.collected_at DESC, record.id DESC
          LIMIT $9`,
      [
        provinceCode, from, to, candidateMode, minQualityScore, cursor?.id ?? null,
        cursor?.sortTime ?? null, cursor?.collectedAt ?? null, pageSize + 1,
      ],
    )
    return rows
  }

  /**
   * Broad but customer-safe public-opinion enumeration.
   *
   * This deliberately ignores publication status, quality score and geography
   * verification.  It still requires a current revision-fenced publication
   * state and never selects raw payloads, extensions, lineage or model traces.
   */
  async listPublicOpinionRegionRecords({
    regionCode,
    visibility,
    sort,
    from,
    to,
    pageSize,
    cursor = null,
  }) {
    if (visibility !== 'all_ingested') {
      throw new AppError(400, 'invalid_visibility', 'Region records currently require visibility=all_ingested')
    }
    if (sort !== 'latest') {
      throw new AppError(400, 'invalid_sort', 'all_ingested region records currently support latest only')
    }
    if (regionCode !== 'CN' && !/^CN-[A-Z]{2}$/.test(regionCode || '')) {
      throw new AppError(400, 'invalid_region', 'regionCode must be CN or an ISO 3166-2:CN province code')
    }

    const values = [from, to]
    const predicates = [
      "record.dataset_id = 'public-opinion.province.v1'",
      "record.platform = 'public_opinion'",
      "record.object_type = 'opinion_item'",
      'record.deleted_at IS NULL',
      'record.collected_at IS NOT NULL',
      'coalesce(record.event_time, record.collected_at) >= $1::timestamptz',
      'coalesce(record.event_time, record.collected_at) <= $2::timestamptz',
    ]
    if (regionCode !== 'CN') {
      values.push(regionCode)
      predicates.push(`publication.display_admin1_code = $${values.length}`)
    }
    if (cursor) {
      values.push(cursor.sortTime, cursor.collectedAt, cursor.id)
      const first = values.length - 2
      predicates.push(
        `(coalesce(record.event_time, record.collected_at), record.collected_at, record.id) < (`
        + `$${first}::timestamptz, $${first + 1}::timestamptz, $${first + 2}::uuid)`,
      )
    }
    values.push(pageSize + 1)
    const limitParameter = values.length
    const { rows } = await this.pool.query(
      `SELECT record.id, record.title, record.body, record.url,
              record.content_type, record.author_name,
              record.event_time, record.collected_at,
              publication.display_admin1_code AS admin1_code,
              record.heat_score, record.stable_fields,
              publication.source_stage,
              publication.status AS quality_status,
              publication.quality_score,
              publication.qualification_threshold,
              publication.geography_verified,
              publication.geo_scope,
              publication.country_code,
              publication.location_label,
              publication.location_type,
              publication.country_name,
              coalesce(record.event_time, record.collected_at) AS sort_time
         FROM core.canonical_records record
         JOIN core.public_opinion_current_state publication
           ON publication.record_id = record.id
          AND publication.canonical_revision = record.current_revision
        WHERE ${predicates.join('\n          AND ')}
        ORDER BY coalesce(record.event_time, record.collected_at) DESC NULLS LAST,
                 record.collected_at DESC NULLS LAST,
                 record.id DESC
        LIMIT $${limitParameter}`,
      values,
    )
    return rows
  }

  async getPublicOpinionRecord(id, { candidateMode = 'formal', minQualityScore = null } = {}) {
    const { rows } = await this.pool.query(
      `SELECT record.id, record.title, record.body, record.url,
              record.content_type, record.author_name,
              record.event_time, record.collected_at,
              publication.display_admin1_code AS admin1_code,
              record.heat_score, record.stable_fields,
              publication.source_stage,
              publication.status AS quality_status,
              publication.quality_score,
              publication.qualification_threshold,
              publication.geography_verified,
              publication.geo_scope,
              publication.country_code,
              publication.location_label,
              publication.location_type,
              publication.country_name
         FROM core.canonical_records record
         JOIN core.public_opinion_current_state publication
           ON publication.record_id = record.id
          AND publication.canonical_revision = record.current_revision
        WHERE record.id = $1
          AND record.dataset_id = 'public-opinion.province.v1'
          AND record.platform = 'public_opinion'
          AND record.object_type = 'opinion_item'
          AND record.deleted_at IS NULL
          AND (
            (publication.source_stage = 'formal' AND publication.status = 'formal')
            OR (
              $2::text = 'qualified'
              AND publication.source_stage = 'candidate'
              AND publication.status = 'qualified'
              AND publication.quality_score >= greatest(
                publication.qualification_threshold,
                coalesce($3::smallint, 80)
              )
            )
            OR (
              $2::text = 'all'
              AND publication.source_stage = 'candidate'
              AND ($3::smallint IS NULL OR publication.quality_score >= $3::smallint)
            )
          )`,
      [id, candidateMode, minQualityScore],
    )
    return rows[0] ?? null
  }

  async getPublicOpinionProvinceCoverage({
    from,
    to,
    candidateMode = 'formal',
    minQualityScore = null,
  }) {
    const { rows } = await this.pool.query(
      `SELECT publication.display_admin1_code AS province_code,
              count(*) FILTER (
                WHERE publication.source_stage = 'formal'
                  AND publication.status = 'formal'
              )::integer AS formal_count,
              count(*) FILTER (
                WHERE publication.source_stage = 'candidate'
                  AND (
                    $3::text <> 'all'
                    OR $4::smallint IS NULL
                    OR publication.quality_score >= $4::smallint
                  )
              )::integer AS candidate_count,
              count(*) FILTER (
                WHERE publication.source_stage = 'candidate'
                  AND publication.status = 'qualified'
                  AND publication.quality_score >= greatest(
                    publication.qualification_threshold,
                    coalesce($4::smallint, 80)
                  )
              )::integer AS qualified_candidate_count,
              count(*) FILTER (
                WHERE publication.geography_verified = true
                  AND (
                    (publication.source_stage = 'formal' AND publication.status = 'formal')
                    OR (
                      $3::text = 'qualified'
                      AND publication.source_stage = 'candidate'
                      AND publication.status = 'qualified'
                      AND publication.quality_score >= greatest(
                        publication.qualification_threshold,
                        coalesce($4::smallint, 80)
                      )
                    )
                    OR (
                      $3::text = 'all'
                      AND publication.source_stage = 'candidate'
                      AND ($4::smallint IS NULL OR publication.quality_score >= $4::smallint)
                    )
                  )
              )::integer AS verified_count,
              avg(publication.quality_score) FILTER (
                WHERE publication.source_stage = 'candidate'
                  AND publication.quality_score IS NOT NULL
              ) AS average_quality_score
         FROM core.canonical_records record
         JOIN core.public_opinion_current_state publication
           ON publication.record_id = record.id
          AND publication.canonical_revision = record.current_revision
        WHERE record.dataset_id = 'public-opinion.province.v1'
          AND record.platform = 'public_opinion'
          AND record.object_type = 'opinion_item'
          AND record.deleted_at IS NULL
          AND (
            CASE WHEN publication.source_stage = 'candidate'
              THEN coalesce(record.event_time, record.collected_at)
              ELSE record.event_time
            END
          ) >= $1::timestamptz
          AND (
            CASE WHEN publication.source_stage = 'candidate'
              THEN coalesce(record.event_time, record.collected_at)
              ELSE record.event_time
            END
          ) <= $2::timestamptz
          AND publication.display_admin1_code IS NOT NULL
        GROUP BY publication.display_admin1_code
        ORDER BY province_code`,
      [from, to, candidateMode, minQualityScore],
    )
    return rows
  }

  async getAdminPublicOpinionFunnel({ from, to }) {
    const { rows } = await this.pool.query(
      `WITH current_records AS MATERIALIZED (
         SELECT record.id, record.deleted_at, record.event_time, record.heat_score,
                publication.record_id AS publication_record_id,
                publication.source_stage,
                publication.status AS publication_status,
                publication.display_admin1_code,
                publication.geo_scope
           FROM core.canonical_records record
           LEFT JOIN core.public_opinion_current_state publication
             ON publication.record_id = record.id
            AND publication.canonical_revision = record.current_revision
          WHERE record.dataset_id = 'public-opinion.province.v1'
            AND record.platform = 'public_opinion'
            AND record.object_type = 'opinion_item'
       ), stage_counts AS (
         SELECT coalesce(source_stage, 'unknown') AS key, count(*)::integer AS value
           FROM current_records
          WHERE deleted_at IS NULL AND publication_record_id IS NOT NULL
          GROUP BY coalesce(source_stage, 'unknown')
       ), status_counts AS (
         SELECT coalesce(publication_status, 'unknown') AS key, count(*)::integer AS value
           FROM current_records
          WHERE deleted_at IS NULL AND publication_record_id IS NOT NULL
          GROUP BY coalesce(publication_status, 'unknown')
       ), scope_counts AS (
         SELECT coalesce(geo_scope, 'unknown') AS key, count(*)::integer AS value
           FROM current_records
          WHERE deleted_at IS NULL
          GROUP BY coalesce(geo_scope, 'unknown')
       )
       SELECT count(*)::bigint AS canonical_total,
              count(*) FILTER (WHERE deleted_at IS NULL)::bigint AS active_count,
              count(*) FILTER (WHERE deleted_at IS NOT NULL)::bigint AS deleted_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND publication_record_id IS NOT NULL
              )::bigint AS with_publication_state_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND publication_record_id IS NULL
              )::bigint AS missing_publication_state_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND event_time IS NOT NULL
              )::bigint AS with_event_time_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND event_time IS NULL
              )::bigint AS missing_event_time_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND event_time >= $1::timestamptz
                  AND event_time <= $2::timestamptz
              )::bigint AS within_window_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND event_time IS NOT NULL
                  AND (event_time < $1::timestamptz OR event_time > $2::timestamptz)
              )::bigint AS outside_window_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND display_admin1_code IS NOT NULL
              )::bigint AS with_province_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND display_admin1_code IS NULL
              )::bigint AS without_province_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND heat_score IS NOT NULL
              )::bigint AS with_heat_score_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND heat_score IS NULL
              )::bigint AS missing_heat_score_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND publication_record_id IS NOT NULL
                  AND source_stage IS DISTINCT FROM 'formal'
              )::bigint AS not_formal_stage_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL AND publication_record_id IS NOT NULL
                  AND publication_status IS DISTINCT FROM 'formal'
              )::bigint AS not_formal_status_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL
                  AND source_stage = 'formal' AND publication_status = 'formal'
                  AND event_time >= $1::timestamptz AND event_time <= $2::timestamptz
                  AND display_admin1_code IS NOT NULL
              )::bigint AS coverage_visible_count,
              count(*) FILTER (
                WHERE deleted_at IS NULL
                  AND source_stage = 'formal' AND publication_status = 'formal'
                  AND event_time >= $1::timestamptz AND event_time <= $2::timestamptz
                  AND display_admin1_code IS NOT NULL AND heat_score IS NOT NULL
              )::bigint AS hot_visible_count,
              coalesce((SELECT jsonb_object_agg(key, value) FROM stage_counts), '{}'::jsonb) AS stage_counts,
              coalesce((SELECT jsonb_object_agg(key, value) FROM status_counts), '{}'::jsonb) AS status_counts,
              coalesce((SELECT jsonb_object_agg(key, value) FROM scope_counts), '{}'::jsonb) AS scope_counts
         FROM current_records`,
      [from, to],
    )
    return rows[0] ?? {}
  }

  async listAdminPublicOpinionBrowseRecords({
    from,
    to,
    pageSize,
    cursor = null,
    query = null,
    reason = 'all',
    stage = 'all',
    status = 'all',
    province = 'all',
    scope = 'all',
    time = 'all',
    heat = 'all',
  }) {
    const values = [from, to]
    const predicates = [
      '$1::timestamptz <= $2::timestamptz',
      "record.dataset_id = 'public-opinion.province.v1'",
      "record.platform = 'public_opinion'",
      "record.object_type = 'opinion_item'",
      'record.deleted_at IS NULL',
    ]
    const parameter = (value) => {
      values.push(value)
      return `$${values.length}`
    }

    if (query) {
      const placeholder = parameter(`%${query}%`)
      predicates.push(`(
        record.title ILIKE ${placeholder}
        OR record.body ILIKE ${placeholder}
        OR record.author_name ILIKE ${placeholder}
        OR publication.display_admin1_code ILIKE ${placeholder}
        OR publication.location_label ILIKE ${placeholder}
        OR publication.country_name ILIKE ${placeholder}
        OR record.stable_fields #>> '{attributes,sourceType}' ILIKE ${placeholder}
        OR record.stable_fields #>> '{attributes,sourcePlatform}' ILIKE ${placeholder}
      )`)
    }
    if (stage === 'missing') predicates.push('publication.source_stage IS NULL')
    else if (stage !== 'all') predicates.push(`publication.source_stage = ${parameter(stage)}`)
    if (status === 'missing') predicates.push('publication.status IS NULL')
    else if (status !== 'all') predicates.push(`publication.status = ${parameter(status)}`)
    if (province === 'missing') predicates.push('publication.display_admin1_code IS NULL')
    else if (province !== 'all') predicates.push(`publication.display_admin1_code = ${parameter(province)}`)
    if (scope === 'missing') predicates.push('publication.geo_scope IS NULL')
    else if (scope !== 'all') {
      predicates.push(`publication.geo_scope = ${parameter(scope === 'nationwide' ? 'national' : scope)}`)
    }
    if (time === 'missing') predicates.push('record.event_time IS NULL')
    else if (time === 'within') predicates.push('record.event_time >= $1::timestamptz AND record.event_time <= $2::timestamptz')
    else if (time === 'outside') predicates.push('record.event_time IS NOT NULL AND (record.event_time < $1::timestamptz OR record.event_time > $2::timestamptz)')
    if (heat === 'missing') predicates.push('record.heat_score IS NULL')
    else if (heat === 'present') predicates.push('record.heat_score IS NOT NULL')

    const coverage = `publication.record_id IS NOT NULL
      AND publication.source_stage = 'formal'
      AND publication.status = 'formal'
      AND record.event_time >= $1::timestamptz
      AND record.event_time <= $2::timestamptz
      AND publication.display_admin1_code IS NOT NULL`
    const reasons = {
      coverage_visible: `(${coverage})`,
      hot_visible: `(${coverage} AND record.heat_score IS NOT NULL)`,
      missing_publication_state: 'publication.record_id IS NULL',
      not_formal_stage: "publication.record_id IS NOT NULL AND publication.source_stage IS DISTINCT FROM 'formal'",
      not_formal_status: "publication.record_id IS NOT NULL AND publication.status IS DISTINCT FROM 'formal'",
      missing_event_time: 'record.event_time IS NULL',
      outside_window: 'record.event_time IS NOT NULL AND (record.event_time < $1::timestamptz OR record.event_time > $2::timestamptz)',
      missing_province: 'publication.display_admin1_code IS NULL',
      missing_heat: 'record.heat_score IS NULL',
    }
    if (reason !== 'all') predicates.push(`(${reasons[reason]})`)

    if (cursor) {
      const sortTime = parameter(cursor.sortTime)
      const id = parameter(cursor.id)
      predicates.push(`(coalesce(record.event_time, record.collected_at, to_timestamp(0)), record.id) < (${sortTime}::timestamptz, ${id}::uuid)`)
    }
    const limit = parameter(pageSize + 1)
    const { rows } = await this.pool.query(
      `${ADMIN_PUBLIC_OPINION_BROWSE_SELECT}
        WHERE ${predicates.join('\n          AND ')}
        ORDER BY coalesce(record.event_time, record.collected_at, to_timestamp(0)) DESC,
                 record.id DESC
        LIMIT ${limit}`,
      values,
    )
    return rows
  }

  async getAdminPublicOpinionBrowseRecord(id) {
    const { rows } = await this.pool.query(
      `${ADMIN_PUBLIC_OPINION_BROWSE_SELECT}
        WHERE record.id = $1::uuid
          AND record.dataset_id = 'public-opinion.province.v1'
          AND record.platform = 'public_opinion'
          AND record.object_type = 'opinion_item'
          AND record.deleted_at IS NULL`,
      [id],
    )
    return rows[0] ?? null
  }

  // Admin data-product views are curated/formal-only by design. These focused
  // entry points let HubService distinguish a real PostgreSQL runtime from the
  // MemoryStore demo without adding any new public MemoryStore API.
  listAdminPublicOpinionRecords(input) {
    return this.listPublicOpinionRecords({
      ...input,
      candidateMode: 'formal',
      minQualityScore: null,
    })
  }

  getAdminPublicOpinionProvinceCoverage(input) {
    return this.getPublicOpinionProvinceCoverage({
      ...input,
      candidateMode: 'formal',
      minQualityScore: null,
    })
  }

  getAdminPublicOpinionRecord(id) {
    return this.getPublicOpinionRecord(id, {
      candidateMode: 'formal',
      minQualityScore: null,
    })
  }

  async dataCenter({ datasetId = null, platform = null, objectType = null, pageSize = 50 } = {}) {
    const values = []
    const clauses = []
    for (const [column, value] of [
      ['r.dataset_id', datasetId],
      ['r.platform', platform],
      ['r.object_type', objectType],
    ]) {
      if (!value) continue
      values.push(value)
      clauses.push(`${column} = $${values.length}`)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const recordValues = [...values, pageSize]
    const [datasetResult, recordResult] = await Promise.all([
      this.pool.query(
        `SELECT dataset_id,
                array_agg(DISTINCT platform ORDER BY platform) AS platforms,
                array_agg(DISTINCT object_type ORDER BY object_type) AS object_types,
                coalesce(
                  array_agg(DISTINCT content_type ORDER BY content_type)
                    FILTER (WHERE content_type IS NOT NULL),
                  ARRAY[]::text[]
                ) AS content_types,
                count(*) FILTER (WHERE deleted_at IS NULL) AS active_record_count,
                count(*) FILTER (WHERE deleted_at IS NOT NULL) AS deleted_record_count,
                coalesce(sum(current_revision), 0) AS revision_count,
                max(collected_at) AS last_collected_at,
                max(event_time) AS last_event_at
           FROM core.canonical_records r
           ${where}
          GROUP BY dataset_id
          ORDER BY dataset_id`,
        values,
      ),
      this.pool.query(
        `SELECT id, dataset_id, platform, object_type, content_type, external_id,
                title, current_revision, event_time, collected_at, deleted_at
           FROM core.canonical_records r
           ${where}
          ORDER BY coalesce(event_time, collected_at, last_seen_at, first_seen_at) DESC, id DESC
          LIMIT $${recordValues.length}`,
        recordValues,
      ),
    ])
    const datasets = datasetResult.rows.map(dataCenterDataset)
    return {
      stats: {
        datasetCount: datasets.length,
        activeRecordCount: datasets.reduce((total, row) => total + row.activeRecordCount, 0),
        revisionCount: datasets.reduce((total, row) => total + row.revisionCount, 0),
        deletedRecordCount: datasets.reduce((total, row) => total + row.deletedRecordCount, 0),
      },
      datasets,
      records: recordResult.rows.map(dataCenterRecord),
      pageSize,
    }
  }

  /**
   * Paginated page for the Admin Data Center record browser.
   *
   * This is deliberately separate from `dataCenter()`: the catalog/count query
   * is cheap and stable, while a user may walk many record pages. Only canonical
   * Admin operators need the canonical truth for diagnosis and curation, so
   * this page deliberately includes the current revision payload, extensions
   * and lineage. Public API projections remain separately allowlisted. Cursor
   * callers retain keyset pagination; the Admin UI may request a 1-based page
   * and pay the offset cost needed for direct page jumps.
   */
  async dataCenterRecords({
    datasetId = null,
    platform = null,
    objectType = null,
    query = null,
    relatedAdmin1Code = null,
    relatedProvinceNames = [],
    provinceRelation = 'any',
    sort = 'newest',
    pageSize = 50,
    cursor = null,
    page = null,
  } = {}) {
    const filterValues = []
    const filterClauses = []
    for (const [column, value] of [
      ['r.dataset_id', datasetId],
      ['r.platform', platform],
      ['r.object_type', objectType],
    ]) {
      if (!value) continue
      filterValues.push(value)
      filterClauses.push(`${column} = $${filterValues.length}`)
    }
    if (query) {
      filterValues.push(query)
      filterClauses.push(`(
        r.title ILIKE '%' || $${filterValues.length} || '%'
        OR r.body ILIKE '%' || $${filterValues.length} || '%'
        OR r.external_id ILIKE '%' || $${filterValues.length} || '%'
      )`)
    }
    let provinceFilterJoins = ''
    let relatedMatchesSelect = ''
    if (relatedAdmin1Code) {
      filterValues.push(relatedAdmin1Code)
      const codeParameter = filterValues.length
      filterValues.push(relatedProvinceNames)
      const namesParameter = filterValues.length
      const filterRelations = dataCenterProvinceRelationExpressions({
        recordAlias: 'r',
        publicationAlias: 'publication_filter',
        revisionAlias: 'revision_filter',
        codeParameter,
        namesParameter,
      })
      filterClauses.push(filterRelations[provinceRelation])
      provinceFilterJoins = `LEFT JOIN core.record_revisions revision_filter
          ON revision_filter.record_id = r.id
         AND revision_filter.revision = r.current_revision
        LEFT JOIN core.public_opinion_current_state publication_filter
          ON publication_filter.record_id = r.id
         AND publication_filter.canonical_revision = r.current_revision`
      const resultRelations = dataCenterProvinceRelationExpressions({
        recordAlias: 'r',
        publicationAlias: 'publication',
        revisionAlias: 'revision',
        codeParameter,
        namesParameter,
      })
      relatedMatchesSelect = `,
              ARRAY_REMOVE(ARRAY[
                CASE WHEN ${resultRelations.event} THEN 'event' END,
                CASE WHEN ${resultRelations.publisher} THEN 'publisher' END,
                CASE WHEN ${resultRelations.display} THEN 'display' END,
                CASE WHEN ${resultRelations.report} THEN 'report' END,
                CASE WHEN ${resultRelations.recall} THEN 'recall' END,
                CASE WHEN ${resultRelations.related} THEN 'related' END,
                CASE WHEN ${resultRelations.canonical} THEN 'canonical' END
              ], NULL) AS related_admin1_matches`
    }
    const oldestFirst = sort === 'oldest'
    const direction = oldestFirst ? 'ASC' : 'DESC'
    const cursorOperator = oldestFirst ? '>' : '<'
    const values = [...filterValues]
    const clauses = [...filterClauses]
    if (cursor) {
      values.push(cursor.sortTime, cursor.id)
      clauses.push(
        `(coalesce(r.event_time, r.collected_at, r.last_seen_at, r.first_seen_at), r.id)`
        + ` ${cursorOperator} ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
      )
    }
    values.push(pageSize + 1)
    const limitParameter = values.length
    let offset = ''
    if (page != null) {
      values.push((page - 1) * pageSize)
      offset = `OFFSET $${values.length}`
    }
    const filterWhere = filterClauses.length ? `WHERE ${filterClauses.join(' AND ')}` : ''
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const [countResult, recordResult] = await Promise.all([
      this.pool.query(
        `SELECT count(*)::bigint AS total
           FROM core.canonical_records r
           ${provinceFilterJoins}
           ${filterWhere}`,
        filterValues,
      ),
      this.pool.query(
        `WITH page AS MATERIALIZED (
         SELECT r.id,
                coalesce(r.event_time, r.collected_at, r.last_seen_at, r.first_seen_at) AS sort_time
           FROM core.canonical_records r
           ${provinceFilterJoins}
           ${where}
          ORDER BY coalesce(r.event_time, r.collected_at, r.last_seen_at, r.first_seen_at) ${direction}, r.id ${direction}
          LIMIT $${limitParameter}
          ${offset}
       )
       SELECT r.id, r.dataset_id, r.platform, r.object_type, r.external_id, r.identity_hash,
              r.schema_version, r.payload_sha256, r.content_type, r.url, r.title, r.body,
              r.author_external_id, r.author_name, r.event_time, r.collected_at,
              r.latitude, r.longitude, r.country_code, r.admin1_code, r.admin2_code,
              r.stable_fields, r.extensions, r.current_revision, r.projection_revision,
              r.first_seen_at, r.last_seen_at, r.deleted_at,
              revision.normalized_payload AS raw_payload,
              revision.parser_version, revision.ingest_run_id,
              revision.external_import_run_id,
              observation.id AS observation_id,
              observation.ingest_run_id AS observation_ingest_run_id,
              observation.connector_id AS observation_connector_id,
              observation.source_event_id AS observation_source_event_id,
              observation.query_fingerprint AS observation_query_fingerprint,
              observation_run.request_id AS observation_request_id,
              observation_run.connector_call_id,
              observation_run.external_platform_call_id,
              connector_call.operation AS connector_operation,
              external_call.provider_key AS external_provider_key,
              external_call.operation AS external_operation,
              external_call.endpoint_key AS external_endpoint_key,
              external_call.endpoint_version AS external_endpoint_version,
              external_call.marketplace AS external_marketplace,
              external_call.outcome AS external_outcome,
              external_call.billed AS external_billed,
              external_call.cost_minor AS external_cost_minor,
              external_call.cost_kind AS external_cost_kind,
              external_call.currency AS external_currency,
              external_call.upstream_request_id AS external_upstream_request_id,
              external_call.upstream_record_time AS external_upstream_record_time,
              external_call.completed_at AS external_completed_at,
              external_response.contract_state AS external_response_contract_state,
              external_response.captured_at AS external_response_captured_at,
              external_response.payload_sha256 AS external_response_payload_sha256,
              external_archive.archive_path AS external_archive_path,
              external_archive.source_key AS external_archive_source_key,
              publication.record_id AS publication_record_id,
              publication.source_stage AS publication_source_stage,
              publication.status AS publication_status,
              publication.quality_score AS publication_quality_score,
              publication.qualification_threshold AS publication_qualification_threshold,
              publication.event_admin1_code AS publication_event_admin1_code,
              publication.publisher_admin1_code AS publication_publisher_admin1_code,
              publication.display_admin1_code AS publication_display_admin1_code,
              publication.geography_verified AS publication_geography_verified,
              publication.geo_scope AS publication_geo_scope,
              publication.country_code AS publication_country_code,
              publication.location_label AS publication_location_label,
              publication.location_type AS publication_location_type,
              publication.country_name AS publication_country_name,
              publication.assessed_at AS publication_assessed_at,
              page.sort_time
              ${relatedMatchesSelect}
         FROM page
         JOIN core.canonical_records r ON r.id = page.id
         LEFT JOIN core.record_revisions revision
           ON revision.record_id = r.id AND revision.revision = r.current_revision
         LEFT JOIN core.public_opinion_current_state publication
           ON publication.record_id = r.id
          AND publication.canonical_revision = r.current_revision
          AND r.dataset_id = 'public-opinion.province.v1'
         LEFT JOIN LATERAL (
           SELECT o.id, o.ingest_run_id, o.connector_id, o.source_event_id,
                  o.query_fingerprint, o.observed_at
             FROM core.observations o
            WHERE o.record_id = r.id
            ORDER BY o.observed_at DESC, o.id DESC
            LIMIT 1
         ) observation ON true
         LEFT JOIN ingest.ingest_runs observation_run
           ON observation_run.id = observation.ingest_run_id
         LEFT JOIN serving.connector_calls connector_call
           ON connector_call.id = observation_run.connector_call_id
         LEFT JOIN external_platform.provider_calls external_call
           ON external_call.id = observation_run.external_platform_call_id
         LEFT JOIN external_platform.response_archives external_response
           ON external_response.provider_call_id = external_call.id
         LEFT JOIN LATERAL (
           SELECT archive_path, source_key
             FROM external_platform.archive_objects
            WHERE provider_call_id = external_call.id AND object_kind = 'response'
            ORDER BY item_ordinal
            LIMIT 1
         ) external_archive ON true
        ORDER BY page.sort_time ${direction}, page.id ${direction}`,
        values,
      ),
    ])
    const rows = recordResult.rows
    const total = Number(countResult.rows[0]?.total ?? 0)
    const hasMore = rows.length > pageSize
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows
    const last = pageRows.at(-1)
    return {
      items: pageRows.map(dataCenterRecordDetail),
      total,
      hasMore,
      nextCursor: hasMore && last
        ? { sortTime: iso(last.sort_time), id: last.id }
        : null,
    }
  }

  async dataCenterRecordsByIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return []
    const { rows } = await this.pool.query(
      `SELECT r.id, r.dataset_id, r.platform, r.object_type, r.external_id, r.identity_hash,
              r.schema_version, r.payload_sha256, r.content_type, r.url, r.title, r.body,
              r.author_external_id, r.author_name, r.event_time, r.collected_at,
              r.latitude, r.longitude, r.country_code, r.admin1_code, r.admin2_code,
              r.stable_fields, r.extensions, r.current_revision, r.projection_revision,
              r.first_seen_at, r.last_seen_at, r.deleted_at,
              revision.normalized_payload AS raw_payload,
              revision.parser_version, revision.ingest_run_id,
              revision.external_import_run_id,
              observation.id AS observation_id,
              observation.ingest_run_id AS observation_ingest_run_id,
              observation.connector_id AS observation_connector_id,
              observation.source_event_id AS observation_source_event_id,
              observation.query_fingerprint AS observation_query_fingerprint,
              observation_run.request_id AS observation_request_id,
              observation_run.connector_call_id,
              observation_run.external_platform_call_id,
              connector_call.operation AS connector_operation,
              external_call.provider_key AS external_provider_key,
              external_call.operation AS external_operation,
              external_call.endpoint_key AS external_endpoint_key,
              external_call.endpoint_version AS external_endpoint_version,
              external_call.marketplace AS external_marketplace,
              external_call.outcome AS external_outcome,
              external_call.billed AS external_billed,
              external_call.cost_minor AS external_cost_minor,
              external_call.cost_kind AS external_cost_kind,
              external_call.currency AS external_currency,
              external_call.upstream_request_id AS external_upstream_request_id,
              external_call.upstream_record_time AS external_upstream_record_time,
              external_call.completed_at AS external_completed_at,
              external_response.contract_state AS external_response_contract_state,
              external_response.captured_at AS external_response_captured_at,
              external_response.payload_sha256 AS external_response_payload_sha256,
              external_archive.archive_path AS external_archive_path,
              external_archive.source_key AS external_archive_source_key,
              publication.record_id AS publication_record_id,
              publication.source_stage AS publication_source_stage,
              publication.status AS publication_status,
              publication.quality_score AS publication_quality_score,
              publication.qualification_threshold AS publication_qualification_threshold,
              publication.event_admin1_code AS publication_event_admin1_code,
              publication.publisher_admin1_code AS publication_publisher_admin1_code,
              publication.display_admin1_code AS publication_display_admin1_code,
              publication.geography_verified AS publication_geography_verified,
              publication.geo_scope AS publication_geo_scope,
              publication.country_code AS publication_country_code,
              publication.location_label AS publication_location_label,
              publication.location_type AS publication_location_type,
              publication.country_name AS publication_country_name,
              publication.assessed_at AS publication_assessed_at
         FROM core.canonical_records r
         LEFT JOIN core.record_revisions revision
           ON revision.record_id = r.id AND revision.revision = r.current_revision
         LEFT JOIN core.public_opinion_current_state publication
           ON publication.record_id = r.id
          AND publication.canonical_revision = r.current_revision
          AND r.dataset_id = 'public-opinion.province.v1'
         LEFT JOIN LATERAL (
           SELECT o.id, o.ingest_run_id, o.connector_id, o.source_event_id,
                  o.query_fingerprint, o.observed_at
             FROM core.observations o
            WHERE o.record_id = r.id
            ORDER BY o.observed_at DESC, o.id DESC
            LIMIT 1
         ) observation ON true
         LEFT JOIN ingest.ingest_runs observation_run
           ON observation_run.id = observation.ingest_run_id
         LEFT JOIN serving.connector_calls connector_call
           ON connector_call.id = observation_run.connector_call_id
         LEFT JOIN external_platform.provider_calls external_call
           ON external_call.id = observation_run.external_platform_call_id
         LEFT JOIN external_platform.response_archives external_response
           ON external_response.provider_call_id = external_call.id
         LEFT JOIN LATERAL (
           SELECT archive_path, source_key
             FROM external_platform.archive_objects
            WHERE provider_call_id = external_call.id AND object_kind = 'response'
            ORDER BY item_ordinal
            LIMIT 1
         ) external_archive ON true
        WHERE r.id = ANY($1::uuid[])`,
      [ids],
    )
    return rows.map(dataCenterRecordDetail)
  }

  async #updateRequest(sql, values) {
    const { rows } = await this.pool.query(sql, values)
    if (!rows[0]) throw new AppError(404, 'request_not_found', 'Request not found')
    return requestRecord(rows[0])
  }

  async getRequest(id, consumerId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM usage_requests
       WHERE id = $1 AND ($2::uuid IS NULL OR consumer_id = $2)`,
      [id, consumerId || null],
    )
    const record = requestRecord(rows[0])
    if (!record) return null
    const { responseBody: _responseBody, fingerprint: _fingerprint, ...safe } = record
    return safe
  }

  async usage(filters = {}) {
    const values = []
    const clauses = []
    for (const [column, value] of [
      ['tenant_id', filters.tenantId],
      ['consumer_id', filters.consumerId],
    ]) {
      if (value) {
        values.push(value)
        clauses.push(`${column} = $${values.length}`)
      }
    }
    if (filters.from) {
      values.push(filters.from)
      clauses.push(`created_at >= $${values.length}`)
    }
    if (filters.to) {
      values.push(filters.to)
      clauses.push(`created_at < $${values.length}`)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const { rows } = await this.pool.query(
      `SELECT
         platform,
         capability,
         count(*)::integer AS requests,
         count(*) FILTER (WHERE status = 'committed')::integer AS committed,
         count(*) FILTER (WHERE status = 'released')::integer AS released,
         count(*) FILTER (WHERE status = 'unknown')::integer AS unknown,
         coalesce(sum(units_actual) FILTER (WHERE status = 'committed'), 0)::integer AS units,
         round(avg(upstream_latency_ms))::integer AS average_latency
       FROM usage_requests ${where}
       GROUP BY platform, capability`,
      values,
    )
    return summarizeAggregates(rows)
  }

  async dashboard() {
    const [tenantsResult, consumersResult, keysResult, usage] = await Promise.all([
      this.pool.query('SELECT count(*)::integer AS count FROM tenants'),
      this.pool.query('SELECT count(*)::integer AS count FROM consumers'),
      this.pool.query("SELECT count(*)::integer AS count FROM api_keys WHERE status = 'active' AND expires_at > now()"),
      this.usage(),
    ])
    return {
      tenants: tenantsResult.rows[0].count,
      consumers: consumersResult.rows[0].count,
      activeApiKeys: keysResult.rows[0].count,
      ...usage,
    }
  }

  // ---- shared database connections (migration 048) ----------------------

  async listDatabaseConnections() {
    const { rows } = await this.pool.query(
      `SELECT *
         FROM catalog.database_connections
        ORDER BY created_at DESC, id`,
    )
    return rows.map(databaseConnection)
  }

  async getDatabaseConnection(id) {
    const { rows } = await this.pool.query(
      `SELECT * FROM catalog.database_connections WHERE id = $1`,
      [id],
    )
    return databaseConnection(rows[0])
  }

  async createDatabaseConnection({ key, displayName, engine = 'postgresql', connection = {} }) {
    const { rows } = await this.pool.query(
      `INSERT INTO catalog.database_connections
         (id, connection_key, display_name, engine, connection)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (connection_key) DO NOTHING
       RETURNING *`,
      [randomUUID(), key, displayName, engine, connection],
    )
    if (!rows[0]) {
      throw new AppError(409, 'database_connection_exists', `Database connection key already exists: ${key}`)
    }
    return databaseConnection(rows[0])
  }

  async updateDatabaseConnection(id, patch, { expectedRevision = null } = {}) {
    const hasDisplayName = Object.prototype.hasOwnProperty.call(patch, 'displayName')
    const hasEngine = Object.prototype.hasOwnProperty.call(patch, 'engine')
    const hasConnection = Object.prototype.hasOwnProperty.call(patch, 'connection')
    const { rows } = await this.pool.query(
      `UPDATE catalog.database_connections
          SET display_name = CASE WHEN $2 THEN $3 ELSE display_name END,
              engine = CASE WHEN $4 THEN $5 ELSE engine END,
              connection = CASE WHEN $6 THEN $7 ELSE connection END,
              revision = revision + 1,
              updated_at = now()
        WHERE id = $1
          AND ($8::integer IS NULL OR revision = $8)
        RETURNING *`,
      [
        id,
        hasDisplayName,
        patch.displayName ?? null,
        hasEngine,
        patch.engine ?? null,
        hasConnection,
        patch.connection ?? null,
        expectedRevision,
      ],
    )
    if (!rows[0]) {
      if (expectedRevision != null) {
        const current = await this.pool.query(
          `SELECT revision FROM catalog.database_connections WHERE id = $1`,
          [id],
        )
        if (current.rows[0]) {
          throw new AppError(
            409,
            'database_connection_revision_conflict',
            'Database connection changed; reload before saving',
            {
              expectedRevision,
              currentRevision: Number(current.rows[0].revision),
            },
          )
        }
      }
      throw new AppError(404, 'database_connection_not_found', `Unknown database connection: ${id}`)
    }
    return databaseConnection(rows[0])
  }

  async listDatabaseConnectionReferences(id) {
    const { rows } = await this.pool.query(
      `SELECT *
         FROM catalog.external_sources
        WHERE database_connection_id = $1
        ORDER BY source_key, id`,
      [id],
    )
    return rows.map(externalSource)
  }

  async deleteDatabaseConnection(id) {
    return withPgTransaction(this.pool, async (client) => {
      const current = await client.query(
        `SELECT * FROM catalog.database_connections WHERE id = $1 FOR UPDATE`,
        [id],
      )
      if (!current.rows[0]) {
        throw new AppError(404, 'database_connection_not_found', `Unknown database connection: ${id}`)
      }
      const references = await client.query(
        `SELECT *
           FROM catalog.external_sources
          WHERE database_connection_id = $1
          ORDER BY source_key, id`,
        [id],
      )
      if (references.rows.length > 0) {
        throw new AppError(
          409,
          'database_connection_in_use',
          'Database connection is referenced by one or more external sources',
          {
            references: references.rows.map((row) => ({
              sourceId: row.id,
              sourceKey: row.source_key,
              displayName: row.display_name,
            })),
          },
        )
      }
      await client.query(
        `DELETE FROM catalog.database_connections WHERE id = $1`,
        [id],
      )
      return databaseConnection(current.rows[0])
    })
  }

  // ---- external sources (migration 008) ----------------------------------

  async createExternalSource({
    sourceKey,
    displayName,
    sourceKind,
    datasetId,
    platform,
    objectType,
    status,
    connection,
    databaseConnectionId = null,
    syncIntervalSeconds = 60,
  }) {
    const { rows } = await this.pool.query(
      `INSERT INTO catalog.external_sources
         (id, source_key, display_name, source_kind, dataset_id, platform, object_type, status,
          database_connection_id, connection, sync_interval_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (source_key) DO NOTHING
       RETURNING *`,
      [
        randomUUID(), sourceKey, displayName, sourceKind, datasetId, platform,
        objectType || 'record', status || 'active', databaseConnectionId, connection || {}, syncIntervalSeconds,
      ],
    )
    if (!rows[0]) throw new AppError(409, 'source_exists', `Source key already exists: ${sourceKey}`)
    return externalSource(rows[0])
  }

  async updateExternalSource(sourceKey, patch) {
    const hasDatabaseConnection = Object.prototype.hasOwnProperty.call(patch, 'databaseConnectionId')
    const hasSyncInterval = Object.prototype.hasOwnProperty.call(patch, 'syncIntervalSeconds')
    const { rows } = await this.pool.query(
      `UPDATE catalog.external_sources
          SET status = coalesce($2, status),
              connection = coalesce($3, connection),
              database_connection_id = CASE WHEN $4 THEN $5 ELSE database_connection_id END,
              sync_interval_seconds = CASE WHEN $6 THEN $7 ELSE sync_interval_seconds END,
              updated_at = now()
        WHERE source_key = $1
        RETURNING *`,
      [
        sourceKey,
        patch.status ?? null,
        patch.connection ?? null,
        hasDatabaseConnection,
        patch.databaseConnectionId ?? null,
        hasSyncInterval,
        patch.syncIntervalSeconds ?? null,
      ],
    )
    if (!rows[0]) throw new AppError(404, 'source_not_found', `Unknown external source: ${sourceKey}`)
    return externalSource(rows[0])
  }

  /** Apply related source changes in one transaction (for built-in pipelines). */
  async updateExternalSourcesBatch(updates) {
    if (!Array.isArray(updates) || updates.length === 0) return []
    return withPgTransaction(this.pool, async (client) => {
      const results = []
      for (const update of updates) {
        const hasDatabaseConnection = Object.prototype.hasOwnProperty.call(update, 'databaseConnectionId')
        const hasSyncInterval = Object.prototype.hasOwnProperty.call(update, 'syncIntervalSeconds')
        const { rows } = await client.query(
          `UPDATE catalog.external_sources
              SET status = coalesce($2, status),
                  connection = coalesce($3, connection),
                  database_connection_id = CASE WHEN $4 THEN $5 ELSE database_connection_id END,
                  sync_interval_seconds = CASE WHEN $6 THEN $7 ELSE sync_interval_seconds END,
                  updated_at = now()
            WHERE source_key = $1
            RETURNING *`,
          [
            update.sourceKey,
            update.status ?? null,
            update.connection ?? null,
            hasDatabaseConnection,
            update.databaseConnectionId ?? null,
            hasSyncInterval,
            update.syncIntervalSeconds ?? null,
          ],
        )
        if (!rows[0]) throw new AppError(404, 'source_not_found', `Unknown external source: ${update.sourceKey}`)
        results.push(externalSource(rows[0]))
      }
      return results
    })
  }

  async getExternalSource(sourceKey) {
    const { rows } = await this.pool.query(
      `SELECT * FROM catalog.external_sources WHERE source_key = $1`,
      [sourceKey],
    )
    return externalSource(rows[0])
  }

  async listExternalSources() {
    const { rows } = await this.pool.query(
      `SELECT * FROM catalog.external_sources ORDER BY created_at DESC`,
    )
    return rows.map(externalSource)
  }

  // ---- governed source catalog (migration 036) --------------------------

  async listSourceCatalogEntries({ includeArchived = false } = {}) {
    const { rows } = await this.pool.query(
      `SELECT *
         FROM catalog.source_catalog_entries
        WHERE $1::boolean OR archived_at IS NULL
        ORDER BY legacy_sequence NULLS LAST, canonical_name, id`,
      [includeArchived === true],
    )
    return rows.map(sourceCatalogEntry)
  }

  async getSourceCatalogEntry(id) {
    const { rows } = await this.pool.query(
      `SELECT * FROM catalog.source_catalog_entries WHERE id = $1`,
      [id],
    )
    return sourceCatalogEntry(rows[0])
  }

  async createSourceCatalogEntry(input, { actor = 'admin-token' } = {}) {
    try {
      return await withPgTransaction(this.pool, async (client) => {
        await this.#assertSourceCatalogTaxonomyAvailable(client, input)
        const managedInput = { ...input }
        if (managedInput.ownerId) {
          managedInput.owner = (await this.#requireAssignableSourceCatalogOwner(client, managedInput.ownerId)).displayName
        }
        const { rows } = await client.query(
          `INSERT INTO catalog.source_catalog_entries
             (id, source_key, legacy_sequence, canonical_name, aliases, source_kind,
              parent_source_id, major_category, scenarios, regions, entry_modules,
              monitorable_content, extractable_clues, tracking_fields, suggested_access,
              compliance_boundary, priority, coverage_status, delivery_status, review_status,
              runtime_status, owner, owner_id, connector_hints, notes, tags, evidence_refs,
              custom_fields, imported_from)
           VALUES
             ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
              $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
              $27, $28, $29)
           RETURNING *`,
          [
            randomUUID(), managedInput.sourceKey, managedInput.legacySequence, managedInput.canonicalName,
            managedInput.aliases, managedInput.sourceKind, managedInput.parentSourceId, managedInput.majorCategory,
            managedInput.scenarios, managedInput.regions, managedInput.entryModules, managedInput.monitorableContent,
            managedInput.extractableClues, managedInput.trackingFields, managedInput.suggestedAccess,
            managedInput.complianceBoundary, managedInput.priority, managedInput.coverageStatus,
            managedInput.deliveryStatus, managedInput.reviewStatus, managedInput.runtimeStatus, managedInput.owner,
            managedInput.ownerId, managedInput.connectorHints, managedInput.notes, managedInput.tags,
            JSON.stringify(managedInput.evidenceRefs), managedInput.customFields, managedInput.importedFrom,
          ],
        )
        const entry = sourceCatalogEntry(rows[0])
        await this.#replaceSourceCatalogEntryNames(client, entry)
        await client.query(
          `INSERT INTO catalog.source_catalog_events
             (id, entry_id, event_type, actor, from_revision, to_revision, changes)
           VALUES ($1, $2, 'create', $3, NULL, 1, $4)`,
          [randomUUID(), entry.id, actor, { after: entry }],
        )
        return entry
      })
    } catch (error) {
      if (error?.code === '23505') {
        if (String(error.constraint || '').includes('source_catalog_entry_names')) {
          throw new AppError(409, 'source_catalog_name_conflict', 'Source catalog canonical names and aliases must be unique')
        }
        throw new AppError(409, 'source_catalog_entry_exists', 'Source catalog key or legacy sequence already exists')
      }
      throw error
    }
  }

  async updateSourceCatalogEntry(id, patch, {
    expectedRevision,
    actor = 'admin-token',
    eventType = 'update',
  } = {}) {
    try {
      return await withPgTransaction(this.pool, async (client) => {
      const currentResult = await client.query(
        `SELECT * FROM catalog.source_catalog_entries WHERE id = $1 FOR UPDATE`,
        [id],
      )
      const before = sourceCatalogEntry(currentResult.rows[0])
      if (!before) throw new AppError(404, 'source_catalog_entry_not_found', 'Source catalog entry was not found')
      if (before.revision !== expectedRevision) {
        throw new AppError(409, 'source_catalog_revision_conflict', 'Source catalog entry changed; reload before saving', {
          expectedRevision,
          currentRevision: before.revision,
        })
      }
      if (patch.parentSourceId === id) {
        throw new AppError(400, 'invalid_source_catalog_parent', 'A source catalog entry cannot be its own parent')
      }
      const merged = { ...before, ...patch }
      if (Object.prototype.hasOwnProperty.call(patch, 'ownerId')) {
        if (patch.ownerId) {
          merged.owner = (await this.#requireAssignableSourceCatalogOwner(client, patch.ownerId)).displayName
        } else if (patch.owner) {
          merged.owner = patch.owner
        } else {
          merged.owner = null
        }
      } else if (Object.prototype.hasOwnProperty.call(patch, 'owner')) {
        const managedOwner = before.ownerId
          ? await this.#requireAssignableSourceCatalogOwner(client, before.ownerId)
          : null
        if (
          !patch.owner
          || !managedOwner
          || sourceCatalogComparableName(patch.owner)
            !== sourceCatalogComparableName(managedOwner.displayName)
        ) {
          merged.ownerId = null
        } else {
          merged.ownerId = managedOwner.id
          merged.owner = managedOwner.displayName
        }
      } else if (merged.ownerId) {
        merged.owner = (await this.#requireAssignableSourceCatalogOwner(client, merged.ownerId)).displayName
      }
      if (
        patch.canonicalName
        && sourceCatalogComparableName(patch.canonicalName)
          !== sourceCatalogComparableName(before.canonicalName)
      ) {
        merged.aliases = [...new Set([...(merged.aliases || []), before.canonicalName])]
        if (merged.aliases.length > 32) {
          throw new AppError(400, 'invalid_source_catalog_field', 'aliases has too many values')
        }
      }
      await this.#assertSourceCatalogTaxonomyAvailable(client, merged)
      const { rows } = await client.query(
        `UPDATE catalog.source_catalog_entries
            SET canonical_name = $3,
                aliases = $4,
                source_kind = $5,
                parent_source_id = $6,
                major_category = $7,
                scenarios = $8,
                regions = $9,
                entry_modules = $10,
                monitorable_content = $11,
                extractable_clues = $12,
                tracking_fields = $13,
                suggested_access = $14,
                compliance_boundary = $15,
                priority = $16,
                coverage_status = $17,
                delivery_status = $18,
                review_status = $19,
                runtime_status = $20,
                owner = $21,
                owner_id = $22,
                connector_hints = $23,
                notes = $24,
                tags = $25,
                evidence_refs = $26,
                custom_fields = $27,
                archived_at = $28,
                revision = revision + 1,
                updated_at = now()
          WHERE id = $1 AND revision = $2
          RETURNING *`,
        [
          id, expectedRevision, merged.canonicalName, merged.aliases, merged.sourceKind,
          merged.parentSourceId, merged.majorCategory, merged.scenarios, merged.regions,
          merged.entryModules, merged.monitorableContent, merged.extractableClues,
          merged.trackingFields, merged.suggestedAccess, merged.complianceBoundary,
          merged.priority, merged.coverageStatus, merged.deliveryStatus,
          merged.reviewStatus, merged.runtimeStatus, merged.owner, merged.ownerId,
          merged.connectorHints, merged.notes, merged.tags, JSON.stringify(merged.evidenceRefs),
          merged.customFields, merged.archivedAt,
        ],
      )
      const entry = sourceCatalogEntry(rows[0])
      await this.#replaceSourceCatalogEntryNames(client, entry)
      await client.query(
        `INSERT INTO catalog.source_catalog_events
           (id, entry_id, event_type, actor, from_revision, to_revision, changes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          randomUUID(), id, eventType, actor, before.revision, entry.revision,
          { before, after: entry },
        ],
      )
      return entry
      })
    } catch (error) {
      if (error?.code === '23505' && String(error.constraint || '').includes('source_catalog_entry_names')) {
        throw new AppError(409, 'source_catalog_name_conflict', 'Source catalog canonical names and aliases must be unique')
      }
      throw error
    }
  }

  async archiveSourceCatalogEntry(id, options = {}) {
    return this.updateSourceCatalogEntry(id, { archivedAt: new Date().toISOString() }, {
      ...options,
      eventType: 'archive',
    })
  }

  async restoreSourceCatalogEntry(id, options = {}) {
    return this.updateSourceCatalogEntry(id, { archivedAt: null }, {
      ...options,
      eventType: 'restore',
    })
  }

  async listSourceCatalogEvents(entryId, limit = 50) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200))
    const { rows } = await this.pool.query(
      `SELECT *
         FROM catalog.source_catalog_events
        WHERE entry_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [entryId, safeLimit],
    )
    return rows.map(sourceCatalogEvent)
  }

  async listSourceCatalogOwners({ includeArchived = false } = {}) {
    const { rows } = await this.pool.query(
      `SELECT owner.*, count(entry.id)::integer AS usage_count
         FROM catalog.source_catalog_owners owner
         LEFT JOIN catalog.source_catalog_entries entry ON entry.owner_id = owner.id
        WHERE $1::boolean OR owner.archived_at IS NULL
        GROUP BY owner.id
        ORDER BY owner.display_name, owner.id`,
      [includeArchived === true],
    )
    return rows.map(sourceCatalogOwner)
  }

  async getSourceCatalogOwner(id, client = this.pool) {
    const { rows } = await client.query(
      `SELECT owner.*, count(entry.id)::integer AS usage_count
         FROM catalog.source_catalog_owners owner
         LEFT JOIN catalog.source_catalog_entries entry ON entry.owner_id = owner.id
        WHERE owner.id = $1
        GROUP BY owner.id`,
      [id],
    )
    return sourceCatalogOwner(rows[0])
  }

  async createSourceCatalogOwner(input, { actor = 'admin-token' } = {}) {
    try {
      return await withPgTransaction(this.pool, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO catalog.source_catalog_owners
             (id, owner_key, display_name, normalized_name, description, linked_account_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [
            randomUUID(), input.ownerKey, input.displayName, input.normalizedName,
            input.description, input.linkedAccountId,
          ],
        )
        const owner = sourceCatalogOwner({ ...rows[0], usage_count: 0 })
        await client.query(
          `INSERT INTO catalog.source_catalog_owner_events
             (id, owner_id, event_type, actor, from_revision, to_revision, changes)
           VALUES ($1, $2, 'create', $3, NULL, 1, $4)`,
          [randomUUID(), owner.id, actor, { after: owner }],
        )
        return owner
      })
    } catch (error) {
      if (error?.code === '23505') {
        if (String(error.constraint || '').includes('linked_account')) {
          throw new AppError(409, 'source_catalog_owner_account_conflict', 'This login account is already linked to another source catalog owner')
        }
        throw new AppError(409, 'source_catalog_owner_exists', 'A source catalog owner with this key or name already exists')
      }
      throw error
    }
  }

  async updateSourceCatalogOwner(id, patch, {
    expectedRevision,
    actor = 'admin-token',
    eventType = 'update',
  } = {}) {
    try {
      return await withPgTransaction(this.pool, async (client) => {
        const currentResult = await client.query(
          `SELECT * FROM catalog.source_catalog_owners WHERE id = $1 FOR UPDATE`,
          [id],
        )
        const current = sourceCatalogOwner(currentResult.rows[0])
        if (!current) throw new AppError(404, 'source_catalog_owner_not_found', 'Source catalog owner was not found')
        if (current.revision !== expectedRevision) {
          throw new AppError(409, 'source_catalog_owner_revision_conflict', 'Source catalog owner changed; reload before saving', {
            expectedRevision,
            currentRevision: current.revision,
          })
        }
        const usageCount = await this.#sourceCatalogOwnerUsage(client, id)
        if (patch.archivedAt && usageCount > 0) {
          throw new AppError(409, 'source_catalog_owner_in_use', 'Referenced source catalog owners cannot be archived', {
            usageCount,
          })
        }
        const merged = { ...current, ...patch }
        const { rows } = await client.query(
          `UPDATE catalog.source_catalog_owners
              SET display_name = $3,
                  normalized_name = $4,
                  description = $5,
                  linked_account_id = $6,
                  archived_at = $7,
                  revision = revision + 1,
                  updated_at = now()
            WHERE id = $1 AND revision = $2
            RETURNING *`,
          [
            id, expectedRevision, merged.displayName, merged.normalizedName,
            merged.description, merged.linkedAccountId, merged.archivedAt,
          ],
        )
        const owner = sourceCatalogOwner({ ...rows[0], usage_count: usageCount })
        if (patch.displayName) {
          await client.query(
            `UPDATE catalog.source_catalog_entries SET owner = $2 WHERE owner_id = $1`,
            [id, owner.displayName],
          )
        }
        await client.query(
          `INSERT INTO catalog.source_catalog_owner_events
             (id, owner_id, event_type, actor, from_revision, to_revision, changes)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            randomUUID(), id, eventType, actor, current.revision, owner.revision,
            { before: { ...current, usageCount }, after: owner },
          ],
        )
        return owner
      })
    } catch (error) {
      if (error?.code === '23505') {
        if (String(error.constraint || '').includes('linked_account')) {
          throw new AppError(409, 'source_catalog_owner_account_conflict', 'This login account is already linked to another source catalog owner')
        }
        throw new AppError(409, 'source_catalog_owner_exists', 'A source catalog owner with this name already exists')
      }
      throw error
    }
  }

  async archiveSourceCatalogOwner(id, options = {}) {
    return this.updateSourceCatalogOwner(id, { archivedAt: new Date().toISOString() }, {
      ...options,
      eventType: 'archive',
    })
  }

  async restoreSourceCatalogOwner(id, options = {}) {
    return this.updateSourceCatalogOwner(id, { archivedAt: null }, {
      ...options,
      eventType: 'restore',
    })
  }

  async listSourceCatalogOwnerEvents(ownerId, limit = 50) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200))
    const { rows } = await this.pool.query(
      `SELECT *
         FROM catalog.source_catalog_owner_events
        WHERE owner_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [ownerId, safeLimit],
    )
    return rows.map(sourceCatalogOwnerEvent)
  }

  async #sourceCatalogOwnerUsage(client, ownerId) {
    const { rows } = await client.query(
      `SELECT count(*)::integer AS usage_count
         FROM catalog.source_catalog_entries
        WHERE owner_id = $1`,
      [ownerId],
    )
    return Number(rows[0]?.usage_count || 0)
  }

  async #requireAssignableSourceCatalogOwner(client, ownerId) {
    const { rows } = await client.query(
      `SELECT * FROM catalog.source_catalog_owners WHERE id = $1 FOR KEY SHARE`,
      [ownerId],
    )
    const owner = sourceCatalogOwner(rows[0])
    if (!owner) throw new AppError(404, 'source_catalog_owner_not_found', 'Source catalog owner was not found')
    if (owner.archivedAt) {
      throw new AppError(409, 'source_catalog_owner_archived', 'Archived source catalog owners cannot be assigned', {
        ownerId,
      })
    }
    return owner
  }

  async #replaceSourceCatalogEntryNames(client, entry) {
    const names = sourceCatalogOwnedNames(entry)
    await client.query(
      `DELETE FROM catalog.source_catalog_entry_names WHERE entry_id = $1`,
      [entry.id],
    )
    await client.query(
      `INSERT INTO catalog.source_catalog_entry_names
         (entry_id, normalized_name, display_name, name_kind)
       SELECT $1, name.normalized_name, name.display_name, name.name_kind
         FROM unnest($2::text[], $3::text[], $4::text[])
           AS name(normalized_name, display_name, name_kind)`,
      [
        entry.id,
        names.map((name) => name.normalizedName),
        names.map((name) => name.displayName),
        names.map((name) => name.nameKind),
      ],
    )
  }

  async listSourceCatalogTerms({ includeArchived = false, kind = null } = {}) {
    const { rows } = await this.pool.query(
      `SELECT term.*
         FROM catalog.source_catalog_terms term
        WHERE ($1::boolean OR term.archived_at IS NULL)
          AND ($2::text IS NULL OR term.kind = $2)
        ORDER BY term.kind, term.sort_order, term.display_name, term.id`,
      [includeArchived === true, kind],
    )
    const entries = await this.#sourceCatalogTaxonomyEntries(this.pool)
    return rows.map((row) => {
      const term = sourceCatalogTerm(row)
      return {
        ...term,
        usageCount: entries.filter((entry) => sourceCatalogEntryUsesTerm(entry, term)).length,
      }
    })
  }

  async getSourceCatalogTerm(id, client = this.pool) {
    const { rows } = await client.query(
      `SELECT term.*
         FROM catalog.source_catalog_terms term
        WHERE term.id = $1`,
      [id],
    )
    const term = sourceCatalogTerm(rows[0])
    if (!term) return null
    return {
      ...term,
      usageCount: await this.#sourceCatalogTermUsage(client, term),
    }
  }

  async createSourceCatalogTerm(input, { actor = 'admin-token' } = {}) {
    try {
      return await withPgTransaction(this.pool, async (client) => {
        const { rows } = await client.query(
          `INSERT INTO catalog.source_catalog_terms
             (id, term_key, kind, display_name, normalized_name, description, color, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [
            randomUUID(), input.termKey, input.kind, input.displayName,
            input.normalizedName, input.description, input.color, input.sortOrder,
          ],
        )
        const term = sourceCatalogTerm({ ...rows[0], usage_count: 0 })
        await client.query(
          `INSERT INTO catalog.source_catalog_term_events
             (id, term_id, event_type, actor, from_revision, to_revision, changes)
           VALUES ($1, $2, 'create', $3, NULL, 1, $4)`,
          [randomUUID(), term.id, actor, { after: term }],
        )
        return term
      })
    } catch (error) {
      if (error?.code === '23505') {
        throw new AppError(409, 'source_catalog_term_exists', 'A taxonomy term with this name already exists')
      }
      throw error
    }
  }

  async updateSourceCatalogTerm(id, patch, {
    expectedRevision,
    actor = 'admin-token',
    eventType = 'update',
  } = {}) {
    try {
      return await withPgTransaction(this.pool, async (client) => {
        const currentResult = await client.query(
          `SELECT * FROM catalog.source_catalog_terms WHERE id = $1 FOR UPDATE`,
          [id],
        )
        const current = sourceCatalogTerm(currentResult.rows[0])
        if (!current) {
          throw new AppError(404, 'source_catalog_term_not_found', 'Source catalog taxonomy term was not found')
        }
        if (current.revision !== expectedRevision) {
          throw new AppError(409, 'source_catalog_term_revision_conflict', 'Taxonomy term changed; reload before saving', {
            expectedRevision,
            currentRevision: current.revision,
          })
        }
        const usageCount = await this.#sourceCatalogTermUsage(client, current)
        if (patch.normalizedName && patch.normalizedName !== current.normalizedName && usageCount > 0) {
          throw new AppError(409, 'source_catalog_term_in_use', 'Referenced taxonomy terms cannot be renamed', {
            usageCount,
          })
        }
        if (patch.archivedAt && usageCount > 0) {
          throw new AppError(409, 'source_catalog_term_in_use', 'Referenced taxonomy terms cannot be archived', {
            usageCount,
          })
        }
        const merged = { ...current, ...patch }
        const { rows } = await client.query(
          `UPDATE catalog.source_catalog_terms
              SET display_name = $3,
                  normalized_name = $4,
                  description = $5,
                  color = $6,
                  sort_order = $7,
                  archived_at = $8,
                  revision = revision + 1,
                  updated_at = now()
            WHERE id = $1 AND revision = $2
            RETURNING *`,
          [
            id, expectedRevision, merged.displayName, merged.normalizedName,
            merged.description, merged.color, merged.sortOrder, merged.archivedAt,
          ],
        )
        const term = sourceCatalogTerm({ ...rows[0], usage_count: usageCount })
        await client.query(
          `INSERT INTO catalog.source_catalog_term_events
             (id, term_id, event_type, actor, from_revision, to_revision, changes)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            randomUUID(), id, eventType, actor, current.revision, term.revision,
            { before: { ...current, usageCount }, after: term },
          ],
        )
        return term
      })
    } catch (error) {
      if (error?.code === '23505') {
        throw new AppError(409, 'source_catalog_term_exists', 'A taxonomy term with this name already exists')
      }
      throw error
    }
  }

  async archiveSourceCatalogTerm(id, options = {}) {
    return this.updateSourceCatalogTerm(id, { archivedAt: new Date().toISOString() }, {
      ...options,
      eventType: 'archive',
    })
  }

  async restoreSourceCatalogTerm(id, options = {}) {
    return this.updateSourceCatalogTerm(id, { archivedAt: null }, {
      ...options,
      eventType: 'restore',
    })
  }

  async listSourceCatalogTermEvents(termId, limit = 50) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200))
    const { rows } = await this.pool.query(
      `SELECT *
         FROM catalog.source_catalog_term_events
        WHERE term_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [termId, safeLimit],
    )
    return rows.map(sourceCatalogTermEvent)
  }

  async #sourceCatalogTermUsage(client, term) {
    const entries = await this.#sourceCatalogTaxonomyEntries(client)
    return entries.filter((entry) => sourceCatalogEntryUsesTerm(entry, term)).length
  }

  async #sourceCatalogTaxonomyEntries(client) {
    const { rows } = await client.query(
      `SELECT major_category, scenarios, regions, tags
         FROM catalog.source_catalog_entries`,
    )
    return rows.map((row) => ({
      majorCategory: row.major_category,
      scenarios: row.scenarios || [],
      regions: row.regions || [],
      tags: row.tags || [],
    }))
  }

  async #assertSourceCatalogTaxonomyAvailable(client, candidate) {
    const { rows } = await client.query(
      `SELECT *
         FROM catalog.source_catalog_terms
        ORDER BY id
          FOR KEY SHARE`,
    )
    for (const row of rows) {
      const term = sourceCatalogTerm(row)
      if (!term.archivedAt || !sourceCatalogEntryUsesTerm(candidate, term)) continue
      throw new AppError(409, 'source_catalog_term_archived', 'Source catalog entries cannot reference an archived taxonomy term', {
        termId: term.id,
        kind: term.kind,
        displayName: term.displayName,
      })
    }
  }

  async sourceCatalogRelatedData(entry, { pageSize = 20 } = {}) {
    const matchKeys = [...new Set([entry.canonicalName, ...(entry.aliases || [])]
      .map((value) => String(value).normalize('NFKC').trim().toLocaleLowerCase('zh-CN'))
      .filter(Boolean))]
    const [datasetResult, recordResult, sourceResult, chunkResult] = await Promise.all([
      this.pool.query(
         `WITH matched_records AS (
           SELECT *
             FROM core.canonical_records
            WHERE lower(btrim(normalize(platform, NFKC))) = ANY($1::text[])
               OR stable_fields #>> '{commerce,marketplace,entryId}' = $2
         ), record_stats AS (
           SELECT record.dataset_id,
                  array_agg(DISTINCT record.platform ORDER BY record.platform) AS platforms,
                  array_agg(DISTINCT record.object_type ORDER BY record.object_type) AS object_types,
                  coalesce(
                    array_agg(DISTINCT record.content_type ORDER BY record.content_type)
                      FILTER (WHERE record.content_type IS NOT NULL),
                    ARRAY[]::text[]
                  ) AS content_types,
                  count(*) FILTER (WHERE record.deleted_at IS NULL) AS active_record_count,
                  count(*) FILTER (WHERE record.deleted_at IS NOT NULL) AS deleted_record_count,
                  coalesce(sum(record.current_revision), 0) AS revision_count,
                  max(record.collected_at) AS last_collected_at,
                  max(record.event_time) AS last_event_at
             FROM matched_records record
            GROUP BY record.dataset_id
         ), chunk_stats AS (
           SELECT record.dataset_id,
                  count(chunk.id) AS chunk_count,
                  count(chunk.id) FILTER (WHERE chunk.projected_at IS NOT NULL) AS projected_chunk_count
             FROM matched_records record
             JOIN core.record_chunks chunk ON chunk.record_id = record.id
            WHERE record.deleted_at IS NULL
            GROUP BY record.dataset_id
         )
         SELECT record_stats.*,
                coalesce(chunk_stats.chunk_count, 0) AS chunk_count,
                coalesce(chunk_stats.projected_chunk_count, 0) AS projected_chunk_count
           FROM record_stats
           LEFT JOIN chunk_stats USING (dataset_id)
          ORDER BY record_stats.dataset_id`,
        [matchKeys, entry.id],
      ),
      this.pool.query(
        `SELECT id, dataset_id, platform, object_type, content_type, external_id,
                title, current_revision, event_time, collected_at, deleted_at
           FROM core.canonical_records
          WHERE lower(btrim(normalize(platform, NFKC))) = ANY($1::text[])
             OR stable_fields #>> '{commerce,marketplace,entryId}' = $2
          ORDER BY coalesce(event_time, collected_at, last_seen_at, first_seen_at) DESC, id DESC
          LIMIT $3`,
        [matchKeys, entry.id, pageSize + 1],
      ),
      this.pool.query(
        `SELECT *
          FROM catalog.external_sources
          WHERE lower(btrim(normalize(platform, NFKC))) = ANY($1::text[])
             OR (
               source_key = 'mobile-commerce-collected-items'
               AND EXISTS (
                 SELECT 1
                   FROM core.canonical_records record
                  WHERE record.deleted_at IS NULL
                    AND record.stable_fields #>> '{commerce,marketplace,entryId}' = $2
               )
             )
          ORDER BY updated_at DESC, source_key`,
        [matchKeys, entry.id],
      ),
      this.pool.query(
        `SELECT count(*)::integer AS chunk_count,
                count(*) FILTER (WHERE chunk.embedded_at IS NOT NULL)::integer AS embedded_chunk_count,
                count(*) FILTER (WHERE chunk.projected_at IS NOT NULL)::integer AS projected_chunk_count,
                count(DISTINCT chunk.record_id)::integer AS records_with_chunks
           FROM core.record_chunks chunk
           JOIN core.canonical_records record ON record.id = chunk.record_id
          WHERE record.deleted_at IS NULL
            AND (
              lower(btrim(normalize(record.platform, NFKC))) = ANY($1::text[])
              OR record.stable_fields #>> '{commerce,marketplace,entryId}' = $2
            )`,
        [matchKeys, entry.id],
      ),
    ])
    const datasets = datasetResult.rows.map(sourceCatalogRelatedDataset)
    const allRecentRecords = recordResult.rows.map(dataCenterRecord)
    const recentRecords = allRecentRecords.slice(0, pageSize)
    const externalSources = sourceResult.rows.map(sourceCatalogRelatedExternalSource)
    const chunkStats = chunkResult.rows[0] || {}
    const activeRecordCount = datasets.reduce((total, row) => total + row.activeRecordCount, 0)
    const deletedRecordCount = datasets.reduce((total, row) => total + row.deletedRecordCount, 0)
    const recordCount = activeRecordCount + deletedRecordCount
    const chunkCount = Number(chunkStats.chunk_count || 0)
    const embeddedChunkCount = Number(chunkStats.embedded_chunk_count || 0)
    const projectedChunkCount = Number(chunkStats.projected_chunk_count || 0)
    const projectionState = activeRecordCount === 0
      ? 'empty'
      : projectedChunkCount === 0
        ? 'not_indexed'
        : projectedChunkCount < chunkCount
          ? 'partial'
          : 'ready'
    return {
      entry: {
        id: entry.id,
        sourceKey: entry.sourceKey,
        canonicalName: entry.canonicalName,
        aliases: entry.aliases || [],
        archivedAt: entry.archivedAt,
        revision: entry.revision,
      },
      matchKeys: [entry.canonicalName, ...(entry.aliases || [])],
      stats: {
        datasetCount: datasets.length,
        externalSourceCount: externalSources.length,
        recordCount,
        activeRecordCount,
        deletedRecordCount,
        revisionCount: datasets.reduce((total, row) => total + row.revisionCount, 0),
        chunkCount,
        embeddedChunkCount,
        projectedChunkCount,
      },
      datasets,
      externalSources,
      recentRecords,
      searchProjection: {
        state: projectionState,
        recordCount: activeRecordCount,
        recordsWithChunks: Number(chunkStats.records_with_chunks || 0),
        chunkCount,
        embeddedChunkCount,
        projectedChunkCount,
      },
      pageSize,
      hasMore: allRecentRecords.length > pageSize,
    }
  }

  /**
   * Serialize pull/reset operations for one source across all Hub workers.
   *
   * This is a session advisory lock rather than an in-memory mutex because the
   * ingest deployment can be restarted or scaled.  try-lock semantics keep an
   * operator reset responsive: it reports `source_busy` instead of waiting
   * behind a long upstream query with no visible progress.
   */
  async withExternalSourceLock(sourceKey, operation) {
    const client = await this.pool.connect()
    const lockName = `mx-insight-hub:external-source:${sourceKey}`
    let locked = false
    let lockLost = false
    const markLockLost = () => { lockLost = true }
    client.once?.('error', markLockLost)
    client.once?.('end', markLockLost)
    const assertOwned = async () => {
      if (lockLost) {
        throw new AppError(409, 'source_lock_lost', `External source lock was lost: ${sourceKey}`)
      }
      try {
        await client.query('SELECT 1')
      } catch {
        lockLost = true
        throw new AppError(409, 'source_lock_lost', `External source lock was lost: ${sourceKey}`)
      }
      if (lockLost) {
        throw new AppError(409, 'source_lock_lost', `External source lock was lost: ${sourceKey}`)
      }
    }
    try {
      const { rows } = await client.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [lockName],
      )
      locked = rows[0]?.locked === true
      if (!locked) {
        throw new AppError(409, 'source_busy', `External source is currently being synchronized: ${sourceKey}`)
      }
      return await operation(assertOwned, client)
    } finally {
      if (locked) {
        await client.query(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
          [lockName],
        ).catch(() => {})
      }
      client.off?.('error', markLockLost)
      client.off?.('end', markLockLost)
      client.release(lockLost ? new Error('external source lock session lost') : undefined)
    }
  }

  /**
   * Add a mapping version. Never edits an existing one.
   *
   * Mappings are immutable per version because they explain historical rows:
   * editing version 3 in place would silently rewrite the answer to "why is
   * this 2026-03 record missing a title".
   */
  async createSourceMapping({
    sourceId,
    fieldMap,
    origin,
    agentModel,
    agentConfidence,
    notes,
    schemaFingerprint = null,
    fileStructure = null,
    formatRuleVersionId = null,
    selectedRuleKey = null,
  }) {
    return withPgTransaction(this.pool, async (client) => {
      // max(version) + 1 needs serialization per source. Without this lock, two
      // simultaneous previews can both choose the same next version and one
      // fails at the unique constraint even though both requests are valid.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`mx-insight-hub:source-mapping:${sourceId}`],
      )
      const { rows } = await client.query(
        `INSERT INTO catalog.source_mappings
          (id, source_id, version, field_map, origin, agent_model, agent_confidence, notes,
            schema_fingerprint, file_structure, format_rule_version_id, selected_rule_key)
         VALUES (
           $1, $2,
           (SELECT coalesce(max(version), 0) + 1 FROM catalog.source_mappings WHERE source_id = $2),
           $3, $4, $5, $6, $7, $8, $9, $10, $11
         )
         RETURNING *`,
        [
          randomUUID(), sourceId, fieldMap, origin || 'manual', agentModel || null,
          agentConfidence ?? null, notes || null, schemaFingerprint, fileStructure,
          formatRuleVersionId, selectedRuleKey,
        ],
      )
      return sourceMapping(rows[0])
    })
  }

  async approveSourceMapping({ sourceId, version, approvedBy }, { sessionClient = null } = {}) {
    return withPgTransaction(this.pool, async (client) => {
      const selected = await client.query(
        `SELECT m.*, s.source_kind, s.dataset_id, s.platform, s.object_type
           FROM catalog.source_mappings m
           JOIN catalog.external_sources s ON s.id = m.source_id
          WHERE m.source_id = $1 AND m.version = $2
          FOR UPDATE OF m`,
        [sourceId, version],
      )
      const mapping = selected.rows[0]
      if (!mapping) throw new AppError(404, 'mapping_not_found', 'Mapping version not found')
      const canonicalFieldMap = canonicalFileFieldMap(mapping.field_map)

      if (mapping.source_kind !== 'file' && (
        mapping.schema_fingerprint || mapping.file_structure || mapping.format_rule_version_id
        || mapping.selected_rule_key
      )) {
        throw new AppError(409, 'format_rule_mismatch', 'File structure evidence is only valid for file sources')
      }

      let formatRuleVersionId = mapping.format_rule_version_id
      if (formatRuleVersionId) {
        const selectedRuleClause = mapping.selected_rule_key ? 'AND r.rule_key = $8' : ''
        const linked = await client.query(
          `SELECT v.id
             FROM catalog.file_format_rule_versions v
             JOIN catalog.file_format_rules r ON r.id = v.rule_id
            WHERE v.id = $1
              AND r.dataset_id = $2 AND r.platform = $3 AND r.object_type = $4
              AND v.schema_fingerprint = $5
              AND v.field_map = $6::jsonb
              AND v.file_structure = $7::jsonb
              ${selectedRuleClause}`,
          [
            formatRuleVersionId, mapping.dataset_id, mapping.platform,
            mapping.object_type, mapping.schema_fingerprint, canonicalFieldMap,
            mapping.file_structure,
            ...(mapping.selected_rule_key ? [mapping.selected_rule_key] : []),
          ],
        )
        if (!linked.rows[0]) {
          throw new AppError(409, 'format_rule_mismatch', 'The selected format rule does not match this source and mapping')
        }
      } else if (mapping.schema_fingerprint && mapping.file_structure) {
        const structureLockKey = `mx-insight-hub:file-format-rule:${JSON.stringify([
          mapping.dataset_id, mapping.platform, mapping.object_type,
          mapping.schema_fingerprint,
        ])}`
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [structureLockKey],
        )
        if (mapping.selected_rule_key) {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            [`mx-insight-hub:file-format-rule-key:${mapping.selected_rule_key}`],
          )
        }
        let ruleId = null
        let matched
        if (mapping.selected_rule_key) {
          const selectedRule = await client.query(
            `SELECT r.id
               FROM catalog.file_format_rules r
              WHERE r.rule_key = $1
                AND r.dataset_id = $2 AND r.platform = $3 AND r.object_type = $4
              FOR UPDATE`,
            [
              mapping.selected_rule_key, mapping.dataset_id,
              mapping.platform, mapping.object_type,
            ],
          )
          ruleId = selectedRule.rows[0]?.id ?? null
          if (!ruleId) {
            throw new AppError(409, 'format_rule_mismatch', 'The selected format rule is outside this source scope')
          }
          matched = await client.query(
            `SELECT v.id AS version_id, v.version,
                    v.file_structure = $3::jsonb AS file_structure_matches,
                    v.field_map = $4::jsonb AS field_map_matches
               FROM catalog.file_format_rule_versions v
              WHERE v.rule_id = $1
                AND v.schema_fingerprint = $2
              ORDER BY v.approved_at DESC, v.version DESC
              LIMIT 1`,
            [ruleId, mapping.schema_fingerprint, mapping.file_structure, canonicalFieldMap],
          )
        } else {
          matched = await client.query(
            `SELECT r.id AS rule_id, v.id AS version_id, v.version,
                    v.file_structure = $5::jsonb AS file_structure_matches,
                    v.field_map = $6::jsonb AS field_map_matches
               FROM catalog.file_format_rules r
               JOIN catalog.file_format_rule_versions v ON v.rule_id = r.id
              WHERE r.dataset_id = $1 AND r.platform = $2 AND r.object_type = $3
                AND v.schema_fingerprint = $4
              ORDER BY v.approved_at DESC, v.version DESC
              LIMIT 1
              FOR UPDATE OF r`,
            [
              mapping.dataset_id, mapping.platform, mapping.object_type,
              mapping.schema_fingerprint, mapping.file_structure, canonicalFieldMap,
            ],
          )
          ruleId = matched.rows[0]?.rule_id ?? null
        }
        if (matched.rows[0] && matched.rows[0].file_structure_matches !== true) {
          throw new AppError(409, 'schema_fingerprint_conflict', 'The structure fingerprint is already linked to different structure evidence')
        }
        if (!ruleId) {
          ruleId = randomUUID()
          const inputFormat = typeof mapping.file_structure.format === 'string'
            ? mapping.file_structure.format
            : 'file'
          await client.query(
            `INSERT INTO catalog.file_format_rules
               (id, rule_key, display_name, dataset_id, platform, object_type)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              ruleId,
              `file.${mapping.schema_fingerprint.slice(0, 16)}.${ruleId.slice(0, 8)}`,
              `${inputFormat.toUpperCase()} ${mapping.schema_fingerprint.slice(0, 8)}`,
              mapping.dataset_id,
              mapping.platform,
              mapping.object_type,
            ],
          )
        }

        if (matched.rows[0]?.field_map_matches === true) {
          formatRuleVersionId = matched.rows[0].version_id
        } else {
          const parserFamily = typeof mapping.file_structure.parserFamily === 'string'
            ? mapping.file_structure.parserFamily
            : 'unknown'
          const inputFormat = typeof mapping.file_structure.format === 'string'
            ? mapping.file_structure.format
            : 'unknown'
          const inserted = await client.query(
            `INSERT INTO catalog.file_format_rule_versions
               (id, rule_id, version, schema_fingerprint, parser_family, input_format,
                file_structure, field_map, origin, agent_model, agent_confidence,
                approved_at, approved_by)
             VALUES (
               $1, $2,
               (SELECT coalesce(max(version), 0) + 1 FROM catalog.file_format_rule_versions WHERE rule_id = $2),
               $3, $4, $5, $6, $7, $8, $9, $10, now(), $11
             )
             RETURNING id`,
            [
              randomUUID(), ruleId, mapping.schema_fingerprint,
              parserFamily,
              inputFormat,
              mapping.file_structure, canonicalFieldMap,
              mapping.origin === 'format_rule' ? 'manual' : mapping.origin,
              mapping.agent_model, mapping.agent_confidence, approvedBy,
            ],
          )
          formatRuleVersionId = inserted.rows[0].id
        }
      }

      const approved = await client.query(
        `UPDATE catalog.source_mappings
            SET approved_at = now(), approved_by = $3,
                format_rule_version_id = $4
          WHERE source_id = $1 AND version = $2
          RETURNING *`,
        [sourceId, version, approvedBy, formatRuleVersionId],
      )
      return sourceMapping(approved.rows[0])
    }, { sessionClient })
  }

  async findApprovedFileFormatRule({ schemaFingerprint, datasetId, platform, objectType }) {
    const { rows } = await this.pool.query(
      `SELECT r.id AS rule_id, r.rule_key, r.display_name,
              r.dataset_id, r.platform, r.object_type,
              v.id AS version_id, v.version, v.schema_fingerprint, v.field_map,
              v.parser_family, v.input_format, v.file_structure
         FROM catalog.file_format_rules r
         JOIN catalog.file_format_rule_versions v ON v.rule_id = r.id
        WHERE r.dataset_id = $1 AND r.platform = $2 AND r.object_type = $3
          AND v.schema_fingerprint = $4
        ORDER BY v.approved_at DESC, v.version DESC
        LIMIT 1`,
      [datasetId, platform, objectType, schemaFingerprint],
    )
    return fileFormatRule(rows[0])
  }

  async listFileFormatRules() {
    const { rows } = await this.pool.query(
      `SELECT r.id AS rule_id, r.rule_key, r.display_name,
              r.dataset_id, r.platform, r.object_type,
              v.id AS version_id, v.version, v.schema_fingerprint, v.field_map,
              v.parser_family, v.input_format, v.file_structure
         FROM catalog.file_format_rules r
         LEFT JOIN LATERAL (
           SELECT version.id, version.version, version.schema_fingerprint,
                  version.field_map, version.parser_family, version.input_format,
                  version.file_structure
             FROM catalog.file_format_rule_versions version
            WHERE version.rule_id = r.id
            ORDER BY version.approved_at DESC, version.version DESC
            LIMIT 1
         ) v ON true
        ORDER BY r.platform, r.dataset_id, r.object_type, r.display_name, r.rule_key`,
    )
    return rows.map(fileFormatRule)
  }

  async findApprovedFileFormatRuleByKey({
    ruleKey,
    schemaFingerprint,
    datasetId,
    platform,
    objectType,
  }) {
    const { rows } = await this.pool.query(
      `SELECT r.id AS rule_id, r.rule_key, r.display_name,
              r.dataset_id, r.platform, r.object_type,
              v.id AS version_id, v.version, v.schema_fingerprint, v.field_map,
              v.parser_family, v.input_format, v.file_structure
         FROM catalog.file_format_rules r
         JOIN catalog.file_format_rule_versions v ON v.rule_id = r.id
        WHERE r.rule_key = $1
          AND r.dataset_id = $2 AND r.platform = $3 AND r.object_type = $4
          AND v.schema_fingerprint = $5
        ORDER BY v.approved_at DESC, v.version DESC
        LIMIT 1`,
      [ruleKey, datasetId, platform, objectType, schemaFingerprint],
    )
    return fileFormatRule(rows[0])
  }

  async recordFileObservation({
    sourceId,
    rootId,
    relativePath,
    pathHash,
    inputSha256,
    inputBytes,
    mtime,
    schemaFingerprint = null,
    formatRuleVersionId = null,
    importRunId = null,
    status,
  }) {
    const { rows } = await this.pool.query(
      `INSERT INTO ingest.file_observations
         (id, source_id, root_id, relative_path, path_hash, input_sha256,
          input_bytes, source_mtime, schema_fingerprint, format_rule_version_id,
          import_run_id, status)
       SELECT $1, s.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
         FROM catalog.external_sources s
         LEFT JOIN catalog.file_format_rule_versions v ON v.id = $10
         LEFT JOIN catalog.file_format_rules r ON r.id = v.rule_id
         LEFT JOIN ingest.import_runs ir ON ir.id = $11
        WHERE s.id = $2
          AND s.source_kind = 'file'
          AND s.connection->>'fileMode' = 'server_path'
          AND ($10::uuid IS NULL OR (
            r.dataset_id = s.dataset_id
            AND r.platform = s.platform
            AND r.object_type = s.object_type
            AND v.schema_fingerprint = $9
          ))
          AND ($11::uuid IS NULL OR ir.source_id = s.id)
       ON CONFLICT (source_id, root_id, relative_path, input_sha256) DO UPDATE SET
         input_bytes = EXCLUDED.input_bytes,
         source_mtime = EXCLUDED.source_mtime,
         schema_fingerprint = CASE
           WHEN EXCLUDED.status = 'imported' OR ingest.file_observations.status <> 'imported'
             THEN EXCLUDED.schema_fingerprint
           ELSE ingest.file_observations.schema_fingerprint
         END,
         format_rule_version_id = CASE
           WHEN EXCLUDED.status = 'imported' OR ingest.file_observations.status <> 'imported'
             THEN EXCLUDED.format_rule_version_id
           ELSE ingest.file_observations.format_rule_version_id
         END,
         import_run_id = CASE
           WHEN EXCLUDED.status = 'imported' THEN EXCLUDED.import_run_id
           ELSE ingest.file_observations.import_run_id
         END,
         status = CASE WHEN EXCLUDED.status = 'imported' THEN 'imported' ELSE ingest.file_observations.status END,
         last_seen_at = now()
       RETURNING *`,
      [
        randomUUID(), sourceId, rootId, relativePath, pathHash, inputSha256,
        inputBytes, mtime, schemaFingerprint, formatRuleVersionId, importRunId, status,
      ],
    )
    if (!rows[0]) {
      throw new AppError(409, 'file_observation_scope_mismatch', 'File evidence must reference the same file source, format-rule scope and import run')
    }
    return fileObservation(rows[0])
  }

  async listFileObservations(sourceId, limit = 20) {
    const { rows } = await this.pool.query(
      `SELECT * FROM ingest.file_observations
        WHERE source_id = $1
        ORDER BY last_seen_at DESC LIMIT $2`,
      [sourceId, limit],
    )
    return rows.map(fileObservation)
  }

  /** Approve all mappings or none, so a built-in pipeline cannot split versions. */
  async approveSourceMappingsBatch({ approvals, approvedBy }) {
    if (!Array.isArray(approvals) || approvals.length === 0) return []
    return withPgTransaction(this.pool, async (client) => {
      const results = []
      for (const approval of approvals) {
        const { rows } = await client.query(
          `UPDATE catalog.source_mappings
              SET approved_at = now(), approved_by = $4
            WHERE id = $1 AND source_id = $2 AND version = $3
            RETURNING *`,
          [approval.mappingId, approval.sourceId, approval.version, approvedBy],
        )
        if (!rows[0]) throw new AppError(404, 'mapping_not_found', 'Mapping version not found')
        results.push(sourceMapping(rows[0]))
      }
      return results
    })
  }

  async activateExternalSourcesWithAttestation({
    sourceKeys,
    pipelineKey,
    contractVersion,
    contractDigest,
    contractSummary,
    attestedBy,
    approvals = [],
  }) {
    return withPgTransaction(this.pool, async (client) => {
      for (const approval of approvals) {
        const approved = await client.query(
          `UPDATE catalog.source_mappings
              SET approved_at = now(), approved_by = $4
            WHERE id = $1 AND source_id = $2 AND version = $3
            RETURNING id`,
          [approval.mappingId, approval.sourceId, approval.version, attestedBy],
        )
        if (!approved.rows[0]) throw new AppError(409, 'builtin_mapping_conflict', 'Seeded built-in mapping changed before activation')
      }

      const attestationResult = await client.query(
        `INSERT INTO catalog.pipeline_writer_contract_attestations
           (id, pipeline_key, contract_version, contract_digest, contract_summary, attested_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [randomUUID(), pipelineKey, contractVersion, contractDigest, contractSummary, attestedBy],
      )
      const sources = []
      for (const sourceKey of sourceKeys) {
        const { rows } = await client.query(
          `UPDATE catalog.external_sources
              SET status = 'active', updated_at = now()
            WHERE source_key = $1
            RETURNING *`,
          [sourceKey],
        )
        if (!rows[0]) throw new AppError(404, 'source_not_found', `Unknown external source: ${sourceKey}`)
        sources.push(externalSource(rows[0]))
      }
      return {
        sources,
        attestation: pipelineWriterContractAttestation(attestationResult.rows[0]),
      }
    }, { outcomeUnknownCode: 'pipeline_activation_outcome_unknown' })
  }

  async getLatestPipelineWriterContractAttestation(pipelineKey) {
    const { rows } = await this.pool.query(
      `SELECT *
         FROM catalog.pipeline_writer_contract_attestations
        WHERE pipeline_key = $1
        ORDER BY attested_at DESC
        LIMIT 1`,
      [pipelineKey],
    )
    return pipelineWriterContractAttestation(rows[0])
  }

  async listSourceMappings(sourceId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM catalog.source_mappings WHERE source_id = $1 ORDER BY version DESC',
      [sourceId],
    )
    return rows.map(sourceMapping)
  }

  /** Highest approved version. Unapproved mappings are never returned. */
  async getActiveMapping(sourceId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM catalog.source_mappings
        WHERE source_id = $1 AND approved_at IS NOT NULL
        ORDER BY version DESC LIMIT 1`,
      [sourceId],
    )
    return sourceMapping(rows[0])
  }

  async getImportRunState(id) {
    const { rows } = await this.pool.query(
      `SELECT id, source_id, status
         FROM ingest.import_runs
        WHERE id = $1`,
      [id],
    )
    return rows[0] && {
      id: rows[0].id,
      sourceId: rows[0].source_id,
      status: rows[0].status,
    }
  }

  async getImportBatch(importRunId, batchKey) {
    const { rows } = await this.pool.query(
      `SELECT batch_key, cursor_start, cursor_end, row_count, ingested_count,
              changed_count, deleted_count, rejected_count, status, error_code,
              page_fingerprint
         FROM ingest.import_run_batches
        WHERE import_run_id = $1 AND batch_key = $2`,
      [importRunId, batchKey],
    )
    return importRunBatch(rows[0])
  }

  /** Finish a database import and its durable cursor in one PostgreSQL commit. */
  async finalizeExternalImportRun({
    importRunId,
    sourceId,
    cursorId,
    position,
    status,
    cursorStatus,
    processedDelta = 0,
    error = null,
  }) {
    return withPgTransaction(this.pool, async (client) => {
      const updated = await client.query(
        `UPDATE ingest.import_runs
            SET status = $3,
                cursor_end = coalesce($4, cursor_end),
                last_error = $5,
                finished_at = now()
          WHERE id = $1 AND source_id = $2 AND status = 'running'
          RETURNING *`,
        [
          importRunId,
          sourceId,
          status,
          position,
          error ? String(error).slice(0, 2_000) : null,
        ],
      )
      if (updated.rowCount === 0) {
        throw new AppError(
          409,
          'import_run_not_running',
          'The import run is missing, terminal, or belongs to another source',
        )
      }
      const cursor = await saveCursorInTransaction(client, cursorId, position, {
        status: cursorStatus,
        processedDelta,
        error,
      })
      return { run: importRun(updated.rows[0]), cursor }
    }, { outcomeUnknownCode: 'external_finalize_outcome_unknown' })
  }

  /** Keep a resumable run open when only its continuation hand-off is lost. */
  async markExternalImportCursorFailed({ importRunId, sourceId, cursorId, position, error }) {
    return withPgTransaction(this.pool, async (client) => {
      const { rows } = await client.query(
        `SELECT id
           FROM ingest.import_runs
          WHERE id = $1 AND source_id = $2 AND status = 'running'
          FOR UPDATE`,
        [importRunId, sourceId],
      )
      if (!rows[0]) {
        throw new AppError(
          409,
          'import_run_not_running',
          'The continuation import run is missing, terminal, or belongs to another source',
        )
      }
      const cursor = await saveCursorInTransaction(client, cursorId, position, {
        status: 'failed',
        processedDelta: 0,
        error,
      })
      return { importRunId, cursor }
    }, { outcomeUnknownCode: 'external_cursor_failure_outcome_unknown' })
  }

  /** Reset the checkpoint and fail every orphaned running run atomically. */
  async resetExternalImportCheckpoint({ sourceId, cursorId, position }) {
    return withPgTransaction(this.pool, async (client) => {
      const { rows } = await client.query(
        `UPDATE ingest.import_runs
            SET status = 'failed',
                cursor_end = $2,
                last_error = 'checkpoint_reset',
                finished_at = now()
          WHERE source_id = $1 AND run_key IS NOT NULL AND status = 'running'
          RETURNING id`,
        [sourceId, position],
      )
      const cursor = await saveCursorInTransaction(client, cursorId, position, {
        status: 'idle',
        error: null,
      })
      return { failedRunIds: rows.map((row) => row.id), cursor }
    }, { outcomeUnknownCode: 'external_reset_outcome_unknown' })
  }

  /** Reset every child checkpoint of one built-in pipeline in one commit. */
  async resetExternalImportCheckpointsBatch(resets) {
    return withPgTransaction(this.pool, async (client) => {
      const results = []
      for (const reset of resets) {
        const { rows } = await client.query(
          `UPDATE ingest.import_runs
              SET status = 'failed',
                  cursor_end = $2,
                  last_error = 'checkpoint_reset',
                  finished_at = now()
            WHERE source_id = $1 AND run_key IS NOT NULL AND status = 'running'
            RETURNING id`,
          [reset.sourceId, reset.position],
        )
        const cursor = await saveCursorInTransaction(client, reset.cursorId, reset.position, {
          status: 'idle',
          error: null,
        })
        results.push({
          sourceKey: reset.sourceKey,
          failedRunIds: rows.map((row) => row.id),
          cursor,
        })
      }
      return results
    }, { outcomeUnknownCode: 'external_reset_outcome_unknown' })
  }

  /**
   * Open an import run, or report that this exact input already succeeded.
   *
   * Content-hash deduplication at the file level is cheaper than relying on
   * per-row uniqueness for a 50,000-row spreadsheet someone uploaded twice, and
   * it gives the operator a clear answer ("skipped, identical to run X")
   * instead of a run that reports 50,000 rows and zero changes.
   */
  async startImportRun({
    sourceId,
    mappingVersion,
    inputSha256,
    interpretationKey = null,
    inputName,
    inputBytes,
    cursorStart = null,
    trigger = inputSha256 ? 'file' : 'manual',
    runKey = null,
    sessionClient = null,
  }) {
    if (inputSha256) {
      const keyedInterpretation = interpretationKey !== null
      return withPgTransaction(this.pool, async (client) => {
        // This UPDATE is the database fence for a reclaimed file import. It
        // takes the same run-row lock that ingestExternalRecords holds while
        // writing a batch, so an old writer either commits before this claim
        // or observes the failed status before touching canonical state.
        // input_sha256 also covers file runs created before migration 012,
        // whose trigger column was backfilled to the legacy 'manual' default.
        await client.query(
          `UPDATE ingest.import_runs
              SET status = 'failed',
                  last_error = 'superseded_by_new_file_import',
                  finished_at = now()
            WHERE source_id = $1
              AND input_sha256 IS NOT NULL
              AND status = 'running'`,
          [sourceId],
        )

        const { rows } = await client.query(
          `SELECT id, started_at FROM ingest.import_runs
            WHERE source_id = $1
              AND input_sha256 = $2
              AND ${keyedInterpretation ? 'interpretation_key = $3' : 'interpretation_key IS NULL'}
              AND status = 'succeeded'
            ORDER BY started_at DESC LIMIT 1`,
          keyedInterpretation
            ? [sourceId, inputSha256, interpretationKey]
            : [sourceId, inputSha256],
        )
        if (rows[0]) return { duplicateOf: rows[0].id, id: null }

        const inserted = await client.query(
          `INSERT INTO ingest.import_runs
             (id, source_id, mapping_version, input_sha256, input_name, input_bytes,
              interpretation_key, cursor_start, trigger)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [
            randomUUID(), sourceId, mappingVersion, inputSha256, inputName, inputBytes,
            interpretationKey, cursorStart, trigger,
          ],
        )
        return { id: inserted.rows[0].id, duplicateOf: null }
      }, {
        outcomeUnknownCode: 'external_import_claim_outcome_unknown',
        sessionClient,
      })
    }
    if (runKey) {
      const { rows } = await this.pool.query(
        `INSERT INTO ingest.import_runs
           (id, source_id, mapping_version, input_sha256, input_name, input_bytes,
            interpretation_key, cursor_start, trigger, run_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (source_id, run_key)
           WHERE run_key IS NOT NULL AND status = 'running'
         DO UPDATE SET run_key = EXCLUDED.run_key
         RETURNING id`,
        [
          randomUUID(), sourceId, mappingVersion, inputSha256, inputName, inputBytes,
          interpretationKey, cursorStart, trigger, runKey,
        ],
      )
      return { id: rows[0].id, duplicateOf: null }
    }
    const { rows } = await this.pool.query(
      `INSERT INTO ingest.import_runs
         (id, source_id, mapping_version, input_sha256, input_name, input_bytes,
          interpretation_key, cursor_start, trigger)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        randomUUID(), sourceId, mappingVersion, inputSha256, inputName, inputBytes,
        interpretationKey, cursorStart, trigger,
      ],
    )
    return { id: rows[0].id, duplicateOf: null }
  }

  async finishImportRun(id, {
    status,
    rowCount,
    rejectedCount,
    changedCount,
    deletedCount,
    cursorEnd = null,
    error,
  }, { sessionClient = null } = {}) {
    const result = await (sessionClient ?? this.pool).query(
      `UPDATE ingest.import_runs
          SET status = $2,
              row_count = coalesce($3, row_count),
              rejected_count = coalesce($4, rejected_count),
              changed_count = coalesce($5, changed_count),
              deleted_count = coalesce($6, deleted_count),
              cursor_end = coalesce($7, cursor_end),
              last_error = $8,
              finished_at = now()
        WHERE id = $1
          AND (status = 'running' OR status = $2)`,
      [
        id, status, rowCount, rejectedCount, changedCount ?? null, deletedCount ?? null, cursorEnd,
        error ? String(error).slice(0, 2_000) : null,
      ],
    )
    return { transitioned: result.rowCount !== 0 }
  }

  async recordRejectedImportBatch(importRunId, {
    sourceId = null,
    batchKey,
    cursorStart = null,
    rowCount,
    rejections,
    pageFingerprint = null,
    errorCode = 'row_rejections_detected',
  }) {
    return withPgTransaction(this.pool, async (client) => {
      const runResult = await client.query(
        `SELECT id, source_id, status
           FROM ingest.import_runs
          WHERE id = $1
          FOR UPDATE`,
        [importRunId],
      )
      const run = runResult.rows[0]
      if (!run || run.status !== 'running' || (sourceId && run.source_id !== sourceId)) {
        throw new AppError(409, 'import_run_not_running', 'Rejected rows can only be attached to their running import run')
      }
      const inserted = await client.query(
        `INSERT INTO ingest.import_run_batches
           (import_run_id, batch_key, cursor_start, cursor_end, row_count,
            ingested_count, changed_count, deleted_count, rejected_count, status,
            error_code, page_fingerprint)
         VALUES ($1, $2, $3, $3, $4, 0, 0, 0, $5, 'failed', $6, $7)
         ON CONFLICT (import_run_id, batch_key) DO NOTHING
         RETURNING batch_key`,
        [
          importRunId, batchKey, cursorStart, rowCount, rejections.length,
          errorCode, pageFingerprint,
        ],
      )
      if (inserted.rowCount === 0) return { recorded: false }
      const stored = rejections.slice(0, 1_000)
      if (stored.length > 0) {
        const values = stored.flatMap((rejection) => [
          importRunId, rejection.rowIndex, rejection.reason, rejection.raw,
        ])
        const tuples = stored
          .map((_, index) => `($${index * 4 + 1}, $${index * 4 + 2}, $${index * 4 + 3}, $${index * 4 + 4})`)
          .join(', ')
        await client.query(
          `INSERT INTO ingest.rejected_rows (import_run_id, row_index, reason, raw_row) VALUES ${tuples}`,
          values,
        )
      }
      await client.query(
        `UPDATE ingest.import_runs
            SET row_count = row_count + $2,
                rejected_count = rejected_count + $3
          WHERE id = $1 AND status = 'running'`,
        [importRunId, rowCount, rejections.length],
      )
      return { recorded: true }
    })
  }

  /**
   * Record rows that could not be mapped, with the reason.
   *
   * These are evidence. A row rejected for a missing external id is how you
   * find out a spreadsheet gained a header row or an upstream column was
   * renamed; discarding them is how an import "succeeds" at 60% coverage and
   * nobody notices for a month.
   */
  async recordRejectedRows(importRunId, rejections, { sessionClient = null } = {}) {
    if (rejections.length === 0) return
    // Cap what is stored: a mapping that rejects every row of a large file
    // would otherwise write a second copy of it into the database.
    const stored = rejections.slice(0, 1_000)
    const values = stored.flatMap((rejection) => [importRunId, rejection.rowIndex, rejection.reason, rejection.raw])
    const tuples = stored
      .map((_, index) => `($${index * 4 + 1}, $${index * 4 + 2}, $${index * 4 + 3}, $${index * 4 + 4})`)
      .join(', ')
    await (sessionClient ?? this.pool).query(
      `INSERT INTO ingest.rejected_rows (import_run_id, row_index, reason, raw_row) VALUES ${tuples}`,
      values,
    )
  }

  async listImportRuns(sourceId, limit = 20) {
    const { rows } = await this.pool.query(
      `SELECT r.*,
              (SELECT count(*)::int FROM ingest.import_run_batches b WHERE b.import_run_id = r.id) AS batch_count
         FROM ingest.import_runs r
        WHERE ($1::uuid IS NULL OR r.source_id = $1)
        ORDER BY r.started_at DESC LIMIT $2`,
      [sourceId || null, limit],
    )
    return rows.map(importRun)
  }

  // ---- federated identity (migration 007) --------------------------------

  /**
   * Find or create the Hub member behind a verified external identity.
   *
   * The binding, not the member, carries the uniqueness constraint, so the same
   * human reaching the Hub through two issuers gets two bindings and (for now)
   * two members. Merging them is an explicit operator action; doing it
   * automatically would mean guessing that two subjects are the same person,
   * which is exactly the mistake that email-keyed identity makes.
   */
  async upsertExternalIdentity({
    issuer,
    subject,
    audience,
    organizationId,
    launcherTenantId,
    authProvider,
    displayName,
  }) {
    return withPgTransaction(this.pool, async (client) => {
      const existing = await client.query(
        `SELECT b.member_id, m.display_name, m.status
           FROM iam.external_identity_bindings b
           JOIN iam.members m ON m.id = b.member_id
          WHERE b.issuer = $1 AND b.subject = $2 AND b.audience = $3`,
        [issuer, subject, audience],
      )

      if (existing.rows[0]) {
        const row = existing.rows[0]
        await client.query(
          `UPDATE iam.external_identity_bindings
              SET last_seen_at = now(),
                  organization_id = COALESCE($4, organization_id),
                  launcher_tenant_id = COALESCE($5, launcher_tenant_id),
                  auth_provider = COALESCE($6, auth_provider)
            WHERE issuer = $1 AND subject = $2 AND audience = $3`,
          [issuer, subject, audience, organizationId, launcherTenantId, authProvider],
        )
        // Refresh the cached display name, which is a Launcher attribute and can
        // change there at any time.
        if (displayName && displayName !== row.display_name) {
          await client.query(
            'UPDATE iam.members SET display_name = $2, updated_at = now() WHERE id = $1',
            [row.member_id, displayName],
          )
        }
        return { id: row.member_id, displayName: displayName || row.display_name, status: row.status }
      }

      const memberId = randomUUID()
      await client.query(
        'INSERT INTO iam.members (id, display_name) VALUES ($1, $2)',
        [memberId, displayName || subject],
      )
      await client.query(
        `INSERT INTO iam.external_identity_bindings
           (id, member_id, issuer, subject, audience, organization_id, launcher_tenant_id, auth_provider, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
        [randomUUID(), memberId, issuer, subject, audience, organizationId, launcherTenantId, authProvider],
      )
      await client.query(
        `INSERT INTO iam.identity_events (member_id, event_type, issuer, subject, detail)
         VALUES ($1, 'member.provisioned', $2, $3, $4)`,
        [memberId, issuer, subject, { organizationId, authProvider }],
      )
      return { id: memberId, displayName: displayName || subject, status: 'active' }
    })
  }

  /**
   * Reconcile platform-admin status against the current token's scopes.
   *
   * Revoking is as important as granting: if the allowlisted scope is removed in
   * Launcher, the next sign-in must drop the Hub privilege too. A grant that
   * only ever accumulates is a privilege ratchet.
   */
  async syncPlatformAdmin(memberId, { granted, grantedVia }) {
    if (granted) {
      await this.pool.query(
        `INSERT INTO iam.platform_admins (member_id, granted_via)
         VALUES ($1, $2)
         ON CONFLICT (member_id) DO UPDATE SET granted_via = EXCLUDED.granted_via, updated_at = now()`,
        [memberId, grantedVia || 'launcher-scope'],
      )
      return true
    }
    const { rowCount } = await this.pool.query(
      'DELETE FROM iam.platform_admins WHERE member_id = $1',
      [memberId],
    )
    if (rowCount > 0) {
      await this.pool.query(
        `INSERT INTO iam.identity_events (member_id, event_type, detail)
         VALUES ($1, 'platform_admin.revoked', '{"reason":"scope no longer present"}'::jsonb)`,
        [memberId],
      )
    }
    return false
  }

  async listTenantMemberships(memberId) {
    const { rows } = await this.pool.query(
      `SELECT m.id, m.tenant_id, m.role, m.status, t.name AS tenant_name
         FROM iam.tenant_memberships m
         JOIN tenants t ON t.id = m.tenant_id
        WHERE m.member_id = $1
        ORDER BY t.name`,
      [memberId],
    )
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name,
      role: row.role,
      status: row.status,
    }))
  }

  async listMembers() {
    const { rows } = await this.pool.query(
      `SELECT m.id, m.display_name, m.status, m.created_at,
              (a.member_id IS NOT NULL) AS platform_admin,
              coalesce(
                json_agg(
                  json_build_object('tenantId', tm.tenant_id, 'role', tm.role, 'status', tm.status)
                ) FILTER (WHERE tm.id IS NOT NULL),
                '[]'::json
              ) AS memberships
         FROM iam.members m
         LEFT JOIN iam.platform_admins a ON a.member_id = m.id
         LEFT JOIN iam.tenant_memberships tm ON tm.member_id = m.id
        GROUP BY m.id, a.member_id
        ORDER BY m.created_at DESC`,
    )
    return rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      status: row.status,
      platformAdmin: row.platform_admin,
      memberships: row.memberships,
      createdAt: iso(row.created_at),
    }))
  }

  async grantTenantMembership({ memberId, tenantId, role, grantedBy }) {
    const { rows } = await this.pool.query(
      `INSERT INTO iam.tenant_memberships (id, member_id, tenant_id, role, granted_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (member_id, tenant_id) DO UPDATE SET
         role = EXCLUDED.role, status = 'active', granted_by = EXCLUDED.granted_by, updated_at = now()
       RETURNING id, member_id, tenant_id, role, status`,
      [randomUUID(), memberId, tenantId, role, grantedBy],
    )
    await this.pool.query(
      `INSERT INTO iam.identity_events (member_id, event_type, detail)
       VALUES ($1, 'membership.granted', $2)`,
      [memberId, { tenantId, role, grantedBy }],
    )
    const row = rows[0]
    return { id: row.id, memberId: row.member_id, tenantId: row.tenant_id, role: row.role, status: row.status }
  }

  async revokeTenantMembership({ memberId, tenantId, revokedBy }) {
    const { rowCount } = await this.pool.query(
      `UPDATE iam.tenant_memberships SET status = 'suspended', updated_at = now()
        WHERE member_id = $1 AND tenant_id = $2`,
      [memberId, tenantId],
    )
    if (rowCount === 0) throw new AppError(404, 'membership_not_found', 'Membership not found')
    await this.pool.query(
      `INSERT INTO iam.identity_events (member_id, event_type, detail)
       VALUES ($1, 'membership.revoked', $2)`,
      [memberId, { tenantId, revokedBy }],
    )
    return { memberId, tenantId, status: 'suspended' }
  }
}

function dataCenterProvinceRelationExpressions({
  recordAlias,
  publicationAlias,
  revisionAlias,
  codeParameter,
  namesParameter,
}) {
  const code = `$${codeParameter}::text`
  const names = `$${namesParameter}::text[]`
  const trustedReportRaw = `EXISTS (
    SELECT 1
      FROM jsonb_array_elements(jsonb_build_array(
        ${revisionAlias}.normalized_payload -> 'reportProvince',
        ${revisionAlias}.normalized_payload -> 'report_attribution',
        ${revisionAlias}.normalized_payload -> 'reportAttribution',
        ${revisionAlias}.normalized_payload #> '{raw,reportProvince}',
        ${revisionAlias}.normalized_payload #> '{raw,report_attribution}',
        ${revisionAlias}.normalized_payload #> '{raw,reportAttribution}',
        ${revisionAlias}.normalized_payload #> '{raw,raw,reportProvince}',
        ${revisionAlias}.normalized_payload #> '{raw,raw,report_attribution}',
        ${revisionAlias}.normalized_payload #> '{raw,raw,reportAttribution}'
      )) report_attribution
     WHERE jsonb_typeof(report_attribution) = 'object'
       AND report_attribution ->> 'basis' = 'publisher_registry'
       AND coalesce(
         nullif(btrim(report_attribution ->> 'registryRef'), ''),
         nullif(btrim(report_attribution ->> 'registry_ref'), ''),
         nullif(btrim(report_attribution ->> 'sourceRef'), ''),
         nullif(btrim(report_attribution ->> 'source_ref'), '')
       ) IS NOT NULL
       AND (
         upper(coalesce(
           report_attribution ->> 'admin1Code',
           report_attribution ->> 'admin1_code',
           report_attribution ->> 'province'
         )) = upper(${code})
         OR coalesce(
           report_attribution ->> 'admin1Code',
           report_attribution ->> 'admin1_code',
           report_attribution ->> 'province'
         ) = ANY(${names})
       )
  )`
  const recallCode = `coalesce(
    ${revisionAlias}.normalized_payload #>> '{heat_metrics,provinceSuggestionCode}',
    ${revisionAlias}.normalized_payload #>> '{heat_metrics,recallAdmin1Code}',
    ${revisionAlias}.normalized_payload #>> '{raw,politicalTerrorProvinceSuggestionCode}',
    ${revisionAlias}.normalized_payload #>> '{raw,politicalTerrorRecallAdmin1Code}'
  )`
  const recallName = `coalesce(
    ${revisionAlias}.normalized_payload #>> '{heat_metrics,provinceSuggestion}',
    ${revisionAlias}.normalized_payload #>> '{raw,politicalTerrorProvinceSuggestion}'
  )`
  const recallQuery = `coalesce(
    ${revisionAlias}.normalized_payload #>> '{heat_metrics,provinceRecallQuery}',
    ${revisionAlias}.normalized_payload #>> '{raw,politicalTerrorProvinceRecallQuery}',
    ''
  )`
  const recallFlag = `lower(coalesce(
    ${revisionAlias}.normalized_payload #>> '{heat_metrics,provinceRecall}',
    ${revisionAlias}.normalized_payload #>> '{raw,politicalTerrorProvinceRecall}',
    'false'
  )) = 'true'`
  const currentAssertion = (fieldKey, valuePredicate) => `EXISTS (
    SELECT 1
      FROM agent_center.classification_assertions related_assertion
      JOIN agent_center.analysis_tasks related_task
        ON related_task.id = related_assertion.task_id
     WHERE related_assertion.task_id = ${publicationAlias}.materialized_from_task_id
       AND related_assertion.pipeline_key = 'province-geography-v1'
       AND related_assertion.record_id = ${recordAlias}.id
       AND related_assertion.canonical_revision = ${recordAlias}.current_revision
       AND related_assertion.source_object_revision_id = ${publicationAlias}.source_object_revision_id
       AND related_assertion.field_key = '${fieldKey}'
       AND related_assertion.status IN ('accepted', 'proposed')
       AND related_task.status = 'succeeded'
       AND related_task.record_id = ${recordAlias}.id
       AND related_task.canonical_revision = ${recordAlias}.current_revision
       AND related_task.source_object_revision_id = ${publicationAlias}.source_object_revision_id
       AND ${valuePredicate}
  )`
  const reportAssertion = currentAssertion(
    'geography.report_attribution',
    `jsonb_typeof(related_assertion.proposed_value) = 'object'
       AND related_assertion.proposed_value ->> 'admin1Code' = ${code}`,
  )
  const relatedAssertion = currentAssertion(
    'geography.related_admin1_codes',
    `jsonb_typeof(related_assertion.proposed_value) = 'array'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(related_assertion.proposed_value) related_area
          WHERE related_area ->> 'admin1Code' = ${code}
       )`,
  )
  const relations = {
    event: `${publicationAlias}.event_admin1_code = ${code}`,
    publisher: `${publicationAlias}.publisher_admin1_code = ${code}`,
    display: `${publicationAlias}.display_admin1_code = ${code}`,
    report: `(
      ${trustedReportRaw}
      OR ${reportAssertion}
    )`,
    recall: `(${recallFlag} AND (
        upper(${recallCode}) = upper(${code})
        OR ${recallName} = ANY(${names})
        OR EXISTS (
          SELECT 1
            FROM unnest(${names}) AS related_province_name
           WHERE ${recallQuery} ILIKE '%' || related_province_name || '%'
        )
      )
    )`,
    related: relatedAssertion,
    canonical: `${recordAlias}.admin1_code = ${code}`,
  }
  relations.any = `(${[
    relations.event,
    relations.publisher,
    relations.display,
    relations.report,
    relations.recall,
    relations.related,
    relations.canonical,
  ].join(' OR ')})`
  return relations
}

function dataCenterDataset(row) {
  return {
    datasetId: row.dataset_id,
    platforms: row.platforms || [],
    objectTypes: row.object_types || [],
    contentTypes: row.content_types || [],
    activeRecordCount: Number(row.active_record_count || 0),
    deletedRecordCount: Number(row.deleted_record_count || 0),
    revisionCount: Number(row.revision_count || 0),
    lastCollectedAt: iso(row.last_collected_at),
    lastEventAt: iso(row.last_event_at),
  }
}

function dataCenterRecord(row) {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    platform: row.platform,
    objectType: row.object_type,
    contentType: row.content_type,
    externalId: row.external_id,
    title: row.title,
    currentRevision: Number(row.current_revision),
    eventTime: iso(row.event_time),
    collectedAt: iso(row.collected_at),
    deletedAt: iso(row.deleted_at),
  }
}

function dataCenterPublication(row) {
  if (row.publication_record_id == null) return null
  return {
    sourceStage: row.publication_source_stage,
    status: row.publication_status,
    qualityScore: row.publication_quality_score == null ? null : Number(row.publication_quality_score),
    qualificationThreshold: Number(row.publication_qualification_threshold),
    eventAdmin1Code: row.publication_event_admin1_code,
    publisherAdmin1Code: row.publication_publisher_admin1_code,
    displayAdmin1Code: row.publication_display_admin1_code,
    geographyVerified: row.publication_geography_verified === true,
    geoScope: row.publication_geo_scope,
    countryCode: row.publication_country_code,
    locationLabel: row.publication_location_label,
    locationType: row.publication_location_type,
    countryName: row.publication_country_name,
    assessedAt: iso(row.publication_assessed_at),
  }
}

function dataCenterRecordDetail(row) {
  const publication = dataCenterPublication(row)
  return {
    ...dataCenterRecord(row),
    identityHash: row.identity_hash,
    schemaVersion: row.schema_version,
    payloadSha256: row.payload_sha256,
    url: row.url,
    body: row.body,
    authorExternalId: row.author_external_id,
    authorName: row.author_name,
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
    countryCode: row.country_code,
    admin1Code: row.admin1_code,
    admin2Code: row.admin2_code,
    stableFields: row.stable_fields || {},
    extensions: row.extensions || {},
    metrics: row.stable_fields?.metrics || {},
    rawPayload: row.raw_payload ?? null,
    lineage: {
      parserVersion: row.parser_version ?? null,
      ingestRunId: row.ingest_run_id ?? null,
      externalImportRunId: row.external_import_run_id ?? null,
      latestObservation: row.observation_id ? {
        id: row.observation_id,
        ingestRunId: row.observation_ingest_run_id ?? null,
        connectorId: row.observation_connector_id ?? null,
        sourceEventId: row.observation_source_event_id ?? null,
        queryFingerprint: row.observation_query_fingerprint ?? null,
        requestId: row.observation_request_id ?? null,
        connectorCallId: row.connector_call_id ?? null,
        operation: row.connector_operation ?? null,
        ...(row.external_platform_call_id ? {
          externalPlatformCallId: row.external_platform_call_id,
          externalPlatform: {
            providerKey: row.external_provider_key,
            operation: row.external_operation,
            endpointKey: row.external_endpoint_key,
            endpointVersion: row.external_endpoint_version,
            marketplace: row.external_marketplace,
            outcome: row.external_outcome,
            billed: row.external_billed,
            costMinor: row.external_cost_minor == null ? null : Number(row.external_cost_minor),
            costKind: row.external_cost_kind,
            currency: row.external_currency,
            upstreamRequestId: row.external_upstream_request_id,
            upstreamRecordTime: row.external_upstream_record_time,
            completedAt: row.external_completed_at ? iso(row.external_completed_at) : null,
            responseContractState: row.external_response_contract_state,
            responseCapturedAt: row.external_response_captured_at
              ? iso(row.external_response_captured_at)
              : null,
            responsePayloadSha256: row.external_response_payload_sha256,
            archivePath: row.external_archive_path,
            sourceCatalogKey: row.external_archive_source_key,
          },
        } : {}),
      } : null,
    },
    projectionRevision: Number(row.projection_revision || 0),
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
    ...(Array.isArray(row.related_admin1_matches) ? {
      relatedProvinceMatches: row.related_admin1_matches,
    } : {}),
    ...(publication ? { publication } : {}),
    highlight: null,
  }
}

function externalSource(row) {
  return row && {
    id: row.id,
    sourceKey: row.source_key,
    displayName: row.display_name,
    sourceKind: row.source_kind,
    datasetId: row.dataset_id,
    platform: row.platform,
    objectType: row.object_type,
    status: row.status,
    connection: row.connection,
    databaseConnectionId: row.database_connection_id ?? null,
    syncIntervalSeconds: row.sync_interval_seconds == null ? null : Number(row.sync_interval_seconds),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function databaseConnection(row) {
  return row && {
    id: row.id,
    key: row.connection_key,
    displayName: row.display_name,
    engine: row.engine,
    connection: row.connection || {},
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function virtualSupermarketCategory(row) {
  return row && {
    id: row.id ?? row.category_id,
    categoryKey: row.category_key,
    displayName: row.display_name ?? row.category_display_name,
    departmentKey: row.department_key,
    departmentName: row.department_name,
    departmentSortOrder: Number(row.department_sort_order || 0),
    aisleKey: row.aisle_key,
    aisleName: row.aisle_name,
    aisleSortOrder: Number(row.aisle_sort_order || 0),
    shelfKey: row.shelf_key,
    shelfName: row.shelf_name,
    shelfSortOrder: Number(row.shelf_sort_order || 0),
    sortOrder: Number(row.sort_order ?? row.category_sort_order ?? 0),
    revision: Number(row.revision ?? row.category_revision ?? 1),
    archivedAt: iso(row.archived_at ?? row.category_archived_at),
    createdAt: iso(row.created_at ?? row.category_created_at),
    updatedAt: iso(row.updated_at ?? row.category_updated_at),
  }
}

function virtualSupermarketItem(row) {
  return row && {
    id: row.id,
    externalId: row.external_id,
    title: row.title,
    authorName: row.author_name,
    collectedAt: iso(row.collected_at),
    currentRevision: Number(row.current_revision || 1),
    stableFields: row.stable_fields || {},
    listing: {
      explicit: row.listing_explicit === true,
      publicationId: row.publication_id,
      status: row.listing_status,
      categoryId: row.listing_category_id,
      displayTitle: row.display_title,
      specification: row.specification,
      priceAmount: row.price_amount == null ? null : String(row.price_amount),
      currency: row.currency,
      shelfPosition: row.shelf_position == null ? null : Number(row.shelf_position),
      revision: Number(row.listing_revision || 0),
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: iso(row.listing_created_at),
      updatedAt: iso(row.listing_updated_at),
    },
    category: virtualSupermarketCategory({
      ...row,
      id: row.category_id,
      display_name: row.category_display_name,
      sort_order: row.category_sort_order,
      revision: row.category_revision,
      archived_at: row.category_archived_at,
      created_at: row.category_created_at,
      updated_at: row.category_updated_at,
    }),
  }
}

function virtualSupermarketEvent(row) {
  return row && {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    actor: row.actor,
    fromRevision: row.from_revision == null ? null : Number(row.from_revision),
    toRevision: Number(row.to_revision),
    storefrontRevision: Number(row.storefront_revision),
    reason: row.reason,
    changes: row.changes || {},
    createdAt: iso(row.created_at),
  }
}

async function virtualSupermarketItemById(connection, id, { onShelfOnly = false } = {}) {
  const { rows } = await connection.query(
    `${VIRTUAL_SUPERMARKET_ITEM_SELECT}
      WHERE record.id = $1::uuid
        AND record.dataset_id = 'mobile-commerce.collected-items.v1'
        AND record.platform = 'mobile_commerce'
        AND record.object_type = 'commerce_capture'
        AND record.deleted_at IS NULL
        ${onShelfOnly ? "AND listing.status = 'on_shelf' AND category.archived_at IS NULL" : ''}`,
    [id],
  )
  return virtualSupermarketItem(rows[0])
}

function sourceCatalogEntry(row) {
  return row && {
    id: row.id,
    sourceKey: row.source_key,
    legacySequence: row.legacy_sequence == null ? null : Number(row.legacy_sequence),
    canonicalName: row.canonical_name,
    aliases: row.aliases || [],
    sourceKind: row.source_kind,
    parentSourceId: row.parent_source_id,
    majorCategory: row.major_category,
    scenarios: row.scenarios || [],
    regions: row.regions || [],
    entryModules: row.entry_modules || [],
    monitorableContent: row.monitorable_content || [],
    extractableClues: row.extractable_clues || [],
    trackingFields: row.tracking_fields || [],
    suggestedAccess: row.suggested_access || [],
    complianceBoundary: row.compliance_boundary,
    priority: row.priority,
    coverageStatus: row.coverage_status,
    deliveryStatus: row.delivery_status,
    reviewStatus: row.review_status,
    runtimeStatus: row.runtime_status,
    owner: row.owner,
    ownerId: row.owner_id,
    connectorHints: row.connector_hints || [],
    notes: row.notes,
    tags: row.tags || [],
    evidenceRefs: row.evidence_refs || [],
    customFields: row.custom_fields || {},
    revision: Number(row.revision || 1),
    archivedAt: iso(row.archived_at),
    importedFrom: row.imported_from,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function sourceCatalogEvent(row) {
  return row && {
    id: row.id,
    entryId: row.entry_id,
    eventType: row.event_type,
    actor: row.actor,
    fromRevision: row.from_revision == null ? null : Number(row.from_revision),
    toRevision: Number(row.to_revision),
    changes: row.changes || {},
    createdAt: iso(row.created_at),
  }
}

function sourceCatalogTerm(row) {
  return row && {
    id: row.id,
    termKey: row.term_key,
    kind: row.kind,
    displayName: row.display_name,
    normalizedName: row.normalized_name,
    description: row.description,
    color: row.color,
    sortOrder: Number(row.sort_order || 0),
    usageCount: Number(row.usage_count || 0),
    revision: Number(row.revision || 1),
    archivedAt: iso(row.archived_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function sourceCatalogTermEvent(row) {
  return row && {
    id: row.id,
    termId: row.term_id,
    eventType: row.event_type,
    actor: row.actor,
    fromRevision: row.from_revision == null ? null : Number(row.from_revision),
    toRevision: Number(row.to_revision),
    changes: row.changes || {},
    createdAt: iso(row.created_at),
  }
}

function sourceCatalogOwner(row) {
  return row && {
    id: row.id,
    ownerKey: row.owner_key,
    displayName: row.display_name,
    normalizedName: row.normalized_name,
    description: row.description,
    linkedAccountId: row.linked_account_id,
    usageCount: Number(row.usage_count || 0),
    revision: Number(row.revision || 1),
    archivedAt: iso(row.archived_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function sourceCatalogOwnerEvent(row) {
  return row && {
    id: row.id,
    ownerId: row.owner_id,
    eventType: row.event_type,
    actor: row.actor,
    fromRevision: row.from_revision == null ? null : Number(row.from_revision),
    toRevision: Number(row.to_revision),
    changes: row.changes || {},
    createdAt: iso(row.created_at),
  }
}

function sourceCatalogRelatedDataset(row) {
  return {
    datasetId: row.dataset_id,
    platforms: row.platforms || [],
    objectTypes: row.object_types || [],
    contentTypes: row.content_types || [],
    activeRecordCount: Number(row.active_record_count || 0),
    deletedRecordCount: Number(row.deleted_record_count || 0),
    revisionCount: Number(row.revision_count || 0),
    lastCollectedAt: iso(row.last_collected_at),
    lastEventAt: iso(row.last_event_at),
    chunkCount: Number(row.chunk_count || 0),
    projectedChunkCount: Number(row.projected_chunk_count || 0),
  }
}

function sourceCatalogRelatedExternalSource(row) {
  return row && {
    id: row.id,
    sourceKey: row.source_key,
    displayName: row.display_name,
    sourceKind: row.source_kind,
    datasetId: row.dataset_id,
    platform: row.platform,
    objectType: row.object_type,
    status: row.status,
    databaseConnectionId: row.database_connection_id ?? null,
    syncIntervalSeconds: row.sync_interval_seconds == null ? null : Number(row.sync_interval_seconds),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function sourceMapping(row) {
  return row && {
    id: row.id,
    sourceId: row.source_id,
    version: row.version,
    fieldMap: row.field_map,
    origin: row.origin,
    agentModel: row.agent_model,
    agentConfidence: row.agent_confidence === null ? null : Number(row.agent_confidence),
    notes: row.notes,
    schemaFingerprint: row.schema_fingerprint ?? null,
    fileStructure: row.file_structure ?? null,
    formatRuleVersionId: row.format_rule_version_id ?? null,
    selectedRuleKey: row.selected_rule_key ?? null,
    approved: Boolean(row.approved_at),
    approvedAt: iso(row.approved_at),
    approvedBy: row.approved_by,
    createdAt: iso(row.created_at),
  }
}

function fileFormatRule(row) {
  if (!row) return null
  return {
    ruleId: row.rule_id,
    ruleKey: row.rule_key,
    displayName: row.display_name,
    datasetId: row.dataset_id,
    platform: row.platform,
    objectType: row.object_type,
    versionId: row.version_id ?? null,
    version: row.version == null ? null : Number(row.version),
    schemaFingerprint: row.schema_fingerprint ?? null,
    fieldMap: row.field_map ?? null,
    parserFamily: row.parser_family ?? null,
    inputFormat: row.input_format ?? null,
    fileStructure: row.file_structure ?? null,
  }
}

function fileObservation(row) {
  return row && {
    id: row.id,
    sourceId: row.source_id,
    rootId: row.root_id,
    relativePath: row.relative_path,
    pathHash: row.path_hash,
    inputSha256: row.input_sha256,
    inputBytes: Number(row.input_bytes),
    mtime: iso(row.source_mtime),
    schemaFingerprint: row.schema_fingerprint ?? null,
    formatRuleVersionId: row.format_rule_version_id ?? null,
    importRunId: row.import_run_id ?? null,
    status: row.status,
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
  }
}

function pipelineWriterContractAttestation(row) {
  return row && {
    id: row.id,
    pipelineKey: row.pipeline_key,
    contractVersion: row.contract_version,
    contractDigest: row.contract_digest,
    contractSummary: row.contract_summary,
    attestedBy: row.attested_by,
    attestedAt: iso(row.attested_at),
  }
}

function importRun(row) {
  return row && {
    id: row.id,
    sourceId: row.source_id,
    mappingVersion: row.mapping_version,
    inputName: row.input_name,
    inputBytes: row.input_bytes === null ? null : Number(row.input_bytes),
    status: row.status,
    rowCount: row.row_count,
    ingestedCount: row.ingested_count,
    rejectedCount: row.rejected_count,
    changedCount: Number(row.changed_count ?? 0),
    deletedCount: Number(row.deleted_count ?? 0),
    batchCount: Number(row.batch_count ?? 0),
    trigger: row.trigger ?? null,
    cursorStart: row.cursor_start ?? null,
    cursorEnd: row.cursor_end ?? null,
    lastError: row.last_error,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  }
}

function importRunBatch(row) {
  return row && {
    key: row.batch_key,
    cursorStart: row.cursor_start ?? null,
    cursorEnd: row.cursor_end ?? null,
    rowCount: Number(row.row_count),
    ingested: Number(row.ingested_count),
    changed: Number(row.changed_count),
    deleted: Number(row.deleted_count),
    rejected: Number(row.rejected_count),
    status: row.status,
    errorCode: row.error_code ?? null,
    pageFingerprint: row.page_fingerprint ?? null,
  }
}

async function saveCursorInTransaction(client, id, position, {
  status,
  processedDelta = 0,
  error = null,
}) {
  const { rows } = await client.query(
    `INSERT INTO mxq.cursors
       (id, position, status, processed_count, last_error, started_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (id) DO UPDATE SET
       position = EXCLUDED.position,
       status = EXCLUDED.status,
       processed_count = mxq.cursors.processed_count + $4,
       last_error = EXCLUDED.last_error,
       updated_at = now()
     RETURNING *`,
    [id, position, status, processedDelta, error],
  )
  return rows[0]
}

// Local transaction helper. mx-common exports an equivalent, but the store
// receives a pool rather than the shared config and should not reach into the
// package for one three-line function.
async function withPgTransaction(pool, fn, {
  outcomeUnknownCode = null,
  sessionClient = null,
} = {}) {
  const client = sessionClient ?? await pool.connect()
  let commitStarted = false
  let committed = false
  let releaseError = null
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    commitStarted = true
    await client.query('COMMIT')
    committed = true
    return result
  } catch (error) {
    if (commitStarted && !committed && outcomeUnknownCode) {
      releaseError = error
      const unknown = new AppError(
        503,
        outcomeUnknownCode,
        'The transaction outcome is unknown; retry the same operation',
      )
      unknown.cause = error
      throw unknown
    }
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    if (!sessionClient) client.release(releaseError)
  }
}

function summarizeAggregates(rows) {
  const byPlatform = {}
  const byCapability = {}
  let requests = 0
  let committed = 0
  let released = 0
  let unknown = 0
  let units = 0
  let weightedLatency = 0
  let latencyRequests = 0
  for (const row of rows) {
    const entry = {
      requests: row.requests,
      committed: row.committed,
      released: row.released,
      unknown: row.unknown,
      units: row.units,
    }
    if (row.capability) byCapability[row.capability] = entry
    else byPlatform[row.platform] = entry
    requests += row.requests
    committed += row.committed
    released += row.released
    unknown += row.unknown
    units += row.units
    if (row.average_latency != null && row.committed > 0) {
      weightedLatency += row.average_latency * row.committed
      latencyRequests += row.committed
    }
  }
  return {
    requests,
    committed,
    released,
    unknown,
    units,
    averageUpstreamLatencyMs: latencyRequests ? Math.round(weightedLatency / latencyRequests) : null,
    byPlatform,
    byCapability,
  }
}

export async function createPostgresStore(options) {
  const { Pool } = await import('pg')
  return new PostgresStore(new Pool(options))
}
