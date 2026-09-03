import {
  DEFAULT_SEARCH_PROFILE,
  POSTGRES_SEARCH_PROFILE,
  searchCapabilities,
} from './search/profiles.mjs'

export const PUBLIC_DOCS_LEGACY_ROUTE_SCRIPT = `(()=>{const routes={rules:'/docs/auth','source-catalog':'/docs/source-catalog','virtual-supermarket':'/docs/virtual-supermarket',search:'/docs/search',telegram:'/docs/telegram','public-opinion':'/docs/public-opinion','night-all':'/docs/night-all',tools:'/docs/tools',discovery:'/docs/evidence',errors:'/docs/errors'};const route=routes[location.hash.slice(1)];if(route)location.replace(route)})()`

const PUBLIC_SEARCH_PROFILE_IDS = Object.freeze(
  searchCapabilities({ audience: 'public' }).profiles.map((profile) => profile.id),
)

const errorResponse = {
  description: 'Request failed. The response contains a stable error code and requestId.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ErrorEnvelope' },
    },
  },
}

const publicErrors = Object.fromEntries(
  [400, 401, 403, 404, 409, 410, 429, 502, 503].map((status) => [status, errorResponse]),
)

const canonicalContextErrors = Object.fromEntries(
  [400, 401, 403, 404, 409, 429, 503].map((status) => [status, errorResponse]),
)

const telegramSourceScopeParameter = {
  name: 'sourceScope', in: 'query', required: false,
  description: 'Stored corpus to read. Defaults to monitor for backward compatibility; all merges Monitor and SQLite imports.',
  schema: { type: 'string', enum: ['all', 'monitor', 'sqlite'], default: 'monitor' },
}

const telegramHistoryFilterParameters = [
  {
    name: 'chatId', in: 'query', required: false,
    description: 'Exact normalized chat identifier, or the stable chatKey returned by the chats route.',
    schema: { type: 'string', minLength: 1, maxLength: 256 },
  },
  {
    name: 'from', in: 'query', required: false,
    description: 'Inclusive RFC3339 event-time lower bound.',
    schema: { type: 'string', format: 'date-time' },
  },
  {
    name: 'to', in: 'query', required: false,
    description: 'Inclusive RFC3339 event-time upper bound.',
    schema: { type: 'string', format: 'date-time' },
  },
]

const telegramPageParameters = [
  {
    name: 'pageSize', in: 'query', required: false,
    description: 'Defaults to 50; the API-key policy may impose a lower maximum.',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  },
  {
    name: 'cursor', in: 'query', required: false,
    description: 'Opaque nextCursor returned by the previous page. Return it unchanged with the same filters and pageSize. Legacy monitor-only cursors are at most 1024 characters; extended source/filter cursors are at most 2048.',
    schema: { type: 'string', minLength: 1, maxLength: 2048 },
  },
]

const telegramChatParameters = [
  telegramSourceScopeParameter,
  {
    name: 'kind', in: 'query', required: false,
    description: 'Filter the conversation catalog by normalized Telegram kind.',
    schema: { type: 'string', enum: ['all', 'channel', 'group', 'unknown'], default: 'all' },
  },
  {
    name: 'query', in: 'query', required: false,
    description: 'Case-insensitive title or username substring.',
    schema: { type: 'string', minLength: 1, maxLength: 200 },
  },
  ...telegramHistoryFilterParameters,
  ...telegramPageParameters,
]

const telegramMessageParameters = [
  telegramSourceScopeParameter,
  ...telegramHistoryFilterParameters,
  ...telegramPageParameters,
]

const sourceCatalogQueryParameters = [
  ['query', 'Free-text search across the public catalog projection.'],
  ['majorCategory', 'Exact active major-category display name.'],
  ['scenario', 'Exact active scenario display name.'],
  ['region', 'Exact active region display name.'],
  ['ownerId', 'Exact active owner UUID.'],
  ['tag', 'Exact active tag display name.'],
].map(([name, description]) => ({
  name, in: 'query', required: false, description,
  schema: name === 'ownerId'
    ? { type: 'string', format: 'uuid' }
    : { type: 'string', minLength: 1, maxLength: name === 'query' ? 240 : 160 },
}))
sourceCatalogQueryParameters.splice(1, 0,
  {
    name: 'sourceKind', in: 'query', required: false,
    schema: { type: 'string', enum: ['platform', 'platform_module', 'source_class', 'registry', 'provider', 'dataset', 'other'] },
  },
)
for (const [name, values] of [
  ['coverageStatus', ['unknown', 'not_covered', 'partial', 'covered']],
  ['deliveryStatus', ['exploring', 'planned', 'doing', 'blocked', 'complete', 'paused', 'retired']],
  ['reviewStatus', ['needs_review', 'verified', 'rejected']],
  ['runtimeStatus', ['not_configured', 'unknown', 'healthy', 'degraded', 'failed']],
  ['priority', ['P0', 'P1', 'P2', 'P3']],
]) {
  sourceCatalogQueryParameters.push({
    name, in: 'query', required: false,
    schema: { type: 'string', enum: values },
  })
}
sourceCatalogQueryParameters.push(
  {
    name: 'pageSize', in: 'query', required: false,
    description: 'Defaults to 50; maximum 100, and the source_catalog policy may impose a lower limit.',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  },
  {
    name: 'cursor', in: 'query', required: false,
    description: 'HMAC-signed keyset cursor bound to every filter and pageSize. Return unchanged; changing a filter requires restarting from page one.',
    schema: { type: 'string', minLength: 1, maxLength: 4096 },
  },
)

const mobileCommerceQueryParameters = [
  {
    name: 'sourcePlatform', in: 'query', required: false,
    description: 'Exact raw marketplace label retained from the collector, such as 快手小店.',
    schema: { type: 'string', minLength: 1, maxLength: 120 },
  },
  {
    name: 'catalogEntryId', in: 'query', required: false,
    description: 'Exact governed source-catalog UUID assigned by the reviewed marketplace mapping.',
    schema: { type: 'string', format: 'uuid' },
  },
  ...['keyword', 'brand', 'taskId'].map((name) => ({
    name, in: 'query', required: false,
    description: `Exact collector ${name} label; it narrows results and does not grant access.`,
    schema: { type: 'string', minLength: 1, maxLength: name === 'taskId' ? 120 : 240 },
  })),
  ...['from', 'to'].map((name) => ({
    name, in: 'query', required: false,
    description: `Inclusive RFC3339 collection-time ${name === 'from' ? 'lower' : 'upper'} bound with an explicit offset.`,
    schema: { type: 'string', format: 'date-time' },
  })),
  {
    name: 'refresh', in: 'query', required: false,
    description: 'Only stored is available. Remote acquisition by the external mobile collector is reserved and never runs inside Hub.',
    schema: { type: 'string', enum: ['stored'], default: 'stored' },
  },
  {
    name: 'pageSize', in: 'query', required: false,
    description: 'Defaults to 50; maximum 100, and the mobile_commerce policy may impose a lower limit.',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  },
  {
    name: 'cursor', in: 'query', required: false,
    description: 'HMAC-signed keyset cursor bound to all normalized filters and pageSize.',
    schema: { type: 'string', minLength: 1, maxLength: 2048 },
  },
]

const virtualSupermarketQueryParameters = [
  {
    name: 'categoryId', in: 'query', required: false,
    description: 'Exact active virtual-supermarket category UUID returned by metadata.',
    schema: { type: 'string', format: 'uuid' },
  },
  ...['department', 'aisle', 'shelf'].map((name) => ({
    name, in: 'query', required: false,
    description: `Exact semantic ${name} key returned by virtual-supermarket metadata.`,
    schema: { type: 'string', minLength: 1, maxLength: 128 },
  })),
  {
    name: 'marketplace', in: 'query', required: false,
    description: 'Exact customer-safe marketplace display value.',
    schema: { type: 'string', minLength: 1, maxLength: 160 },
  },
  {
    name: 'query', in: 'query', required: false,
    description: 'Customer-safe product text search. Required on the dedicated search route.',
    schema: { type: 'string', minLength: 1, maxLength: 240 },
  },
  {
    name: 'sort', in: 'query', required: false,
    schema: { type: 'string', enum: ['newest', 'title_asc', 'price_asc', 'price_desc'], default: 'newest' },
  },
  {
    name: 'pageSize', in: 'query', required: false,
    description: 'Defaults to 24; maximum 100, and the virtual_supermarket policy may impose a lower limit.',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 24 },
  },
  {
    name: 'cursor', in: 'query', required: false,
    description: 'Opaque signed cursor bound to every normalized filter, sort, pageSize and storefrontRevision.',
    schema: { type: 'string', minLength: 1, maxLength: 2048 },
  },
]

const publicOpinionDiagnosticsWindowParameters = [
  {
    name: 'from', in: 'query', required: false,
    description: 'Inclusive RFC3339 lower bound. Supply from and to together; otherwise the latest 30-day window is used.',
    schema: { type: 'string', format: 'date-time' },
  },
  {
    name: 'to', in: 'query', required: false,
    description: 'Inclusive RFC3339 upper bound. Supply from and to together.',
    schema: { type: 'string', format: 'date-time' },
  },
]

const publicOpinionDiagnosticsRecordParameters = [
  ...publicOpinionDiagnosticsWindowParameters,
  {
    name: 'reason', in: 'query', required: false,
    schema: { type: 'string', enum: ['all', 'coverage_visible', 'hot_visible', 'missing_publication_state', 'not_formal_stage', 'not_formal_status', 'missing_event_time', 'outside_window', 'missing_province', 'missing_heat'], default: 'all' },
  },
  {
    name: 'stage', in: 'query', required: false,
    schema: { type: 'string', enum: ['all', 'formal', 'candidate', 'missing'], default: 'all' },
  },
  {
    name: 'status', in: 'query', required: false,
    schema: { type: 'string', enum: ['all', 'formal', 'pending', 'qualified', 'rejected', 'failed', 'missing'], default: 'all' },
  },
  {
    name: 'province', in: 'query', required: false,
    description: 'all, missing, or one ISO 3166-2:CN province code.',
    schema: { type: 'string', default: 'all' },
  },
  {
    name: 'scope', in: 'query', required: false,
    schema: { type: 'string', enum: ['all', 'missing', 'national', 'nationwide', 'province', 'multi_province', 'city', 'maritime', 'overseas', 'unknown'], default: 'all' },
  },
  {
    name: 'time', in: 'query', required: false,
    schema: { type: 'string', enum: ['all', 'within', 'outside', 'missing'], default: 'all' },
  },
  {
    name: 'heat', in: 'query', required: false,
    schema: { type: 'string', enum: ['all', 'present', 'missing'], default: 'all' },
  },
  {
    name: 'query', in: 'query', required: false,
    description: 'Search the customer-safe title, summary, author and location projection.',
    schema: { type: 'string', minLength: 1, maxLength: 500 },
  },
  {
    name: 'pageSize', in: 'query', required: false,
    description: 'Defaults to 50; the public_opinion platform maxPageSize may impose a lower limit.',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  },
  {
    name: 'cursor', in: 'query', required: false,
    description: 'HMAC-signed keyset cursor bound to the complete normalized filter set and pageSize.',
    schema: { type: 'string', minLength: 1, maxLength: 2048 },
  },
]

const publicOpinionProvinceParameters = [
  {
    name: 'province', in: 'path', required: true,
    description: 'Province as an ISO 3166-2:CN code, short Chinese name or official Chinese name. Examples: CN-JS, 江苏, 江苏省. Chinese names must be URL-encoded.',
    schema: { type: 'string', minLength: 1, maxLength: 32 },
  },
  {
    name: 'sort', in: 'query', required: false,
    description: 'hot orders by heat score, effective sort time and canonical id; rows without a heat score are excluded. latest orders by effective sort time, collection time and canonical id. Effective sort time is publishedAt when present, otherwise collectedAt; this fallback is not exposed as publishedAt.',
    schema: { type: 'string', enum: ['hot', 'latest'], default: 'hot' },
  },
  {
    name: 'from', in: 'query', required: false,
    description: 'Inclusive RFC3339 published/event-time lower bound. It must not be later than to.',
    schema: { type: 'string', format: 'date-time' },
  },
  {
    name: 'to', in: 'query', required: false,
    description: 'Inclusive RFC3339 published/event-time upper bound. It must not be earlier than from.',
    schema: { type: 'string', format: 'date-time' },
  },
  {
    name: 'includeCandidates', in: 'query', required: false,
    description: 'Defaults to false and preserves the formal-only contract. qualified adds only candidates already in status=qualified; minQualityScore is an additional request floor, not a reclassification control. true is accepted as an alias. all includes every candidate passing the optional score filter and requires both from and to; omit minQualityScore to retain unscored candidates.',
    schema: { type: 'string', enum: ['false', 'true', 'qualified', 'all'], default: 'false' },
  },
  {
    name: 'minQualityScore', in: 'query', required: false,
    description: 'Additional candidate score floor from 0 to 100. It is valid only with includeCandidates=qualified or all and defaults to 80 for qualified. Setting 0 does not change publication status or lower a record qualification threshold; with all, an explicit 0 still excludes null/unscored values.',
    schema: { type: 'integer', minimum: 0, maximum: 100 },
  },
  {
    name: 'pageSize', in: 'query', required: false,
    description: 'Defaults to 20; maximum 100, and the public_opinion platform policy may impose a lower limit.',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
  {
    name: 'cursor', in: 'query', required: false,
    description: 'HMAC-signed opaque nextCursor bound to province, sort, time bounds and page size. Return it unchanged; changing any bound requires starting from the first page.',
    schema: { type: 'string', minLength: 1, maxLength: 8192 },
  },
]

const publicOpinionCandidateParameters = publicOpinionProvinceParameters.slice(4, 6)

const publicOpinionCoverageParameters = [
  {
    name: 'from', in: 'query', required: true,
    description: 'Inclusive RFC3339 published/event-time lower bound.',
    schema: { type: 'string', format: 'date-time' },
  },
  {
    name: 'to', in: 'query', required: true,
    description: 'Inclusive RFC3339 published/event-time upper bound. It must not be earlier than from.',
    schema: { type: 'string', format: 'date-time' },
  },
  ...publicOpinionCandidateParameters,
  {
    name: 'targetPerProvince', in: 'query', required: false,
    description: 'Coverage target used to calculate shortfall and meetsTarget. Defaults to 10.',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
  },
]

const publicOpinionRegionCatalogParameters = [
  {
    name: 'parentCode', in: 'query', required: false,
    description: 'P1 supports the nationwide parent only. Defaults to CN.',
    schema: { type: 'string', const: 'CN', default: 'CN' },
  },
  {
    name: 'level', in: 'query', required: false,
    description: 'P1 exposes the stable province-level catalog only. City codes are not exposed.',
    schema: { type: 'string', const: 'province', default: 'province' },
  },
]

const publicOpinionRegionFeedParameters = [
  {
    name: 'regionCode', in: 'path', required: true,
    description: 'CN for the nationwide scope, or one exact ISO 3166-2:CN province code returned by the region catalog. Chinese aliases and city codes are not accepted.',
    schema: { type: 'string', pattern: '^CN(?:-[A-Z]{2})?$' },
  },
  {
    name: 'visibility', in: 'query', required: true,
    description: 'P1 requires all_ingested. No quality score, qualification status or geography-verification predicate is applied.',
    schema: { type: 'string', const: 'all_ingested' },
  },
  {
    name: 'sort', in: 'query', required: false,
    description: 'P1 supports latest only and defaults to latest. Null heat scores do not remove records.',
    schema: { type: 'string', const: 'latest', default: 'latest' },
  },
  {
    name: 'from', in: 'query', required: true,
    description: 'Inclusive RFC3339 effective-time lower bound. Effective time is publishedAt when present, otherwise collectedAt.',
    schema: { type: 'string', format: 'date-time' },
  },
  {
    name: 'to', in: 'query', required: true,
    description: 'Inclusive RFC3339 effective-time upper bound. It must not be earlier than from.',
    schema: { type: 'string', format: 'date-time' },
  },
  {
    name: 'pageSize', in: 'query', required: false,
    description: 'Defaults to 20; maximum 100, and the public_opinion platform policy may impose a lower limit.',
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
  {
    name: 'cursor', in: 'query', required: false,
    description: 'HMAC-signed opaque nextCursor bound to region, visibility, sort, time bounds and page size. Return it unchanged.',
    schema: { type: 'string', minLength: 1, maxLength: 8192 },
  },
]

const resultTypeProperty = {
  type: 'string',
  enum: ['fresh', 'stable'],
  default: 'fresh',
  description: "Result freshness. 'fresh' always searches current data and replays a committed response only within 120 seconds, which covers a retry without turning the key into a cache. 'stable' replays the first response for that key indefinitely, for snapshots that must stay reproducible. Part of the request fingerprint.",
}

const publicOpinionSearchRequestProperties = {
  includeCandidates: {
    type: 'string',
    enum: ['qualified', 'all'],
    description: 'Valid only with explicit platform=public_opinion. qualified includes only candidates already in status=qualified and defaults the additional minQualityScore floor to 80; 0 does not reclassify pending/rejected/failed rows. all is a bounded audit mode and requires from, to and at least one of province, countryCode or location; omit minQualityScore to retain unscored candidates.',
  },
  minQualityScore: {
    type: 'integer', minimum: 0, maximum: 100,
    description: 'Additional candidate score floor. Valid only with includeCandidates=qualified or all; qualified defaults to 80. It does not change publication status or lower a record qualification threshold.',
  },
  province: {
    type: 'string', minLength: 1, maxLength: 64,
    description: 'Exact China province filter as an ISO 3166-2:CN code or supported Chinese province name. Valid only with explicit platform=public_opinion.',
  },
  countryCode: {
    type: 'string', pattern: '^[A-Za-z]{2}$',
    description: 'Exact ISO 3166-1 alpha-2 country filter. Valid only with explicit platform=public_opinion.',
  },
  location: {
    type: 'string', minLength: 1, maxLength: 160,
    description: 'Exact normalized location-label filter. Valid only with explicit platform=public_opinion.',
  },
  from: {
    type: 'string', format: 'date-time',
    description: 'Inclusive lower bound. Formal rows use eventTime; explicitly requested candidates use eventTime or collectedAt when eventTime is absent.',
  },
  to: {
    type: 'string', format: 'date-time',
    description: 'Inclusive upper bound. It must not be earlier than from.',
  },
}

const publicOpinionSearchFilterProperties = {
  includeCandidates: {
    oneOf: [
      { type: 'boolean', const: false },
      { type: 'string', enum: ['qualified', 'all'] },
    ],
  },
  minQualityScore: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
  province: { type: ['string', 'null'] },
  countryCode: { type: ['string', 'null'] },
  location: { type: ['string', 'null'] },
  from: { type: ['string', 'null'], format: 'date-time' },
  to: { type: ['string', 'null'], format: 'date-time' },
}

const idempotencyParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description: 'The key is global within one consumer. Reuse it only when retrying the exact same path and normalized body; a new path, body or page requires a new key.',
  schema: {
    type: 'string',
    minLength: 8,
    maxLength: 128,
    pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$',
  },
}

const nightAllCompatibilityIdempotencyParameter = {
  ...idempotencyParameter,
  description: 'Permanently names one immutable paid dispatch for this exact path and normalized body. Reuse always replays that result; use a new key only when intentionally requesting a new live call.',
}

const externalCommerceIdempotencyParameter = {
  ...idempotencyParameter,
  required: false,
  description: 'Optional but recommended for explicit replay control. Reuse the same key only for a transport retry of the exact same page request. Every next-page request changes the body and must use a new key. When omitted, Hub derives a short-lived freshness-bucket key for the normalized request.',
}

const searchResponse = {
  description: 'Stable data-search response.',
  headers: {
    'x-mx-insight-request-id': {
      description: 'Durable request identifier for status lookup.',
      schema: { type: 'string', format: 'uuid' },
    },
    'idempotent-replay': {
      description: 'Whether the stored result of the same idempotent request was returned.',
      schema: { type: 'string', enum: ['true', 'false'] },
    },
  },
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/SearchEnvelope' },
    },
  },
}

const externalCommerceProductSearchResponse = {
  description: 'Provider-neutral product results plus explicit Hub freshness metadata.',
  headers: {
    'x-mx-insight-request-id': {
      description: 'Durable Hub request identifier.',
      schema: { type: 'string', format: 'uuid' },
    },
    'idempotent-replay': {
      description: 'Whether this body is the committed result for the same caller-supplied idempotency key.',
      schema: { type: 'string', enum: ['true', 'false'] },
    },
    'x-mx-insight-source-mode': {
      description: 'How Hub satisfied this request.',
      schema: {
        type: 'string',
        enum: ['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay'],
      },
    },
    'x-mx-insight-captured-at': {
      description: 'When the delivered external-data snapshot was captured.',
      schema: { type: 'string', format: 'date-time' },
    },
    Age: {
      description: 'Whole seconds between capture and delivery.',
      schema: { type: 'integer', minimum: 0 },
    },
    Warning: {
      description: 'HTTP Warning 110 is present when sourceMode is stored_fallback.',
      schema: { type: 'string' },
    },
  },
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ExternalCommerceProductSearchEnvelope' },
    },
  },
}

const nightAllCompatibilityResponse = {
  description: 'Night-All legacy envelope. The response body and any stale snapshot retain the upstream data fields unchanged.',
  headers: {
    'x-mx-insight-request-id': {
      description: 'Durable Hub request identifier for status lookup.',
      schema: { type: 'string', format: 'uuid' },
    },
    'x-mx-insight-source-mode': {
      description: 'live for the current Night-All result; stale for an exact last-good Hub snapshot.',
      schema: { type: 'string', enum: ['live', 'stale'] },
    },
    'x-mx-insight-captured-at': {
      description: 'When the delivered Night-All response was captured.',
      schema: { type: 'string', format: 'date-time' },
    },
    Age: {
      description: 'Age of the delivered snapshot in seconds.',
      schema: { type: 'integer', minimum: 0 },
    },
    Warning: {
      description: 'Present as HTTP Warning 110 when source mode is stale.',
      schema: { type: 'string' },
    },
    'idempotent-replay': {
      schema: { type: 'string', enum: ['true', 'false'] },
    },
  },
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/NightAllLegacyEnvelope' },
    },
  },
}

const storedSearchResponse = {
  description: 'Hub canonical stored-search response.',
  headers: searchResponse.headers,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/StoredSearchEnvelope' },
    },
  },
}

const canonicalSearchResponse = {
  description: 'Source-independent search across the caller\'s granted Hub canonical corpus.',
  headers: searchResponse.headers,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/CanonicalSearchEnvelope' },
    },
  },
}

const canonicalContextResponse = {
  description: 'Nearest stored messages around one canonical Telegram message.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/CanonicalContextEnvelope' },
    },
  },
}

const canonicalTimelineResponse = {
  description: 'One ascending initial or directional page from a stored Telegram message timeline.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/CanonicalTimelineEnvelope' },
    },
  },
}

const publicOpinionPageResponse = {
  description: 'A customer-safe page of canonical public-opinion items for one normalized province.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/PublicOpinionPageEnvelope' },
    },
  },
}

const publicOpinionItemResponse = {
  description: 'One customer-safe canonical public-opinion item.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/PublicOpinionItemEnvelope' },
    },
  },
}

const publicOpinionCoverageResponse = {
  description: 'Customer-safe province coverage for one explicit time window.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/PublicOpinionCoverageEnvelope' },
    },
  },
}

const publicOpinionRegionsResponse = {
  description: 'The stable P1 province-level public-opinion region catalog.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/PublicOpinionRegionsEnvelope' },
    },
  },
}

const publicOpinionRegionFeedResponse = {
  description: 'A customer-safe page of current canonical public-opinion items without quality filtering.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/PublicOpinionRegionFeedEnvelope' },
    },
  },
}

const mobileCommercePageResponse = {
  description: 'A customer-safe stored page of mobile-commerce captures.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/MobileCommercePageEnvelope' },
    },
  },
}

const virtualSupermarketMetadataResponse = {
  description: 'Customer-safe semantic storefront metadata for all three render modes.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/VirtualSupermarketMetadataEnvelope' },
    },
  },
}

const virtualSupermarketPageResponse = {
  description: 'One on-shelf-only page from a single virtual-supermarket storefront revision.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/VirtualSupermarketPageEnvelope' },
    },
  },
}

const virtualSupermarketDetailResponse = {
  description: 'One on-shelf customer-safe virtual-supermarket product.',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/VirtualSupermarketDetailEnvelope' },
    },
  },
}

export const PUBLIC_OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'MX Insight Hub Open API',
    version: '1.0.0',
    description: [
      'Consumer-facing data and tool access only. All endpoints require an issued API key and enforce the consumer\'s explicit platform or capability grants, policy and usage quota.',
      'The three explicitly named Night-All compatibility routes retain the current upstream legacy data envelope; other public routes do not expose raw source rows or management coordinates.',
    ].join('\n\n'),
  },
  servers: [{ url: '/api/v1', description: 'Same-origin public API' }],
  tags: [
    { name: 'Discovery', description: 'Discover the caller\'s granted platform capabilities.' },
    { name: 'Source Catalog', description: 'Reconstruct the active governed source catalog, filters, taxonomy, owners and status summary.' },
    { name: 'Mobile Commerce', description: 'Read stored mobile-collector commerce captures and their governed source-catalog classification.' },
    { name: 'Virtual Supermarket', description: 'Reconstruct the on-shelf Hub storefront using semantic department, aisle, shelf and position data.' },
    { name: 'External Data', description: 'Call governed external data platforms through provider-neutral Hub contracts.' },
    { name: 'Search', description: 'Idempotent content search.' },
    { name: 'Compatibility', description: 'Temporary Night-All legacy routes with durable Hub evidence and exact last-good fallback.' },
    { name: 'Tools', description: 'Granted platform-independent processing capabilities.' },
    {
      name: 'Telegram',
      description: 'Hub-stored Telegram history, search and entities. Every consumer granted telegram reads the same complete canonical corpus; tenant-specific row subsets are not implemented.',
    },
    {
      name: 'Public Opinion',
      description: 'Hub-stored province and nationwide public-opinion feeds plus customer-safe item details. All surfaces require the public_opinion platform grant; the all-ingested region feed additionally requires public_opinion.all_ingested.read.',
    },
    { name: 'Evidence', description: 'Request outcome and usage evidence for the current consumer.' },
  ],
  security: [{ bearerKey: [] }, { apiKeyHeader: [] }],
  paths: {
    '/data/capabilities': {
      get: {
        tags: ['Discovery'],
        operationId: 'listPublicCapabilities',
        summary: 'List capabilities granted to the authenticated consumer',
        description: 'Use this response to decide which platform operations and generic capabilities the current API key may call. data.platforms describes granted Hub data surfaces. Telegram bounded message context and bidirectional live-keyset timeline are advertised per dataset under platform.context and platform.timeline; their ready flags are index-serving gates independent from the broader Telegram platform ready flag. For public_opinion, ready requires both an active fixed ingest source and both valid Hub serving indexes; it is not another grant or a freshness guarantee, and a paused source may still have indexed rows. The independent data.legacySearch value is the Hub-pinned, grant-filtered dispatch matrix for the three Night-All compatibility operations: it is compiled into the deployed Hub contract rather than discovered from Night-All at request time. A platform must appear in both supportedPlatforms and readyPlatforms before dispatch. In this pinned contract, readyPlatforms means Hub dispatch eligibility; it does not prove current Night-All handler, endpoint, provider, credential, or upstream health. legacySearch is null when the consumer has no granted platform eligible for Night-All compatibility; compatibility calls then fail closed.',
        responses: {
          200: {
            description: 'Granted public capabilities.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CapabilitiesEnvelope' },
                example: {
                  data: {
                    platforms: [
                      {
                        platform: 'telegram',
                        ready: true,
                        capabilities: ['monitor_chats', 'monitor_messages', 'sqlite_chats', 'sqlite_messages', 'multi_source_conversations', 'conversation_filter', 'stored_search', 'entity_search', 'message_context', 'message_timeline'],
                        source: 'hub',
                        servingMode: 'stored',
                        context: {
                          contractVersion: 'mx-insight-hub.canonical-context.v1',
                          ready: true,
                          defaultBefore: 10,
                          defaultAfter: 10,
                          maxBefore: 50,
                          maxAfter: 50,
                          datasets: [
                            {
                              datasetId: 'telegram.monitor.messages.v1',
                              objectType: 'message',
                              streamType: 'chat',
                              ordering: ['eventTime', 'canonicalId'],
                              upstreamCompleteness: { status: 'unknown', basis: null, through: null },
                            },
                            {
                              datasetId: 'telegram.sqlite.messages.v1',
                              objectType: 'message',
                              streamType: 'chat',
                              ordering: ['eventTime', 'canonicalId'],
                              upstreamCompleteness: { status: 'bounded', basis: 'append_only_overlap', through: null },
                            },
                          ],
                        },
                        timeline: {
                          contractVersion: 'mx-insight-hub.canonical-timeline.v1',
                          ready: true,
                          consistency: 'live-keyset',
                          defaultBefore: 10,
                          defaultAfter: 10,
                          maxBefore: 50,
                          maxAfter: 50,
                          cursor: { opaque: true, directions: ['older', 'newer'], newerPolling: true },
                          datasets: [
                            {
                              datasetId: 'telegram.monitor.messages.v1',
                              objectType: 'message',
                              streamType: 'chat',
                              ordering: ['eventTime', 'canonicalId'],
                              upstreamCompleteness: { status: 'unknown', basis: null, through: null },
                            },
                            {
                              datasetId: 'telegram.sqlite.messages.v1',
                              objectType: 'message',
                              streamType: 'chat',
                              ordering: ['eventTime', 'canonicalId'],
                              upstreamCompleteness: { status: 'bounded', basis: 'append_only_overlap', through: null },
                            },
                          ],
                        },
                      },
                      {
                        platform: 'public_opinion',
                        ready: true,
                        capabilities: [
                          'province_feed',
                          'province_coverage',
                          'region_catalog',
                          'region_feed',
                          'item_detail',
                          'stored_search',
                          'diagnostics',
                        ],
                        source: 'hub',
                        servingMode: 'stored',
                      },
                      {
                        platform: 'source_catalog',
                        ready: true,
                        capabilities: ['catalog_entries', 'catalog_metadata', 'catalog_detail', 'filtered_browse'],
                        source: 'hub',
                        servingMode: 'stored',
                      },
                      {
                        platform: 'virtual_supermarket',
                        ready: true,
                        capabilities: [
                          'metadata', 'products', 'product_detail', 'stored_search',
                          'category_filter', 'department_filter', 'aisle_filter',
                          'shelf_filter', 'marketplace_filter',
                        ],
                        source: 'hub',
                        servingMode: 'stored',
                      },
                      {
                        platform: 'ecommerce',
                        ready: true,
                        capabilities: ['product_search'],
                        source: 'hub',
                        servingMode: 'live_with_stored_fallback',
                        contractVersion: 'mx-insight-hub.ecommerce-products.v1',
                        marketplaces: ['taobao', 'tmall', 'jd', 'xiaohongshu_ec', 'xianyu'],
                        pagination: 'opaque_cursor',
                        idempotencyKey: 'optional',
                        freshnessModes: ['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay'],
                      },
                      { platform: 'xiaohongshu', ready: true },
                      { platform: 'twitter', ready: true },
                    ],
                    legacySearch: {
                      contractVersion: 'night-all.legacy-search-capabilities.v1',
                      operations: {
                        raw: {
                          supportedPlatforms: ['twitter', 'xiaohongshu'],
                          readyPlatforms: ['twitter', 'xiaohongshu'],
                        },
                        crawl: {
                          supportedPlatforms: ['twitter', 'xiaohongshu'],
                          readyPlatforms: ['twitter', 'xiaohongshu'],
                        },
                        'user-info': {
                          supportedPlatforms: ['twitter', 'xiaohongshu'],
                          readyPlatforms: ['twitter', 'xiaohongshu'],
                        },
                      },
                    },
                    capabilities: [
                      { capability: 'nlp.tokenize', ready: true },
                      { capability: 'public_opinion.all_ingested.read', ready: true },
                      { capability: 'public_opinion.diagnostics.read', ready: true },
                    ],
                  },
                  requestId: '00000000-0000-4000-8000-000000000001',
                },
              },
            },
          },
          401: errorResponse,
        },
      },
    },
    '/data/ecommerce/products/search': {
      post: {
        tags: ['External Data'],
        operationId: 'searchExternalCommerceProducts',
        summary: 'Search marketplace products through the governed external data gateway',
        description: 'Requires the ecommerce platform grant. The strict body accepts only marketplace, query, page, cursor, sort and price; pageSize and routing fields are not part of this contract. page and cursor are mutually exclusive. Prefer the opaque nextCursor returned by Hub, keep marketplace/query/sort/price unchanged, and use a new Idempotency-Key for every next page. Hub may satisfy an exact request from a fresh snapshot or an exact last-good fallback, but never labels a stored result as live. No external platform identity, credential, endpoint or raw response is exposed.',
        'x-mx-error-codes': {
          400: [
            'invalid_request', 'invalid_marketplace', 'unsupported_marketplace',
            'invalid_query', 'invalid_page', 'invalid_cursor', 'invalid_pagination',
            'cursor_scope_mismatch', 'continuation_required', 'unsupported_sort',
            'invalid_price', 'unsupported_price_filter', 'unsupported_request_field',
            'invalid_idempotency_key',
          ],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted'],
          409: [
            'request_in_progress', 'idempotency_conflict', 'request_outcome_unknown',
            'external_platform_response_unusable',
          ],
          413: ['payload_too_large'],
          429: ['quota_exceeded', 'external_platform_busy', 'external_platform_capacity_exceeded'],
          502: [
            'external_platform_response_unusable', 'external_platform_outcome_unknown',
            'external_platform_rejected',
          ],
          503: [
            'external_platform_unavailable', 'external_platform_not_configured',
            'external_platform_circuit_open', 'external_platform_capacity_unavailable',
          ],
        },
        parameters: [externalCommerceIdempotencyParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ExternalCommerceProductSearchRequest' },
              examples: {
                firstPage: {
                  summary: 'First page',
                  value: { marketplace: 'jd', query: 'AI recorder' },
                },
                continuation: {
                  summary: 'Continuation with the opaque Hub cursor',
                  value: { marketplace: 'jd', query: 'AI recorder', cursor: 'opaque-next-cursor' },
                },
              },
            },
          },
        },
        responses: {
          200: externalCommerceProductSearchResponse,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          409: errorResponse,
          413: errorResponse,
          429: errorResponse,
          502: errorResponse,
          503: errorResponse,
        },
      },
    },
    '/data/search': {
      post: {
        tags: ['Search'],
        operationId: 'searchData',
        summary: 'Search one explicitly selected platform',
        description: 'One request targets one granted platform. For platform=telegram, Hub searches canonical stored messages. public_opinion is Hub-local and is deliberately rejected by this Night-All-oriented compatibility route; use the province feed, /data/stored/search or /data/canonical/search. Each page uses its own idempotency key; replay the same body with the same key.',
        'x-mx-error-codes': {
          400: ['invalid_request', 'invalid_cursor', 'page_size_exceeded', 'unsupported_fields', 'unsupported_match_mode', 'idempotency_key_required', 'invalid_idempotency_key', 'platform_operation_unsupported'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted'],
          409: ['request_in_progress', 'idempotency_conflict', 'request_outcome_unknown'],
          410: ['search_cursor_expired'],
          429: ['quota_exceeded'],
          502: ['night_all_rejected', 'upstream_outcome_unknown'],
          503: ['stored_search_unavailable', 'search_cursor_unavailable'],
        },
        parameters: [idempotencyParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SearchRequest' },
              examples: {
                telegram: {
                  summary: 'Telegram stored search',
                  value: { platform: 'telegram', query: 'AI Agent', pageSize: 20 },
                },
                platform: {
                  summary: 'Another granted platform',
                  value: { platform: 'xiaohongshu', query: 'AI Agent', pageSize: 20 },
                },
              },
            },
          },
        },
        responses: { 200: searchResponse, ...publicErrors },
      },
    },
    '/night-all/search/{operation}': {
      post: {
        tags: ['Compatibility'],
        operationId: 'searchNightAllCompatibility',
        summary: 'Call one of the three Night-All legacy search operations',
        description: 'The Hub authenticates and authorizes the platform, then checks the Hub-pinned, grant-filtered data.legacySearch dispatch matrix returned by GET /data/capabilities. The selected platform must appear in both supportedPlatforms and readyPlatforms; a data.platforms entry alone, including telegram, does not grant a legacy operation. The matrix is owned by the deployed Hub release and is not fetched from Night-All at request time. readyPlatforms means Hub permits dispatch under that pinned contract; it does not prove current Night-All handler, endpoint, provider, credential, or upstream health. A null or invalid matrix fails closed before dispatch. The Hub injects its consumer businessId, records the attempt, and stores complete responses as exact last-good snapshots. Network/timeout ambiguity, an unusable HTTP 2xx content-type/JSON/envelope, or a real non-2xx HTTP 502/503/504 may return that exact snapshot. An unusable 2xx is outcome-unknown because paid work may already have happened. The response body retains Night-All data fields unchanged. Provider/token/credential/endpoint/capability/moduleCode routing controls and archive/fullArchive/allTweets/archiveLimit/totalCount/max*Pages/pageCount/chunkSize/budget/crawlDepth cost-amplification controls are rejected; they require a separately granted capability and server policy. Work-budget arithmetic bounds returned/processed item work, not Night-All provider calls or billing.',
        'x-mx-error-codes': {
          400: ['invalid_request', 'invalid_cursor', 'invalid_platform', 'page_size_exceeded', 'work_budget_exceeded', 'unsupported_fields', 'business_id_mismatch', 'idempotency_key_required', 'invalid_idempotency_key', 'platform_operation_unsupported', 'night_all_rejected'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted'],
          404: ['not_found', 'night_all_rejected'],
          409: ['request_in_progress', 'idempotency_conflict', 'request_outcome_unknown', 'night_all_rejected'],
          422: ['night_all_rejected'],
          429: ['quota_exceeded', 'night_all_rejected'],
          502: ['night_all_rejected', 'upstream_outcome_unknown'],
          503: ['platform_operation_unavailable', 'compatibility_capabilities_unavailable', 'compatibility_store_unavailable'],
        },
        parameters: [
          {
            name: 'operation', in: 'path', required: true,
            schema: { type: 'string', enum: ['raw', 'crawl', 'user-info'] },
          },
          nightAllCompatibilityIdempotencyParameter,
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/NightAllLegacyRequest' },
              examples: {
                raw: { value: { platform: 'xiaohongshu', keyword: 'AI Agent', count: 20 } },
                crawl: { value: { platform: 'twitter', username: 'openai', count: 20 } },
                userInfo: { value: { platform: 'twitter', username: 'openai' } },
              },
            },
          },
        },
        responses: { 200: nightAllCompatibilityResponse, ...publicErrors, 422: errorResponse },
      },
    },
    '/data/stored/search': {
      post: {
        tags: ['Search'],
        operationId: 'searchStoredData',
        summary: 'Search Hub canonical data without calling an upstream provider',
        description: 'Requires the explicit platform grant. datasetId and objectType are exact filters, not separate authorization grants: every consumer granted a platform can search the complete Hub canonical corpus for that platform. For platform=public_opinion the default is formal-only. Candidate and exact geography/time controls are accepted only with explicit platform=public_opinion; includeCandidates=all requires from, to and at least one of province, countryCode or location. Other platforms are unaffected. Explicit candidate responses expose only bounded Hub quality/location metadata and omit candidate author/contentType and upstream source identity. Elasticsearch is preferred and transport failure falls back to PostgreSQL. Physical databases, indices and query DSL are not accepted. The publication-visibility contract is part of the idempotency fingerprint; after upgrading to this contract, use a new Idempotency-Key instead of reusing a pre-upgrade key.',
        parameters: [idempotencyParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/StoredSearchRequest' },
              example: {
                platform: 'xiaohongshu',
                query: 'AI Agent',
                datasetId: 'night-all.search.v1',
                objectType: 'post',
                pageSize: 20,
              },
            },
          },
        },
        responses: { 200: storedSearchResponse, ...publicErrors },
      },
    },
    '/data/canonical/search': {
      post: {
        tags: ['Search'],
        operationId: 'searchCanonicalData',
        summary: 'Search all authorized Hub canonical datasets in one ranked result set',
        description: 'Searches the shared Hub canonical current-state projection once; it does not fan out to source APIs. Omitting platform searches all platforms currently granted to the consumer. In a mixed-platform result, only the public_opinion branch is formal-only by default; every other platform is unchanged. Candidate and exact geography/time controls require explicit platform=public_opinion; includeCandidates=all requires from, to and at least one of province, countryCode or location. Explicit candidate responses expose only bounded Hub quality/location metadata and omit candidate author/contentType and upstream source identity. platform, datasetId and objectType only narrow the authorized scope. searchProfile selects a versioned, server-owned query policy; callers cannot supply analyzers or Elasticsearch DSL. Balanced search uses HanLP/pre-segmented AND only while query segmentation is healthy; degraded Jieba/bigram terms switch the applied profile to raw phrase. The signed cursor is bound to the sorted platform-grant scope, query, filters, page size, resolved search profile and first-page analysis state so later pages do not re-segment. The independent canonical-search usage bucket always uses the strictest limits across the consumer\'s complete current grant set. Elasticsearch is preferred and PostgreSQL is the explicit degradation path. The publication-visibility contract is part of the idempotency fingerprint whenever the authorized scope can include public_opinion; after upgrading to this contract, use a new Idempotency-Key instead of reusing a pre-upgrade key.',
        parameters: [idempotencyParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CanonicalSearchRequest' },
              examples: {
                telegramAllSources: {
                  summary: 'Telegram monitor and SQLite-import datasets together',
                  value: { platform: 'telegram', query: 'AI Agent', objectType: 'message', searchProfile: DEFAULT_SEARCH_PROFILE, pageSize: 20 },
                },
                allGrantedPlatforms: {
                  summary: 'All platforms granted to this consumer',
                  value: { query: 'AI Agent', pageSize: 20 },
                },
              },
            },
          },
        },
        responses: { 200: canonicalSearchResponse, ...publicErrors },
      },
    },
    '/data/canonical/items/{id}/context': {
      get: {
        tags: ['Search', 'Telegram'],
        operationId: 'getCanonicalMessageContext',
        summary: 'Read the nearest stored messages around one canonical search hit',
        description: 'Requires the telegram platform grant. The anchor id is the Hub canonical UUID returned by canonical search. Context never crosses dataset, platform, object type or normalized chat id. Rows are ordered by the declared total order (eventTime, canonicalId), not by inferred Telegram sequence. before and after default to 10 and are independently capped at 50. storedWindow describes only active records currently stored in Hub; upstreamCompleteness is a separate declared source-capture statement, may be upgraded only from persisted evidence, and must not be inferred from storedWindow, source activity or cursor state. Only datasets explicitly advertised by the Telegram context capability are supported. Raw rows, extensions, source credentials and lineage remain private. This safe GET is metered on every call and retry.',
        'x-mx-error-codes': {
          400: ['invalid_request', 'unsupported_fields'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted'],
          404: ['item_not_found'],
          409: ['context_not_supported'],
          429: ['quota_exceeded'],
          503: ['stored_data_unavailable', 'serving_indexes_unavailable'],
        },
        parameters: [
          {
            name: 'id', in: 'path', required: true,
            description: 'Hub canonical message UUID returned by a search result.',
            schema: { type: 'string', format: 'uuid' },
          },
          {
            name: 'before', in: 'query', required: false,
            description: 'Number of nearest stored messages before the anchor.',
            schema: { type: 'integer', minimum: 0, maximum: 50, default: 10 },
          },
          {
            name: 'after', in: 'query', required: false,
            description: 'Number of nearest stored messages after the anchor.',
            schema: { type: 'integer', minimum: 0, maximum: 50, default: 10 },
          },
        ],
        responses: { 200: canonicalContextResponse, ...canonicalContextErrors },
      },
    },
    '/data/canonical/items/{id}/timeline': {
      get: {
        tags: ['Search', 'Telegram'],
        operationId: 'getCanonicalMessageTimeline',
        summary: 'Read and continue a bidirectional stored-message timeline',
        description: 'Requires the telegram platform grant. On the initial call, omit cursor and request independent before and after windows; each defaults to 10, accepts 0..50 and is also constrained by the grant page-size limit. Zero suppresses that side on the initial page; any returned continuation cursor for a zero-sized side uses the default page size constrained by the current grant limit. A continuation call sends only one opaque cursor returned in pageInfo.older.cursor or pageInfo.newer.cursor and must omit before and after. Direction is signed inside the timeline cursor; search, history and timeline cursors are not interchangeable. Every page is ordered ascending by (eventTime, canonicalId); eventTime preserves the exact six-digit UTC microsecond value used by ordering and cursor boundaries. The cursor remains bound to the original anchor, dataset, normalized chat stream, page size, authorization scope and contract version, and never crosses Monitor/SQLite datasets or chats. The implementation uses live keyset consistency rather than a frozen snapshot: concurrent writes, late arrivals and deletes can affect boundary-external rows not yet read. pageInfo hasMore describes only active messages currently stored in Hub, not upstream completeness. The route never invokes Telegram or another upstream collector and does not provide a changes feed. Current support is limited to the two datasets advertised by the Telegram timeline capability. Raw rows, extensions, source credentials and internal lineage remain private. This safe GET is metered on every call and retry.',
        'x-mx-allowed-query-fields': ['before', 'after', 'cursor'],
        'x-mx-error-codes': {
          400: ['invalid_request', 'invalid_cursor', 'page_size_exceeded', 'unsupported_fields'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted'],
          404: ['item_not_found'],
          409: ['context_not_supported'],
          429: ['quota_exceeded'],
          503: ['stored_data_unavailable', 'serving_indexes_unavailable'],
        },
        parameters: [
          {
            name: 'id', in: 'path', required: true,
            description: 'Original Hub canonical message UUID. It remains path-bound on continuation calls.',
            schema: { type: 'string', format: 'uuid' },
          },
          {
            name: 'before', in: 'query', required: false,
            description: 'Initial call only: nearest stored messages before the anchor. Defaults to 10; 0..50 and the grant page-size limit apply. Zero omits older rows from the initial page; a returned older cursor uses the constrained default page size.',
            schema: { type: 'integer', minimum: 0, maximum: 50, default: 10 },
          },
          {
            name: 'after', in: 'query', required: false,
            description: 'Initial call only: nearest stored messages after the anchor. Defaults to 10; 0..50 and the grant page-size limit apply. Zero omits newer rows from the initial page; the pollable newer cursor uses the constrained default page size.',
            schema: { type: 'integer', minimum: 0, maximum: 50, default: 10 },
          },
          {
            name: 'cursor', in: 'query', required: false,
            description: 'Continuation call only: return exactly one opaque timeline cursor unchanged. It embeds older/newer direction and cannot be combined with before or after.',
            schema: { type: 'string', minLength: 1, maxLength: 2048 },
          },
        ],
        responses: { 200: canonicalTimelineResponse, ...canonicalContextErrors },
      },
    },
    '/data/mobile-commerce/items': {
      get: {
        tags: ['Mobile Commerce'],
        operationId: 'listMobileCommerceItems',
        summary: 'List stored mobile-commerce captures',
        description: 'Requires the mobile_commerce platform grant. Reads only committed Hub canonical data and never invokes a marketplace or mobile collector. Every ingested row follows the normal canonical outbox and Elasticsearch projection path, so canonical search can query the same dataset. The top-level authorization platform is mobile_commerce; the real marketplace is a governed source-catalog facet. id identifies a capture row, goodsId is optional product identity, collectedAt is Asia/Shanghai-normalized collection time, and share payloads remain text rather than verified URLs. Raw rows, arbitrary metadata, device/report fields, credentials and operational lineage are excluded. refresh currently accepts only stored; future acquisition will be an asynchronous command executed by an external mobile-collector machine, with Hub limited to trigger/status/data APIs.',
        'x-mx-allowed-query-fields': mobileCommerceQueryParameters.map(({ name }) => name),
        'x-mx-error-codes': {
          400: ['invalid_request', 'invalid_cursor', 'page_size_exceeded', 'unsupported_fields'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted'],
          409: ['remote_fetch_unavailable'],
          429: ['quota_exceeded'],
          503: ['stored_data_unavailable'],
        },
        parameters: mobileCommerceQueryParameters,
        responses: { 200: mobileCommercePageResponse, ...publicErrors },
      },
    },
    '/data/virtual-supermarket/metadata': {
      get: {
        tags: ['Virtual Supermarket'],
        operationId: 'getVirtualSupermarketMetadata',
        summary: 'Read the semantic virtual-supermarket storefront model',
        description: 'Requires the independent virtual_supermarket platform grant. Returns the same ordered department, aisle, shelf and category semantics used by guided browse, panorama and catalog modes. Panorama is a client renderer; this response never exposes WebGL coordinates, camera, mesh, material, lighting or other renderer state. storefrontRevision identifies the complete current publication surface. The response does not expose capture rows, task/run data, source connections, management state or credentials.',
        'x-mx-allowed-query-fields': [],
        'x-mx-error-codes': {
          400: ['unsupported_fields'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted'],
          429: ['quota_exceeded'],
          503: ['stored_data_unavailable'],
        },
        parameters: [],
        responses: { 200: virtualSupermarketMetadataResponse, ...publicErrors },
      },
    },
    '/data/virtual-supermarket/products': {
      get: {
        tags: ['Virtual Supermarket'],
        operationId: 'listVirtualSupermarketProducts',
        summary: 'Browse on-shelf virtual-supermarket products',
        description: 'Requires the independent virtual_supermarket platform grant. Returns only explicitly published on-shelf Hub publication overlays with independent publication UUIDs; capture/canonical row IDs are never exposed or accepted as product IDs. unpublishing never deletes the referenced canonical capture. placement contains semantic department/aisle/shelf/position values rather than renderer coordinates. sort defaults to newest; v1 has no server-side merchandising sort. The signed cursor is bound to all filters, sort, pageSize and storefrontRevision. A revision change returns storefront_revision_changed instead of silently combining snapshots. Raw captures, task/run/campaign data, share payloads, arbitrary metadata, device/report fields, management actors and physical storage/search controls are excluded.',
        'x-mx-allowed-query-fields': virtualSupermarketQueryParameters.map(({ name }) => name),
        'x-mx-error-codes': {
          400: ['invalid_request', 'invalid_cursor', 'page_size_exceeded', 'unsupported_fields'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted'],
          409: ['storefront_revision_changed'],
          429: ['quota_exceeded'],
          503: ['stored_data_unavailable'],
        },
        parameters: virtualSupermarketQueryParameters,
        responses: { 200: virtualSupermarketPageResponse, ...publicErrors },
      },
    },
    '/data/virtual-supermarket/products/{id}': {
      get: {
        tags: ['Virtual Supermarket'],
        operationId: 'getVirtualSupermarketProduct',
        summary: 'Read one on-shelf virtual-supermarket product',
        description: 'Requires the independent virtual_supermarket platform grant. The path UUID is the independent Hub publication UUID returned by product list or search, never a mobile-commerce capture/canonical row ID. Unknown, off-shelf and archived publications all return the same not-found error and do not reveal internal state. The response uses the same customer-safe product allowlist as list/search and includes the current storefrontRevision.',
        'x-mx-allowed-query-fields': [],
        'x-mx-error-codes': {
          400: ['invalid_request', 'unsupported_fields'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted'],
          404: ['virtual_supermarket_product_not_found'],
          429: ['quota_exceeded'],
          503: ['stored_data_unavailable'],
        },
        parameters: [{
          name: 'id', in: 'path', required: true,
          description: 'Exact Hub publication UUID returned by product browse or search.',
          schema: { type: 'string', format: 'uuid' },
        }],
        responses: { 200: virtualSupermarketDetailResponse, ...publicErrors },
      },
    },
    '/data/virtual-supermarket/search': {
      get: {
        tags: ['Virtual Supermarket'],
        operationId: 'searchVirtualSupermarketProducts',
        summary: 'Search on-shelf virtual-supermarket products',
        description: 'Requires the independent virtual_supermarket platform grant and a non-blank query. Returns the same on-shelf product projection and cursor/revision semantics as browse. The caller cannot select an Elasticsearch index, field, analyzer, DSL, script or boost. Every GET and retry is separately metered.',
        'x-mx-allowed-query-fields': virtualSupermarketQueryParameters.map(({ name }) => name),
        'x-mx-error-codes': {
          400: ['invalid_request', 'invalid_cursor', 'page_size_exceeded', 'unsupported_fields'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted'],
          409: ['storefront_revision_changed'],
          429: ['quota_exceeded'],
          503: ['stored_data_unavailable'],
        },
        parameters: virtualSupermarketQueryParameters.map((parameter) => (
          parameter.name === 'query' ? { ...parameter, required: true } : parameter
        )),
        responses: { 200: virtualSupermarketPageResponse, ...publicErrors },
      },
    },
    '/data/source-catalog': {
      get: {
        tags: ['Source Catalog'],
        operationId: 'listSourceCatalogEntries',
        summary: 'List active governed source-catalog entries',
        description: 'Requires the source_catalog platform grant. Returns the complete customer-safe business projection needed to rebuild the Hub catalog table and its status filters. Ordinary governed notes remain available, but high-confidence credentials, credentialed URLs, DSNs, private-network connection coordinates, API keys and tokens accidentally pasted into any free-text field are removed; redactedFields reports the affected field names. Search and facets operate only on this redacted projection. Archived entries and evidence, custom fields, import provenance, events, related-data coordinates, login bindings, connection details and credentials are not returned. Results use the stable (legacySequence NULLS LAST, canonicalName, id) order. The HMAC-signed keyset cursor is bound to every normalized filter and pageSize; changing any one of them requires restarting from the first page. This safe GET is metered on every call and retry.',
        'x-mx-error-codes': {
          400: ['invalid_request', 'invalid_cursor', 'page_size_exceeded', 'unsupported_fields'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted'],
          429: ['quota_exceeded'],
          503: ['stored_data_unavailable'],
        },
        'x-mx-allowed-query-fields': [
          'query', 'sourceKind', 'majorCategory', 'scenario', 'region',
          'coverageStatus', 'deliveryStatus', 'reviewStatus', 'runtimeStatus', 'priority',
          'ownerId', 'tag', 'pageSize', 'cursor',
        ],
        parameters: sourceCatalogQueryParameters,
        responses: {
          200: {
            description: 'One filtered page from the active source catalog.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SourceCatalogPageEnvelope' } } },
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
    },
    '/data/source-catalog/{id}': {
      get: {
        tags: ['Source Catalog'],
        operationId: 'getSourceCatalogEntry',
        summary: 'Read one active governed source-catalog entry',
        description: 'Requires the source_catalog platform grant. Returns the same customer-safe SourceCatalogEntry projection used by the list, selected by an exact UUID obtained from that list. Archived or unknown entries are not exposed. This route accepts no query fields and every call or retry is separately metered.',
        'x-mx-allowed-query-fields': [],
        'x-mx-error-codes': {
          400: ['invalid_source_catalog_id', 'unsupported_fields'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted'],
          404: ['source_catalog_entry_not_found'],
          429: ['quota_exceeded'],
          503: ['stored_data_unavailable'],
        },
        parameters: [
          {
            name: 'id', in: 'path', required: true,
            description: 'Exact active source-catalog UUID returned by the list route.',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          200: {
            description: 'One active customer-safe source-catalog entry.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SourceCatalogDetailEnvelope' } } },
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
    },
    '/data/source-catalog/{id}/items': {
      get: {
        tags: ['Source Catalog', 'Mobile Commerce'],
        operationId: 'listSourceCatalogItems',
        summary: 'List stored data classified under one source-catalog entry',
        description: 'Requires both source_catalog and mobile_commerce platform grants. The path UUID is the governed classification boundary and is injected into the query; catalogEntryId is therefore not accepted as a query field. P1 dispatches to the mobile-commerce stored data product. It returns the safe active catalog entry plus captures whose reviewed stable marketplace facet references that exact entry. The route does not infer from titles and does not trigger remote acquisition. Future data products may extend this catalog-driven surface under a new contract version.',
        'x-mx-allowed-query-fields': mobileCommerceQueryParameters
          .filter(({ name }) => name !== 'catalogEntryId')
          .map(({ name }) => name),
        parameters: [
          {
            name: 'id', in: 'path', required: true,
            description: 'Exact active source-catalog UUID returned by the list route.',
            schema: { type: 'string', format: 'uuid' },
          },
          ...mobileCommerceQueryParameters.filter(({ name }) => name !== 'catalogEntryId'),
        ],
        responses: {
          200: {
            description: 'One catalog entry and its stored mobile-commerce data page.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SourceCatalogItemsEnvelope' } } },
          },
          ...publicErrors,
        },
      },
    },
    '/data/source-catalog/metadata': {
      get: {
        tags: ['Source Catalog'],
        operationId: 'getSourceCatalogMetadata',
        summary: 'Read source-catalog fields, enums, taxonomy, owners and facets',
        description: 'Requires the source_catalog platform grant. Returns only active taxonomy terms and owners, plus the field model, enumerations, summary and facets needed to reconstruct Hub filters and reporting. The owner projection is independent from login accounts. This route accepts no query fields; any supplied query key returns 400 unsupported_fields. This safe GET is metered on every call and retry.',
        'x-mx-allowed-query-fields': [],
        'x-mx-error-codes': {
          400: ['unsupported_fields'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted'],
          429: ['quota_exceeded'],
          503: ['stored_data_unavailable'],
        },
        responses: {
          200: {
            description: 'Active source-catalog metadata and reporting facets.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SourceCatalogMetadataEnvelope' } } },
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
    },
    '/data/public-opinion/regions': {
      get: {
        tags: ['Public Opinion'],
        operationId: 'listPublicOpinionRegions',
        summary: 'List the stable nationwide province-level region catalog',
        description: 'Requires the public_opinion platform grant. P1 supports parentCode=CN and level=province only, returning all 34 stable province-level regions even when the current corpus has no matching item. The returned exact code is accepted by the P1 region feed. City taxonomy and city selectors are not exposed by this contract. The response contains no corpus counts, raw data or source coordinates.',
        'x-mx-error-codes': {
          400: ['invalid_request', 'invalid_parent_region', 'unsupported_region_level', 'unsupported_fields'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted'],
          429: ['quota_exceeded'],
          503: ['stored_data_unavailable'],
        },
        parameters: publicOpinionRegionCatalogParameters,
        responses: {
          200: publicOpinionRegionsResponse,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
    },
    '/data/public-opinion/regions/{regionCode}/items': {
      get: {
        tags: ['Public Opinion'],
        operationId: 'listPublicOpinionRegionItems',
        summary: 'List nationwide or province current canonical items without quality filtering',
        description: 'Requires both the public_opinion platform grant and the separate, non-default public_opinion.all_ingested.read capability. P1 accepts CN or one exact province code from the region catalog; Chinese aliases and city codes are rejected. visibility must be all_ingested, sort supports latest only, and from/to are required. Effective time is publishedAt when present and otherwise collectedAt; the fallback is used for filtering and ordering without rewriting publishedAt. The nationwide CN scope includes current safe items without an assigned province, while a province scope matches only that province. canonical_current_safe means the current, non-deleted, revision-fenced public projection: it includes formal and candidate items regardless of score, status or geography verification but excludes raw rows, revision history, provider/endpoint identities, credentials, strategy/run ids, quality flags and rejection reasons, model reasoning and internal lineage. Every returned item includes its safe quality summary. Each call and retry is independently metered; no Idempotency-Key is accepted.',
        'x-mx-error-codes': {
          400: ['invalid_region', 'invalid_visibility', 'invalid_sort', 'invalid_request', 'page_size_exceeded', 'invalid_cursor', 'unsupported_fields', 'all_ingested_scope_required'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted', 'capability_not_granted'],
          429: ['quota_exceeded'],
          503: ['stored_data_unavailable', 'serving_indexes_unavailable'],
        },
        parameters: publicOpinionRegionFeedParameters,
        responses: {
          200: publicOpinionRegionFeedResponse,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
    },
    '/data/public-opinion/provinces/{province}/items': {
      get: {
        tags: ['Public Opinion'],
        operationId: 'listProvincePublicOpinionItems',
        summary: 'List hot or latest public-opinion items for one province',
        description: 'Requires the public_opinion platform grant and valid Hub serving indexes. The province path is normalized to a stable ISO 3166-2:CN code. By default includeCandidates=false preserves the existing formal-only response. includeCandidates=qualified adds only candidates already in status=qualified and at or above the effective quality floor; minQualityScore (default 80) is an additional request floor, so setting 0 does not reclassify pending/rejected/failed rows or lower the record qualification threshold. includeCandidates=all is an explicit bounded audit view and requires both from and to; omit minQualityScore to retain unscored candidates. The province path always excludes candidates without that display province. This safe GET reads the Hub canonical PostgreSQL projection and is independently metered on every call and retry. hot excludes records without heatScore and sorts by heatScore, effective sort time and id; latest sorts by effective sort time, collectedAt and id. Effective sort time is publishedAt when present, otherwise collectedAt; this fallback is not exposed as publishedAt. For formal rows, from/to retain the existing publishedAt semantics and exclude an undated row. For candidate rows only, an absent publishedAt uses collectedAt for the bounded window so an explicitly requested audit candidate remains reachable. Both orders use a signed keyset cursor bound to candidate visibility controls. Only the documented customer-safe item allowlist is returned; raw rows, upstream provider identities, strategy/run ids, source coordinates, extensions, model reasoning and lineage remain private.',
        'x-mx-error-codes': {
          400: ['invalid_province', 'invalid_request', 'invalid_sort', 'page_size_exceeded', 'invalid_cursor', 'unsupported_fields', 'candidate_scope_required'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted'],
          429: ['quota_exceeded'],
          503: ['stored_data_unavailable', 'serving_indexes_unavailable'],
        },
        parameters: publicOpinionProvinceParameters,
        responses: {
          200: {
            ...publicOpinionPageResponse,
            content: {
              'application/json': {
                ...publicOpinionPageResponse.content['application/json'],
                example: {
                  data: {
                    contractVersion: 'mx-insight-hub.public-opinion.v1',
                    province: { code: 'CN-JS', name: '江苏' },
                    sort: 'hot',
                    items: [{
                      id: '11111111-1111-4111-8111-111111111111',
                      title: '江苏舆情样例',
                      summary: '公开摘要',
                      url: 'https://example.com/items/11111111',
                      publishedAt: '2026-08-23T03:00:00.000Z',
                      collectedAt: '2026-08-23T03:01:00.000Z',
                      province: { code: 'CN-JS', name: '江苏' },
                      heatScore: 88.5,
                      origin: { name: '江苏新闻广播', type: 'social', platform: 'douyin' },
                    }],
                    pageInfo: { returnedCount: 1, hasMore: false, nextCursor: null },
                  },
                  requestId: '00000000-0000-4000-8000-000000000005',
                },
              },
            },
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
    },
    '/data/public-opinion/province-coverage': {
      get: {
        tags: ['Public Opinion'],
        operationId: 'getPublicOpinionProvinceCoverage',
        summary: 'Compare public-opinion availability across every province',
        description: 'Requires the public_opinion platform grant, valid Hub serving indexes and an explicit from/to window. The default remains formal-only. includeCandidates=qualified adds only candidates already in status=qualified and at or above the effective quality floor; minQualityScore (default 80) is an additional request floor and setting 0 does not reclassify rows. includeCandidates=all includes all candidates, optionally narrowed by an explicit minQualityScore; omit it to retain unscored candidates. Coverage groups only records with a display province, so it cannot inventory unclassified candidates. Formal rows use publishedAt for the window; undated candidates use collectedAt. targetPerProvince defaults to 10 and affects only shortfall/meetsTarget calculations. featuredProvinceCodes contains at most eight provinces ranked by available count and average quality; provinces always contains the full stable province taxonomy. Counts and scores are Hub-owned publication metadata. Upstream raw rows, provider names, endpoint ids, credentials, strategy/run ids, source coordinates, extensions, reasoning and lineage remain private.',
        'x-mx-error-codes': {
          400: ['invalid_request', 'unsupported_fields'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted'],
          429: ['quota_exceeded'],
          503: ['stored_data_unavailable', 'serving_indexes_unavailable'],
        },
        parameters: publicOpinionCoverageParameters,
        responses: {
          200: publicOpinionCoverageResponse,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
    },
    '/data/public-opinion/funnel': {
      get: {
        tags: ['Public Opinion'],
        operationId: 'getPublicOpinionDiagnosticsFunnel',
        summary: 'Explain the public-opinion visibility funnel',
        description: 'Requires both the public_opinion platform grant and the independent public_opinion.diagnostics.read capability. Returns counts for canonical state, publication stage/status, event time, geography, heat and current product visibility in one bounded window. It exposes governed aggregate diagnostics only; raw rows, source connections, extensions and model reasoning remain private. This safe GET uses the capability quota and is metered on every call and retry.',
        'x-mx-error-codes': {
          400: ['invalid_request', 'unsupported_fields'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted', 'capability_not_granted'],
          429: ['quota_exceeded'],
          503: ['stored_data_unavailable'],
        },
        parameters: publicOpinionDiagnosticsWindowParameters,
        responses: {
          200: {
            description: 'Customer-safe public-opinion funnel diagnostics.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PublicOpinionDiagnosticsFunnelEnvelope' } } },
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
    },
    '/data/public-opinion/records': {
      get: {
        tags: ['Public Opinion'],
        operationId: 'listPublicOpinionDiagnosticRecords',
        summary: 'Browse displayed and non-displayed public-opinion records',
        description: 'Requires the public_opinion grant and public_opinion.diagnostics.read. Filters mirror the Hub funnel explorer, including missing ownership, publication, event-time and heat reasons. The response is a bounded customer-safe allowlist. Pagination uses an HMAC-signed keyset cursor bound to the entire normalized filter set and pageSize.',
        'x-mx-error-codes': {
          400: ['invalid_request', 'invalid_cursor', 'page_size_exceeded', 'unsupported_fields'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted', 'capability_not_granted'],
          429: ['quota_exceeded'],
          503: ['stored_data_unavailable'],
        },
        parameters: publicOpinionDiagnosticsRecordParameters,
        responses: {
          200: {
            description: 'A customer-safe page of public-opinion diagnostic records.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PublicOpinionDiagnosticsRecordsEnvelope' } } },
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
    },
    '/data/public-opinion/records/{id}': {
      get: {
        tags: ['Public Opinion'],
        operationId: 'getPublicOpinionDiagnosticRecord',
        summary: 'Read one customer-safe public-opinion diagnostic record',
        description: 'Requires the public_opinion grant and public_opinion.diagnostics.read. Returns the governed projection and all deterministic reasons why the record is or is not displayed in the requested window. Raw payloads, extensions, source connections and model reasoning are excluded.',
        'x-mx-error-codes': {
          400: ['invalid_request', 'unsupported_fields'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted', 'capability_not_granted'],
          404: ['item_not_found'],
          429: ['quota_exceeded'],
          503: ['stored_data_unavailable'],
        },
        parameters: [
          {
            name: 'id', in: 'path', required: true,
            schema: { type: 'string', format: 'uuid' },
          },
          ...publicOpinionDiagnosticsWindowParameters,
        ],
        responses: {
          200: {
            description: 'One customer-safe public-opinion diagnostic record.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PublicOpinionDiagnosticsRecordEnvelope' } } },
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
    },
    '/data/public-opinion/items/{id}': {
      get: {
        tags: ['Public Opinion'],
        operationId: 'getPublicOpinionItem',
        summary: 'Get one customer-safe public-opinion item',
        description: 'Requires the public_opinion platform grant. id is the Hub canonical UUID returned by the province feed or canonical search. By default includeCandidates=false looks only in the formal corpus and preserves the existing response. includeCandidates=qualified may resolve only a candidate already in status=qualified and above the effective quality floor; minQualityScore is an additional request floor, not a reclassification control. includeCandidates=all may resolve any candidate passing its optional score filter; omit minQualityScore to retain unscored candidates. Because the id is exact, this detail route does not require a time window. The lookup remains fixed to Hub-owned public-opinion corpora; deleted, below-threshold or out-of-scope records are returned as item_not_found. This safe GET is independently metered on every call and retry. Only the documented allowlist is returned; upstream raw and operational coordinates remain private.',
        'x-mx-error-codes': {
          400: ['invalid_request', 'unsupported_fields'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted'],
          404: ['item_not_found'],
          429: ['quota_exceeded'],
          503: ['stored_data_unavailable'],
        },
        parameters: [
          {
            name: 'id', in: 'path', required: true,
            description: 'Canonical UUID from a public-opinion list or canonical-search result.',
            schema: { type: 'string', format: 'uuid' },
          },
          ...publicOpinionCandidateParameters,
        ],
        responses: {
          200: publicOpinionItemResponse,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
    },
    '/tools/tokenize': {
      post: {
        tags: ['Tools'],
        operationId: 'tokenizeText',
        summary: 'Tokenize bounded Chinese or mixed-language text',
        description: 'Requires an issued API Key and the nlp.tokenize capability grant. New or never-configured consumers receive it by default; administrators may explicitly disable it. The default is 1000 requests per rolling 3600-second consumer + capability window, shared by all API Keys for that consumer. The response reports the backend actually used and whether fallback degraded the result. Idempotency-Key is required; an exact replay is not segmented or metered twice.',
        parameters: [idempotencyParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/TokenizeRequest' },
              example: { text: '吴恩达与人工智能' },
            },
          },
        },
        responses: {
          200: {
            description: 'Bounded tokens and actual backend metadata.',
            headers: {
              'x-mx-insight-request-id': { schema: { type: 'string', format: 'uuid' } },
              'idempotent-replay': { schema: { type: 'string', enum: ['true', 'false'] } },
            },
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TokenizeEnvelope' },
              },
            },
          },
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          409: errorResponse,
          413: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
    },
    '/data/telegram/chats': {
      get: {
        tags: ['Telegram'],
        operationId: 'listTelegramChats',
        summary: 'List normalized Telegram chats from Hub storage',
        description: 'Requires the telegram grant. Legacy chatId/from/to filters remain accepted. Omitting sourceScope/kind/query preserves the historical Monitor behavior. Explicit sourceScope, kind or query opts into the additive conversation contract; all merges Monitor and SQLite imports. New-mode keysets use immutable effectiveSortTime, falling back from business event time to collectedAt and then firstSeenAt, while response eventTime/collectedAt remain their true nullable values. Each chat carries a stable chatKey for subsequent history reads. This safe GET is separately metered on every call and retry.',
        parameters: telegramChatParameters,
        responses: {
          200: {
            description: 'A page of normalized Telegram chats.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/TelegramPageEnvelope' } } },
          },
          ...publicErrors,
        },
      },
    },
    '/data/telegram/messages': {
      get: {
        tags: ['Telegram'],
        operationId: 'listTelegramMessages',
        summary: 'List normalized Telegram messages from Hub storage',
        description: 'Requires the telegram grant. Omitting sourceScope with a plain external chatId preserves the Monitor legacy path. Explicit sourceScope or a qualified chatKey opts into source-aware history; all with a plain external ID merges Monitor and SQLite messages. New-mode keysets use immutable effectiveSortTime, falling back from business event time to collectedAt and then firstSeenAt, without rewriting nullable response times. Every item includes canonicalId and sourceScope. Return nextCursor unchanged; offset pagination is not supported.',
        'x-mx-error-codes': {
          400: ['invalid_request', 'invalid_cursor', 'page_size_exceeded', 'unsupported_fields', 'source_scope_mismatch'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted'],
          404: ['chat_not_found'],
          429: ['quota_exceeded'],
          503: ['stored_data_unavailable'],
        },
        parameters: telegramMessageParameters,
        responses: {
          200: {
            description: 'A page of normalized Telegram messages.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TelegramPageEnvelope' },
                example: {
                  data: {
                    items: [{
                      canonicalId: '11111111-1111-4111-8111-111111111111',
                      id: '-1001234567890:42',
                      externalId: '-1001234567890:42',
                      platform: 'telegram',
                      objectType: 'message',
                      contentType: 'text',
                      title: null,
                      text: 'Example normalized message',
                      url: null,
                      author: { id: '12345', name: 'Example', username: 'example_user' },
                      relations: { chatId: '-1001234567890', messageId: '42' },
                      attributes: {},
                      metrics: { views: 10 },
                      media: {},
                      entities: [],
                      links: [],
                      eventTime: '2026-08-09T08:00:00.000Z',
                      collectedAt: '2026-08-09T08:01:00.000Z',
                      editedAt: null,
                      lineage: { datasetId: 'telegram.monitor.messages.v1', origin: 'hub-direct' },
                      sourceScope: 'monitor',
                      dataVersion: '2',
                    }],
                    pageInfo: { returnedCount: 1, hasMore: false, nextCursor: null },
                  },
                  requestId: '00000000-0000-4000-8000-000000000002',
                },
              },
            },
          },
          ...publicErrors,
        },
      },
    },
    '/data/telegram/search': {
      post: {
        tags: ['Telegram'],
        operationId: 'searchTelegram',
        summary: 'Advanced search across canonical Telegram messages and chats',
        description: 'Requires the telegram grant. sourceScope defaults to monitor for compatibility; set all to search both Monitor and SQLite-import conversations. Omitting chatId searches the selected corpus globally, while a chatId/chatKey limits the query to one conversation. Ranked full-text search uses the governed search projection and a documented PostgreSQL fallback. The version-3 opaque cursor is bound to the query, sourceScope, filters and bounded first-page analysis state, so later pages do not call the segmenter again.',
        parameters: [idempotencyParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/TelegramSearchRequest' },
              example: {
                query: 'AI Agent',
                scope: 'messages',
                chatId: '-1001234567890',
                from: '2026-08-01T00:00:00Z',
                sourceScope: 'all',
                matchMode: 'full_text',
                pageSize: 20,
              },
            },
          },
        },
        responses: { 200: searchResponse, ...publicErrors },
      },
    },
    '/data/telegram/entities/search': {
      get: {
        tags: ['Telegram'],
        operationId: 'searchTelegramEntities',
        summary: 'Fuzzy-search Telegram authors and chats',
        description: 'Searches author names/usernames and chat titles/usernames. This safe GET is separately metered and does not use an idempotency key.',
        parameters: [
          {
            name: 'query', in: 'query', required: true,
            schema: { type: 'string', minLength: 1, maxLength: 200 },
          },
          {
            name: 'pageSize', in: 'query', required: false,
            schema: { type: 'integer', minimum: 1, maximum: 100 },
          },
        ],
        responses: {
          200: {
            description: 'Ranked author/chat entity union.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/EntitySearchEnvelope' } } },
          },
          ...publicErrors,
        },
      },
    },
    '/requests/{requestId}': {
      get: {
        tags: ['Evidence'],
        operationId: 'getPublicRequestStatus',
        summary: 'Read the outcome of a request owned by this consumer',
        description: 'Use x-mx-insight-request-id from a search response. An unknown status is ambiguous: do not repeat with a new idempotency key.',
        parameters: [{
          name: 'requestId', in: 'path', required: true,
          schema: { type: 'string', format: 'uuid' },
        }],
        responses: {
          200: {
            description: 'Caller-owned request status.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RequestStatusEnvelope' } } },
          },
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    '/usage': {
      get: {
        tags: ['Evidence'],
        operationId: 'getPublicUsage',
        summary: 'Read usage for the authenticated consumer',
        parameters: [
          { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
        ],
        responses: {
          200: {
            description: 'Consumer-scoped usage summary.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/UsageEnvelope' } } },
          },
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerKey: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'MX-API-Key',
        description: 'Authorization: Bearer <issued API key>',
      },
      apiKeyHeader: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description: 'Alternative to the Bearer header.',
      },
    },
    schemas: {
      SearchRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['platform', 'query'],
        properties: {
          platform: { type: 'string', minLength: 1, description: 'One explicit granted platform; wildcards and all are invalid.' },
          query: { type: 'string', minLength: 1, maxLength: 500 },
          pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          cursor: { type: 'string', minLength: 1, maxLength: 8192, description: 'Opaque nextCursor from the prior page.' },
          type: resultTypeProperty,
        },
      },
      ExternalCommerceProductSearchRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['marketplace', 'query'],
        not: { required: ['page', 'cursor'] },
        description: 'Provider-neutral product search. page and cursor are mutually exclusive. The server owns result-size policy; pageSize is intentionally unsupported.',
        properties: {
          marketplace: {
            type: 'string',
            enum: ['taobao', 'tmall', 'jd', 'xiaohongshu_ec', 'xianyu'],
          },
          query: { type: 'string', minLength: 1, maxLength: 200 },
          page: {
            type: 'integer', minimum: 1, maximum: 1000, default: 1,
            description: 'Numeric page for a first traversal. Do not combine with cursor; continuation cursors are preferred.',
          },
          cursor: {
            type: 'string', minLength: 1, maxLength: 4096,
            description: 'Opaque nextCursor from the prior response. Return it unchanged with the same marketplace, query, sort and price.',
          },
          sort: {
            type: 'string',
            enum: ['relevance', 'sales_desc', 'price_asc', 'price_desc', 'recent', 'seller_credit', 'price_drop', 'newest'],
            description: 'Marketplace-specific. taobao/tmall accept relevance, sales_desc, price_asc and price_desc; xianyu accepts relevance, recent, seller_credit, price_asc, price_desc, price_drop and newest; jd and xiaohongshu_ec do not accept sort.',
          },
          price: {
            type: 'object',
            additionalProperties: false,
            description: 'Optional taobao/tmall-only inclusive price range. min must not exceed max.',
            properties: {
              min: {
                type: 'string',
                pattern: '^(?:0|[1-9][0-9]{0,11})(?:[.][0-9]{1,8})?$',
              },
              max: {
                type: 'string',
                pattern: '^(?:0|[1-9][0-9]{0,11})(?:[.][0-9]{1,8})?$',
              },
            },
          },
        },
      },
      ExternalCommerceProduct: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'marketplace', 'title', 'url', 'pricing', 'shop', 'images', 'signals', 'attributes'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 256 },
          marketplace: {
            type: 'string',
            enum: ['taobao', 'tmall', 'jd', 'xiaohongshu_ec', 'xianyu'],
          },
          title: { type: ['string', 'null'], maxLength: 4096 },
          url: { type: ['string', 'null'], format: 'uri', maxLength: 2048 },
          pricing: {
            type: 'object',
            additionalProperties: false,
            required: ['current', 'original', 'currency'],
            properties: {
              current: { type: ['string', 'null'], maxLength: 128 },
              original: { type: ['string', 'null'], maxLength: 128 },
              currency: { type: 'string', minLength: 1, maxLength: 16 },
            },
          },
          shop: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'name'],
            properties: {
              id: { type: ['string', 'null'], maxLength: 256 },
              name: { type: ['string', 'null'], maxLength: 512 },
            },
          },
          images: {
            type: 'array', maxItems: 20,
            items: { type: 'string', format: 'uri', maxLength: 2048 },
          },
          signals: {
            type: 'object',
            additionalProperties: false,
            required: ['sales', 'reviewCount', 'location'],
            properties: {
              sales: { type: ['string', 'null'], maxLength: 128 },
              reviewCount: { type: ['string', 'null'], maxLength: 128 },
              location: { type: ['string', 'null'], maxLength: 512 },
            },
          },
          attributes: {
            type: 'object',
            additionalProperties: false,
            required: ['brand', 'category'],
            properties: {
              brand: { type: ['string', 'null'], maxLength: 512 },
              category: { type: ['string', 'null'], maxLength: 512 },
            },
          },
        },
      },
      ExternalCommerceProductSearchPage: {
        type: 'object',
        additionalProperties: false,
        required: ['page', 'returnedCount', 'discardedCount', 'hasMore', 'nextCursor'],
        properties: {
          page: { type: 'integer', minimum: 1, maximum: 1000 },
          returnedCount: { type: 'integer', minimum: 0 },
          discardedCount: { type: 'integer', minimum: 0 },
          hasMore: {
            type: ['boolean', 'null'],
            description: 'null means the platform hinted at more data but Hub could not issue a safe continuation; do not guess another page.',
          },
          nextCursor: {
            type: ['string', 'null'], maxLength: 4096,
            description: 'Opaque Hub cursor. null means the client must stop this traversal.',
          },
        },
      },
      ExternalCommerceProductSearchEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['contractVersion', 'data', 'meta', 'requestId'],
        properties: {
          contractVersion: { type: 'string', const: 'mx-insight-hub.ecommerce-products.v1' },
          data: {
            type: 'object',
            additionalProperties: false,
            required: ['items', 'page'],
            properties: {
              items: {
                type: 'array',
                items: { $ref: '#/components/schemas/ExternalCommerceProduct' },
              },
              page: { $ref: '#/components/schemas/ExternalCommerceProductSearchPage' },
            },
          },
          meta: {
            type: 'object',
            additionalProperties: false,
            required: ['capturedAt', 'servedAt', 'sourceMode', 'ageSeconds'],
            properties: {
              capturedAt: { type: 'string', format: 'date-time' },
              servedAt: { type: 'string', format: 'date-time' },
              sourceMode: {
                type: 'string',
                enum: ['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay'],
              },
              ageSeconds: { type: 'integer', minimum: 0 },
              fallbackReason: {
                type: 'string',
                description: 'Bounded reason category present only for stored_fallback.',
              },
            },
          },
          requestId: { type: 'string', format: 'uuid' },
        },
      },
      NightAllLegacyRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['platform'],
        description: 'Shared schema for the operation path parameter. The x-mx-operation-fields allowlists mirror runtime exactly: raw requires one singular string or plural string-array query field; crawl and user-info require a supported user/channel identifier. LinkedIn user-info requires complete /in/ personal profile URLs in url, profileUrl, profile_url, or urls; company URLs and bare slugs are rejected. Canonical decimal strings are accepted for integer fields normalized by runtime. Server-owned routing, credential and cost-amplification controls are rejected, including when nested in params.',
        'x-mx-common-fields': ['businessId', 'business_id', 'platform', 'count', 'pageSize', 'limit', 'page', 'cursor', 'concurrency', 'params', 'includeRaw'],
        'x-mx-operation-fields': {
          raw: ['keyword', 'query', 'keywords', 'queries', 'disableAutoDetails', 'includeDetails', 'includeComments', 'commentLimit', 'cacheMaxAgeHours', 'maxEnrichItems', 'commentCursor', 'enrichConcurrency'],
          crawl: ['username', 'usernames', 'userId', 'userIds', 'user_id', 'uid', 'channelUrl', 'channel_url', 'channelId', 'channel_id', 'url', 'urls', 'activityTypes', 'cacheMaxAgeHours'],
          'user-info': ['username', 'usernames', 'userId', 'userIds', 'user_id', 'uid', 'url', 'profileUrl', 'profile_url', 'urls'],
        },
        'x-mx-rejected-params': ['provider', 'endpoint', 'credential', 'token/auth', 'timeout', 'capability', 'moduleCode', 'archive', 'fullArchive', 'allTweets', 'archiveLimit', 'totalCount', 'max*Pages', 'pageCount', 'chunkSize', 'budget', 'crawlDepth', 'count', 'limit', 'pageSize', 'page', 'pageNumber', 'pageNo', 'concurrency', 'includeDetails', 'includeComments', 'disableAutoDetails', 'commentLimit', 'maxEnrichItems', 'enrichConcurrency', 'cacheMaxAgeHours'],
        'x-mx-params-limits': {
          maxDepth: 8,
          maxNodes: 1000,
          maxStringLength: 8192,
          arrayMaxItems: 'consumer effective platform maxPageSize',
        },
        'x-mx-work-budget': {
          maxRawQueries: 50,
          maxCrawlIdentifiers: 50,
          raw: 'queryCount * effective pageSize <= consumer effective platform maxPageSize',
          crawl: 'identifierCount * effective pageSize * activityTypeCount <= consumer effective platform maxPageSize',
          'user-info': 'no multiplication rule; identifier collections remain bounded',
          description: 'Bounds returned/processed item work; it is not a provider-call or billing-count claim because Night-All owns provider/token policy.',
        },
        properties: {
          platform: { type: 'string', minLength: 1, maxLength: 64 },
          businessId: { type: 'string', maxLength: 128, description: 'Optional migration field; when present it must equal the authenticated consumer businessId.' },
          business_id: { type: 'string', maxLength: 128 },
          includeRaw: { type: 'boolean', enum: [false], description: 'Legacy false is accepted then removed before dispatch; true is rejected.' },
          keyword: { type: 'string', minLength: 1, maxLength: 2048 },
          query: { type: 'string', minLength: 1, maxLength: 2048 },
          keywords: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 2048 } },
          queries: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 2048 } },
          username: { type: ['string', 'number'], minLength: 1, maxLength: 2048 },
          usernames: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 2048 } },
          userId: { type: ['string', 'number'], minLength: 1, maxLength: 2048 },
          userIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 2048 } },
          user_id: { type: ['string', 'number'], minLength: 1, maxLength: 2048 },
          uid: { type: ['string', 'number'], minLength: 1, maxLength: 2048 },
          channelUrl: { type: 'string', minLength: 1, maxLength: 2048 },
          channel_url: { type: 'string', minLength: 1, maxLength: 2048 },
          channelId: { type: ['string', 'number'], minLength: 1, maxLength: 2048 },
          channel_id: { type: ['string', 'number'], minLength: 1, maxLength: 2048 },
          url: { type: 'string', minLength: 1, maxLength: 2048 },
          profileUrl: { type: 'string', minLength: 1, maxLength: 2048 },
          profile_url: { type: 'string', minLength: 1, maxLength: 2048 },
          urls: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 2048 } },
          count: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^[1-9][0-9]*$' }] },
          pageSize: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^[1-9][0-9]*$' }] },
          limit: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^[1-9][0-9]*$' }] },
          page: { oneOf: [{ type: 'integer', minimum: 1, maximum: 1000 }, { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]{1,2}|1000)$' }] },
          cursor: { type: 'string', minLength: 1, maxLength: 8192 },
          concurrency: { oneOf: [{ type: 'integer', minimum: 1, maximum: 20 }, { type: 'string', pattern: '^(?:[1-9]|1[0-9]|20)$' }] },
          cacheMaxAgeHours: { type: 'number', minimum: 0, maximum: 720, description: 'raw and crawl only.' },
          disableAutoDetails: { type: 'boolean' },
          includeDetails: { type: 'boolean' },
          includeComments: { type: 'boolean' },
          commentLimit: { oneOf: [{ type: 'integer', minimum: 1, maximum: 100 }, { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' }] },
          maxEnrichItems: { oneOf: [{ type: 'integer', minimum: 1, maximum: 20 }, { type: 'string', pattern: '^(?:[1-9]|1[0-9]|20)$' }] },
          commentCursor: { type: 'string', minLength: 1, maxLength: 8192 },
          enrichConcurrency: { oneOf: [{ type: 'integer', minimum: 1, maximum: 5 }, { type: 'string', pattern: '^[1-5]$' }] },
          activityTypes: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 128 } },
          params: { type: 'object', additionalProperties: true, description: 'Platform continuation values only. Rejected keys and workload overrides are listed by x-mx-rejected-params; nested strings are at most 8192 characters and arrays are bounded by the consumer effective platform maxPageSize.' },
        },
      },
      StoredSearchRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['platform', 'query'],
        properties: {
          platform: { type: 'string', minLength: 1, maxLength: 64, description: 'One explicit granted platform; wildcards and all are invalid.' },
          query: { type: 'string', minLength: 1, maxLength: 500 },
          datasetId: { type: 'string', minLength: 1, maxLength: 200, description: 'Optional exact logical dataset filter; not a physical database or authorization grant.' },
          objectType: { type: 'string', minLength: 1, maxLength: 100, description: 'Optional exact canonical object-type filter.' },
          ...publicOpinionSearchRequestProperties,
          pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          cursor: { type: 'string', minLength: 1, maxLength: 8192, description: 'HMAC-signed opaque nextCursor bound to the normalized query and filters.' },
          type: resultTypeProperty,
        },
      },
      CanonicalSearchRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 500 },
          platform: { type: 'string', minLength: 1, maxLength: 64, description: 'Optional exact platform filter. It must already be granted; omit it to search every currently granted platform.' },
          datasetId: { type: 'string', minLength: 1, maxLength: 200, description: 'Optional exact logical dataset filter; never a physical source selector or authorization grant.' },
          objectType: { type: 'string', minLength: 1, maxLength: 100, description: 'Optional exact canonical object-type filter.' },
          ...publicOpinionSearchRequestProperties,
          searchProfile: {
            type: 'string',
            enum: PUBLIC_SEARCH_PROFILE_IDS,
            default: DEFAULT_SEARCH_PROFILE,
            description: 'Versioned server-owned search policy. Healthy HanLP/pre-segmented terms drive the default AND branch; degraded fallback terms cause an explicit phrase-only applied profile. Arbitrary analyzers, tokenizers, filters and Elasticsearch DSL are not accepted.',
          },
          pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          cursor: { type: 'string', minLength: 1, maxLength: 8192, description: 'HMAC-signed opaque nextCursor bound to the query, filters, page size, resolved search profile, requested sort, authorized platform scope and bounded first-page analysis state.' },
          sort: {
            type: 'string',
            enum: ['newest', 'oldest', 'relevance'],
            default: 'newest',
            description: "Result ordering. 'newest'/'oldest' order by event time, 'relevance' by score then event time. Every ordering ends on the record id, so paging is deterministic. Part of the cursor binding: changing it requires starting from the first page.",
          },
          type: resultTypeProperty,
        },
      },
      TokenizeRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: {
            type: 'string', minLength: 1, maxLength: 4096,
            description: 'Must contain at least one Unicode letter or number; control characters are rejected.',
          },
        },
      },
      TelegramSearchRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 500 },
          scope: { type: 'string', enum: ['messages', 'chats', 'all'], default: 'messages' },
          chatId: { type: 'string', minLength: 1, maxLength: 256 },
          authorId: { type: 'string', minLength: 1, maxLength: 256 },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
          sourceScope: { type: 'string', enum: ['all', 'monitor', 'sqlite'], default: 'monitor' },
          matchMode: { type: 'string', enum: ['full_text'], default: 'full_text' },
          pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          cursor: { type: 'string', minLength: 1, maxLength: 8192, description: 'HMAC-signed version-3 cursor bound to query, filters and bounded first-page analysis state; return unchanged.' },
        },
      },
      PageInfo: {
        type: 'object',
        required: ['returnedCount', 'hasMore', 'nextCursor'],
        properties: {
          returnedCount: { type: 'integer', minimum: 0 },
          hasMore: { type: 'boolean' },
          nextCursor: { type: ['string', 'null'] },
        },
      },
      SearchItem: {
        type: 'object',
        required: ['id', 'externalId', 'platform', 'text'],
        properties: {
          canonicalId: { type: ['string', 'null'], format: 'uuid', description: 'Present for Hub canonical Telegram search hits.' },
          sourceScope: { type: ['string', 'null'], enum: ['monitor', 'sqlite', null], description: 'Stored Telegram source for a canonical hit.' },
          id: { type: 'string' }, externalId: { type: 'string' }, platform: { type: 'string' },
          contentType: { type: ['string', 'null'] }, url: { type: ['string', 'null'] },
          title: { type: ['string', 'null'] }, text: { type: ['string', 'null'] },
          publishedAt: { type: ['string', 'null'], format: 'date-time' },
          collectedAt: { type: ['string', 'null'], format: 'date-time' },
          author: { type: ['object', 'null'], additionalProperties: true },
          metrics: { type: 'object', additionalProperties: { type: ['number', 'null'] } },
          media: { type: 'object', additionalProperties: true },
          source: { type: 'object', additionalProperties: true },
        },
      },
      SearchEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            additionalProperties: false,
            required: ['contractVersion', 'platform', 'query', 'items', 'pageInfo', 'status', 'warnings', 'meta'],
            properties: {
              contractVersion: { type: 'string', const: 'night-all.data-search.v1' },
              platform: { type: 'string' }, query: { type: 'string' },
              items: { type: 'array', items: { $ref: '#/components/schemas/SearchItem' } },
              pageInfo: {
                type: 'object', additionalProperties: false,
                required: ['pageIndex', 'pageSize', 'returnedCount', 'hasMore', 'nextCursor', 'cursorType'],
                properties: {
                  pageIndex: { type: 'integer', minimum: 1 }, pageSize: { type: 'integer', minimum: 0, maximum: 100 },
                  returnedCount: { type: 'integer', minimum: 0, maximum: 100 }, hasMore: { type: 'boolean' },
                  nextCursor: { type: ['string', 'null'], maxLength: 8192 },
                  cursorType: { type: 'string', enum: ['opaque', 'none'] },
                },
              },
              status: { type: 'string', enum: ['ok', 'partial', 'failed'] },
              warnings: {
                type: 'array', items: {
                  type: 'object', additionalProperties: false, required: ['code', 'message'],
                  properties: { code: { type: 'string' }, message: { type: 'string' } },
                },
              },
              meta: {
                type: 'object', additionalProperties: false,
                required: ['capability', 'capabilityStatus', 'paginationMode', 'sourceProvider', 'endpointId', 'providerCalls', 'durationMs'],
                properties: {
                  capability: { type: 'string' }, capabilityStatus: { type: 'string' }, paginationMode: { type: 'string' },
                  sourceProvider: { type: ['string', 'null'] }, endpointId: { type: ['string', 'null'] },
                  providerCalls: { type: 'integer', minimum: 0 }, durationMs: { type: 'integer', minimum: 0 },
                },
              },
            },
          },
          requestId: { type: 'string' },
          traceId: { type: 'string' },
        },
      },
      NightAllLegacyEnvelope: {
        type: 'object',
        additionalProperties: true,
        required: ['data'],
        properties: {
          data: {
            type: 'object',
            additionalProperties: true,
            required: ['raw_info', 'raw_data', 'page', 'meta'],
            properties: {
              raw_info: { type: 'string', contentMediaType: 'application/json', description: 'Night-All JSON-string array, retained unchanged.' },
              raw_data: { type: 'string', contentMediaType: 'application/json', description: 'Night-All JSON-string array, retained unchanged.' },
              page: { type: 'object', additionalProperties: true },
              meta: { type: 'object', additionalProperties: true },
            },
          },
          requestId: { type: 'string' },
          traceId: { type: 'string' },
        },
      },
      StoredSearchItem: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'datasetId', 'platform', 'objectType', 'source'],
        properties: {
          id: { type: 'string', format: 'uuid' }, datasetId: { type: 'string' }, platform: { type: 'string' },
          objectType: { type: 'string' }, contentType: { type: ['string', 'null'] }, externalId: { type: 'string', description: 'Public stable item identity. For public_opinion this repeats the Hub canonical id; the upstream source-row id remains private.' },
          url: { type: ['string', 'null'] }, title: { type: ['string', 'null'] }, text: { type: ['string', 'null'] },
          author: { type: 'object', additionalProperties: false, properties: {
            id: { type: ['string', 'null'] }, name: { type: ['string', 'null'] }, username: { type: ['string', 'null'] },
          } },
          metrics: { type: 'object', additionalProperties: { type: ['number', 'null'] } },
          eventTime: { type: ['string', 'null'], format: 'date-time' },
          collectedAt: { type: ['string', 'null'], format: 'date-time' },
          score: { type: ['number', 'null'] }, source: { type: 'string', const: 'hub' },
          quality: { $ref: '#/components/schemas/PublicOpinionSearchQuality' },
          location: { $ref: '#/components/schemas/PublicOpinionSearchLocation' },
        },
      },
      PublicOpinionSearchQuality: {
        type: 'object',
        additionalProperties: false,
        required: ['stage', 'status', 'score', 'geographyVerified'],
        description: 'Bounded Hub publication metadata returned only for explicit public_opinion candidate searches.',
        properties: {
          stage: { type: ['string', 'null'], enum: ['formal', 'candidate', null] },
          status: {
            type: ['string', 'null'],
            enum: ['formal', 'pending', 'qualified', 'rejected', 'failed', null],
          },
          score: { type: ['number', 'null'], minimum: 0, maximum: 100 },
          geographyVerified: { type: 'boolean' },
        },
      },
      PublicOpinionSearchLocation: {
        type: 'object',
        additionalProperties: false,
        required: ['provinceCode', 'label', 'type', 'country', 'countryCode'],
        description: 'Bounded Hub-normalized location returned only for explicit public_opinion candidate searches.',
        properties: {
          provinceCode: { type: ['string', 'null'] },
          label: { type: ['string', 'null'] },
          type: {
            type: ['string', 'null'],
            enum: ['province', 'country', 'region', 'city', 'maritime', 'unknown', null],
          },
          country: { type: ['string', 'null'] },
          countryCode: { type: ['string', 'null'], pattern: '^[A-Z]{2}$' },
        },
      },
      StoredSearchPageInfo: {
        type: 'object',
        additionalProperties: false,
        required: ['pageIndex', 'pageSize', 'returnedCount', 'hasMore', 'nextCursor', 'cursorType'],
        properties: {
          pageIndex: { type: 'integer', minimum: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 100 },
          returnedCount: { type: 'integer', minimum: 0, maximum: 100 }, hasMore: { type: 'boolean' },
          nextCursor: { type: ['string', 'null'], maxLength: 8192 },
          cursorType: { type: 'string', enum: ['opaque', 'none'] },
        },
      },
      CanonicalSearchPageInfo: {
        type: 'object',
        additionalProperties: false,
        required: ['pageIndex', 'pageSize', 'returnedCount', 'totalCount', 'totalRelation', 'totalPages', 'hasMore', 'nextCursor', 'cursorType'],
        properties: {
          pageIndex: { type: 'integer', minimum: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 100 },
          returnedCount: { type: 'integer', minimum: 0, maximum: 100 },
          totalCount: { type: ['integer', 'null'], minimum: 0 },
          totalRelation: { type: 'string', enum: ['eq', 'gte', 'unknown'] },
          totalPages: { type: ['integer', 'null'], minimum: 0 },
          hasMore: { type: 'boolean' },
          nextCursor: { type: ['string', 'null'], maxLength: 8192 },
          cursorType: { type: 'string', enum: ['opaque', 'none'] },
        },
      },
      StoredSearchEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            additionalProperties: false,
            required: ['contractVersion', 'source', 'query', 'filters', 'items', 'pageInfo', 'searchMode', 'warnings', 'durationMs'],
            properties: {
              contractVersion: { type: 'string', const: 'mx-insight-hub.stored-search.v1' },
              source: { type: 'string', const: 'hub' }, query: { type: 'string' },
              filters: { type: 'object', additionalProperties: false, required: ['platform', 'datasetId', 'objectType'], properties: {
                platform: { type: 'string' }, datasetId: { type: ['string', 'null'] }, objectType: { type: ['string', 'null'] },
                ...publicOpinionSearchFilterProperties,
              } },
              items: { type: 'array', items: { $ref: '#/components/schemas/StoredSearchItem' } },
              pageInfo: { $ref: '#/components/schemas/StoredSearchPageInfo' },
              searchMode: { type: 'string', enum: ['elasticsearch', 'postgres'] },
              warnings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['code', 'message'], properties: {
                code: { type: 'string' }, message: { type: 'string' },
              } } },
              durationMs: { type: 'integer', minimum: 0 },
            },
          },
          requestId: { type: 'string', format: 'uuid' },
        },
      },
      CanonicalSearchEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            additionalProperties: false,
            required: ['contractVersion', 'source', 'query', 'scope', 'filters', 'search', 'items', 'pageInfo', 'searchMode', 'warnings', 'durationMs'],
            properties: {
              contractVersion: { type: 'string', const: 'mx-insight-hub.canonical-search.v1' },
              source: { type: 'string', const: 'hub' },
              query: { type: 'string' },
              scope: {
                type: 'object', additionalProperties: false, required: ['platforms'],
                properties: { platforms: { type: 'array', minItems: 1, items: { type: 'string' } } },
              },
              filters: {
                type: 'object', additionalProperties: false, required: ['platform', 'datasetId', 'objectType'],
                properties: {
                  platform: { type: ['string', 'null'] },
                  datasetId: { type: ['string', 'null'] },
                  objectType: { type: ['string', 'null'] },
                  ...publicOpinionSearchFilterProperties,
                },
              },
              search: {
                type: 'object',
                additionalProperties: false,
                required: ['requestedProfile', 'appliedProfile', 'degraded'],
                properties: {
                  requestedProfile: { type: 'string', enum: PUBLIC_SEARCH_PROFILE_IDS },
                  appliedProfile: { type: 'string', enum: [...PUBLIC_SEARCH_PROFILE_IDS, POSTGRES_SEARCH_PROFILE] },
                  degraded: { type: 'boolean' },
                },
              },
              items: { type: 'array', items: { $ref: '#/components/schemas/StoredSearchItem' } },
              pageInfo: { $ref: '#/components/schemas/CanonicalSearchPageInfo' },
              searchMode: { type: 'string', enum: ['elasticsearch', 'postgres'] },
              warnings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['code', 'message'], properties: {
                code: { type: 'string' }, message: { type: 'string' },
              } } },
              durationMs: { type: 'integer', minimum: 0 },
            },
          },
          requestId: { type: 'string', format: 'uuid' },
        },
      },
      CanonicalContextCompleteness: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'basis', 'through'],
        description: 'Declared upstream-capture statement for this dataset. attested_complete requires persisted scope/time evidence. It is independent from the number of neighboring active rows currently stored in Hub.',
        properties: {
          status: { type: 'string', enum: ['unknown', 'bounded', 'attested_complete'] },
          basis: { type: ['string', 'null'] },
          through: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      CanonicalContextCapabilityDataset: {
        type: 'object',
        additionalProperties: false,
        required: ['datasetId', 'objectType', 'streamType', 'ordering', 'upstreamCompleteness'],
        properties: {
          datasetId: { type: 'string' },
          objectType: { type: 'string', const: 'message' },
          streamType: { type: 'string', const: 'chat' },
          ordering: { type: 'array', const: ['eventTime', 'canonicalId'] },
          upstreamCompleteness: { $ref: '#/components/schemas/CanonicalContextCompleteness' },
        },
      },
      CanonicalContextCapability: {
        type: 'object',
        additionalProperties: false,
        required: ['contractVersion', 'ready', 'defaultBefore', 'defaultAfter', 'maxBefore', 'maxAfter', 'datasets'],
        properties: {
          contractVersion: { type: 'string', const: 'mx-insight-hub.canonical-context.v1' },
          ready: { type: 'boolean', description: 'True only while every serving index required by the advertised dataset set is valid and ready.' },
          defaultBefore: { type: 'integer', const: 10 },
          defaultAfter: { type: 'integer', const: 10 },
          maxBefore: { type: 'integer', const: 50 },
          maxAfter: { type: 'integer', const: 50 },
          datasets: {
            type: 'array', minItems: 1,
            items: { $ref: '#/components/schemas/CanonicalContextCapabilityDataset' },
          },
        },
      },
      CanonicalTimelineCapability: {
        type: 'object',
        additionalProperties: false,
        required: ['contractVersion', 'ready', 'consistency', 'defaultBefore', 'defaultAfter', 'maxBefore', 'maxAfter', 'cursor', 'datasets'],
        properties: {
          contractVersion: { type: 'string', const: 'mx-insight-hub.canonical-timeline.v1' },
          ready: { type: 'boolean', description: 'True only while every serving index required by the advertised dataset set is valid and ready.' },
          consistency: { type: 'string', const: 'live-keyset' },
          defaultBefore: { type: 'integer', const: 10 },
          defaultAfter: { type: 'integer', const: 10 },
          maxBefore: { type: 'integer', const: 50 },
          maxAfter: { type: 'integer', const: 50 },
          cursor: {
            type: 'object', additionalProperties: false,
            required: ['opaque', 'directions', 'newerPolling'],
            properties: {
              opaque: { type: 'boolean', const: true },
              directions: { type: 'array', const: ['older', 'newer'] },
              newerPolling: { type: 'boolean', const: true },
            },
          },
          datasets: {
            type: 'array', minItems: 1,
            items: { $ref: '#/components/schemas/CanonicalContextCapabilityDataset' },
          },
        },
      },
      CanonicalContextEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            additionalProperties: false,
            required: ['contractVersion', 'source', 'anchorId', 'anchorIndex', 'stream', 'items', 'storedWindow', 'ordering', 'upstreamCompleteness', 'warnings'],
            properties: {
              contractVersion: { type: 'string', const: 'mx-insight-hub.canonical-context.v1' },
              source: { type: 'string', const: 'hub' },
              anchorId: { type: 'string', format: 'uuid' },
              anchorIndex: { type: 'integer', minimum: 0, maximum: 50 },
              stream: {
                type: 'object', additionalProperties: false,
                required: ['platform', 'datasetId', 'objectType', 'type', 'id'],
                properties: {
                  platform: { type: 'string', const: 'telegram' },
                  datasetId: { type: 'string' },
                  objectType: { type: 'string', const: 'message' },
                  type: { type: 'string', const: 'chat' },
                  id: { type: 'string', minLength: 1, maxLength: 256 },
                },
              },
              items: {
                type: 'array', minItems: 1, maxItems: 101,
                description: 'One ascending list. items[anchorIndex].id always equals anchorId.',
                items: { $ref: '#/components/schemas/StoredSearchItem' },
              },
              storedWindow: {
                type: 'object', additionalProperties: false,
                required: ['beforeRequested', 'afterRequested', 'beforeReturned', 'afterReturned', 'returnedCount', 'hasMoreStoredBefore', 'hasMoreStoredAfter'],
                properties: {
                  beforeRequested: { type: 'integer', minimum: 0, maximum: 50 },
                  afterRequested: { type: 'integer', minimum: 0, maximum: 50 },
                  beforeReturned: { type: 'integer', minimum: 0, maximum: 50 },
                  afterReturned: { type: 'integer', minimum: 0, maximum: 50 },
                  returnedCount: { type: 'integer', minimum: 1, maximum: 101 },
                  hasMoreStoredBefore: { type: 'boolean' },
                  hasMoreStoredAfter: { type: 'boolean' },
                },
              },
              ordering: {
                type: 'object', additionalProperties: false,
                required: ['fields', 'direction', 'quality'],
                properties: {
                  fields: { type: 'array', const: ['eventTime', 'canonicalId'] },
                  direction: { type: 'string', const: 'ascending' },
                  quality: { type: 'string', const: 'deterministic' },
                },
              },
              upstreamCompleteness: { $ref: '#/components/schemas/CanonicalContextCompleteness' },
              warnings: {
                type: 'array', maxItems: 1,
                items: {
                  type: 'object', additionalProperties: false, required: ['code', 'message'],
                  properties: {
                    code: { type: 'string', enum: ['upstream_completeness_unknown', 'upstream_completeness_bounded'] },
                    message: { type: 'string' },
                  },
                },
              },
            },
          },
          requestId: { type: 'string', format: 'uuid' },
        },
      },
      CanonicalTimelineDirectionPage: {
        type: 'object',
        additionalProperties: false,
        required: ['hasMore', 'cursor'],
        description: 'One continuation direction. An exhausted older side has cursor=null. The newer cursor is retained when hasMore=false. It advances to the newest returned item when a page is non-empty and remains unchanged on an empty page, so the client can poll for later stored writes.',
        properties: {
          hasMore: { type: 'boolean', description: 'Whether another active Hub-stored row is currently known beyond this page.' },
          cursor: {
            type: ['string', 'null'], minLength: 1, maxLength: 2048,
            description: 'Opaque HMAC timeline cursor. Return unchanged; do not decode, construct or use as a search/history cursor.',
          },
        },
      },
      CanonicalTimelinePageInfo: {
        type: 'object',
        additionalProperties: false,
        required: ['mode', 'direction', 'returnedCount', 'older', 'newer'],
        properties: {
          mode: { type: 'string', enum: ['initial', 'continuation'] },
          direction: { type: ['string', 'null'], enum: [null, 'older', 'newer'] },
          returnedCount: { type: 'integer', minimum: 0, maximum: 101 },
          older: {
            oneOf: [
              { $ref: '#/components/schemas/CanonicalTimelineDirectionPage' },
              { type: 'null' },
            ],
          },
          newer: {
            oneOf: [
              { $ref: '#/components/schemas/CanonicalTimelineDirectionPage' },
              { type: 'null' },
            ],
          },
        },
      },
      CanonicalTimelineEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            additionalProperties: false,
            required: ['contractVersion', 'consistency', 'source', 'anchorId', 'anchorIndex', 'stream', 'items', 'pageInfo', 'ordering', 'upstreamCompleteness', 'warnings'],
            properties: {
              contractVersion: { type: 'string', const: 'mx-insight-hub.canonical-timeline.v1' },
              consistency: {
                type: 'string', const: 'live-keyset',
                description: 'Pages use exclusive live keyset boundaries, not a frozen snapshot or changes-feed revision.',
              },
              source: { type: 'string', const: 'hub' },
              anchorId: { type: 'string', format: 'uuid' },
              anchorIndex: {
                type: ['integer', 'null'], minimum: 0, maximum: 50,
                description: 'Index of anchorId on the initial page; null on continuation pages.',
              },
              stream: {
                type: 'object', additionalProperties: false,
                required: ['platform', 'datasetId', 'objectType', 'type', 'id'],
                properties: {
                  platform: { type: 'string', const: 'telegram' },
                  datasetId: { type: 'string' },
                  objectType: { type: 'string', const: 'message' },
                  type: { type: 'string', const: 'chat' },
                  id: { type: 'string', minLength: 1, maxLength: 256 },
                },
              },
              items: {
                type: 'array', minItems: 0, maxItems: 101,
                description: 'Ascending safe stored-message projection. eventTime preserves the six-digit UTC microsecond value used by timeline ordering and cursor boundaries. Initial items[anchorIndex].id equals anchorId; a continuation may be empty.',
                items: { $ref: '#/components/schemas/StoredSearchItem' },
              },
              pageInfo: { $ref: '#/components/schemas/CanonicalTimelinePageInfo' },
              ordering: {
                type: 'object', additionalProperties: false,
                required: ['fields', 'direction', 'quality'],
                properties: {
                  fields: { type: 'array', const: ['eventTime', 'canonicalId'] },
                  direction: { type: 'string', const: 'ascending' },
                  quality: { type: 'string', const: 'deterministic' },
                },
              },
              upstreamCompleteness: { $ref: '#/components/schemas/CanonicalContextCompleteness' },
              warnings: {
                type: 'array', maxItems: 1,
                items: {
                  type: 'object', additionalProperties: false, required: ['code', 'message'],
                  properties: {
                    code: { type: 'string', enum: ['upstream_completeness_unknown', 'upstream_completeness_bounded'] },
                    message: { type: 'string' },
                  },
                },
              },
            },
          },
          requestId: { type: 'string', format: 'uuid' },
        },
      },
      MobileCommerceMarketplace: {
        type: 'object',
        additionalProperties: false,
        required: [
          'sourceValue', 'mappingStatus', 'catalogEntryId', 'catalogSourceKey',
          'catalogRevision', 'canonicalName', 'majorCategory', 'scenarios', 'regions',
        ],
        properties: {
          sourceValue: { type: ['string', 'null'] },
          mappingStatus: { type: 'string', enum: ['mapped', 'unmapped'] },
          catalogEntryId: { type: ['string', 'null'], format: 'uuid' },
          catalogSourceKey: { type: ['string', 'null'] },
          catalogRevision: { type: ['integer', 'null'], minimum: 1 },
          canonicalName: { type: ['string', 'null'] },
          majorCategory: { type: ['string', 'null'] },
          scenarios: { type: 'array', items: { type: 'string' } },
          regions: { type: 'array', items: { type: 'string' } },
        },
      },
      MobileCommerceItem: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'captureId', 'dataVersion', 'marketplace', 'task', 'product', 'shop', 'signals', 'collectedAt'],
        properties: {
          id: {
            type: 'string',
            format: 'uuid',
          },
          captureId: { type: ['string', 'null'] },
          dataVersion: { type: 'string' },
          marketplace: { $ref: '#/components/schemas/MobileCommerceMarketplace' },
          task: {
            type: 'object', additionalProperties: false,
            required: ['id', 'keyword', 'sourceBrandLabel'],
            properties: {
              id: { type: ['string', 'null'] },
              keyword: { type: ['string', 'null'] },
              sourceBrandLabel: { type: ['string', 'null'] },
            },
          },
          product: {
            type: 'object', additionalProperties: false,
            required: ['goodsId', 'title', 'price', 'resolution'],
            properties: {
              goodsId: { type: ['string', 'null'] },
              title: { type: ['string', 'null'] },
              price: { type: ['string', 'null'] },
              resolution: { type: 'string', enum: ['source-goods-id', 'capture-only'] },
            },
          },
          shop: {
            type: 'object', additionalProperties: false,
            required: ['id', 'name', 'level', 'fans', 'reputation'],
            properties: Object.fromEntries(
              ['id', 'name', 'level', 'fans', 'reputation']
                .map((field) => [field, { type: ['string', 'null'] }]),
            ),
          },
          signals: {
            type: 'object', additionalProperties: false,
            required: ['sales', 'shipFrom', 'commentCount', 'goodRate', 'tagsText'],
            properties: Object.fromEntries(
              ['sales', 'shipFrom', 'commentCount', 'goodRate', 'tagsText']
                .map((field) => [field, { type: ['string', 'null'] }]),
            ),
          },
          collectedAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      MobileCommercePage: {
        type: 'object',
        additionalProperties: false,
        required: ['contractVersion', 'sourceMode', 'acquisition', 'scope', 'filters', 'items', 'pageInfo'],
        properties: {
          contractVersion: { type: 'string', const: 'mx-insight-hub.data-products.mobile-commerce-items.v1' },
          sourceMode: { type: 'string', const: 'stored' },
          acquisition: {
            type: 'object', additionalProperties: false,
            required: ['remoteFetchAvailable', 'remoteFetchStatus', 'executionPlane', 'hubRole', 'plannedMode'],
            properties: {
              remoteFetchAvailable: { type: 'boolean', const: false },
              remoteFetchStatus: { type: 'string', const: 'reserved' },
              executionPlane: { type: 'string', const: 'external-mobile-collector' },
              hubRole: { type: 'string', const: 'asynchronous-trigger-and-data-api' },
              plannedMode: { type: 'string', const: 'asynchronous-command' },
            },
          },
          scope: {
            type: 'object', additionalProperties: false,
            required: ['authorizationPlatform', 'datasetId', 'objectType'],
            properties: {
              authorizationPlatform: { type: 'string', const: 'mobile_commerce' },
              datasetId: { type: 'string', const: 'mobile-commerce.collected-items.v1' },
              objectType: { type: 'string', const: 'commerce_capture' },
            },
          },
          filters: {
            type: 'object', additionalProperties: false,
            required: ['sourcePlatform', 'catalogEntryId', 'keyword', 'brand', 'taskId', 'from', 'to'],
            properties: {
              sourcePlatform: { type: ['string', 'null'] },
              catalogEntryId: { type: ['string', 'null'], format: 'uuid' },
              keyword: { type: ['string', 'null'] },
              brand: { type: ['string', 'null'] },
              taskId: { type: ['string', 'null'] },
              from: { type: ['string', 'null'], format: 'date-time' },
              to: { type: ['string', 'null'], format: 'date-time' },
            },
          },
          items: { type: 'array', maxItems: 100, items: { $ref: '#/components/schemas/MobileCommerceItem' } },
          pageInfo: {
            type: 'object', additionalProperties: false,
            required: ['returnedCount', 'hasMore', 'nextCursor'],
            properties: {
              returnedCount: { type: 'integer', minimum: 0, maximum: 100 },
              hasMore: { type: 'boolean' },
              nextCursor: { type: ['string', 'null'], maxLength: 2048 },
            },
          },
        },
      },
      MobileCommercePageEnvelope: {
        type: 'object', additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: { $ref: '#/components/schemas/MobileCommercePage' },
          requestId: { type: 'string', minLength: 1 },
        },
      },
      VirtualSupermarketPlacementPart: {
        type: 'object', additionalProperties: false,
        required: ['key', 'name', 'sortOrder'],
        properties: {
          key: { type: 'string', minLength: 1, maxLength: 128 },
          name: { type: 'string', minLength: 1, maxLength: 160 },
          sortOrder: { type: 'integer', minimum: 0, maximum: 1_000_000 },
        },
      },
      VirtualSupermarketCategory: {
        type: 'object', additionalProperties: false,
        required: ['id', 'key', 'name', 'sortOrder', 'department', 'aisle', 'shelf', 'revision', 'updatedAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          key: { type: 'string', minLength: 1, maxLength: 128 },
          name: { type: 'string', minLength: 1, maxLength: 160 },
          sortOrder: { type: 'integer', minimum: 0, maximum: 1_000_000 },
          department: { $ref: '#/components/schemas/VirtualSupermarketPlacementPart' },
          aisle: { $ref: '#/components/schemas/VirtualSupermarketPlacementPart' },
          shelf: { $ref: '#/components/schemas/VirtualSupermarketPlacementPart' },
          revision: { type: 'integer', minimum: 1 },
          updatedAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      VirtualSupermarketShelf: {
        type: 'object', additionalProperties: false,
        required: ['key', 'name', 'sortOrder', 'categories'],
        properties: {
          key: { type: 'string', minLength: 1, maxLength: 128 },
          name: { type: 'string', minLength: 1, maxLength: 160 },
          sortOrder: { type: 'integer', minimum: 0, maximum: 1_000_000 },
          categories: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['id', 'key', 'name', 'sortOrder'],
              properties: {
                id: { type: 'string', format: 'uuid' },
                key: { type: 'string', minLength: 1, maxLength: 128 },
                name: { type: 'string', minLength: 1, maxLength: 160 },
                sortOrder: { type: 'integer', minimum: 0, maximum: 1_000_000 },
              },
            },
          },
        },
      },
      VirtualSupermarketAisle: {
        type: 'object', additionalProperties: false,
        required: ['key', 'name', 'sortOrder', 'shelves'],
        properties: {
          key: { type: 'string', minLength: 1, maxLength: 128 },
          name: { type: 'string', minLength: 1, maxLength: 160 },
          sortOrder: { type: 'integer', minimum: 0, maximum: 1_000_000 },
          shelves: { type: 'array', items: { $ref: '#/components/schemas/VirtualSupermarketShelf' } },
        },
      },
      VirtualSupermarketDepartment: {
        type: 'object', additionalProperties: false,
        required: ['key', 'name', 'sortOrder', 'aisles'],
        properties: {
          key: { type: 'string', minLength: 1, maxLength: 128 },
          name: { type: 'string', minLength: 1, maxLength: 160 },
          sortOrder: { type: 'integer', minimum: 0, maximum: 1_000_000 },
          aisles: { type: 'array', items: { $ref: '#/components/schemas/VirtualSupermarketAisle' } },
        },
      },
      VirtualSupermarketMetadata: {
        type: 'object', additionalProperties: false,
        required: [
          'contractVersion', 'platform', 'sourceMode', 'storefrontRevision',
          'catalogRevision', 'categories', 'departments', 'supportedSorts',
        ],
        properties: {
          contractVersion: { type: 'string', const: 'mx-insight-hub.data-products.virtual-supermarket.v1' },
          platform: { type: 'string', const: 'virtual_supermarket' },
          sourceMode: { type: 'string', const: 'stored' },
          storefrontRevision: { type: 'integer', minimum: 1 },
          catalogRevision: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
          categories: { type: 'array', items: { $ref: '#/components/schemas/VirtualSupermarketCategory' } },
          departments: { type: 'array', items: { $ref: '#/components/schemas/VirtualSupermarketDepartment' } },
          supportedSorts: {
            type: 'array', const: ['newest', 'title_asc', 'price_asc', 'price_desc'],
          },
        },
      },
      VirtualSupermarketMetadataEnvelope: {
        type: 'object', additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: { $ref: '#/components/schemas/VirtualSupermarketMetadata' },
          requestId: { type: 'string', minLength: 1 },
        },
      },
      VirtualSupermarketMarketplace: {
        type: 'object', additionalProperties: false,
        required: ['id', 'name'],
        properties: {
          id: {
            type: ['string', 'null'],
            format: 'uuid',
            description: 'Reviewed public marketplace-directory UUID, or null when no approved mapping exists.',
          },
          name: {
            type: ['string', 'null'],
            description: 'Reviewed public marketplace name, or null when no approved mapping exists.',
          },
        },
      },
      VirtualSupermarketPrice: {
        type: 'object', additionalProperties: false,
        required: ['amount', 'currency', 'display', 'provenance'],
        properties: {
          amount: {
            type: ['string', 'null'],
            pattern: '^(?:0|[1-9]\\d{0,17})(?:\\.\\d{1,2})?$',
            description: 'Normalized decimal amount when the source or curated override is valid.',
          },
          currency: {
            type: ['string', 'null'],
            pattern: '^[A-Z]{3}$',
            description: 'Reviewed ISO currency for a curated override. Source prices keep null because the fixed source has no currency field.',
          },
          display: {
            type: ['string', 'null'],
            description: 'Normalized customer-facing amount text; raw structured source evidence is never returned here and it does not imply a currency.',
          },
          provenance: { type: 'string', enum: ['curated', 'source', 'missing'] },
        },
      },
      VirtualSupermarketProduct: {
        type: 'object', additionalProperties: false,
        required: [
          'id', 'dataVersion', 'listing', 'placement', 'category', 'marketplace',
          'product', 'shop', 'signals', 'collectedAt',
        ],
        properties: {
          id: {
            type: 'string',
            format: 'uuid',
            description: 'Stable Hub publication UUID; independently allocated and never the mobile-commerce capture/canonical row UUID.',
          },
          dataVersion: { type: 'string', pattern: '^\\d+:\\d+$' },
          listing: {
            type: 'object', additionalProperties: false,
            required: ['status', 'revision'],
            properties: {
              status: { type: 'string', const: 'on_shelf' },
              revision: { type: 'integer', minimum: 1 },
            },
          },
          placement: {
            type: 'object', additionalProperties: false,
            required: ['department', 'aisle', 'shelf', 'position'],
            properties: {
              department: { $ref: '#/components/schemas/VirtualSupermarketPlacementPart' },
              aisle: { $ref: '#/components/schemas/VirtualSupermarketPlacementPart' },
              shelf: { $ref: '#/components/schemas/VirtualSupermarketPlacementPart' },
              position: { type: ['integer', 'null'], minimum: 0, maximum: 1_000_000 },
            },
          },
          category: {
            type: 'object', additionalProperties: false,
            required: ['id', 'key', 'name', 'sortOrder'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              key: { type: 'string', minLength: 1, maxLength: 128 },
              name: { type: 'string', minLength: 1, maxLength: 160 },
              sortOrder: { type: 'integer', minimum: 0, maximum: 1_000_000 },
            },
          },
          marketplace: { $ref: '#/components/schemas/VirtualSupermarketMarketplace' },
          product: {
            type: 'object', additionalProperties: false,
            required: ['title', 'specification', 'price', 'provenance'],
            properties: {
              title: { type: ['string', 'null'] },
              specification: { type: ['string', 'null'] },
              price: { $ref: '#/components/schemas/VirtualSupermarketPrice' },
              provenance: {
                type: 'object', additionalProperties: false,
                required: ['title', 'specification', 'price'],
                properties: {
                  title: { type: 'string', enum: ['curated', 'source', 'missing'] },
                  specification: { type: 'string', enum: ['curated', 'missing'] },
                  price: { type: 'string', enum: ['curated', 'source', 'missing'] },
                },
              },
            },
          },
          shop: {
            type: 'object', additionalProperties: false,
            required: ['name'],
            properties: {
              name: { type: ['string', 'null'] },
            },
          },
          signals: {
            type: 'object', additionalProperties: false,
            required: ['sales'],
            properties: { sales: { type: ['string', 'null'] } },
          },
          collectedAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      VirtualSupermarketFilters: {
        type: 'object', additionalProperties: false,
        required: ['status', 'categoryId', 'department', 'aisle', 'shelf', 'marketplace', 'query', 'sort'],
        properties: {
          status: { type: 'string', const: 'on_shelf' },
          categoryId: { type: ['string', 'null'], format: 'uuid' },
          department: { type: ['string', 'null'], maxLength: 128 },
          aisle: { type: ['string', 'null'], maxLength: 128 },
          shelf: { type: ['string', 'null'], maxLength: 128 },
          marketplace: { type: ['string', 'null'], maxLength: 160 },
          query: { type: ['string', 'null'], maxLength: 240 },
          sort: { type: 'string', enum: ['newest', 'title_asc', 'price_asc', 'price_desc'] },
        },
      },
      VirtualSupermarketPage: {
        type: 'object', additionalProperties: false,
        required: [
          'contractVersion', 'platform', 'sourceMode', 'storefrontRevision',
          'filters', 'items', 'pageInfo',
        ],
        properties: {
          contractVersion: { type: 'string', const: 'mx-insight-hub.data-products.virtual-supermarket.v1' },
          platform: { type: 'string', const: 'virtual_supermarket' },
          sourceMode: { type: 'string', const: 'stored' },
          storefrontRevision: { type: 'integer', minimum: 1 },
          filters: { $ref: '#/components/schemas/VirtualSupermarketFilters' },
          items: { type: 'array', maxItems: 100, items: { $ref: '#/components/schemas/VirtualSupermarketProduct' } },
          pageInfo: {
            type: 'object', additionalProperties: false,
            required: ['returnedCount', 'hasMore', 'nextCursor'],
            properties: {
              returnedCount: { type: 'integer', minimum: 0, maximum: 100 },
              hasMore: { type: 'boolean' },
              nextCursor: { type: ['string', 'null'], maxLength: 2048 },
            },
          },
        },
      },
      VirtualSupermarketPageEnvelope: {
        type: 'object', additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: { $ref: '#/components/schemas/VirtualSupermarketPage' },
          requestId: { type: 'string', minLength: 1 },
        },
      },
      VirtualSupermarketDetail: {
        type: 'object', additionalProperties: false,
        required: ['contractVersion', 'platform', 'sourceMode', 'storefrontRevision', 'item'],
        properties: {
          contractVersion: { type: 'string', const: 'mx-insight-hub.data-products.virtual-supermarket.v1' },
          platform: { type: 'string', const: 'virtual_supermarket' },
          sourceMode: { type: 'string', const: 'stored' },
          storefrontRevision: { type: 'integer', minimum: 1 },
          item: { $ref: '#/components/schemas/VirtualSupermarketProduct' },
        },
      },
      VirtualSupermarketDetailEnvelope: {
        type: 'object', additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: { $ref: '#/components/schemas/VirtualSupermarketDetail' },
          requestId: { type: 'string', minLength: 1 },
        },
      },
      SourceCatalogItemsEnvelope: {
        type: 'object', additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object', additionalProperties: false,
            required: ['contractVersion', 'catalogEntry', 'dataProductKey', 'page'],
            properties: {
              contractVersion: { type: 'string', const: 'mx-insight-hub.data-products.source-catalog-items.v1' },
              catalogEntry: { $ref: '#/components/schemas/SourceCatalogEntry' },
              dataProductKey: { type: 'string', const: 'mobile-commerce-items' },
              page: { $ref: '#/components/schemas/MobileCommercePage' },
            },
          },
          requestId: { type: 'string', minLength: 1 },
        },
      },
      SourceCatalogEntry: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id', 'sourceKey', 'legacySequence', 'canonicalName', 'aliases', 'sourceKind',
          'parentSourceId', 'majorCategory', 'scenarios', 'regions', 'entryModules',
          'monitorableContent', 'extractableClues', 'trackingFields', 'suggestedAccess',
          'complianceBoundary', 'priority', 'coverageStatus', 'deliveryStatus',
          'reviewStatus', 'runtimeStatus', 'ownerId', 'owner', 'connectorHints', 'tags', 'notes',
          'redactedFields',
        ],
        properties: {
          id: { type: 'string', format: 'uuid' },
          sourceKey: { type: 'string', minLength: 1, maxLength: 128 },
          legacySequence: { type: ['integer', 'null'], minimum: 1 },
          canonicalName: { type: 'string', minLength: 1, maxLength: 160 },
          aliases: { type: 'array', items: { type: 'string' } },
          sourceKind: { type: 'string', enum: ['platform', 'platform_module', 'source_class', 'registry', 'provider', 'dataset', 'other'] },
          parentSourceId: { type: ['string', 'null'], format: 'uuid' },
          majorCategory: { type: 'string' },
          scenarios: { type: 'array', items: { type: 'string' } },
          regions: { type: 'array', items: { type: 'string' } },
          entryModules: { type: 'array', items: { type: 'string' } },
          monitorableContent: { type: 'array', items: { type: 'string' } },
          extractableClues: { type: 'array', items: { type: 'string' } },
          trackingFields: { type: 'array', items: { type: 'string' } },
          suggestedAccess: { type: 'array', items: { type: 'string' } },
          complianceBoundary: { type: ['string', 'null'] },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          coverageStatus: { type: 'string', enum: ['unknown', 'not_covered', 'partial', 'covered'] },
          deliveryStatus: { type: 'string', enum: ['exploring', 'planned', 'doing', 'blocked', 'complete', 'paused', 'retired'] },
          reviewStatus: { type: 'string', enum: ['needs_review', 'verified', 'rejected'] },
          runtimeStatus: { type: 'string', enum: ['not_configured', 'unknown', 'healthy', 'degraded', 'failed'] },
          ownerId: { type: ['string', 'null'], format: 'uuid' },
          owner: { type: ['string', 'null'] },
          connectorHints: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
          notes: { type: ['string', 'null'] },
          redactedFields: { type: 'array', uniqueItems: true, items: { type: 'string' } },
        },
      },
      SourceCatalogFilters: {
        type: 'object',
        additionalProperties: false,
        required: ['query', 'sourceKind', 'majorCategory', 'scenario', 'region', 'coverageStatus', 'deliveryStatus', 'reviewStatus', 'runtimeStatus', 'priority', 'ownerId', 'tag'],
        properties: Object.fromEntries(sourceCatalogQueryParameters
          .filter(({ name }) => !['pageSize', 'cursor'].includes(name))
          .map(({ name, schema }) => [name, {
            ...schema,
            type: schema.type === 'string' ? ['string', 'null'] : schema.type,
            ...(schema.enum ? { enum: [...schema.enum, null] } : {}),
          }])),
      },
      SourceCatalogPageInfo: {
        type: 'object',
        additionalProperties: false,
        required: ['returnedCount', 'totalCount', 'hasMore', 'nextCursor'],
        properties: {
          returnedCount: { type: 'integer', minimum: 0, maximum: 100 },
          totalCount: { type: 'integer', minimum: 0 },
          hasMore: { type: 'boolean' },
          nextCursor: { type: ['string', 'null'], maxLength: 4096 },
        },
      },
      SourceCatalogPageEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object', additionalProperties: false,
            required: ['contractVersion', 'items', 'filters', 'pageInfo'],
            properties: {
              contractVersion: { type: 'string', const: 'source-catalog.public.v1' },
              items: { type: 'array', maxItems: 100, items: { $ref: '#/components/schemas/SourceCatalogEntry' } },
              filters: { $ref: '#/components/schemas/SourceCatalogFilters' },
              pageInfo: { $ref: '#/components/schemas/SourceCatalogPageInfo' },
            },
          },
          requestId: { type: 'string', minLength: 1 },
        },
      },
      SourceCatalogDetailEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object', additionalProperties: false,
            required: ['contractVersion', 'item'],
            properties: {
              contractVersion: { type: 'string', const: 'source-catalog.public.v1' },
              item: { $ref: '#/components/schemas/SourceCatalogEntry' },
            },
          },
          requestId: { type: 'string', minLength: 1 },
        },
      },
      SourceCatalogCoverageCounts: {
        type: 'object', additionalProperties: false,
        properties: Object.fromEntries(
          ['unknown', 'not_covered', 'partial', 'covered']
            .map((status) => [status, { type: 'integer', minimum: 0 }]),
        ),
      },
      SourceCatalogDeliveryCounts: {
        type: 'object', additionalProperties: false,
        properties: Object.fromEntries(
          ['exploring', 'planned', 'doing', 'blocked', 'complete', 'paused', 'retired']
            .map((status) => [status, { type: 'integer', minimum: 0 }]),
        ),
      },
      SourceCatalogPriorityCounts: {
        type: 'object', additionalProperties: false,
        properties: Object.fromEntries(
          ['P0', 'P1', 'P2', 'P3'].map((priority) => [priority, { type: 'integer', minimum: 0 }]),
        ),
      },
      SourceCatalogReviewCounts: {
        type: 'object', additionalProperties: false,
        properties: Object.fromEntries(
          ['needs_review', 'verified', 'rejected']
            .map((status) => [status, { type: 'integer', minimum: 0 }]),
        ),
      },
      SourceCatalogCategorySummary: {
        type: 'object', additionalProperties: false,
        required: ['category', 'total', 'covered', 'partial', 'complete', 'doing'],
        properties: {
          category: { type: 'string', minLength: 1 },
          total: { type: 'integer', minimum: 0 },
          covered: { type: 'integer', minimum: 0 },
          partial: { type: 'integer', minimum: 0 },
          complete: { type: 'integer', minimum: 0 },
          doing: { type: 'integer', minimum: 0 },
        },
      },
      SourceCatalogSummary: {
        type: 'object', additionalProperties: false,
        required: [
          'total', 'covered', 'uncovered', 'partial', 'unknownCoverage', 'coverageRate',
          'complete', 'inProgress', 'exploring', 'blocked', 'unassigned',
          'coverage', 'delivery', 'priorities', 'review', 'categories',
        ],
        properties: {
          total: { type: 'integer', minimum: 0 },
          covered: { type: 'integer', minimum: 0 },
          uncovered: { type: 'integer', minimum: 0 },
          partial: { type: 'integer', minimum: 0 },
          unknownCoverage: { type: 'integer', minimum: 0 },
          coverageRate: { type: 'number', minimum: 0, maximum: 100 },
          complete: { type: 'integer', minimum: 0 },
          inProgress: { type: 'integer', minimum: 0 },
          exploring: { type: 'integer', minimum: 0 },
          blocked: { type: 'integer', minimum: 0 },
          unassigned: { type: 'integer', minimum: 0 },
          coverage: { $ref: '#/components/schemas/SourceCatalogCoverageCounts' },
          delivery: { $ref: '#/components/schemas/SourceCatalogDeliveryCounts' },
          priorities: { $ref: '#/components/schemas/SourceCatalogPriorityCounts' },
          review: { $ref: '#/components/schemas/SourceCatalogReviewCounts' },
          categories: {
            type: 'array',
            items: { $ref: '#/components/schemas/SourceCatalogCategorySummary' },
          },
        },
      },
      SourceCatalogFacets: {
        type: 'object', additionalProperties: false,
        required: ['majorCategories', 'scenarios', 'regions', 'owners', 'connectorHints', 'tags'],
        properties: Object.fromEntries(
          ['majorCategories', 'scenarios', 'regions', 'owners', 'connectorHints', 'tags']
            .map((field) => [field, {
              type: 'array', uniqueItems: true, items: { type: 'string' },
            }]),
        ),
      },
      SourceCatalogMetadataEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object', additionalProperties: false,
            required: ['contractVersion', 'fields', 'enums', 'summary', 'facets', 'taxonomy', 'owners'],
            properties: {
              contractVersion: { type: 'string', const: 'source-catalog.public.v1' },
              fields: {
                type: 'array',
                items: {
                  type: 'object', additionalProperties: false,
                  required: ['key', 'label', 'type'],
                  properties: {
                    key: { type: 'string' }, label: { type: 'string' }, type: { type: 'string' },
                    enum: { type: 'string' }, taxonomyKind: { type: 'string', enum: ['major_category', 'scenario', 'region', 'tag'] },
                  },
                },
              },
              enums: {
                type: 'object', additionalProperties: false,
                required: ['sourceKinds', 'coverageStatuses', 'deliveryStatuses', 'reviewStatuses', 'runtimeStatuses', 'priorities', 'taxonomyKinds'],
                properties: {
                  sourceKinds: { type: 'array', items: { type: 'string', enum: ['platform', 'platform_module', 'source_class', 'registry', 'provider', 'dataset', 'other'] } },
                  coverageStatuses: { type: 'array', items: { type: 'string', enum: ['unknown', 'not_covered', 'partial', 'covered'] } },
                  deliveryStatuses: { type: 'array', items: { type: 'string', enum: ['exploring', 'planned', 'doing', 'blocked', 'complete', 'paused', 'retired'] } },
                  reviewStatuses: { type: 'array', items: { type: 'string', enum: ['needs_review', 'verified', 'rejected'] } },
                  runtimeStatuses: { type: 'array', items: { type: 'string', enum: ['not_configured', 'unknown', 'healthy', 'degraded', 'failed'] } },
                  priorities: { type: 'array', items: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] } },
                  taxonomyKinds: { type: 'array', items: { type: 'string', enum: ['major_category', 'scenario', 'region', 'tag'] } },
                },
              },
              summary: { $ref: '#/components/schemas/SourceCatalogSummary' },
              facets: { $ref: '#/components/schemas/SourceCatalogFacets' },
              taxonomy: {
                type: 'array', items: {
                  type: 'object', additionalProperties: false,
                  required: ['id', 'termKey', 'kind', 'displayName', 'description', 'color', 'sortOrder', 'usageCount'],
                  properties: {
                    id: { type: 'string', format: 'uuid' }, termKey: { type: 'string' },
                    kind: { type: 'string', enum: ['major_category', 'scenario', 'region', 'tag'] },
                    displayName: { type: 'string' }, description: { type: ['string', 'null'] },
                    color: { type: ['string', 'null'] }, sortOrder: { type: 'integer' },
                    usageCount: { type: 'integer', minimum: 0 },
                    redactedFields: { type: 'array', uniqueItems: true, items: { type: 'string' } },
                  },
                },
              },
              owners: {
                type: 'array', items: {
                  type: 'object', additionalProperties: false,
                  required: ['id', 'displayName', 'description', 'usageCount'],
                  properties: {
                    id: { type: 'string', format: 'uuid' }, displayName: { type: 'string' },
                    description: { type: ['string', 'null'] }, usageCount: { type: 'integer', minimum: 0 },
                    redactedFields: { type: 'array', uniqueItems: true, items: { type: 'string' } },
                  },
                },
              },
            },
          },
          requestId: { type: 'string', minLength: 1 },
        },
      },
      PublicOpinionProvince: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'name'],
        properties: {
          code: {
            type: 'string',
            pattern: '^CN-[A-Z]{2}$',
            description: 'Normalized ISO 3166-2:CN province-level code.',
          },
          name: { type: 'string', minLength: 1, description: 'Normalized short Chinese display name.' },
        },
      },
      PublicOpinionRegionCatalogEntry: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'name', 'officialName', 'level', 'parentCode'],
        properties: {
          code: { type: 'string', pattern: '^CN-[A-Z]{2}$' },
          name: { type: 'string', minLength: 1 },
          officialName: { type: 'string', minLength: 1 },
          level: { type: 'string', const: 'province' },
          parentCode: { type: 'string', const: 'CN' },
        },
      },
      PublicOpinionRegionScope: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'name', 'officialName', 'level', 'parentCode'],
        properties: {
          code: { type: 'string', pattern: '^CN(?:-[A-Z]{2})?$' },
          name: { type: 'string', minLength: 1 },
          officialName: { type: 'string', minLength: 1 },
          level: { type: 'string', enum: ['country', 'province'] },
          parentCode: { type: ['string', 'null'], enum: ['CN', null] },
        },
      },
      PublicOpinionRegionVisibility: {
        type: 'object',
        additionalProperties: false,
        required: ['mode', 'qualityFiltered', 'corpusDefinition'],
        properties: {
          mode: { type: 'string', const: 'all_ingested' },
          qualityFiltered: { type: 'boolean', const: false },
          corpusDefinition: { type: 'string', const: 'canonical_current_safe' },
        },
      },
      PublicOpinionRegionsEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            additionalProperties: false,
            required: ['contractVersion', 'parentCode', 'level', 'regions'],
            properties: {
              contractVersion: { type: 'string', const: 'mx-insight-hub.public-opinion.regions.v1' },
              parentCode: { type: 'string', const: 'CN' },
              level: { type: 'string', const: 'province' },
              regions: {
                type: 'array', minItems: 34, maxItems: 34,
                items: { $ref: '#/components/schemas/PublicOpinionRegionCatalogEntry' },
              },
            },
          },
          requestId: { type: 'string', minLength: 1 },
        },
      },
      PublicOpinionOrigin: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'type', 'platform'],
        properties: {
          name: { type: ['string', 'null'], description: 'Reviewed public-facing source name, when available.' },
          type: { type: ['string', 'null'], description: 'Reviewed source/content type, when available.' },
          platform: { type: ['string', 'null'], description: 'Reviewed originating content platform, distinct from the public_opinion authorization platform.' },
        },
      },
      PublicOpinionQuality: {
        type: 'object',
        additionalProperties: false,
        required: ['stage', 'status', 'score', 'threshold', 'geographyVerified'],
        description: 'Hub-owned publication metadata. Legacy province/detail responses include it only with candidate visibility; the all-ingested region feed requires it on every formal or candidate item.',
        properties: {
          stage: { type: 'string', enum: ['formal', 'candidate'] },
          status: { type: 'string', enum: ['formal', 'pending', 'qualified', 'rejected', 'failed'] },
          score: { type: ['number', 'null'], minimum: 0, maximum: 100 },
          threshold: { type: ['number', 'null'], minimum: 0, maximum: 100 },
          geographyVerified: { type: 'boolean' },
        },
      },
      PublicOpinionLocation: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'type', 'country', 'countryCode', 'geoScope'],
        description: 'Hub-normalized event location returned only with explicit candidate visibility when location evidence is available.',
        properties: {
          label: { type: ['string', 'null'] },
          type: {
            type: ['string', 'null'],
            enum: ['province', 'country', 'region', 'city', 'maritime', 'unknown', null],
          },
          country: { type: ['string', 'null'] },
          countryCode: { type: ['string', 'null'] },
          geoScope: {
            type: ['string', 'null'],
            enum: ['province', 'multi_province', 'national', 'maritime', 'overseas', 'unknown', null],
          },
        },
      },
      PublicOpinionItem: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'summary', 'url', 'publishedAt', 'collectedAt', 'province', 'heatScore', 'origin'],
        properties: {
          id: { type: 'string', format: 'uuid', description: 'Hub canonical record id.' },
          title: { type: ['string', 'null'] },
          summary: { type: ['string', 'null'] },
          url: { type: ['string', 'null'] },
          publishedAt: { type: ['string', 'null'], format: 'date-time' },
          collectedAt: { type: ['string', 'null'], format: 'date-time' },
          province: {
            description: 'Normalized province. Null is retained for a legacy/unclassified detail record; province feeds themselves contain only the requested normalized province.',
            oneOf: [
              { $ref: '#/components/schemas/PublicOpinionProvince' },
              { type: 'null' },
            ],
          },
          heatScore: { type: ['number', 'null'], description: 'Typed source heat score. It is used only by the province hot ordering and is not a cross-source relevance score.' },
          origin: { $ref: '#/components/schemas/PublicOpinionOrigin' },
          quality: { $ref: '#/components/schemas/PublicOpinionQuality' },
          location: { $ref: '#/components/schemas/PublicOpinionLocation' },
        },
      },
      PublicOpinionRegionFeedItem: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id', 'title', 'summary', 'url', 'publishedAt', 'collectedAt',
          'province', 'heatScore', 'origin', 'quality',
        ],
        properties: {
          id: { type: 'string', format: 'uuid', description: 'Hub canonical record id.' },
          title: { type: ['string', 'null'] },
          summary: { type: ['string', 'null'] },
          url: { type: ['string', 'null'] },
          publishedAt: { type: ['string', 'null'], format: 'date-time' },
          collectedAt: { type: ['string', 'null'], format: 'date-time' },
          province: {
            description: 'Assigned normalized province, or null for a nationwide unclassified item.',
            oneOf: [
              { $ref: '#/components/schemas/PublicOpinionProvince' },
              { type: 'null' },
            ],
          },
          heatScore: { type: ['number', 'null'] },
          origin: { $ref: '#/components/schemas/PublicOpinionOrigin' },
          quality: { $ref: '#/components/schemas/PublicOpinionQuality' },
          location: { $ref: '#/components/schemas/PublicOpinionLocation' },
        },
      },
      PublicOpinionPageInfo: {
        type: 'object',
        additionalProperties: false,
        required: ['returnedCount', 'hasMore', 'nextCursor'],
        properties: {
          returnedCount: { type: 'integer', minimum: 0, maximum: 100 },
          hasMore: { type: 'boolean' },
          nextCursor: {
            type: ['string', 'null'],
            maxLength: 8192,
            description: 'Signed opaque keyset cursor. Return it unchanged with the same province, sort, bounds and pageSize.',
          },
        },
      },
      PublicOpinionPageEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            additionalProperties: false,
            required: ['contractVersion', 'province', 'sort', 'items', 'pageInfo'],
            properties: {
              contractVersion: { type: 'string', const: 'mx-insight-hub.public-opinion.v1' },
              province: { $ref: '#/components/schemas/PublicOpinionProvince' },
              sort: { type: 'string', enum: ['hot', 'latest'] },
              items: { type: 'array', maxItems: 100, items: { $ref: '#/components/schemas/PublicOpinionItem' } },
              pageInfo: { $ref: '#/components/schemas/PublicOpinionPageInfo' },
            },
          },
          requestId: { type: 'string', minLength: 1 },
        },
      },
      PublicOpinionRegionFeedEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            additionalProperties: false,
            required: [
              'contractVersion', 'region', 'visibility', 'sort', 'timeBasis',
              'from', 'to', 'items', 'pageInfo',
            ],
            properties: {
              contractVersion: { type: 'string', const: 'mx-insight-hub.public-opinion.region-feed.v1' },
              region: { $ref: '#/components/schemas/PublicOpinionRegionScope' },
              visibility: { $ref: '#/components/schemas/PublicOpinionRegionVisibility' },
              sort: { type: 'string', const: 'latest' },
              timeBasis: { type: 'string', const: 'effective' },
              from: { type: 'string', format: 'date-time' },
              to: { type: 'string', format: 'date-time' },
              items: {
                type: 'array', maxItems: 100,
                items: { $ref: '#/components/schemas/PublicOpinionRegionFeedItem' },
              },
              pageInfo: { $ref: '#/components/schemas/PublicOpinionPageInfo' },
            },
          },
          requestId: { type: 'string', minLength: 1 },
        },
      },
      PublicOpinionItemEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: { $ref: '#/components/schemas/PublicOpinionItem' },
          requestId: { type: 'string', minLength: 1 },
        },
      },
      PublicOpinionCoverageProvince: {
        type: 'object',
        additionalProperties: false,
        required: [
          'province', 'formalCount', 'qualifiedCandidateCount', 'candidateCount',
          'qualifiedCandidateRate', 'verifiedCount', 'verifiedRate',
          'availableCount', 'shortfall', 'meetsTarget', 'averageQualityScore',
        ],
        properties: {
          province: { $ref: '#/components/schemas/PublicOpinionProvince' },
          formalCount: { type: 'integer', minimum: 0 },
          qualifiedCandidateCount: { type: 'integer', minimum: 0 },
          candidateCount: { type: 'integer', minimum: 0 },
          qualifiedCandidateRate: { type: ['number', 'null'], minimum: 0, maximum: 1 },
          verifiedCount: { type: 'integer', minimum: 0 },
          verifiedRate: { type: ['number', 'null'], minimum: 0, maximum: 1 },
          availableCount: { type: 'integer', minimum: 0 },
          shortfall: { type: 'integer', minimum: 0 },
          meetsTarget: { type: 'boolean' },
          averageQualityScore: { type: ['number', 'null'], minimum: 0, maximum: 100 },
        },
      },
      PublicOpinionCoverageTotals: {
        type: 'object',
        additionalProperties: false,
        required: ['provinceCount', 'availableCount', 'provincesMeetingTarget', 'totalShortfall'],
        properties: {
          provinceCount: { type: 'integer', minimum: 0, maximum: 34 },
          availableCount: { type: 'integer', minimum: 0 },
          provincesMeetingTarget: { type: 'integer', minimum: 0, maximum: 34 },
          totalShortfall: { type: 'integer', minimum: 0 },
        },
      },
      PublicOpinionCoverageEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            additionalProperties: false,
            required: [
              'contractVersion', 'from', 'to', 'includeCandidates', 'minQualityScore',
              'targetPerProvince', 'featuredProvinceCodes', 'totals', 'provinces',
            ],
            properties: {
              contractVersion: { type: 'string', const: 'mx-insight-hub.public-opinion.coverage.v1' },
              from: { type: 'string', format: 'date-time' },
              to: { type: 'string', format: 'date-time' },
              includeCandidates: {
                oneOf: [
                  { type: 'boolean', const: false },
                  { type: 'string', enum: ['qualified', 'all'] },
                ],
              },
              minQualityScore: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
              targetPerProvince: { type: 'integer', minimum: 1, maximum: 100 },
              featuredProvinceCodes: {
                type: 'array', maxItems: 8, uniqueItems: true,
                items: { type: 'string', pattern: '^CN-[A-Z]{2}$' },
              },
              totals: { $ref: '#/components/schemas/PublicOpinionCoverageTotals' },
              provinces: {
                type: 'array', maxItems: 34,
                items: { $ref: '#/components/schemas/PublicOpinionCoverageProvince' },
              },
            },
          },
          requestId: { type: 'string', minLength: 1 },
        },
      },
      PublicOpinionDiagnosticsSourceScope: {
        type: 'object', additionalProperties: false,
        required: ['mode', 'datasets'],
        properties: {
          mode: { type: 'string', const: 'canonical' },
          datasets: { type: 'array', const: ['public-opinion.province.v1'] },
        },
      },
      PublicOpinionDiagnosticsWindow: {
        type: 'object', additionalProperties: false,
        required: ['from', 'to'],
        properties: {
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
        },
      },
      PublicOpinionDiagnosticsCounts: {
        type: 'object',
        additionalProperties: { type: 'integer', minimum: 0 },
      },
      PublicOpinionDiagnosticsFunnelEnvelope: {
        type: 'object', additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object', additionalProperties: false,
            required: ['contractVersion', 'sourceScope', 'window', 'canonical', 'publication', 'time', 'geography', 'heat', 'visibility', 'reasons'],
            properties: {
              contractVersion: { type: 'string', const: 'mx-insight-hub.data-products.public-opinion-funnel.v1' },
              sourceScope: { $ref: '#/components/schemas/PublicOpinionDiagnosticsSourceScope' },
              window: { $ref: '#/components/schemas/PublicOpinionDiagnosticsWindow' },
              canonical: { $ref: '#/components/schemas/PublicOpinionDiagnosticsCounts' },
              publication: {
                type: 'object', additionalProperties: false,
                required: ['withState', 'missingState', 'stages', 'statuses'],
                properties: {
                  withState: { type: 'integer', minimum: 0 },
                  missingState: { type: 'integer', minimum: 0 },
                  stages: { $ref: '#/components/schemas/PublicOpinionDiagnosticsCounts' },
                  statuses: { $ref: '#/components/schemas/PublicOpinionDiagnosticsCounts' },
                },
              },
              time: { $ref: '#/components/schemas/PublicOpinionDiagnosticsCounts' },
              geography: {
                type: 'object', additionalProperties: false,
                required: ['withProvince', 'withoutProvince', 'scopes'],
                properties: {
                  withProvince: { type: 'integer', minimum: 0 },
                  withoutProvince: { type: 'integer', minimum: 0 },
                  scopes: { $ref: '#/components/schemas/PublicOpinionDiagnosticsCounts' },
                },
              },
              heat: { $ref: '#/components/schemas/PublicOpinionDiagnosticsCounts' },
              visibility: { $ref: '#/components/schemas/PublicOpinionDiagnosticsCounts' },
              reasons: { $ref: '#/components/schemas/PublicOpinionDiagnosticsCounts' },
            },
          },
          requestId: { type: 'string', minLength: 1 },
        },
      },
      PublicOpinionDiagnosticRecordFields: {
        type: 'object',
        required: ['id', 'title', 'summary', 'url', 'contentType', 'authorName', 'eventTime', 'collectedAt', 'heatScore', 'sourceStage', 'publicationStatus', 'qualityScore', 'qualificationThreshold', 'provinceCode', 'geography', 'source', 'qualityFlags', 'rejectionCodes', 'diagnostics'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          title: { type: ['string', 'null'] },
          summary: { type: ['string', 'null'] },
          url: { type: ['string', 'null'], format: 'uri' },
          contentType: { type: ['string', 'null'] },
          authorName: { type: ['string', 'null'] },
          eventTime: { type: ['string', 'null'], format: 'date-time' },
          collectedAt: { type: ['string', 'null'], format: 'date-time' },
          heatScore: { type: ['number', 'null'] },
          sourceStage: { type: ['string', 'null'] },
          publicationStatus: { type: ['string', 'null'] },
          qualityScore: { type: ['number', 'null'] },
          qualificationThreshold: { type: ['number', 'null'] },
          provinceCode: { type: ['string', 'null'] },
          geography: {
            type: 'object', additionalProperties: false,
            required: ['verified', 'scope', 'countryCode', 'countryName', 'locationLabel', 'locationType'],
            properties: {
              verified: { type: 'boolean' }, scope: { type: ['string', 'null'] },
              countryCode: { type: ['string', 'null'] }, countryName: { type: ['string', 'null'] },
              locationLabel: { type: ['string', 'null'] }, locationType: { type: ['string', 'null'] },
            },
          },
          source: {
            type: 'object', additionalProperties: false,
            required: ['type', 'platform'],
            properties: { type: { type: ['string', 'null'] }, platform: { type: ['string', 'null'] } },
          },
          qualityFlags: { type: 'array', maxItems: 100, items: { type: 'string' } },
          rejectionCodes: { type: 'array', maxItems: 100, items: { type: 'string' } },
          diagnostics: {
            type: 'object', additionalProperties: false,
            required: ['hasPublicationState', 'coverageVisible', 'hotVisible', 'reasons'],
            properties: {
              hasPublicationState: { type: 'boolean' }, coverageVisible: { type: 'boolean' }, hotVisible: { type: 'boolean' },
              reasons: { type: 'array', items: { type: 'string', enum: ['missing_publication_state', 'not_formal_stage', 'not_formal_status', 'missing_event_time', 'outside_window', 'missing_province', 'missing_heat'] } },
            },
          },
        },
      },
      PublicOpinionDiagnosticRecord: {
        allOf: [{ $ref: '#/components/schemas/PublicOpinionDiagnosticRecordFields' }],
        unevaluatedProperties: false,
      },
      PublicOpinionDiagnosticRecordDetail: {
        allOf: [
          { $ref: '#/components/schemas/PublicOpinionDiagnosticRecordFields' },
          {
            type: 'object',
            required: ['contractVersion', 'sourceScope', 'window'],
            properties: {
              contractVersion: { type: 'string', const: 'mx-insight-hub.data-products.public-opinion-record.v1' },
              sourceScope: { $ref: '#/components/schemas/PublicOpinionDiagnosticsSourceScope' },
              window: { $ref: '#/components/schemas/PublicOpinionDiagnosticsWindow' },
            },
          },
        ],
        unevaluatedProperties: false,
      },
      PublicOpinionDiagnosticsPageInfo: {
        type: 'object', additionalProperties: false,
        required: ['returnedCount', 'hasMore', 'nextCursor'],
        properties: {
          returnedCount: { type: 'integer', minimum: 0, maximum: 100 },
          hasMore: { type: 'boolean' },
          nextCursor: { type: ['string', 'null'], maxLength: 2048 },
        },
      },
      PublicOpinionDiagnosticsRecordsEnvelope: {
        type: 'object', additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object', additionalProperties: false,
            required: ['contractVersion', 'sourceScope', 'window', 'filters', 'items', 'pageInfo'],
            properties: {
              contractVersion: { type: 'string', const: 'mx-insight-hub.data-products.public-opinion-records.v1' },
              sourceScope: { $ref: '#/components/schemas/PublicOpinionDiagnosticsSourceScope' },
              window: { $ref: '#/components/schemas/PublicOpinionDiagnosticsWindow' },
              filters: { type: 'object', additionalProperties: false, required: ['query', 'reason', 'stage', 'status', 'province', 'scope', 'time', 'heat'], properties: Object.fromEntries(publicOpinionDiagnosticsRecordParameters.filter(({ name }) => !['from', 'to', 'pageSize', 'cursor'].includes(name)).map(({ name, schema }) => [name, { ...schema, ...(name === 'query' ? { type: ['string', 'null'] } : {}) }])) },
              items: { type: 'array', maxItems: 100, items: { $ref: '#/components/schemas/PublicOpinionDiagnosticRecord' } },
              pageInfo: { $ref: '#/components/schemas/PublicOpinionDiagnosticsPageInfo' },
            },
          },
          requestId: { type: 'string', minLength: 1 },
        },
      },
      PublicOpinionDiagnosticsRecordEnvelope: {
        type: 'object', additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: { $ref: '#/components/schemas/PublicOpinionDiagnosticRecordDetail' },
          requestId: { type: 'string', minLength: 1 },
        },
      },
      TelegramRecord: {
        type: 'object',
        additionalProperties: false,
        required: ['canonicalId', 'id', 'externalId', 'platform', 'objectType', 'contentType', 'title', 'text', 'url', 'author', 'relations', 'attributes', 'metrics', 'media', 'entities', 'links', 'eventTime', 'collectedAt', 'editedAt', 'lineage', 'sourceScope', 'dataVersion'],
        properties: {
          canonicalId: { type: ['string', 'null'], format: 'uuid' },
          id: { type: 'string' }, externalId: { type: 'string' }, platform: { type: 'string', const: 'telegram' },
          objectType: { type: 'string', enum: ['chat', 'message'] }, contentType: { type: ['string', 'null'] },
          title: { type: ['string', 'null'] }, text: { type: ['string', 'null'] }, url: { type: ['string', 'null'] },
          author: { type: ['object', 'null'], additionalProperties: true },
          relations: { type: 'object', additionalProperties: true }, attributes: { type: 'object', additionalProperties: true },
          metrics: { type: 'object', additionalProperties: true }, media: { type: 'object', additionalProperties: true },
          entities: { type: 'array', items: { type: 'object', additionalProperties: true } },
          links: { type: 'array', items: {} }, eventTime: { type: ['string', 'null'], format: 'date-time' },
          collectedAt: { type: ['string', 'null'], format: 'date-time' }, editedAt: { type: ['string', 'null'], format: 'date-time' },
          lineage: { type: 'object', additionalProperties: false, required: ['datasetId', 'origin'], properties: { datasetId: { type: 'string', enum: ['telegram.monitor.chats.v1', 'telegram.monitor.messages.v1', 'telegram.sqlite.chats.v1', 'telegram.sqlite.messages.v1'] }, origin: { type: 'string', enum: ['hub-direct', 'hub-import'] } } },
          sourceScope: { type: ['string', 'null'], enum: ['monitor', 'sqlite', null] },
          chatKey: { type: 'string', description: 'Present for chat records; use as chatId to select the exact stored source.' },
          kind: { type: 'string', enum: ['channel', 'group', 'unknown'], description: 'Present for chat records.' },
          dataVersion: { type: 'string' },
        },
      },
      TelegramPageEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            additionalProperties: false,
            required: ['contractVersion', 'sourceScope', 'filters', 'items', 'pageInfo'],
            properties: {
              contractVersion: { type: 'string', enum: ['mx-insight-hub.data-products.telegram-chats.v1', 'mx-insight-hub.data-products.telegram-messages.v1'] },
              sourceScope: {
                type: 'object', additionalProperties: false,
                required: ['selected', 'datasets'],
                properties: {
                  selected: { type: 'string', enum: ['all', 'monitor', 'sqlite'] },
                  datasets: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['telegram.monitor.chats.v1', 'telegram.monitor.messages.v1', 'telegram.sqlite.chats.v1', 'telegram.sqlite.messages.v1'] } },
                },
              },
              filters: {
                type: 'object', additionalProperties: false,
                properties: {
                  kind: { type: 'string', enum: ['all', 'channel', 'group', 'unknown'] },
                  query: { type: ['string', 'null'] }, chatId: { type: ['string', 'null'] },
                  from: { type: ['string', 'null'], format: 'date-time' },
                  to: { type: ['string', 'null'], format: 'date-time' },
                },
              },
              chat: { $ref: '#/components/schemas/TelegramRecord' },
              items: { type: 'array', items: { $ref: '#/components/schemas/TelegramRecord' } },
              pageInfo: { $ref: '#/components/schemas/PageInfo' },
            },
          },
          requestId: { type: 'string' },
        },
      },
      NightAllLegacyOperationAvailability: {
        type: 'object',
        additionalProperties: false,
        required: ['supportedPlatforms', 'readyPlatforms'],
        description: 'Hub-pinned, grant-filtered Night-All operation dispatch entry. readyPlatforms is always a subset of supportedPlatforms and means the deployed Hub contract permits dispatch. It is not populated by live Night-All discovery and does not prove handler, endpoint, provider, credential, or upstream health. A caller may dispatch only when its platform appears in both arrays.',
        properties: {
          supportedPlatforms: {
            type: 'array', uniqueItems: true,
            items: { type: 'string', minLength: 1, maxLength: 64 },
          },
          readyPlatforms: {
            type: 'array', uniqueItems: true,
            items: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
      },
      NightAllLegacySearchCapabilities: {
        type: 'object',
        additionalProperties: false,
        required: ['contractVersion', 'operations'],
        properties: {
          contractVersion: { type: 'string', const: 'night-all.legacy-search-capabilities.v1' },
          operations: {
            type: 'object',
            additionalProperties: false,
            required: ['raw', 'crawl', 'user-info'],
            properties: {
              raw: { $ref: '#/components/schemas/NightAllLegacyOperationAvailability' },
              crawl: { $ref: '#/components/schemas/NightAllLegacyOperationAvailability' },
              'user-info': { $ref: '#/components/schemas/NightAllLegacyOperationAvailability' },
            },
          },
        },
      },
      CapabilitiesEnvelope: {
        type: 'object',
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            required: ['platforms', 'legacySearch', 'capabilities'],
            properties: {
              platforms: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['platform', 'ready'],
                  properties: {
                    platform: { type: 'string' }, ready: { type: 'boolean' },
                    capabilities: { type: 'array', items: { type: 'string' } },
                    source: { type: 'string', enum: ['hub'], description: 'Present for Hub-owned platform entries.' },
                    servingMode: {
                      type: 'string',
                      enum: ['stored', 'live_with_stored_fallback'],
                      description: 'Present for Hub-owned stored or governed live-with-fallback entries.',
                    },
                    contractVersion: { type: 'string', description: 'Stable Hub contract version when the platform exposes one.' },
                    marketplaces: {
                      type: 'array',
                      items: { type: 'string', enum: ['taobao', 'tmall', 'jd', 'xiaohongshu_ec', 'xianyu'] },
                    },
                    pagination: { type: 'string', enum: ['opaque_cursor'] },
                    idempotencyKey: { type: 'string', enum: ['optional'] },
                    freshnessModes: {
                      type: 'array',
                      items: {
                        type: 'string',
                        enum: ['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay'],
                      },
                    },
                    context: { $ref: '#/components/schemas/CanonicalContextCapability' },
                    timeline: { $ref: '#/components/schemas/CanonicalTimelineCapability' },
                  },
                },
              },
              legacySearch: {
                description: 'Hub-pinned, grant-filtered dispatch matrix, or null when the consumer has no granted platform eligible for Night-All compatibility. It is authoritative only for Hub routing and is not a live Night-All capability or provider-readiness result. Null fails closed for every compatibility operation.',
                oneOf: [
                  { $ref: '#/components/schemas/NightAllLegacySearchCapabilities' },
                  { type: 'null' },
                ],
              },
              capabilities: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['capability', 'ready'],
                  properties: {
                    capability: {
                      type: 'string',
                      enum: ['nlp.tokenize', 'public_opinion.all_ingested.read', 'public_opinion.diagnostics.read'],
                    },
                    ready: { type: 'boolean' },
                  },
                },
              },
            },
          },
          requestId: { type: 'string' },
        },
      },
      EntitySearchEnvelope: {
        type: 'object',
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            required: ['items', 'pageInfo', 'searchMode'],
            properties: {
              items: { type: 'array', items: { type: 'object', additionalProperties: true } },
              pageInfo: { $ref: '#/components/schemas/PageInfo' },
              searchMode: { type: 'string', enum: ['elasticsearch', 'postgres'] },
            },
          },
          requestId: { type: 'string' },
        },
      },
      RequestStatusEnvelope: {
        type: 'object',
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            required: ['id', 'status'],
            oneOf: [
              { required: ['platform'], not: { required: ['capability'] } },
              { required: ['capability'], not: { required: ['platform'] } },
            ],
            properties: {
              id: { type: 'string', format: 'uuid' },
              status: { type: 'string', enum: ['reserved', 'committed', 'released', 'unknown'] },
              platform: { type: 'string' }, units: { type: ['integer', 'null'] },
              capability: { type: 'string' },
              sourceMode: { type: 'string', enum: ['live', 'stale'] },
              capturedAt: { type: 'string', format: 'date-time' },
              errorCode: { type: ['string', 'null'] }, reservedAt: { type: 'string', format: 'date-time' },
              completedAt: { type: ['string', 'null'], format: 'date-time' },
            },
          },
          requestId: { type: 'string' },
        },
      },
      UsageEnvelope: {
        type: 'object',
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            required: ['requests', 'committed', 'released', 'unknown', 'units'],
            properties: {
              requests: { type: 'integer' }, committed: { type: 'integer' }, released: { type: 'integer' },
              unknown: { type: 'integer' }, units: { type: 'integer' },
              averageUpstreamLatencyMs: { type: ['integer', 'null'] },
              byPlatform: { type: 'object', additionalProperties: true },
              byCapability: { type: 'object', additionalProperties: true },
            },
          },
          requestId: { type: 'string' },
        },
      },
      TokenizeEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            additionalProperties: false,
            required: ['capability', 'tokens', 'actualBackend', 'degraded', 'errorCode'],
            properties: {
              capability: { type: 'string', const: 'nlp.tokenize' },
              tokens: { type: 'array', minItems: 1, maxItems: 8192, items: { type: 'string', minLength: 1, maxLength: 512 } },
              actualBackend: { type: 'string', enum: ['hanlp', 'jieba', 'bigram'] },
              degraded: { type: 'boolean' },
              errorCode: { type: ['string', 'null'] },
            },
          },
          requestId: { type: 'string', format: 'uuid' },
        },
      },
      ErrorEnvelope: {
        type: 'object',
        required: ['error', 'requestId'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string' }, message: { type: 'string' }, details: { type: 'object', additionalProperties: true },
            },
          },
          requestId: { type: 'string' },
        },
      },
    },
  },
}

export const PUBLIC_DOCS_ROUTES = Object.freeze([
  { key: 'start', path: '/docs', label: '开始调用' },
  { key: 'rules', path: '/docs/auth', label: '认证与调用规则' },
  { key: 'source-catalog', path: '/docs/source-catalog', label: '数据源目录' },
  { key: 'virtual-supermarket', path: '/docs/virtual-supermarket', label: '虚拟超市' },
  { key: 'telegram', path: '/docs/telegram', label: 'Telegram 会话' },
  { key: 'public-opinion', path: '/docs/public-opinion', label: '全国舆情' },
  { key: 'search', path: '/docs/search', label: '通用搜索' },
  { key: 'night-all', path: '/docs/night-all', label: 'Night-All 兼容层' },
  { key: 'tools', path: '/docs/tools', label: '通用工具' },
  { key: 'discovery', path: '/docs/evidence', label: '能力与证据' },
  { key: 'errors', path: '/docs/errors', label: '错误与重试' },
])

const PUBLIC_DOCS_ROUTE_ALIASES = Object.freeze({
  '/docs/authentication': '/docs/auth',
  '/docs/operations': '/docs/evidence',
})

const PUBLIC_DOCS_TEMPLATE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="MX Insight Hub Open API 文档">
  <title>__PUBLIC_DOCS_TITLE__ · MX Insight Hub Open API</title>
  <style>
    :root { color-scheme: dark; --bg:#070b12; --panel:#101824; --line:#26364b; --text:#e9f2fb; --muted:#91a4b8; --cyan:#2de4d0; --blue:#5597ff; --amber:#f3c85a; }
    * { box-sizing:border-box; }
    body { margin:0; background:radial-gradient(circle at 75% 0,#102338 0,transparent 34rem),var(--bg); color:var(--text); font:15px/1.7 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    a { color:var(--cyan); text-decoration:none; }
    a:hover { text-decoration:underline; }
    .layout { display:grid; grid-template-columns:250px minmax(0,1fr); min-height:100vh; }
    aside { position:sticky; top:0; height:100vh; padding:28px 22px; border-right:1px solid var(--line); background:rgba(7,11,18,.9); }
    .brand { display:flex; gap:12px; align-items:center; margin-bottom:32px; }
    .mark { width:38px; height:38px; display:grid; place-items:center; border:1px solid var(--cyan); border-radius:10px; color:var(--cyan); font-weight:800; box-shadow:0 0 24px #2de4d033; }
    .brand strong { display:block; font-size:16px; }
    .brand span,.eyebrow,.muted { color:var(--muted); }
    nav a { display:block; padding:7px 10px; border-left:2px solid transparent; color:var(--muted); }
    nav a:hover { border-color:var(--cyan); color:var(--text); text-decoration:none; background:#11202d; }
    nav a.active { border-color:var(--cyan); color:var(--cyan); background:#112b31; }
    main { width:min(1120px,100%); padding:54px clamp(24px,5vw,72px) 90px; }
    .doc-page > :first-child { margin-top:0; }
    .eyebrow { text-transform:uppercase; letter-spacing:.18em; color:var(--cyan); font-size:12px; font-weight:700; }
    h1 { margin:.2em 0; font-size:clamp(34px,5vw,58px); line-height:1.08; }
    h2 { margin:62px 0 18px; font-size:27px; }
    h3 { margin:34px 0 12px; font-size:19px; }
    p { max-width:850px; }
    .lead { font-size:18px; color:#b9c7d5; }
    .cards { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; margin:28px 0; }
    .card,.endpoint,.notice { border:1px solid var(--line); border-radius:12px; background:linear-gradient(150deg,#111c29,#0c131e); }
    .card { padding:18px; }
    .card strong { display:block; color:var(--cyan); margin-bottom:5px; }
    .endpoint { padding:18px 20px; margin:14px 0; }
    .endpoint-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .method { min-width:54px; text-align:center; padding:2px 8px; border-radius:5px; background:#153c38; color:var(--cyan); font-size:12px; font-weight:800; letter-spacing:.06em; }
    .method.post { background:#173256; color:#80b4ff; }
    code,pre { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    .path { color:#e5edf7; overflow-wrap:anywhere; }
    pre { overflow:auto; padding:17px; border:1px solid #24354a; border-radius:10px; background:#050911; color:#cfe2f2; line-height:1.55; }
    :not(pre)>code { padding:.15em .4em; border-radius:4px; background:#142131; color:#9fc6ff; }
    .notice { padding:16px 18px; border-color:#4c4429; color:#efd786; }
    table { width:100%; border-collapse:collapse; margin:16px 0; }
    th,td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    footer { margin-top:70px; padding-top:20px; border-top:1px solid var(--line); color:var(--muted); }
    @media(max-width:820px){ .layout{display:block} aside{position:relative;height:auto;border-right:0;border-bottom:1px solid var(--line)} nav{display:flex;flex-wrap:wrap}.cards{grid-template-columns:1fr} main{padding-top:36px} }
  </style>
</head>
<body>
<div class="layout">
  <aside>
    <div class="brand"><div class="mark">MX</div><div><strong>MX Insight Hub</strong><span>Open API</span></div></div>
    <nav aria-label="文档目录">
      __PUBLIC_DOCS_NAV__
      <a href="/docs/openapi.json">OpenAPI JSON ↗</a>
    </nav>
  </aside>
  <main>
    <section class="doc-page" data-doc-page="start">
    <header id="start"><div class="eyebrow">Consumer contract · API v1</div><h1>统一数据访问，<br>由授权边界控制。</h1>
      <p class="lead">通过一个调用者 API Key 访问已授权平台与通用能力。Telegram 与省级舆情数据由 Hub 的规范化数据层提供，通用搜索和分词工具保持稳定响应结构。</p></header>
    <div class="cards"><div class="card"><strong>Base path</strong><code>/api/v1</code></div><div class="card"><strong>Authentication</strong>Bearer API Key 或 <code>x-api-key</code></div><div class="card"><strong>Machine contract</strong><a href="/docs/openapi.json">OpenAPI 3.1 JSON</a></div></div>
    <script>${PUBLIC_DOCS_LEGACY_ROUTE_SCRIPT}</script>
    </section>

    <section class="doc-page" data-doc-page="rules">
    <h2 id="rules">认证与调用规则</h2>
    <h3>认证及显式授权</h3>
    <p>每个请求必须携带已签发的调用者 API Key。建议使用 Bearer；不要把 Key 放进 URL、日志或前端代码。Key 只能调用后台为其调用者显式启用的平台或通用 capability；先调用 capabilities 确认授权与 Hub dispatch eligibility。</p>
    <pre><code>export HUB_URL="https://hub.example.com"
read -rsp 'MX Insight API Key: ' MX_INSIGHT_API_KEY
export MX_INSIGHT_API_KEY
printf '\\n'

curl -sS "$HUB_URL/api/v1/data/capabilities" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" | jq</code></pre>
    <h3>幂等、游标与配额</h3>
    <table><thead><tr><th>规则</th><th>客户端行为</th></tr></thead><tbody>
      <tr><td>POST 搜索</td><td><code>Idempotency-Key</code> 在同一 consumer 内全局唯一。仅在重试完全相同的路径和规范化 body 时复用；新路径、新 body 或新页面必须使用新 Key。</td></tr>
      <tr><td>舆情可见性契约升级</td><td>可命中 <code>public_opinion</code> 的 stored/canonical 搜索会把 formal/candidate 可见性契约写入幂等指纹。升级后不要复用升级前的 Key；请生成新 Key。旧 Key 会返回 <code>409 idempotency_conflict</code>，不会回放升级前可能未门禁的响应。</td></tr>
      <tr><td>结果新鲜度</td><td>可选 <code>type</code>：<code>fresh</code>（默认）表示始终检索当前数据，重放窗口为 120 秒，足以吸收一次重试而不会把 Key 变成缓存；<code>stable</code> 表示同一个 Key 永久返回首次的结果，用于报表、分页序列和审计等需要快照可复现的场景。<code>type</code> 参与请求指纹，同一个 Key 不能在两种语义之间切换。</td></tr>
      <tr><td>POST 分词</td><td>同样必须携带 <code>Idempotency-Key</code>；相同请求重放不会再次分词或重复计量。</td></tr>
      <tr><td>下一页</td><td>使用响应中的 <code>pageInfo.nextCursor</code>，不要解析或修改；因为 body 已变化，新页面必须使用新的幂等 Key。</td></tr>
      <tr><td>双向时间线</td><td>首屏读取 <code>pageInfo.older/newer.cursor</code>；每次续页只回传其中一个 <code>cursor</code>，方向已经签名在 token 中。不能同时传 <code>before/after</code>，也不能复用搜索或历史游标。</td></tr>
      <tr><td>GET 历史/上下文/时间线/实体/舆情</td><td>不使用幂等 Key；每次调用和重试都会独立计量。</td></tr>
      <tr><td>页大小</td><td>同时受接口上限与该调用者平台策略约束；超限返回 <code>page_size_exceeded</code>。</td></tr>
    </tbody></table>
    </section>

    <section class="doc-page" data-doc-page="source-catalog">
    <h2 id="source-catalog">数据源目录</h2>
    <div class="notice">这是只读、active-only 的已治理业务视图。负责该调用者的 Hub operator 必须先授予 <code>source_catalog</code> platform grant；调用者不能通过 Public API 自行授权。三个 GET 都只接受已签发的调用者 API Key，按同一 platform policy 独立计量，不使用 <code>Idempotency-Key</code>。</div>
    <p>授权入口是 Hub 管理台的“开放能力”：依次选择租户、调用者和“数据源目录”，配置配额后启用。授权按 consumer 动态生效，已有 API Key 不需要重新签发。</p>
    <h3>1. 准备 API Key 并确认授权</h3>
    <pre><code>export HUB_URL="https://hub.minsight-ai.com"
read -rsp 'MX Insight API Key: ' MX_INSIGHT_API_KEY
export MX_INSIGHT_API_KEY
printf '\\n'

curl -sS "$HUB_URL/api/v1/data/capabilities" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  | jq '.data.platforms[] | select(.platform == "source_catalog")'</code></pre>
    <p>预检结果必须包含 <code>ready=true</code>，以及 <code>catalog_entries</code>、<code>catalog_metadata</code>、<code>catalog_detail</code>、<code>filtered_browse</code>。没有该平台项时，请让 operator 为当前 consumer 授权；不要改用管理凭据调用 Public API。</p>

    <h3>2. 先读取 metadata</h3>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/source-catalog/metadata</code></div><p>返回 <code>source-catalog.public.v1</code> 的公开字段定义与枚举、active taxonomy、负责人公开投影、严格的 summary 与 facets。该路由不接受任何 query 参数；传入任意 query key 都返回 <code>400 unsupported_fields</code>。</p></div>
    <pre><code>curl -sS "$HUB_URL/api/v1/data/source-catalog/metadata" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  | jq '{contractVersion: .data.contractVersion,
         fields: .data.fields,
         enums: .data.enums,
         summary: .data.summary,
         facets: .data.facets,
         taxonomy: .data.taxonomy,
         owners: .data.owners,
         requestId}'</code></pre>
    <p><code>summary</code> 固定包含 total、coverage/delivery/review/priority 计数、coverageRate、负责人缺失数和分类汇总；<code>facets</code> 固定包含 majorCategories、scenarios、regions、owners、connectorHints、tags。客户端应使用 metadata 返回的精确值构造目录过滤条件。</p>

    <h3>3. 查询第一页</h3>
    <p>公开投影保留还原目录和对外汇报所需的治理字段；不返回证据、custom fields、导入来源、事件历史、关联数据、登录绑定、连接坐标或凭据。误粘的 DSN、带凭据 URL、私网连接、API key、token 或敏感口令会在搜索/facet 前按字段移除，<code>redactedFields</code> 列出受影响字段。</p>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/source-catalog</code></div><p>支持 <code>query</code>、<code>sourceKind</code>、<code>majorCategory</code>、<code>scenario</code>、<code>region</code>、<code>coverageStatus</code>、<code>deliveryStatus</code>、<code>reviewStatus</code>、<code>runtimeStatus</code>、<code>priority</code>、<code>ownerId</code>、<code>tag</code>、<code>pageSize</code> 和 <code>cursor</code>。<code>pageSize</code> 默认 50、硬上限 100，并可能被 consumer policy 进一步降低。</p></div>
    <pre><code>FIRST_PAGE=$(curl -sS -G "$HUB_URL/api/v1/data/source-catalog" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  --data-urlencode 'coverageStatus=covered' \
  --data-urlencode 'deliveryStatus=doing' \
  --data-urlencode 'pageSize=50')

printf '%s\n' "$FIRST_PAGE" \
  | jq '{contractVersion: .data.contractVersion,
         items: .data.items,
         filters: .data.filters,
         pageInfo: .data.pageInfo,
         requestId}'</code></pre>
    <p>成功响应固定为顶层 <code>data + requestId</code>；<code>data</code> 固定包含 <code>contractVersion</code>、<code>items</code>、规范化后的 <code>filters</code> 和 <code>pageInfo.returnedCount/totalCount/hasMore/nextCursor</code>。</p>

    <h3>4. 使用不透明 cursor 读取下一页</h3>
    <pre><code>NEXT_CURSOR=$(printf '%s\n' "$FIRST_PAGE" | jq -r '.data.pageInfo.nextCursor // empty')

curl -sS -G "$HUB_URL/api/v1/data/source-catalog" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  --data-urlencode 'coverageStatus=covered' \
  --data-urlencode 'deliveryStatus=doing' \
  --data-urlencode 'pageSize=50' \
  --data-urlencode "cursor=$NEXT_CURSOR" | jq</code></pre>
    <p>只有 <code>hasMore=true</code> 时才请求下一页。<code>nextCursor</code> 是 HMAC 签名的 keyset，绑定全部规范化 filters 与 <code>pageSize</code>；必须原样返回。更改任一条件后应移除 cursor，从第一页重新开始，否则返回 <code>400 invalid_cursor</code>。</p>

    <h3>5. 按列表返回的 UUID 读取详情</h3>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/source-catalog/{id}</code></div><p>返回与列表完全相同的安全 <code>SourceCatalogEntry</code> 投影。只接受列表返回的 active UUID，不接受 query 参数。</p></div>
    <pre><code>SOURCE_ID=$(printf '%s\n' "$FIRST_PAGE" | jq -r '.data.items[0].id')

curl -sS "$HUB_URL/api/v1/data/source-catalog/$SOURCE_ID" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  | jq '{contractVersion: .data.contractVersion, item: .data.item, requestId}'</code></pre>

    <h3>6. 从目录条目读取已归类数据</h3>
    <div class="notice">手机采集商品记录使用 <code>mobile_commerce</code> 作为授权域，真实平台通过每行的 reviewed source-catalog UUID 分类。按目录读取同时要求 <code>source_catalog</code> 与 <code>mobile_commerce</code> 两个平台授权；目录筛选不能扩大授权。</div>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/source-catalog/{id}/items</code></div><p>P1 返回该 active 目录条目下的 <code>mobile-commerce-items</code> stored 数据产品。支持 <code>keyword</code>、<code>brand</code>、<code>taskId</code>、<code>sourcePlatform</code>、<code>from</code>、<code>to</code>、<code>pageSize</code> 与签名 <code>cursor</code>；路径已经提供 <code>catalogEntryId</code>，query 不再接受它。unknown 平台保留为 unmapped，不靠标题猜目录。</p></div>
    <pre><code>curl -sS -G "$HUB_URL/api/v1/data/source-catalog/$SOURCE_ID/items" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  --data-urlencode 'refresh=stored' \
  --data-urlencode 'pageSize=50' | jq</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/mobile-commerce/items</code></div><p>直接读取同一安全数据产品，并可用 <code>catalogEntryId</code> 或 raw <code>sourcePlatform</code> 精确收窄。记录进入 canonical 后沿普通 outbox 异步投影到 Elasticsearch；也可通过 <code>POST /api/v1/data/canonical/search</code> 以 <code>platform=mobile_commerce</code>、<code>datasetId=mobile-commerce.collected-items.v1</code>、<code>objectType=commerce_capture</code> 检索。</p></div>
    <div class="notice"><code>refresh</code> 当前只支持 <code>stored</code>。未来“获取最新”是发往外部手机采集执行器的异步命令；采集运行在另一台机器/手机平台，Hub 只负责触发、状态、清洗、索引和数据接口，不在 Hub 进程中运行平台抓取。</div>

    <h3>数据源目录错误码</h3>
    <table><thead><tr><th>HTTP</th><th>error.code</th><th>调用方处理</th></tr></thead><tbody>
      <tr><td>400</td><td><code>invalid_request</code>、<code>invalid_cursor</code>、<code>invalid_source_catalog_id</code>、<code>page_size_exceeded</code>、<code>unsupported_fields</code></td><td>修正字段、UUID 或分页状态；不要原样重试。</td></tr>
      <tr><td>401</td><td><code>api_key_required</code>、<code>invalid_api_key</code></td><td>提供或轮换当前 consumer 的 API Key。</td></tr>
      <tr><td>403</td><td><code>platform_not_granted</code></td><td>让 operator 为该 consumer 授予 <code>source_catalog</code>。</td></tr>
      <tr><td>404</td><td><code>source_catalog_entry_not_found</code></td><td>重新从列表获取 active UUID。</td></tr>
      <tr><td>429</td><td><code>quota_exceeded</code></td><td>等待 platform policy 的计量窗口恢复。</td></tr>
      <tr><td>503</td><td><code>stored_data_unavailable</code></td><td>安全 GET 可稍后重试；保留错误响应的 <code>requestId</code> 供排查。</td></tr>
    </tbody></table>
    </section>

    <section class="doc-page" data-doc-page="virtual-supermarket">
    <h2 id="virtual-supermarket">虚拟超市</h2>
    <div class="notice">虚拟超市是 Hub 拥有的商品发布产品，要求独立 <code>virtual_supermarket</code> platform grant。<code>mobile_commerce</code> 采集读和 <code>source_catalog</code> 源目录读都不会隐式授予该产品，反向也不成立。</div>
    <p>同一份发布快照支持“逛超市”、“超市全景”和“目录模式”。全景只是客户端 renderer；API 只返回 <code>department / aisle / shelf / position</code> 语义和顺序，不返回 WebGL 坐标、摄像机、网格、材质或灯光。外部应用可用 2D、可访问目录或自己的 3D renderer 复刻业务等价超市。</p>
    <h3>1. 授权预检</h3>
    <pre><code>curl -sS "$HUB_URL/api/v1/data/capabilities" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  | jq '.data.platforms[] | select(.platform == "virtual_supermarket")'</code></pre>
    <p>已授权且存储面就绪时，该项使用 <code>source=hub</code>、<code>servingMode=stored</code>，并广告 <code>metadata</code>、<code>products</code>、<code>product_detail</code>、<code>stored_search</code> 与已实现的语义筛选能力。Public 不广告上下架、分类编辑或远程手机采集。</p>
    <h3>2. 读取超市语义</h3>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/virtual-supermarket/metadata</code></div><p>返回 <code>mx-insight-hub.data-products.virtual-supermarket.v1</code>、<code>storefrontRevision</code>、分类与有序 department/aisle/shelf 结构。</p></div>
    <pre><code>MARKET_META=$(curl -sS "$HUB_URL/api/v1/data/virtual-supermarket/metadata" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY")
printf '%s\n' "$MARKET_META" | jq '{contractVersion:.data.contractVersion,storefrontRevision:.data.storefrontRevision,departments:.data.departments,requestId}'</code></pre>
    <h3>3. 逛货架与读详情</h3>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/virtual-supermarket/products</code></div><p>只返回已显式上架的安全商品投影。支持 <code>categoryId</code>、<code>department</code>、<code>aisle</code>、<code>shelf</code>、<code>marketplace</code>、<code>query</code>、<code>sort</code>、<code>pageSize</code> 和 <code>cursor</code>；<code>sort</code> 默认 <code>newest</code>，且只能是 <code>newest|title_asc|price_asc|price_desc</code>，v1 不提供服务端货架陈列排序。</p></div>
    <pre><code>PRODUCT_PAGE=$(curl -sS -G "$HUB_URL/api/v1/data/virtual-supermarket/products" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  --data-urlencode 'department=home-care' \
  --data-urlencode 'aisle=laundry' \
  --data-urlencode 'sort=newest' \
  --data-urlencode 'pageSize=24')
printf '%s\n' "$PRODUCT_PAGE" | jq '{storefrontRevision:.data.storefrontRevision,items:.data.items,pageInfo:.data.pageInfo,requestId}'</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/virtual-supermarket/products/{id}</code></div><p>用列表返回的独立 Hub publication UUID 读取同一 allowlist 详情；它不是 mobile-commerce capture/canonical row ID。下架、归档或不存在都返回 <code>404 virtual_supermarket_product_not_found</code>，不暴露内部状态。</p></div>
    <h3>4. 搜索已上架商品</h3>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/virtual-supermarket/search?query=婴儿洗衣液</code></div><p><code>query</code> 必填，其余 filters/cursor 与 products 一致。调用方不能选择 Elasticsearch index、field、analyzer、DSL、script 或 boost。</p></div>
    <pre><code>curl -sS -G "$HUB_URL/api/v1/data/virtual-supermarket/search" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  --data-urlencode 'query=婴儿洗衣液' \
  --data-urlencode 'sort=price_asc' \
  --data-urlencode 'pageSize=20' | jq</code></pre>
    <div class="notice"><code>storefrontRevision</code> 会随分类和商品发布面变更。不透明 cursor 绑定完整 filters、sort、pageSize 和该 revision；条件改变后必须从首页开始。当 revision 已变更且旧快照不再可服务时，Hub 返回 <code>409 storefront_revision_changed</code>，不静默混页。</div>
    <h3>5. 外部复刻流程</h3>
    <p>先读取 metadata 并记录 <code>storefrontRevision</code>；再按默认 <code>sort=newest</code> 从无 cursor 的 products 首页逐页读取到 <code>nextCursor=null</code>。所有页面必须与 metadata 保持同一 revision；不一致或遇到 409 时丢弃未完成本地快照，重新读取 metadata 和首页。完整取回后，按 metadata 的 department/aisle/shelf/category <code>sortOrder</code> 与 item <code>placement.position</code> 在客户端陈列，position 相同或为空时用 publication UUID 稳定打破平局。调用方可选择 2D、3D 或可访问目录 renderer，但不能从 API 的 newest 分页顺序或 WebGL 坐标反推业务货架顺序。</p>
    <p>响应不包含 capture/source-row ID、marketplace product/shop source ID、marketplace raw label/映射状态/内部 source key、task/run/campaign、raw tags/share payload、metadata/device/<code>is_reported</code>、source profile/table/checkpoint、Admin audit 或凭据。公开 marketplace 只有经审核的 <code>{id,name}</code>；未有 approved mapping 时二者均为 null。价格 amount 使用 decimal string，并返回 display/provenance；当前固定源没有 currency 字段，所以 source price 的 <code>currency=null</code>，不能猜成 CNY，只有人工 curated override 才携带已审核的三位 ISO currency。外层 <code>collectedAt</code> 是观测时间，不是实时交易报价；v1 不发布 brand 或 media 字段，未审核规格保持 null，当前源无图片时不伪造商品图。下架仅改变 storefront overlay，不删除 canonical capture。</p>
    </section>

    <section class="doc-page" data-doc-page="search">
    <h2 id="search">通用搜索</h2>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/ecommerce/products/search</code></div><p>通过 Hub 的外部数据平台网关检索商品。需要 <code>ecommerce</code> 授权；公开合同不会暴露外部平台身份、凭据、接口地址或原始响应。</p></div>
    <div class="notice">body 只接受 <code>marketplace</code>、<code>query</code>、<code>page</code>、<code>cursor</code>、<code>sort</code>、<code>price</code>，没有 <code>pageSize</code>。<code>page</code> 与 <code>cursor</code> 互斥。重试同一页时复用同一个 Idempotency-Key；使用 <code>nextCursor</code> 请求下一页时必须换新 key，并保持 marketplace/query/sort/price 不变。</div>
    <pre><code>curl -sS -X POST "$HUB_URL/api/v1/data/ecommerce/products/search" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ecommerce-$(uuidgen)" \
  -d '{"marketplace":"jd","query":"AI recorder"}' | jq</code></pre>
    <pre><code>{
  "contractVersion": "mx-insight-hub.ecommerce-products.v1",
  "data": {
    "items": [],
    "page": { "page": 1, "returnedCount": 0, "discardedCount": 0, "hasMore": false, "nextCursor": null }
  },
  "meta": {
    "capturedAt": "2026-09-03T00:00:00.000Z",
    "servedAt": "2026-09-03T00:00:00.010Z",
    "sourceMode": "live",
    "ageSeconds": 0
  },
  "requestId": "00000000-0000-4000-8000-000000000006"
}</code></pre>
    <table><thead><tr><th>sourceMode</th><th>含义</th></tr></thead><tbody>
      <tr><td><code>live</code></td><td>本次完成一次新的外部数据调用。</td></tr>
      <tr><td><code>fresh_cache</code></td><td>返回同一调用者、同一规范化请求的有效 Hub 快照，没有再次调用外部数据平台。</td></tr>
      <tr><td><code>stored_fallback</code></td><td>外部调用不可用时返回同请求的 last-good 快照；同时返回年龄信息与 HTTP Warning 110。</td></tr>
      <tr><td><code>idempotent_replay</code></td><td>同 key、同路径、同 body 的已提交结果重放。</td></tr>
    </tbody></table>
    <p><code>hasMore=null</code> 表示没有足够证据安全继续，调用方必须停止，不能自行拼页码或外部 continuation。<code>capturedAt</code>、<code>servedAt</code> 与 <code>ageSeconds</code> 始终用于判断数据时效。</p>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/search</code></div><p>在一个请求中选择一个已授权平台。<code>platform=telegram</code> 使用 Hub 已清洗数据。</p></div>
    <pre><code>curl -sS -X POST "$HUB_URL/api/v1/data/search" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: search-$(uuidgen)" \\
  -d '{"platform":"telegram","query":"AI Agent","pageSize":5}' | jq</code></pre>
    <pre><code>{
  "data": {
    "contractVersion": "night-all.data-search.v1",
    "platform": "telegram",
    "query": "AI Agent",
    "items": [],
    "pageInfo": { "returnedCount": 0, "hasMore": false, "nextCursor": null },
    "status": "ok",
    "warnings": [],
    "meta": { "capability": "stored_search", "sourceProvider": "mx-insight-hub" }
  },
  "requestId": "00000000-0000-4000-8000-000000000003"
}</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/stored/search</code></div><p>只搜索 Hub canonical 数据，不调用 Night-All。可按逻辑 <code>datasetId</code> 和 <code>objectType</code> 精确过滤；不接受数据库、索引、SQL 或 ES DSL。</p></div>
    <div class="notice">授权边界仍是 <code>platform</code>：<code>datasetId</code> 只是过滤条件，不是独立授权。获得某平台授权的调用者当前可搜索该平台完整 canonical 语料。</div>
    <pre><code>curl -sS -X POST "$HUB_URL/api/v1/data/stored/search" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: stored-$(uuidgen)" \
  -d '{"platform":"xiaohongshu","query":"AI Agent","datasetId":"night-all.search.v1","objectType":"post","pageSize":20}' | jq</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/canonical/search</code></div><p>来源无关的统一检索：在一份 canonical 全局索引中直接排序，不逐个调用来源后拼接。省略 <code>platform</code> 时搜索当前调用者已授权的全部平台；<code>datasetId</code> 与 <code>objectType</code> 只用于收窄。可用 <code>searchProfile</code> 选择版本化搜索策略；不接受任意 analyzer、tokenizer、filter 或 ES DSL。</p></div>
    <div class="notice">统一接口只读取 Hub 已存数据，不触发第三方采集。响应的 <code>scope.platforms</code> 是本次实际授权范围；游标与该范围及首屏分词状态绑定，后续页不会再次调用 HanLP。授权或 profile 发生变化后应从第一页重新搜索。独立的 canonical-search 用量桶固定采用调用者当前全部平台授权中最严格的限额。</div>
    <div class="notice"><strong>public_opinion 可见性：</strong>stored/canonical 搜索默认只返回 <code>sourceStage=formal</code> 且 <code>status=formal</code> 的舆情记录；混合平台搜索只门禁 <code>public_opinion</code> 分支，其他平台不受影响。候选查询必须显式指定 <code>platform=public_opinion</code>。<code>includeCandidates=qualified</code> 只加入已经是 <code>status=qualified</code> 的候选；<code>minQualityScore</code> 是额外请求下限，传 0 不会把 pending/rejected/failed 重新分类。<code>includeCandidates=all</code> 必须同时提供 <code>from</code>、<code>to</code>，并至少提供 <code>province</code>、<code>countryCode</code> 或 <code>location</code> 之一；要保留 unscored candidate 应省略 <code>minQualityScore</code>。候选时间窗按 <code>eventTime</code>，缺失时回退 <code>collectedAt</code>；formal 仍只按 <code>eventTime</code>。显式候选响应只增加有界 <code>quality</code>/<code>location</code>，且不返回候选 author、contentType、provider、raw、flags 或内部理由。</div>
    <table><thead><tr><th>searchProfile</th><th>查询策略</th></tr></thead><tbody>
      <tr><td><code>canonical.balanced.v1</code>（默认）</td><td>HanLP 健康时使用“原文 phrase 或全部 HanLP/presegmented 词命中（AND）”；若分词降级到 Jieba/bigram，则明确应用 phrase-only，绝不拿 fallback 词误查 HanLP 字段。</td></tr>
      <tr><td><code>canonical.phrase.v1</code></td><td>只匹配保持语序的原文 phrase，精度优先。</td></tr>
      <tr><td><code>canonical.terms-all.v1</code></td><td>所有预分词查询词都必须命中，允许词序变化。</td></tr>
      <tr><td><code>canonical.zh-recall.v1</code></td><td>在默认策略上增加较低权重的 CJK bigram 召回。</td></tr>
      <tr><td><code>canonical.title-prefix.v1</code></td><td>用于标题、作者、用户名和会话名的有界前缀检索。</td></tr>
    </tbody></table>
    <pre><code>curl -sS -X POST "$HUB_URL/api/v1/data/canonical/search" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: canonical-$(uuidgen)" \
  -d '{"query":"AI Agent","searchProfile":"canonical.balanced.v1","pageSize":20}' | jq</code></pre>
    <pre><code>curl -sS -X POST "$HUB_URL/api/v1/data/canonical/search" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: public-opinion-audit-$(uuidgen)" \
  -d '{"platform":"public_opinion","query":"涉恐","includeCandidates":"all","countryCode":"SS","location":"南苏丹","from":"2026-08-24T00:00:00Z","to":"2026-08-25T23:59:59Z","pageSize":20}' | jq</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/canonical/items/{id}/context?before=10&amp;after=10</code></div><p>对 Telegram 消息搜索结果的 canonical UUID 读取同一 dataset、同一 chat 的邻近已存消息。默认前后各 10 条，单侧上限 50；返回一个升序 <code>items</code> 列表，<code>anchorIndex</code> 指向命中项。</p></div>
    <div class="notice"><code>storedWindow.hasMoreStoredBefore/After</code> 只描述 Hub PostgreSQL 当前是否还有记录；<code>upstreamCompleteness</code> 单独描述有持久证据支持的上游采集完整性。两者不能互相推导。</div>
    <pre><code>ANCHOR_ID="&lt;canonical-search-item-id&gt;"
curl -sS "$HUB_URL/api/v1/data/canonical/items/$ANCHOR_ID/context?before=10&amp;after=10" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" | jq</code></pre>
    </section>

    <section class="doc-page" data-doc-page="public-opinion">
    <h2 id="public-opinion">全国省级舆情</h2>
    <div class="notice">需要调用者显式获得 <code>public_opinion</code> 平台授权。能力发现中的该平台项来自 Hub stored 数据面，不属于 Night-All compatibility，也不改变既有 <code>POST /api/v1/data/search</code> 契约。</div>
    <p>先读取 <code>GET /api/v1/data/capabilities</code>。固定数据源处于 active，且两个 curated province-feed 索引都有效时，平台项的 <code>ready</code> 才为 <code>true</code>：</p>
    <pre><code>{
  "platform": "public_opinion",
  "ready": true,
  "source": "hub",
  "servingMode": "stored",
  "capabilities": ["province_feed", "province_coverage", "region_catalog", "region_feed", "item_detail", "stored_search"]
}</code></pre>
    <div class="notice"><code>public_opinion.all_ingested.read</code> 的独立 <code>ready=true</code> 还要求 region feed 专用的全局 latest 索引与 revision-fenced display-province 索引同时通过合同校验；任一索引缺失或漂移都会以 <code>503 serving_indexes_unavailable</code> 失败关闭。</div>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/public-opinion/regions?parentCode=CN&amp;level=province</code></div><p>返回固定的 34 个省级地区及 ISO 代码，供地区切换器直接使用。该目录只要求 <code>public_opinion</code> 平台授权，始终返回完整目录；P1 不发布市级代码，也不接受推断出来的市级 selector。</p></div>
    <pre><code>curl -sS -G "$HUB_URL/api/v1/data/public-opinion/regions" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  --data-urlencode 'parentCode=CN' \
  --data-urlencode 'level=province' | jq</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/public-opinion/regions/{regionCode}/items</code></div><p>读取全国（<code>CN</code>）或一个精确省级代码的当前安全规范投影。除 <code>public_opinion</code> 平台授权外，还必须单独获得非默认的 <code>public_opinion.all_ingested.read</code> capability。<code>visibility</code> 固定为 <code>all_ingested</code>，<code>sort</code> 仅支持 <code>latest</code>，且必须给出 <code>from/to</code>。全国结果会保留尚未归省的条目并返回 <code>province=null</code>。</p></div>
    <div class="notice"><code>all_ingested</code> 表示 <code>canonical_current_safe</code>：忽略质量分数、qualification status 和 geography verification 过滤，但仍只返回当前、未删除、revision-fenced 的公开字段投影。每条结果都带安全的 <code>quality</code> 摘要；raw、修订历史、provider/endpoint、凭据、策略/运行 ID、质量理由、模型 reasoning 和内部 lineage 均不公开。</div>
    <pre><code>curl -sS -G "$HUB_URL/api/v1/data/public-opinion/regions/CN/items" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  --data-urlencode 'visibility=all_ingested' \
  --data-urlencode 'sort=latest' \
  --data-urlencode 'from=2026-08-24T00:00:00+08:00' \
  --data-urlencode 'to=2026-08-26T23:59:59+08:00' \
  --data-urlencode 'pageSize=50' | jq</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/public-opinion/provinces/{province}/items</code></div><p>按省份返回热门或最新条目。<code>province</code> 接受 ISO 3166-2:CN 代码、中文简称或正式名称，例如 <code>CN-JS</code>、<code>江苏</code>、<code>江苏省</code>；中文路径值需要 URL 编码。</p></div>
    <table><thead><tr><th>参数</th><th>规则</th></tr></thead><tbody>
      <tr><td><code>sort</code></td><td><code>hot</code>（默认）按 heatScore、内部有效排序时间、ID 降序，且排除无热度分数的记录；<code>latest</code> 按有效排序时间、采集时间、ID 降序。有效排序时间优先 publishedAt，缺失时回退 collectedAt，但不会把回退值冒充 publishedAt 返回。</td></tr>
      <tr><td><code>from / to</code></td><td>可选 RFC3339 闭区间；formal 记录继续按 publishedAt 过滤并排除无日期记录。只有显式候选模式下，候选缺少 publishedAt 时才用 collectedAt 参与窗口过滤，返回时仍保持 publishedAt 为空。</td></tr>
      <tr><td><code>includeCandidates</code></td><td>默认 <code>false</code>，保持原 formal-only 契约。<code>qualified</code>（或 <code>true</code>）只加入已经 qualified 且达到有效质量下限的候选；<code>all</code> 是显式审计视图，必须同时提供 <code>from</code> 与 <code>to</code>。</td></tr>
      <tr><td><code>minQualityScore</code></td><td>仅可与候选模式一起使用，范围 0–100；它是额外请求下限，不改变 publication status 或记录 qualification threshold。<code>qualified</code> 默认 80；<code>all</code> 要保留 unscored 时应省略该字段。</td></tr>
      <tr><td><code>pageSize</code></td><td>默认 20，接口上限 100，并受调用者 <code>public_opinion</code> 平台策略的更低上限约束。</td></tr>
      <tr><td><code>cursor</code></td><td>返回上一页的 <code>nextCursor</code> 原值。游标与省份、排序、时间范围及页大小绑定；任一条件改变都必须从第一页开始。</td></tr>
    </tbody></table>
    <pre><code>curl -sS "$HUB_URL/api/v1/data/public-opinion/provinces/CN-JS/items?sort=hot&amp;pageSize=20" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" | jq</code></pre>
    <pre><code>curl -sS "$HUB_URL/api/v1/data/public-opinion/provinces/CN-JS/items?sort=latest&amp;includeCandidates=qualified&amp;minQualityScore=80&amp;from=2026-08-24T00%3A00%3A00Z&amp;to=2026-08-25T23%3A59%3A59Z" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" | jq</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/public-opinion/province-coverage</code></div><p>在明确的 <code>from/to</code> 时间窗内返回全部省级地区的 formal、qualified candidate、全部 candidate、地理已验证和可用数量，并按默认每省 10 条目标计算缺口。formal 按 publishedAt 统计，候选缺日期时按 collectedAt 统计。<code>featuredProvinceCodes</code> 只给出最多 8 个数据较充足的热门省份；<code>provinces</code> 始终返回完整地区列表，适合界面折叠展示其余省份。</p></div>
    <pre><code>curl -sS "$HUB_URL/api/v1/data/public-opinion/province-coverage?from=2026-08-24T00%3A00%3A00Z&amp;to=2026-08-25T23%3A59%3A59Z&amp;includeCandidates=qualified&amp;minQualityScore=80&amp;targetPerProvince=10" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" | jq</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/public-opinion/items/{id}</code></div><p>用列表或 canonical search 返回的 Hub canonical UUID 读取详情。默认只查 formal；若 ID 来自显式候选列表，详情请求需携带相同的 <code>includeCandidates</code> 与 <code>minQualityScore</code>。精确 ID 查询不要求时间窗；不存在、低于阈值、已删除或不在公开语料范围内的记录统一返回 <code>404 item_not_found</code>。</p></div>
    <pre><code>curl -sS "$HUB_URL/api/v1/data/public-opinion/items/11111111-1111-4111-8111-111111111111" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" | jq</code></pre>
    <p>默认列表与详情继续只返回 <code>id</code>、标题、摘要、公开链接、发布时间、采集时间、规范省份、heatScore，以及经映射的公开来源名称/类型/平台。显式候选模式额外返回 Hub 自有的 <code>quality</code>，以及有证据时的规范 <code>location</code>；候选来源三元组保持为空，避免把搜索引擎或上游 Provider 身份当作发布方公开。上游原始行、凭据与内部操作坐标，策略与运行 ID、源表坐标、extensions、模型理由和内部 lineage 均不会进入公开响应。原始 heatScore 仅用于同一省级语料的热门排序，不表示跨来源的全局相关度。</p>

    <h3>漏斗与未展示记录诊断</h3>
    <div class="notice">诊断面仍需要 <code>public_opinion</code> platform grant，并额外要求 step-up capability <code>public_opinion.diagnostics.read</code>。它使用 API Key 的独立 capability 策略与计量配额，不接受 admin token。Admin 的操作、原始投影、extensions、connection 信息和模型 reasoning 不对外。</div>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/public-opinion/funnel?from=...&amp;to=...</code></div><p>在给定时间窗返回从 active current 数据到发布状态、formal 阶段/状态、事件时间、时间窗、省份归属与热度分的可解释漏斗，契约版本为 <code>mx-insight-hub.data-products.public-opinion-funnel.v1</code>。</p></div>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/public-opinion/records</code></div><p>分页查看漏斗各阶段和未展示记录。支持 <code>from</code>、<code>to</code>、<code>reason</code>、<code>scope</code>、<code>stage</code>、<code>status</code>、<code>province</code>、<code>time</code>、<code>heat</code>、<code>query</code>、<code>pageSize</code> 和不透明 <code>cursor</code>。<code>reason</code> 可用于查看 <code>missing_province</code>、<code>missing_publication_state</code>、<code>not_formal_stage</code>、<code>not_formal_status</code>、<code>missing_event_time</code>、<code>outside_window</code> 或 <code>missing_heat</code> 等原因。</p></div>
    <pre><code>curl -sS -G "$HUB_URL/api/v1/data/public-opinion/records" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  --data-urlencode 'reason=missing_province' \
  --data-urlencode 'from=2026-08-24T00:00:00Z' \
  --data-urlencode 'to=2026-08-25T23:59:59Z' \
  --data-urlencode 'pageSize=50' | jq</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/public-opinion/records/{id}?from=...&amp;to=...</code></div><p>读取一条诊断记录的安全详情与未展示原因。列表、详情与漏斗分别使用 <code>...public-opinion-records.v1</code>、<code>...public-opinion-record.v1</code> 和上述 funnel 契约。</p></div>
    </section>

    <section class="doc-page" data-doc-page="night-all">
    <h2 id="night-all">Night-All 兼容层</h2>
    <div class="notice"><strong>Telegram 警告：</strong><code>data.platforms[]</code> 中出现 <code>telegram</code> 只代表 Hub stored/monitor 数据面已授权，不代表 Night-All legacy search。Telegram 不支持下面三条 compatibility route；请使用本页 Telegram 专用 Hub API。</div>
    <p>每次调用前读取 <code>GET /api/v1/data/capabilities</code>。<code>data.legacySearch</code> 是由当前 Hub 发布版本固定（<code>Hub-pinned</code>）、再按 consumer grants 过滤的 operation dispatch 矩阵，contractVersion 固定为 <code>night-all.legacy-search-capabilities.v1</code>。它不会在请求时从 Night-All 的 capability 接口实时发现。只有平台同时出现在相应 operation 的 <code>supportedPlatforms</code> 和 <code>readyPlatforms</code> 中，Hub 才会 dispatch；这里的 <code>readyPlatforms</code> 仅表示 Hub 在固定契约下允许 dispatch，不证明 Night-All 当前 handler、endpoint、provider、credential 或上游健康。没有可用于 Night-All compatibility 的 platform grant 时该字段为 <code>null</code>，三条兼容路由全部 fail closed。</p>
    <table><thead><tr><th>operation</th><th>示例</th><th>运行时判断字段</th></tr></thead><tbody>
      <tr><td><code>raw</code></td><td><code>xiaohongshu + query</code></td><td><code>data.legacySearch.operations.raw</code></td></tr>
      <tr><td><code>crawl</code></td><td><code>twitter + username=openai</code></td><td><code>data.legacySearch.operations.crawl</code></td></tr>
      <tr><td><code>user-info</code></td><td><code>twitter + username=openai</code></td><td><code>data.legacySearch.operations["user-info"]</code></td></tr>
    </tbody></table>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/night-all/search/raw</code></div><p>按关键词搜索平台内容。</p></div>
    <pre><code>curl -i -sS -X POST "$HUB_URL/api/v1/night-all/search/raw" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: night-all-raw-$(uuidgen)" \\
  -d '{"platform":"xiaohongshu","query":"AI Agent","count":20,"includeRaw":false}'</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/night-all/search/crawl</code></div><p>抓取一个账号公开发布的内容。</p></div>
    <pre><code>curl -i -sS -X POST "$HUB_URL/api/v1/night-all/search/crawl" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: night-all-crawl-$(uuidgen)" \\
  -d '{"platform":"twitter","username":"openai","count":20,"activityTypes":["posts"]}'</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/night-all/search/user-info</code></div><p>读取账号资料。LinkedIn 必须使用完整的 <code>/in/</code> 个人 profile URL（<code>url</code>、<code>profileUrl</code>、<code>profile_url</code> 或 <code>urls</code>）；公司 URL 和裸 slug 会被拒绝。</p></div>
    <pre><code>curl -i -sS -X POST "$HUB_URL/api/v1/night-all/search/user-info" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: night-all-user-info-$(uuidgen)" \\
  -d '{"platform":"twitter","username":"openai"}'</code></pre>
    <p>响应 body 保留 Night-All 当前业务字段，不在此层脱敏。Hub 通过响应头返回 durable request ID、<code>live|stale</code> 和采集时间；网络/超时、不可用的 2xx content-type/JSON/envelope，或真实非 2xx 的 502/503/504 才会回放完全相同请求的 last-good 快照。不可用 2xx 记为 outcome unknown。</p>
    <p><code>Idempotency-Key</code> 永久绑定一次付费 dispatch；重用永远回放该结果，新鲜调用必须换新 key。legacy <code>includeRaw:false</code> 可接受但会在 dispatch 前移除，<code>true</code> 被拒绝。调用方不能通过 body 或嵌套 <code>params</code> 注入 provider、token、credential、endpoint、capability/moduleCode、timeout 或工作量覆盖；archive/fullArchive/allTweets、archiveLimit/totalCount、max*Pages、pageCount/chunkSize/budget/crawlDepth 等成本放大控制也会被拒绝。work budget 只限制返回/处理 item，不代表 Night-All provider call 或计费次数。未来脱敏应通过独立、版本化的 Hub projection/API 提供。</p>
    <table><thead><tr><th>HTTP / code</th><th>含义</th></tr></thead><tbody>
      <tr><td><code>400 platform_operation_unsupported</code></td><td>平台不在该 operation 的 <code>supportedPlatforms</code>；Telegram 会走此分支。</td></tr>
      <tr><td><code>503 platform_operation_unavailable</code></td><td>平台在固定支持集内，但当前 Hub dispatch 矩阵未将其列入 <code>readyPlatforms</code>；这不是 provider 健康状态。</td></tr>
      <tr><td><code>503 compatibility_capabilities_unavailable</code></td><td>Hub-pinned legacySearch dispatch 矩阵缺失或无效，Hub fail closed，尚未 dispatch。</td></tr>
      <tr><td><code>503 compatibility_store_unavailable</code></td><td>fallback 所需的 Hub compatibility store 暂不可用。</td></tr>
      <tr><td><code>400/404/409/422/429 night_all_rejected</code></td><td>Night-All 明确拒绝；Hub 保留这些可安全转发的 HTTP 状态。其他明确拒绝映射为 502。</td></tr>
    </tbody></table>
    </section>

    <section class="doc-page" data-doc-page="tools">
    <h2 id="tools">通用工具</h2>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/tools/tokenize</code></div><p>新建或从未配置的调用者默认获得 <code>nlp.tokenize</code>，管理员可显式停用；调用仍必须携带已签发的 API Key。默认按 consumer + capability 的 3600 秒滚动窗口限制 1000 次，同一调用者的所有 Key 共享上限。它不授予数据平台权限，响应会报告实际分词后端及降级状态。</p></div>
    <pre><code>curl -sS -X POST "$HUB_URL/api/v1/tools/tokenize" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: tokenize-$(uuidgen)" \
  -d '{"text":"吴恩达与人工智能"}' | jq</code></pre>
    <pre><code>{
  "data": {
    "capability": "nlp.tokenize",
    "tokens": ["吴恩达", "与", "人工智能"],
    "actualBackend": "hanlp",
    "degraded": false,
    "errorCode": null
  },
  "requestId": "00000000-0000-4000-8000-000000000004"
}</code></pre>
    </section>

    <section class="doc-page" data-doc-page="telegram">
    <h2 id="telegram">Telegram 会话</h2>
    <div class="notice">授权 <code>telegram</code> 后，调用者读取的是同一份 Hub 全量规范化语料；当前没有按租户划分不同的 Telegram 行级数据子集。租户隔离作用于 API Key 所有权、平台授权、策略、配额和用量证据。</div>
    <div class="notice">现有路径没有改名：省略扩展字段时，<code>chats</code>、<code>messages</code> 和 Telegram 专用 <code>search</code> 仍严格使用 Monitor-only 旧合同与旧 cursor binding。显式传 <code>sourceScope=all|sqlite|monitor</code> 才启用来源感知的扩展合同；要还原 Hub Admin 的 Monitor + SQLite 合并视图请传 <code>all</code>。Night-All 的 <code>raw/crawl/user-info</code> 转接路径、默认和响应保持不变。</div>
    <div class="notice">扩展会话模式使用不可变的 <code>effectiveSortTime</code> 排序键：优先业务事件时间，其次采集时间，最后首次入库时间；响应中的 <code>eventTime</code>/<code>collectedAt</code> 仍保留真实可空值。省略扩展参数的 Monitor 旧模式排序与 cursor 语义保持不变。</div>
    <table><thead><tr><th>调用目标</th><th>接口</th><th>实际数据范围</th></tr></thead><tbody>
      <tr><td>Monitor 消息历史</td><td><code>GET /data/telegram/messages</code></td><td><code>telegram.monitor.messages.v1</code></td></tr>
      <tr><td>Monitor 会话目录</td><td><code>GET /data/telegram/chats</code></td><td><code>telegram.monitor.chats.v1</code></td></tr>
      <tr><td>Monitor 高级检索</td><td><code>POST /data/telegram/search</code></td><td>固定的 <code>telegram.monitor.*</code></td></tr>
      <tr><td>Monitor + SQLite 统一检索</td><td><code>POST /data/canonical/search</code></td><td>授权范围内全部 Telegram canonical dataset</td></tr>
      <tr><td>Monitor + SQLite 会话/消息还原</td><td><code>GET /data/telegram/chats|messages?sourceScope=all</code></td><td>相容响应中增加来源与 canonical 定位</td></tr>
      <tr><td>命中消息的前后文</td><td><code>GET /data/canonical/items/{id}/context</code></td><td>命中项所在 dataset + chat；默认前后各 10 条</td></tr>
      <tr><td>命中后持续双向滚动</td><td><code>GET /data/canonical/items/{id}/timeline</code></td><td>首屏前后窗口 + 单一不透明方向游标</td></tr>
      <tr><td>指定单个来源数据集</td><td><code>POST /data/stored/search</code></td><td>由 <code>datasetId</code> 精确收窄</td></tr>
    </tbody></table>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/telegram/messages</code></div><p>消息历史；支持 <code>sourceScope=all|monitor|sqlite</code>、<code>chatId</code>、<code>from</code>、<code>to</code>、<code>pageSize</code>、<code>cursor</code>。普通 external chatId 且省略 sourceScope 时保留 Monitor v1 cursor；显式来源或 <code>monitor:&lt;UUID&gt;</code>/<code>sqlite:&lt;UUID&gt;</code> chatKey 使用与来源、会话、时间窗和 pageSize 绑定的 HMAC v2 cursor。每条消息返回 <code>canonicalId</code> 和 <code>sourceScope</code>。</p></div>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/telegram/chats</code></div><p>会话目录；支持 <code>sourceScope</code>、<code>query</code>、<code>kind=all|channel|group|unknown</code>、<code>pageSize</code> 和 <code>cursor</code>。省略 sourceScope/kind/query 保留旧 Monitor v1 cursor；显式任一扩展过滤使用 HMAC v2 cursor。响应的 <code>chatKey</code> 是稳定的来源感知会话选择键。</p></div>
    <pre><code>curl -sS "$HUB_URL/api/v1/data/telegram/messages?chatId=-1001234567890&amp;pageSize=20" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" | jq</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/telegram/search</code></div><p>高级全文检索；<code>sourceScope</code> 可选 <code>all</code>、<code>monitor</code>、<code>sqlite</code>，省略时保留旧 Monitor-only v3 cursor binding，显式传值才将来源加入扩展 binding。<code>scope</code> 可选 <code>messages</code>、<code>chats</code>、<code>all</code>；省略 <code>chatId</code> 为全局搜索，传入时只搜当前会话。</p></div>
    <pre><code>curl -sS -X POST "$HUB_URL/api/v1/data/telegram/search" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: telegram-$(uuidgen)" \\
  -d '{"query":"AI Agent","sourceScope":"all","scope":"all","from":"2026-08-01T00:00:00Z","pageSize":20}' | jq</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/canonical/search</code></div><p>同时检索 Telegram monitor 与 SQLite 导入数据。省略 <code>datasetId</code> 是合并的关键；如果只要消息，可用 <code>objectType=message</code> 收窄。</p></div>
    <pre><code>curl -sS -X POST "$HUB_URL/api/v1/data/canonical/search" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: telegram-all-sources-$(uuidgen)" \\
  -d '{"platform":"telegram","objectType":"message","query":"AI Agent","searchProfile":"canonical.balanced.v1","pageSize":20}' | jq</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/canonical/items/{id}/context</code></div><p>用上一步搜索项的 <code>id</code> 读取邻近消息。排序总序为 <code>(eventTime, canonicalId)</code>；不会跨 Monitor/SQLite dataset，也不会跨 chat。未知的新数据源默认返回 <code>context_not_supported</code>，只有能力发现中 <code>context.datasets</code> 明确列出的 dataset 才支持。</p></div>
    <div class="notice">当前 Monitor 的 <code>upstreamCompleteness.status</code> 为 <code>unknown</code>；SQLite 导入为 <code>bounded</code>。这不会阻止读取 Hub 已提交的上下文，但调用方不得把列表头尾解释成 Telegram 上游历史的绝对头尾。</div>
    <pre><code>curl -sS "$HUB_URL/api/v1/data/canonical/items/&lt;search-item-id&gt;/context?before=10&amp;after=10" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" | jq</code></pre>
    <h3>搜索命中后的双向时间线</h3>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/canonical/items/{id}/timeline?before=10&amp;after=10</code></div><p>正式的双向分页合同。首屏返回升序 <code>items</code>、数字 <code>anchorIndex</code>，以及 <code>pageInfo.older/newer</code>；续页只发送其中一个不透明 <code>cursor</code>，此时 <code>anchorIndex=null</code>，未请求方向的页信息也为 <code>null</code>。<code>before=0</code> 或 <code>after=0</code> 只省略该侧首屏数据；返回的该侧游标使用受 grant 上限约束的默认页大小。路径 <code>id</code>、dataset、chat、方向、排他边界、page size、consumer 授权范围和合同版本都由 HMAC 绑定。</p></div>
    <pre><code>TIMELINE=$(curl -sS -G "$HUB_URL/api/v1/data/canonical/items/&lt;search-item-id&gt;/timeline" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \\
  --data-urlencode 'before=10' \\
  --data-urlencode 'after=10')

OLDER_CURSOR=$(printf '%s\n' "$TIMELINE" | jq -r '.data.pageInfo.older.cursor // empty')
curl -sS -G "$HUB_URL/api/v1/data/canonical/items/&lt;search-item-id&gt;/timeline" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \\
  --data-urlencode "cursor=$OLDER_CURSOR" | jq</code></pre>
    <div class="notice"><code>eventTime</code> 保留服务端排序和游标排他使用的 UTC 六位微秒值。<code>consistency=live-keyset</code> 表示它不是冻结快照：并发新写入、晚到或删除可能改变尚未读取的边界外集合。<code>hasMore</code> 只说明 Hub 当前 stored active 数据；不证明 Telegram 上游已完整，也不提供 changes feed。即使 <code>newer.hasMore=false</code>，仍保留其 cursor：有新项时推进到最新返回项，空页保持原 token，客户端可用它轮询之后写入；older 耗尽时 cursor 为 null。此 GET 不调用 Telegram 或其他上游采集。</div>
    <h3>外部会话应用复刻流程</h3>
    <table><thead><tr><th>步骤</th><th>调用与客户端动作</th></tr></thead><tbody>
      <tr><td>1. 搜索</td><td><code>POST /data/telegram/search</code> 并提供本页唯一的 <code>Idempotency-Key</code>；搜索结果下一页 body 含新 cursor，必须换新 Key。</td></tr>
      <tr><td>2. 选中命中</td><td>优先取 message item 的 <code>canonicalId</code>；canonical search item 则取 <code>id</code>，作为 timeline 路径 ID。</td></tr>
      <tr><td>3. 建立窗口</td><td><code>GET .../{id}/timeline?before=10&amp;after=10</code>；timeline GET 不需要幂等 Key。</td></tr>
      <tr><td>4. 向上滚动</td><td>回传 <code>pageInfo.older.cursor</code>，按 canonical ID 去重后 prepend；记录插入前后 scroll height 差值并补偿 <code>scrollTop</code>，保持用户当前视口。</td></tr>
      <tr><td>5. 向下/实时跟随</td><td>回传 <code>pageInfo.newer.cursor</code>，去重后 append；到达底部后可继续用返回的新 newer cursor 轮询。</td></tr>
    </tbody></table>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/telegram/entities/search?query=example&amp;pageSize=20</code></div><p>模糊匹配作者名称/用户名和会话标题/用户名。</p></div>
    <div class="notice">如果搜索响应包含 <code>search_projection_degraded</code>，代表当前页面由 PostgreSQL 检索托底。Canonical 接口还会以 <code>search.appliedProfile=postgres.substring.v1</code> 和 <code>search_profile_degraded</code> 明示策略变化；Telegram/Stored 兼容响应只保留投影告警。若 Elasticsearch 仍在线但 HanLP 查询降级，三个接口都会返回 <code>search_profile_degraded</code>。已有 Elasticsearch 游标会签名并复用首屏分词状态，不会中途切换模式或重新分词。</div>
    </section>

    <section class="doc-page" data-doc-page="discovery">
    <h2 id="discovery">能力、请求状态与用量</h2>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/capabilities</code></div><p>返回当前调用者已授权的 Hub 平台、通用 capabilities，以及独立的 Hub-pinned、grant-filtered <code>data.legacySearch</code> operation dispatch 矩阵。该矩阵不证明 Night-All provider readiness。Telegram 与 <code>public_opinion</code> 平台项使用 <code>source=hub</code>、<code>servingMode=stored</code>；它们不代表 Night-All compatibility。Telegram 的 <code>context.datasets</code> 与 <code>timeline.datasets</code> 分别是 bounded context 和双向时间线支持清单，各自的 <code>ready</code> 是独立服务索引门禁；<code>message_timeline</code> 明示正式时间线能力。</p></div>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/requests/{requestId}</code></div><p>查询当前调用者拥有的持久请求记录。requestId 来自搜索响应头 <code>x-mx-insight-request-id</code>。</p></div>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/usage?from=...&amp;to=...</code></div><p>读取当前调用者的请求、提交、释放、未知状态与计费单元汇总。</p></div>
    </section>

    <section class="doc-page" data-doc-page="errors">
    <h2 id="errors">错误与重试</h2>
    <table><thead><tr><th>HTTP</th><th>含义</th><th>建议</th></tr></thead><tbody>
      <tr><td>400</td><td>字段、游标、页大小或幂等 Key 不合法</td><td>修正请求，不原样盲重试</td></tr>
      <tr><td>401 / 403</td><td>Key 无效，或平台未授权</td><td>检查 Key 与 capabilities</td></tr>
      <tr><td>409</td><td>幂等冲突/处理中/结果未知，或该 dataset 不支持上下文/时间线</td><td>搜索请求保持原 body 与原幂等 Key；上下文/时间线请求先检查 capabilities</td></tr>
      <tr><td>410</td><td>搜索游标过期</td><td>从无 cursor 的第一页重新开始，并使用新幂等 Key</td></tr>
      <tr><td>429</td><td>请求或并发配额耗尽</td><td>等待策略窗口恢复</td></tr>
      <tr><td>503</td><td>当前数据或搜索运行时不可用</td><td>安全 GET 可稍后重试；POST 复用原幂等 Key</td></tr>
    </tbody></table>
    <p>所有错误都返回稳定的 <code>error.code</code> 和用于排查的 <code>requestId</code>。</p>
    </section>
    <footer>MX Insight Hub Open API v1 · <a href="/docs/openapi.json">下载 OpenAPI JSON</a></footer>
  </main>
</div>
</body>
</html>`

function normalizedDocsPath(pathname) {
  if (typeof pathname !== 'string') return null
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  return normalized || '/'
}

function docsNavigation(activeKey) {
  return PUBLIC_DOCS_ROUTES.map((route) => {
    const active = route.key === activeKey
    return `<a href="${route.path}"${active ? ' class="active" aria-current="page"' : ''}>${route.label}</a>`
  }).join('')
}

export function publicDocsHtmlForPath(pathname) {
  const normalized = normalizedDocsPath(pathname)
  const route = PUBLIC_DOCS_ROUTES.find((candidate) => candidate.path === normalized)
  if (!route) return null

  return PUBLIC_DOCS_TEMPLATE
    .replace('__PUBLIC_DOCS_TITLE__', route.label)
    .replace('__PUBLIC_DOCS_NAV__', docsNavigation(route.key))
    .replace(/\n\s*<section class="doc-page" data-doc-page="([^"]+)">[\s\S]*?<\/section>/g, (section, key) => (
      key === route.key ? section : ''
    ))
}

export function publicDocsRedirectForPath(pathname) {
  const normalized = normalizedDocsPath(pathname)
  return PUBLIC_DOCS_ROUTE_ALIASES[normalized] || null
}

export const PUBLIC_DOCS_HTML = publicDocsHtmlForPath('/docs')
