import {
  DEFAULT_SEARCH_PROFILE,
  POSTGRES_SEARCH_PROFILE,
  searchCapabilities,
} from './search/profiles.mjs'
import { QUOTA_429_CODES } from './core/quota-codes.mjs'
import { ECOMMERCE_DELIVERY_MODES } from './contracts/justone.mjs'
import { XIAOHONGSHU_POST_DELIVERY_MODES } from './contracts/tikhub-xiaohongshu.mjs'
import { SOCIAL_ACCOUNT_PLATFORMS } from './contracts/social-accounts.mjs'
import { JUSTONE_RELEASED_RESOURCES, JUSTONE_RESOURCE_CATALOG } from './contracts/justone-resources.mjs'

export const PUBLIC_DOCS_LEGACY_ROUTE_SCRIPT = `(()=>{const routes={rules:'/docs/auth','source-catalog':'/docs/source-catalog','ecommerce-treasure-box':'/docs/ecommerce-treasure-box','xiaohongshu-note':'/docs/xiaohongshu-note','virtual-supermarket':'/docs/virtual-supermarket','topic-reports':'/docs/topic-reports',search:'/docs/search',telegram:'/docs/telegram','public-opinion':'/docs/public-opinion','night-all':'/docs/night-all',tools:'/docs/tools',discovery:'/docs/evidence',errors:'/docs/errors'};const route=routes[location.hash.slice(1)];if(route)location.replace(route)})()`

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

const nightAllCompatibilityErrors = Object.fromEntries(
  [400, 401, 403, 404, 409, 422, 429, 502, 503].map((status) => [status, errorResponse]),
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
  description: 'The Idempotency-Key is global within one consumer and remains bound to the Hub API key that created its usage record. Reuse it only with that same API key when retrying the exact same path and normalized body; another API key, a new path, body or page requires a new Idempotency-Key.',
  schema: {
    type: 'string',
    minLength: 8,
    maxLength: 128,
    pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$',
  },
}

const nightAllCompatibilityIdempotencyParameter = {
  ...idempotencyParameter,
  description: 'Permanently names one immutable provider dispatch for this exact path and normalized body. The dispatch may consume provider quota or Hub procurement cost; it does not prove a Hub customer charge. Reuse always replays that result; use a new Idempotency-Key only when intentionally requesting a new live call.',
}

const externalCommerceIdempotencyParameter = {
  ...idempotencyParameter,
  required: false,
  description: 'Optional for cache_only and cache_first, but required for refresh. Reuse the same Idempotency-Key only for a transport retry of the exact same page request. Every next-page request changes the body and must use a new Idempotency-Key. When omitted, every HTTP call receives a unique internal key and is a distinct metered Hub request, even when it is served from cache.',
}

const externalCommerceUncertainRepeatParameter = {
  name: 'X-MX-Insight-Retry-Of',
  in: 'header',
  required: false,
  description: 'UUID of a matching prior same-consumer ecommerce request whose durable status is unknown. It explicitly accepts possible duplicate provider cost for one intentionally new refresh. Hub verifies the operation and normalized fingerprint. It requires deliveryMode=refresh and a different new Idempotency-Key. It never bypasses reserved state, succeeded-unusable quarantine, failed status lookup, route/version mismatch, quota, circuit or concurrency.',
  schema: { type: 'string', format: 'uuid' },
}

const externalPostIdempotencyParameter = {
  ...idempotencyParameter,
  required: false,
  description: 'Optional for cache_only and cache_first, but required for refresh. Reuse it only for a transport retry of the exact same normalized note URL. The canonical and compatibility route spellings share one idempotency namespace; changing the path does not authorize another external call. A caller-supplied key is consumer-scoped and remains bound to the API key that first used it. When omitted, every HTTP call receives a unique internal key and creates its own usage/charge attribution; consumer snapshots and dispatch suppression remain shared.',
}

const externalPostUncertainRepeatParameter = {
  name: 'X-MX-Insight-Retry-Of',
  in: 'header',
  required: false,
  description: 'UUID of a matching prior same-consumer Xiaohongshu post request whose durable outcome is unknown. It requires deliveryMode=refresh and a different new Idempotency-Key. Hub verifies the operation and normalized note identity; it never bypasses a reserved request, response quarantine, failed status lookup, quota, circuit or concurrency.',
  schema: { type: 'string', format: 'uuid' },
}

const searchResponse = {
  description: 'Stable provider-neutral data-search response. Xiaohongshu requests served by the Hub-native connector also expose delivery-source and capture-age headers.',
  headers: {
    'x-mx-insight-request-id': {
      description: 'Durable request identifier for status lookup.',
      schema: { type: 'string', format: 'uuid' },
    },
    'idempotent-replay': {
      description: 'Whether the stored result of the same idempotent request was returned.',
      schema: { type: 'string', enum: ['true', 'false'] },
    },
    'x-mx-insight-source-mode': {
      description: 'Present when Hub has delivery-path evidence. stale is the historical compatibility snapshot mode; the other cache/fallback values are Hub-native connector modes.',
      schema: {
        type: 'string',
        enum: ['live', 'stale', 'fresh_cache', 'stored_fallback', 'idempotent_replay'],
      },
    },
    'x-mx-insight-captured-at': {
      description: 'Present when Hub knows when the delivered external-data snapshot was captured.',
      schema: { type: 'string', format: 'date-time' },
    },
    Age: {
      description: 'Whole seconds between capture and delivery when capture evidence is available.',
      schema: { type: 'integer', minimum: 0 },
    },
    Warning: {
      description: 'HTTP Warning 110 is present for stale or stored_fallback delivery.',
      schema: { type: 'string' },
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

const externalSocialPostResponse = {
  description: 'A provider-neutral normalized social post plus explicit Hub freshness metadata. Business media and avatar URLs are preserved; media indexes 0..19 also include a same-origin authenticated Hub relay locator, while later media remain intact without a relay locator.',
  headers: externalCommerceProductSearchResponse.headers,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ExternalSocialPostEnvelope' },
    },
  },
}

const externalCommerceProductMediaResponse = {
  description: 'A bounded image retained by the same consumer search response and fetched through the Hub media relay. This read does not create Hub usage or dispatch a product-search request.',
  headers: {
    'x-mx-insight-request-id': {
      description: 'Request identifier for this media read, distinct from the search requestId query parameter.',
      schema: { type: 'string', format: 'uuid' },
    },
    'cache-control': {
      description: 'Prevents a consumer-authorized image response from being retained by shared or browser caches.',
      schema: { type: 'string', example: 'private, no-store' },
    },
    vary: {
      description: 'Declares that authorization is part of the response selection boundary.',
      schema: { type: 'string', example: 'Authorization' },
    },
  },
  content: Object.fromEntries(
    ['image/jpeg', 'image/png', 'image/webp']
      .map((contentType) => [contentType, {
        schema: { type: 'string', format: 'binary' },
      }]),
  ),
}

const externalSocialPostMediaResponse = {
  ...externalCommerceProductMediaResponse,
  description: 'One bounded image retained by the same consumer\'s committed social-post response. This read creates no Hub usage and dispatches no post-detail request.',
}

function externalSocialPostOperation({ platformShaped = false } = {}) {
  return {
    tags: ['External Data'],
    operationId: platformShaped ? 'getXiaohongshuNoteInfo' : 'resolveExternalSocialPost',
    summary: platformShaped
      ? 'Resolve one Xiaohongshu note link using the recommended platform-shaped JSON contract'
      : 'Resolve one Xiaohongshu note link through the governed external data gateway',
    description: `${platformShaped
      ? 'Recommended JSON-body form of the platform-shaped route. A missing platform defaults to xiaohongshu. '
      : 'Canonical provider-neutral social-post route. platform must be xiaohongshu. '
    }The request accepts only an official Xiaohongshu note or share URL plus deliveryMode. It requires a Live Hub Public API key whose immutable platform and capability snapshots include xiaohongshu and social.posts.resolve, while those consumer grants remain active. cache_only never dispatches external acquisition; cache_first is the default; refresh requires Idempotency-Key. All supported route and method forms share one normalized note identity, snapshot, external-dispatch suppression boundary and idempotency namespace; the immutable idempotency request binding additionally includes deliveryMode, so changing that policy conflicts instead of replaying or dispatching. The response never exposes provider credentials, endpoint coordinates, raw envelopes, diagnostic cache URLs, procurement price or customer invoice. Business content is not desensitized or filtered: media[].url and author.avatarUrl preserve accepted source values, while media indexes 0..19 receive an additive authenticated same-origin media[].hubRelayUrl bound to this response requestId and index; later source media remain intact without a relay locator. An accepted but unavailable note may consume external capacity, so a verified request-local miss is negative-cached and is never retried automatically.`,
    'x-mx-canonical-operation': '/data/post',
    'x-mx-error-codes': {
      400: [
        'invalid_request', 'invalid_json', 'invalid_platform', 'invalid_post_url', 'unsupported_fields',
        'invalid_delivery_mode', 'idempotency_key_required', 'invalid_idempotency_key',
        'invalid_uncertain_retry',
      ],
      401: ['api_key_required', 'invalid_api_key'],
      403: ['platform_not_granted', 'capability_not_granted', 'test_key_not_supported'],
      404: ['post_not_found', 'stored_snapshot_not_found'],
      409: [
        'request_in_progress', 'idempotency_conflict', 'request_outcome_unknown',
        'external_platform_response_unusable', 'uncertain_retry_not_allowed',
      ],
      413: ['payload_too_large'],
      429: [...QUOTA_429_CODES, 'external_platform_busy', 'external_platform_rate_limited', 'external_platform_capacity_exceeded', 'external_platform_cost_budget_exhausted', 'external_platform_subsidy_budget_exhausted'],
      502: [
        'external_platform_response_unusable', 'external_platform_outcome_unknown',
        'external_platform_rejected',
      ],
      503: [
        'external_platform_unavailable', 'external_platform_not_configured',
        'external_platform_contract_unverified',
        'external_platform_circuit_open', 'external_platform_capacity_unavailable',
        'external_platform_cost_control_unavailable', 'external_platform_cost_evidence_incomplete',
        'external_platform_operation_disabled', 'external_platform_operation_shadow',
        'external_platform_operation_paused', 'external_platform_operation_canary',
        'external_platform_operation_blocked',
      ],
    },
    parameters: [externalPostIdempotencyParameter, externalPostUncertainRepeatParameter],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            $ref: platformShaped
              ? '#/components/schemas/XiaohongshuPostCompatibilityRequest'
              : '#/components/schemas/XiaohongshuPostRequest',
          },
          example: {
            ...(platformShaped ? {} : { platform: 'xiaohongshu' }),
            url: 'https://www.xiaohongshu.com/explore/0123456789abcdef01234567',
            deliveryMode: 'cache_first',
          },
        },
      },
    },
    responses: {
      200: externalSocialPostResponse,
      400: errorResponse,
      401: errorResponse,
      403: errorResponse,
      404: errorResponse,
      409: errorResponse,
      413: errorResponse,
      429: errorResponse,
      502: errorResponse,
      503: errorResponse,
    },
  }
}

function platformShapedExternalSocialPostGetOperation() {
  const { requestBody: _requestBody, ...operation } = externalSocialPostOperation({ platformShaped: true })
  return {
    ...operation,
    operationId: 'getXiaohongshuNoteInfoCompatibility',
    summary: 'Resolve one Xiaohongshu note using the compatibility GET contract',
    description: 'This Hub-owned platform-shaped GET path accepts note_id or one official note/share link in share_text; note_id takes precedence when both are present. delivery_mode is an optional Hub policy. It returns the same stable Hub social-post contract as /data/post and the JSON-body form of this path. Authentication, authorization, quota, cache, archive and response semantics are identical. Equivalent note_id and long-link inputs share one canonical note identity, snapshot and external-dispatch suppression; the idempotency binding additionally includes delivery mode, so reusing a key after changing that policy conflicts. Changing route, method or parameter spelling does not authorize another external dispatch. The public response does not expose external provider identity, credentials, endpoint coordinates or raw envelopes. Because GET places share_text in the request target, prefer note_id or a JSON POST form when a link contains temporary query parameters such as xsec_token that could be retained by access logs.',
    parameters: [
      {
        name: 'note_id', in: 'query', required: false,
        description: 'A 24-character Xiaohongshu note ID. Either note_id or share_text is required; note_id takes precedence when both are present.',
        schema: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
      },
      {
        name: 'share_text', in: 'query', required: false,
        description: 'Exactly one official xiaohongshu.com note URL or xhslink.com/xhslink.cn share URL. Either share_text or note_id is required. Plain text, arbitrary pages, credentials, ports and fragments are rejected. Prefer note_id or JSON POST when temporary query parameters must not enter access logs.',
        schema: { type: 'string', format: 'uri', minLength: 1, maxLength: 2048 },
      },
      {
        name: 'delivery_mode', in: 'query', required: false,
        description: 'Hub delivery policy. refresh permits one new acquisition and requires Idempotency-Key.',
        schema: { type: 'string', enum: [...XIAOHONGSHU_POST_DELIVERY_MODES], default: 'cache_first' },
      },
      ...operation.parameters,
    ],
  }
}

const officialXiaohongshuIdempotencyParameter = {
  name: 'Idempotency-Key', in: 'header', required: false,
  description: 'Optional for App V2-compatible GETs. When supplied it is bound to this exact endpoint and normalized query and only exact explicit reuse is replayed. When omitted, every HTTP call receives a unique internal key and is metered separately; cache and provider-dispatch suppression remain independent.',
  schema: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' },
}

const officialXiaohongshuResponse = {
  description: 'The acquired App V2 business envelope. Hub preserves business fields, text, tags and signed media URLs. For user-post traversal only, provider pagination controls are replaced with the governed opaque Hub cursor/has-more state and terminate at page 15. Only an exact active Hub-to-upstream credential is removed if the upstream echoes it; request Authorization, Cookie and API-key headers are never copied into the response.',
  headers: {
    'x-mx-insight-request-id': {
      description: 'Durable Hub request identifier.',
      schema: { type: 'string', format: 'uuid' },
    },
    'idempotent-replay': { schema: { type: 'string', enum: ['true', 'false'] } },
    'x-mx-insight-source-mode': {
      schema: { type: 'string', enum: ['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay'] },
    },
    'x-mx-insight-captured-at': { schema: { type: 'string', format: 'date-time' } },
    Age: { schema: { type: 'integer', minimum: 0 } },
    Warning: { schema: { type: 'string' } },
  },
  content: {
    'application/json': {
      schema: {
        type: 'object',
        additionalProperties: true,
        description: 'Upstream-compatible business envelope governed and archived by Hub.',
      },
    },
  },
}

function officialXiaohongshuOperation(endpointName) {
  const definitions = {
    get_image_note_detail: {
      operationId: 'getXiaohongshuImageNoteDetailOfficial',
      summary: 'Get one image-note detail with the App V2-compatible contract',
      operationCapability: 'social.posts.resolve',
      parameters: [
        {
          name: 'note_id', in: 'query', required: false,
          description: 'A 24-character Xiaohongshu note ID. Either note_id or share_text is required; note_id takes precedence when both are present.',
          schema: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
        },
        {
          name: 'share_text', in: 'query', required: false,
          description: 'Provider-bound share text or URL. Business query parameters are preserved for the upstream request.',
          schema: { type: 'string', minLength: 1, maxLength: 8192 },
        },
      ],
    },
    search_notes: {
      operationId: 'searchXiaohongshuNotesOfficial',
      summary: 'Search notes with the App V2-compatible contract',
      operationCapability: 'social.posts.search',
      parameters: [
        { name: 'keyword', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 500 } },
        { name: 'page', in: 'query', required: false, description: 'Explicit page, governed to 1..15.', schema: { type: 'integer', minimum: 1, maximum: 15, default: 1 } },
        { name: 'sort_type', in: 'query', required: false, schema: { type: 'string', enum: ['general', 'time_descending', 'popularity_descending', 'comment_descending', 'collect_descending', 'english_preferred'], default: 'general' } },
        { name: 'note_type', in: 'query', required: false, schema: { type: 'string', enum: ['不限', '视频笔记', '普通笔记', '直播笔记'], default: '不限' } },
        { name: 'time_filter', in: 'query', required: false, schema: { type: 'string', enum: ['不限', '一天内', '一周内', '半年内'], default: '不限' } },
        { name: 'search_id', in: 'query', required: false, schema: { type: 'string', minLength: 1, maxLength: 2048 } },
        { name: 'search_session_id', in: 'query', required: false, schema: { type: 'string', minLength: 1, maxLength: 2048 } },
        { name: 'source', in: 'query', required: false, schema: { type: 'string', minLength: 1, maxLength: 8192, default: 'explore_feed' } },
        { name: 'ai_mode', in: 'query', required: false, schema: { type: 'string', enum: ['0', '1'], default: '0' } },
      ],
    },
    search_users: {
      operationId: 'searchXiaohongshuUsersOfficial',
      summary: 'Search users with the App V2-compatible contract',
      operationCapability: 'social.users.resolve',
      parameters: [
        { name: 'keyword', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 500 } },
        { name: 'page', in: 'query', required: false, description: 'Explicit page, governed to 1..15.', schema: { type: 'integer', minimum: 1, maximum: 15, default: 1 } },
        { name: 'search_id', in: 'query', required: false, schema: { type: 'string', minLength: 1, maxLength: 2048 } },
        { name: 'source', in: 'query', required: false, schema: { type: 'string', minLength: 1, maxLength: 8192, default: 'explore_feed' } },
      ],
    },
    get_user_info: {
      operationId: 'getXiaohongshuUserInfoOfficial',
      summary: 'Get one user profile with the App V2-compatible contract',
      operationCapability: 'social.users.resolve',
      parameters: [
        { name: 'user_id', in: 'query', required: false, description: 'A 24-character Xiaohongshu user ID. Either user_id or share_text is required; user_id takes precedence when both are present.', schema: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' } },
        { name: 'share_text', in: 'query', required: false, schema: { type: 'string', minLength: 1, maxLength: 8192 } },
      ],
    },
    get_user_posted_notes: {
      operationId: 'getXiaohongshuUserPostedNotesOfficial',
      summary: 'Get one user\'s posted notes with the App V2-compatible contract',
      operationCapability: 'social.users.posts',
      parameters: [
        { name: 'user_id', in: 'query', required: false, description: 'A 24-character Xiaohongshu user ID. Either user_id or share_text is required; user_id takes precedence when both are present.', schema: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' } },
        { name: 'share_text', in: 'query', required: false, schema: { type: 'string', minLength: 1, maxLength: 8192 } },
        { name: 'cursor', in: 'query', required: false, description: 'Opaque Hub cursor returned by the preceding page. It wraps the provider cursor, binds the user scope and terminates after page 15.', schema: { type: 'string', minLength: 1, maxLength: 8192 } },
      ],
    },
  }
  const definition = definitions[endpointName]
  return {
    tags: ['External Data'],
    operationId: definition.operationId,
    summary: definition.summary,
    'x-mx-strict-query': true,
    'x-mx-required-platform': 'xiaohongshu',
    'x-mx-required-capabilities': ['compat.xiaohongshu.app_v2', definition.operationCapability],
    description: `A Hub-governed App V2-compatible GET, not an unmetered proxy. It requires a Live Hub Public API key whose immutable scope includes the xiaohongshu data domain, compat.xiaohongshu.app_v2 contract and ${definition.operationCapability} operation. It uses one-unit customer metering, provider cost admission, idempotency, response archive and canonical ingest/outbox. Provider business fields remain intact. Explicit page traversal and the opaque user-post cursor are capped at 15 pages; this governance limit does not truncate content. Search responses may contain provider previews; use the detail endpoint for the complete note while every preview is still stored with provider_preview completeness.`,
    'x-mx-error-codes': {
      400: ['invalid_request', 'unsupported_fields', 'invalid_page', 'invalid_sort_type', 'invalid_note_type', 'invalid_time_filter', 'invalid_ai_mode', 'invalid_cursor', 'invalid_idempotency_key'],
      401: ['api_key_required', 'invalid_api_key'],
      403: ['platform_not_granted', 'capability_not_granted', 'test_key_not_supported'],
      404: ['not_found', 'post_not_found'],
      409: ['request_in_progress', 'idempotency_conflict', 'request_outcome_unknown', 'external_platform_response_unusable'],
      429: [...QUOTA_429_CODES, 'external_platform_busy', 'external_platform_rate_limited', 'external_platform_capacity_exceeded', 'external_platform_cost_budget_exhausted', 'external_platform_subsidy_budget_exhausted'],
      502: ['external_platform_response_unusable', 'external_platform_outcome_unknown', 'external_platform_rejected'],
      503: ['external_platform_unavailable', 'external_platform_not_configured', 'external_platform_contract_unverified', 'external_platform_circuit_open', 'external_platform_capacity_unavailable', 'external_platform_cost_control_unavailable', 'external_platform_cost_evidence_incomplete', 'external_platform_operation_disabled', 'external_platform_operation_shadow', 'external_platform_operation_paused', 'external_platform_operation_canary', 'external_platform_operation_blocked'],
    },
    parameters: [...definition.parameters, officialXiaohongshuIdempotencyParameter],
    responses: {
      200: officialXiaohongshuResponse,
      400: errorResponse,
      401: errorResponse,
      403: errorResponse,
      404: errorResponse,
      409: errorResponse,
      429: errorResponse,
      502: errorResponse,
      503: errorResponse,
    },
  }
}

function nightAllCompatibilityOperation({ historicalAlias = false } = {}) {
  const aliasDescription = historicalAlias
    ? 'This historical /search spelling is an exact alias of /night-all/search: both enter the same Hub service and paid-operation fingerprint, so changing the route cannot authorize or purchase a second upstream dispatch. '
    : ''
  return {
    tags: ['Compatibility'],
    operationId: historicalAlias
      ? 'searchHistoricalCompatibilityAlias'
      : 'searchNightAllCompatibility',
    summary: historicalAlias
      ? 'Call a legacy search operation through its historical route alias'
      : 'Call one of the three Night-All legacy search operations',
    'x-mx-required-capabilities-by-platform-operation': {
      xiaohongshu: {
        raw: 'social.posts.search',
        crawl: 'social.users.posts',
        'user-info': 'social.users.resolve',
      },
    },
    description: `${aliasDescription}The Hub authenticates and authorizes the platform, then selects the implementation without exposing provider credentials. For Xiaohongshu, the immutable API-key scope must also include the matching business operation: raw requires social.posts.search, crawl requires social.users.posts and user-info requires social.users.resolve. This operation grant is checked before either Hub-native or historical dispatch. After independent rollout gates, a compatible Xiaohongshu raw first-page request uses the Hub-native direct connector when it has exactly one scalar keyword or query, effective page size 20, and no fan-out/detail/comment workload controls. Explicit includeDetails=false/includeComments=false remain harmless compatibility defaults. Xiaohongshu crawl and user-info also use Hub-native acquisition for one username, userId, uid or official profile URL; crawl additionally requires posts-only activity, effective page size 20, concurrency 1 and either no cursor or its Hub-issued opaque cursor. These migrated shapes retain the historical legacy envelope and one customer usage unit while all provider calls are cost-admitted atomically. Unsupported multi-identifier/channel/non-post/non-20/custom-params shapes continue on the historical compatibility path until migrated. Previously issued direct cursors stay on their owning connector. Historical Night-All cursor/composite/page/offset continuations are replaced at the public boundary by a consumer/operation/platform/query-scoped encrypted mxnc1 cursor carrying the next page number; public page mode becomes cursor mode, public offset mode becomes composite mode, and page 15 is terminal. Pre-migration raw provider cursors or continuation params return 400 invalid_cursor and must restart without a cursor and with a new Idempotency-Key. The direct projection keeps raw_info and raw_data as JSON strings and puts the durable Hub request UUID in both the body requestId and x-mx-insight-request-id header. Night-All-owned live/fallback bodies keep their original business fields and correlation IDs unchanged; only pagination-control fields are governed. Historical ingestion retains the complete pre-projection parsed JSON and legacy raw strings; Hub-native provider calls additionally retain exact response bytes in restricted storage. The legacy x-mx-insight-source-mode header remains live or stale; Hub-native cache/replay states map back to that vocabulary. Historical dispatch is governed by the Hub-pinned, grant-filtered data.legacySearch matrix returned by GET /data/capabilities; its selected platform must appear in both supportedPlatforms and readyPlatforms. A data.platforms entry alone, including telegram, does not grant a historical operation. The matrix is owned by the deployed Hub release and is not fetched from Night-All at request time. readyPlatforms does not prove current Night-All handler, endpoint, provider, credential, or upstream health. Network/timeout ambiguity, an unusable HTTP 2xx content-type/JSON/envelope, or a real non-2xx HTTP 502/503/504 may return the exact governed snapshot. Provider/token/credential/endpoint/capability/moduleCode routing controls and archive/fullArchive/allTweets/archiveLimit/totalCount/max*Pages/pageCount/chunkSize/budget/crawlDepth cost-amplification controls are rejected; they require a separately granted capability and server policy.`,
    ...(historicalAlias
      ? { 'x-mx-canonical-operation': '/night-all/search/{operation}' }
      : {}),
    'x-mx-error-codes': {
      400: ['invalid_request', 'invalid_query', 'invalid_cursor', 'invalid_page_size', 'cursor_scope_mismatch', 'invalid_platform', 'page_size_exceeded', 'work_budget_exceeded', 'unsupported_fields', 'business_id_mismatch', 'idempotency_key_required', 'invalid_idempotency_key', 'invalid_user_profile_url', 'cursor_page_mismatch', 'platform_operation_unsupported', 'night_all_rejected'],
      401: ['api_key_required', 'invalid_api_key'],
      403: ['platform_not_granted', 'capability_not_granted', 'test_key_not_supported'],
      404: ['not_found', 'user_not_found', 'night_all_rejected'],
      409: ['request_in_progress', 'idempotency_conflict', 'request_outcome_unknown', 'external_platform_response_unusable', 'night_all_rejected'],
      422: ['night_all_rejected'],
      429: [...QUOTA_429_CODES, 'external_platform_busy', 'external_platform_rate_limited', 'external_platform_capacity_exceeded', 'external_platform_cost_budget_exhausted', 'external_platform_subsidy_budget_exhausted', 'night_all_rejected'],
      502: ['night_all_rejected', 'upstream_outcome_unknown', 'external_platform_response_unusable', 'external_platform_outcome_unknown', 'external_platform_rejected'],
      503: ['platform_operation_unavailable', 'compatibility_capabilities_unavailable', 'compatibility_store_unavailable', 'external_platform_unavailable', 'external_platform_not_configured', 'external_platform_contract_unverified', 'external_platform_circuit_open', 'external_platform_capacity_unavailable', 'external_platform_cost_control_unavailable', 'external_platform_cost_evidence_incomplete', 'external_platform_operation_disabled', 'external_platform_operation_shadow', 'external_platform_operation_paused', 'external_platform_operation_canary', 'external_platform_operation_blocked'],
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
    responses: { 200: nightAllCompatibilityResponse, ...nightAllCompatibilityErrors },
  }
}

const nightAllCompatibilityResponse = {
  description: 'Legacy envelope. After independent rollout gates, eligible single-query Xiaohongshu raw and eligible single-identifier Xiaohongshu crawl/user-info requests use Hub-native acquisition without changing raw_info/raw_data types. Hub-issued cursors remain on their owning connector. Historical Night-All continuations are exposed only as encrypted mxnc1 Hub cursors and every traversal stops after page 15. Business fields remain unchanged; only pagination controls are governed. Historical ingestion retains complete parsed JSON; Hub-native calls additionally retain exact response bytes in restricted storage.',
  headers: {
    'x-mx-insight-request-id': {
      description: 'Durable Hub request identifier for status lookup.',
      schema: { type: 'string', format: 'uuid' },
    },
    'x-mx-insight-source-mode': {
      description: 'Stable legacy delivery vocabulary. Hub-native cache and replay states are projected to live; a stored fallback, or a replay of one, is projected to stale.',
      schema: { type: 'string', enum: ['live', 'stale'] },
    },
    'x-mx-insight-captured-at': {
      description: 'When the delivered compatibility response was captured.',
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


// OpenAPI entries for the platform-shaped resources are generated from the same
// registry the dispatcher uses, so a released resource cannot ship undocumented
// and a documented one cannot drift from its real parameters.
function justoneResourcePaths() {
  const entries = {}
  for (const resource of JUSTONE_RELEASED_RESOURCES) {
    const versions = resource.versions
    const properties = {
      version: {
        type: 'string',
        enum: [...versions],
        default: resource.defaultVersion,
        description: 'Upstream endpoint version. Each version is a distinct logical request and is fingerprinted separately.',
      },
      deliveryMode: {
        type: 'string',
        enum: [...ECOMMERCE_DELIVERY_MODES],
        default: 'cache_first',
      },
    }
    const required = []
    const seen = new Set()
    for (const version of versions) {
      for (const declared of resource.variantFor(version).params) {
        if (seen.has(declared.name)) {
          if (declared.values) properties[declared.name].enum = [...new Set([...(properties[declared.name].enum || []), ...declared.values])]
          continue
        }
        seen.add(declared.name)
        properties[declared.name] = declared.kind === 'page'
          ? { type: 'integer', minimum: 1, maximum: 1000, default: declared.defaultValue ?? 1 }
          : declared.values
            ? { type: 'string', enum: [...declared.values] }
            : { type: 'string', maxLength: 64 }
      }
      if (version === resource.defaultVersion) {
        for (const declared of resource.variantFor(version).params) {
          if (declared.required) required.push(declared.name)
        }
      }
    }
    entries[resource.hubPath.replace('/api/v1', '')] = {
      post: {
        tags: ['External Data'],
        operationId: `fetch${resource.resourceKey.replace(/[.-]([a-z])/gu, (_, c) => c.toUpperCase()).replace(/^[a-z]/u, (c) => c.toUpperCase())}`,
        summary: `${resource.label}（平台原生字段）`,
        'x-mx-required-platform': 'ecommerce',
        'x-mx-required-capabilities': [resource.operationKey],
        'x-mx-upstream-versions': [...versions],
        'x-mx-version-parameters': Object.fromEntries(versions.map(v => [v, resource.variantFor(v).params])),
        description: `平台原生合同：业务参数名按上游版本映射，Hub 使用独立 POST 路径，响应 data 保留上游字段名，不做 Hub 重命名或裁剪，外层保留 Hub 的 contractVersion/meta/requestId。上游未对 data 发布类型，因此字段随上游变化；需要稳定结构时改用 /data/ecommerce/products/search。要求 ecommerce 数据域授权与 ${resource.operationKey} 业务操作授权，两者独立于商品搜索。deliveryMode 默认 cache_first：cache_only 不发起上游调用，refresh 绕过新鲜缓存并需要调用方提供 Idempotency-Key。每次真实上游调用计一次上游成本；命中缓存不计上游成本。`,
        'x-mx-error-codes': {
          400: [
            'invalid_request', 'unsupported_request_field', 'unsupported_version',
            'invalid_delivery_mode', 'idempotency_key_required', 'invalid_idempotency_key',
          ],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted', 'capability_not_granted', 'test_key_not_supported'],
          404: ['stored_snapshot_not_found', 'unsupported_resource'],
          409: ['request_in_progress', 'idempotency_conflict', 'request_outcome_unknown'],
          413: ['payload_too_large'],
          429: [...QUOTA_429_CODES, 'external_platform_busy', 'external_platform_rate_limited'],
          502: ['external_platform_response_unusable', 'external_platform_outcome_unknown', 'external_platform_rejected'],
          503: [
            'external_platform_unavailable', 'external_platform_not_configured',
            'external_platform_circuit_open', 'external_platform_operation_disabled',
            'external_platform_operation_shadow', 'external_platform_operation_paused',
            'external_platform_operation_canary', 'external_platform_operation_blocked',
          ],
        },
        parameters: [externalCommerceIdempotencyParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object', additionalProperties: false, properties,
                oneOf: versions.map(version => {
                  const variant = resource.variantFor(version)
                  const names = new Set(variant.params.map(p => p.name))
                  return {
                    required: [...(version === resource.defaultVersion ? [] : ['version']), ...variant.params.filter(p => p.required).map(p => p.name)],
                    properties: {
                      version: { const: version },
                      ...Object.fromEntries([...seen].map(name => {
                        const param = variant.params.find(p => p.name === name)
                        return [name, !names.has(name) ? false : param.values ? { enum: [...param.values] } : {}]
                      })),
                    },
                  }
                }),
              },
            },
          },
        },
        responses: { 200: { description: `${resource.label}（上游字段名）` } },
      },
    }
  }
  return entries
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
      'The three explicitly named Night-All compatibility routes retain the legacy envelope. Eligible Xiaohongshu raw calls may use a Hub-native projection with the same raw_info/raw_data field types; Night-All-owned bodies remain unchanged. Other public routes do not expose raw source rows or management coordinates.',
    ].join('\n\n'),
  },
  'x-mx-external-platform-admission': {
    paidReady: {
      definition: 'The current usage request has a positive enforced per-request customer charge and its wallet hold was successfully reserved.',
      rejectedByHubMonthlyProcurementOrSubsidyCaps: false,
    },
    subsidizedTraffic: {
      definition: 'Traffic without that positive enforced per-request wallet hold, including unpriced, shadow-priced and zero-price requests.',
      possibleFinancialCapErrors: [
        'external_platform_cost_budget_exhausted',
        'external_platform_subsidy_budget_exhausted',
      ],
    },
    procurementEvidence: {
      currentEndpointAndRequestRequiredForPaidReady: true,
      unrelatedHistoricalAnomaliesRejectPaidReady: false,
    },
    technicalProtections: {
      applyToPaidReady: true,
      controls: [
        'api_key_and_plan_quota',
        'shared_provider_rate_limit',
        'global_and_consumer_concurrency',
        'circuit_breaker',
        'contract_credential_idempotency_and_dispatch_safety',
      ],
    },
  },
  servers: [{ url: '/api/v1', description: 'Same-origin public API' }],
  tags: [
    { name: 'Discovery', description: 'Discover the caller\'s granted platform capabilities.' },
    { name: 'Source Catalog', description: 'Reconstruct the active governed source catalog, filters, taxonomy, owners and status summary.' },
    { name: 'Mobile Commerce', description: 'Read stored mobile-collector commerce captures and their governed source-catalog classification.' },
    { name: 'Virtual Supermarket', description: 'Reconstruct the on-shelf Hub storefront using semantic department, aisle, shelf and position data.' },
    { name: 'External Data', description: 'Call governed external data platforms through provider-neutral Hub contracts.' },
    { name: 'Search', description: 'Idempotent content search.' },
    { name: 'Compatibility', description: 'Temporary legacy routes with transparent Hub-native routing where contracted, durable Hub evidence and exact last-good fallback.' },
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
    ...justoneResourcePaths(),
    '/data/social/accounts/search': {
      post: {
        tags: ['External Data'],
        operationId: 'searchSocialAccounts',
        summary: '按关键词搜索社交平台账号',
        'x-mx-required-platform': 'social',
        'x-mx-required-capabilities': ['social.accounts.search'],
        description: '跨四个平台的关键词搜账号，返回 Hub 归一化的稳定账号结构（与平台原生层不同，这一层做归一化）。需要 social 数据域与 social.accounts.search 业务操作双授权，两者独立于 ecommerce。上游对这四个接口都不返回总数或 hasMore：空页是翻到底的唯一凭据，非空页不足以证明还有下一页，因此 hasMore 为 null 表示「上游未声明」。快手返回的是内容混合流，同一账号会跨条目重复，Hub 已按 (platform, userId) 去重并在 page.duplicateCount 中报出；抖音个别条目无法解析时计入 page.discardedCount 而不使整页失败。粉丝数只有在上游给出精确整数时才有值，形如「1.2万」的展示串一律为 null，不做换算。',
        'x-mx-error-codes': {
          400: [
            'invalid_request', 'unsupported_request_field', 'unsupported_platform',
            'invalid_keyword', 'invalid_page', 'invalid_delivery_mode',
            'idempotency_key_required', 'invalid_idempotency_key',
          ],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted', 'capability_not_granted', 'test_key_not_supported'],
          404: ['stored_snapshot_not_found'],
          409: ['request_in_progress', 'idempotency_conflict', 'request_outcome_unknown'],
          413: ['payload_too_large'],
          429: [...QUOTA_429_CODES, 'external_platform_busy', 'external_platform_rate_limited'],
          502: ['external_platform_response_unusable', 'external_platform_outcome_unknown', 'external_platform_rejected'],
          503: [
            'external_platform_unavailable', 'external_platform_not_configured',
            'external_platform_circuit_open', 'external_platform_operation_disabled',
            'external_platform_operation_shadow', 'external_platform_operation_paused',
            'external_platform_operation_canary', 'external_platform_operation_blocked',
          ],
        },
        parameters: [externalCommerceIdempotencyParameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['platform', 'keyword'],
                properties: {
                  platform: { type: 'string', enum: [...SOCIAL_ACCOUNT_PLATFORMS] },
                  keyword: { type: 'string', minLength: 1, maxLength: 200 },
                  page: { type: 'integer', minimum: 1, maximum: 1000, default: 1 },
                  deliveryMode: {
                    type: 'string',
                    enum: [...ECOMMERCE_DELIVERY_MODES],
                    default: 'cache_first',
                  },
                },
              },
            },
          },
        },
        responses: { 200: { description: '归一化账号列表' } },
      },
    },

    '/data/capabilities': {
      get: {
        tags: ['Discovery'],
        operationId: 'listPublicCapabilities',
        summary: 'List capabilities granted to the authenticated consumer',
        description: 'Use this response to decide which platform operations and generic capabilities the current API key may call. data.platforms describes granted Hub data surfaces; paid acquisition also requires its matching operation capability. A Xiaohongshu entry with search_posts and search.ready=true advertises the Hub-native 20-item search contract used by /data/search and eligible legacy raw requests, but the key must also have social.posts.search. Eligible single-identifier Xiaohongshu crawl/user-info requests are also Hub-native after their independent rollout gate and require social.users.posts/social.users.resolve respectively. When Xiaohongshu already has a compatibility platform row, Hub preserves its provider-neutral top-level readiness/source identity; only nested search and postDetail describe Hub-direct readiness. post_detail is advertised only when the same key also has the independent social.posts.resolve capability grant. Telegram bounded message context and bidirectional live-keyset timeline are advertised per dataset under platform.context and platform.timeline; their ready flags are index-serving gates independent from the broader Telegram platform ready flag. For public_opinion, ready requires both an active fixed ingest source and both valid Hub serving indexes; it is not another grant or a freshness guarantee, and a paused source may still have indexed rows. Each granted data_center_saved_records_<source_type> entry is Hub-owned with source=hub, servingMode=stored and capabilities stored_search plus canonical_search. Its ready flag requires that exact fixed leaf source to be active and the search layer to be configured; a paused leaf may still retain stored rows, readiness is neither a publication grant nor a freshness guarantee, and these platforms never enter data.legacySearch. The independent data.legacySearch value is the Hub-pinned, grant-filtered dispatch matrix for historical compatibility operations and is compiled into the deployed Hub contract rather than discovered at request time. Xiaohongshu remains in the legacy matrix because unsupported multi-query, multi-identifier, channel, non-post, non-20-page and custom-params shapes have not yet migrated. An operation governed by that matrix requires its platform in both supportedPlatforms and readyPlatforms. In this pinned contract, readyPlatforms means Hub dispatch eligibility; it does not prove the current historical handler, endpoint, provider, credential, or upstream health. legacySearch is null when the consumer has no granted platform eligible for that historical compatibility path.',
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
                        platform: 'data_center_saved_records_news',
                        ready: false,
                        capabilities: ['stored_search', 'canonical_search'],
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
                        deliveryModes: [...ECOMMERCE_DELIVERY_MODES],
                        freshnessModes: ['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay'],
                      },
                      {
                        platform: 'xiaohongshu',
                        ready: true,
                        capabilities: ['search_posts', 'post_detail'],
                        search: {
                          ready: true,
                          source: 'hub',
                          servingMode: 'live_with_stored_fallback',
                          contractVersion: 'night-all.data-search.v1',
                        },
                        postDetail: {
                          ready: true,
                          source: 'hub',
                          servingMode: 'live_with_stored_fallback',
                          contractVersion: 'mx-insight-hub.social-post.v1',
                          input: 'official_note_url',
                          deliveryModes: [...XIAOHONGSHU_POST_DELIVERY_MODES],
                        },
                      },
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
                      { capability: 'social.posts.resolve', ready: true },
                      { capability: 'social.posts.search', ready: true },
                      { capability: 'social.users.resolve', ready: true },
                      { capability: 'social.users.posts', ready: true },
                      { capability: 'compat.xiaohongshu.app_v2', ready: true },
                      { capability: 'ecommerce.products.search', ready: true },
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
        'x-mx-required-platform': 'ecommerce',
        'x-mx-required-capabilities': ['ecommerce.products.search'],
        description: 'Uses the ordinary Live Hub Public API key issued through API Keys and requires both the ecommerce data-domain grant and ecommerce.products.search business-operation grant in the key immutable scope; no ecommerce-specific or provider key is accepted. Legacy Test keys are compatibility metadata rather than an isolated sandbox and are rejected before usage reservation, cache work or provider dispatch. The strict body accepts only marketplace, query, deliveryMode, page, cursor, sort and price; pageSize and provider-routing fields are not part of this contract. deliveryMode defaults to cache_first: cache_only never dispatches external acquisition and returns 404 when no exact snapshot exists; refresh bypasses a fresh snapshot, requires a caller-supplied Idempotency-Key and may still deliver an exact stored fallback when acquisition fails. X-MX-Insight-Retry-Of names a matching prior same-consumer unknown ecommerce request and is accepted only for refresh with a different new Idempotency-Key; Hub verifies operation and normalized fingerprint, and never bypasses reserved state, succeeded-unusable quarantine, lookup failure, route/version mismatch, quota, circuit or concurrency. page and cursor are mutually exclusive. Prefer the opaque nextCursor returned by Hub, keep marketplace/query/sort/price unchanged, and use a new Idempotency-Key for every next page. Hub never labels a stored result as live. A provider success that cannot be normalized is committed as a stable 502; replaying the same Idempotency-Key returns that error without another provider call. A 200 response with an empty items array is a valid delivery, not an interface failure. No external platform identity, credential, endpoint, provider rate/balance/free quota, procurement amount, customer invoice or raw response is exposed; sourceMode is delivery evidence, not a customer price.',
        'x-mx-error-codes': {
          400: [
            'invalid_request', 'invalid_marketplace', 'unsupported_marketplace',
            'invalid_query', 'invalid_page', 'invalid_cursor', 'invalid_pagination',
            'cursor_scope_mismatch', 'continuation_required', 'unsupported_sort',
            'invalid_price', 'unsupported_price_filter', 'unsupported_request_field',
            'invalid_delivery_mode', 'idempotency_key_required', 'invalid_idempotency_key',
            'invalid_uncertain_retry',
          ],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted', 'capability_not_granted', 'test_key_not_supported'],
          404: ['stored_snapshot_not_found'],
          409: [
            'request_in_progress', 'idempotency_conflict', 'request_outcome_unknown',
            'external_platform_response_unusable', 'uncertain_retry_not_allowed',
          ],
          413: ['payload_too_large'],
          429: [...QUOTA_429_CODES, 'external_platform_busy', 'external_platform_rate_limited', 'external_platform_capacity_exceeded', 'external_platform_cost_budget_exhausted', 'external_platform_subsidy_budget_exhausted'],
          502: [
            'external_platform_response_unusable', 'external_platform_outcome_unknown',
            'external_platform_rejected',
          ],
          503: [
            'external_platform_unavailable', 'external_platform_not_configured',
            'external_platform_circuit_open', 'external_platform_capacity_unavailable',
            'external_platform_cost_control_unavailable', 'external_platform_cost_evidence_incomplete',
            'external_platform_operation_disabled', 'external_platform_operation_shadow',
            'external_platform_operation_paused', 'external_platform_operation_canary',
            'external_platform_operation_blocked',
          ],
        },
        parameters: [externalCommerceIdempotencyParameter, externalCommerceUncertainRepeatParameter],
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
                storedOnly: {
                  summary: 'Read an exact Hub snapshot without external acquisition',
                  value: { marketplace: 'jd', query: 'AI recorder', deliveryMode: 'cache_only' },
                },
                explicitRefresh: {
                  summary: 'Bypass a fresh snapshot and attempt one governed acquisition',
                  value: { marketplace: 'jd', query: 'AI recorder', deliveryMode: 'refresh' },
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
          404: errorResponse,
          409: errorResponse,
          413: errorResponse,
          429: errorResponse,
          502: errorResponse,
          503: errorResponse,
        },
      },
    },
    '/data/ecommerce/products/media': {
      get: {
        tags: ['External Data'],
        operationId: 'getExternalCommerceProductMedia',
        summary: 'Read one retained product image through the governed Hub media relay',
        'x-mx-strict-query': true,
        description: 'Authenticates an ordinary Live Hub Public API key and requires the same consumer identity that received a committed ecommerce search result. Test keys are rejected before any store or image-loader work. requestId identifies that response, itemId identifies one returned item and imageIndex selects one of its retained images; these are the only accepted query parameters and each must appear exactly once. Hub never accepts an arbitrary URL on this endpoint. The relay permits bounded public HTTPS JPEG, PNG and WebP images only, validates DNS and every redirect, limits dimensions, duration, rate and concurrency, and rejects private-network destinations, oversized bodies and mismatched content. This read creates no Hub usage record and dispatches no product-search request.',
        'x-mx-error-codes': {
          400: ['invalid_request', 'unsupported_fields'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted', 'test_key_not_supported'],
          404: ['external_media_not_found'],
          413: ['external_media_too_large'],
          415: ['external_media_type_rejected', 'external_media_content_invalid', 'external_media_dimensions_rejected'],
          422: ['external_media_url_invalid', 'external_media_url_blocked', 'external_media_host_blocked'],
          429: ['external_media_rate_limited', 'external_media_busy'],
          502: ['external_media_unavailable', 'external_media_redirect_rejected', 'external_media_source_throttled'],
          503: ['external_media_unavailable'],
          504: ['external_media_timeout'],
        },
        parameters: [
          {
            name: 'requestId', in: 'query', required: true,
            description: 'requestId from the committed ecommerce search response that contained the image reference.',
            schema: { type: 'string', format: 'uuid' },
          },
          {
            name: 'itemId', in: 'query', required: true,
            description: 'Exact item id from that response.',
            schema: { type: 'string', minLength: 1, maxLength: 512 },
          },
          {
            name: 'imageIndex', in: 'query', required: true,
            description: 'Zero-based index into that item\'s images array.',
            schema: { type: 'integer', minimum: 0, maximum: 19 },
          },
        ],
        responses: {
          200: externalCommerceProductMediaResponse,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          413: errorResponse,
          415: errorResponse,
          422: errorResponse,
          429: errorResponse,
          502: errorResponse,
          503: errorResponse,
          504: errorResponse,
        },
      },
    },
    '/data/post': {
      post: externalSocialPostOperation(),
    },
    '/xiaohongshu/app/get_note_info': {
      get: platformShapedExternalSocialPostGetOperation(),
      post: externalSocialPostOperation({ platformShaped: true }),
    },
    '/xiaohongshu/app_v2/get_image_note_detail': {
      get: officialXiaohongshuOperation('get_image_note_detail'),
    },
    '/xiaohongshu/app_v2/search_notes': {
      get: officialXiaohongshuOperation('search_notes'),
    },
    '/xiaohongshu/app_v2/search_users': {
      get: officialXiaohongshuOperation('search_users'),
    },
    '/xiaohongshu/app_v2/get_user_info': {
      get: officialXiaohongshuOperation('get_user_info'),
    },
    '/xiaohongshu/app_v2/get_user_posted_notes': {
      get: officialXiaohongshuOperation('get_user_posted_notes'),
    },
    '/data/posts/media': {
      get: {
        tags: ['External Data'],
        operationId: 'getExternalSocialPostMedia',
        summary: 'Read one retained social-post image through the governed Hub media relay',
        'x-mx-strict-query': true,
        description: 'Requires a Live Hub Public API key from the same consumer that received the committed post response, plus effective xiaohongshu and social.posts.resolve entitlements. requestId and mediaIndex are the complete query allowlist and must each appear exactly once. Hub never accepts an arbitrary source URL. The relay validates public HTTPS DNS and every redirect, enforces bounded type, dimensions, body, duration, rate and concurrency, and returns only JPEG, PNG or WebP. Multiple image reads may run concurrently within the deployment safeguards. This read creates no Hub usage and dispatches no post-detail request.',
        'x-mx-error-codes': {
          400: ['invalid_request', 'unsupported_fields'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted', 'capability_not_granted', 'test_key_not_supported'],
          404: ['external_media_not_found'],
          413: ['external_media_too_large'],
          415: ['external_media_type_rejected', 'external_media_content_invalid', 'external_media_dimensions_rejected'],
          422: ['external_media_url_invalid', 'external_media_url_blocked', 'external_media_host_blocked'],
          429: ['external_media_rate_limited', 'external_media_busy'],
          502: ['external_media_unavailable', 'external_media_redirect_rejected', 'external_media_source_throttled'],
          503: ['external_media_unavailable'],
          504: ['external_media_timeout'],
        },
        parameters: [
          {
            name: 'requestId', in: 'query', required: true,
            description: 'requestId from the committed social-post response that contained the media reference.',
            schema: { type: 'string', format: 'uuid' },
          },
          {
            name: 'mediaIndex', in: 'query', required: true,
            description: 'Zero-based index into data.item.media.',
            schema: { type: 'integer', minimum: 0, maximum: 19 },
          },
        ],
        responses: {
          200: externalSocialPostMediaResponse,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          413: errorResponse,
          415: errorResponse,
          422: errorResponse,
          429: errorResponse,
          502: errorResponse,
          503: errorResponse,
          504: errorResponse,
        },
      },
    },
    '/data/search': {
      post: {
        tags: ['Search'],
        operationId: 'searchData',
        summary: 'Search one explicitly selected platform',
        'x-mx-required-capabilities-by-platform': { xiaohongshu: 'social.posts.search' },
        description: 'One request targets one granted platform. For platform=telegram, Hub searches canonical stored messages. For platform=xiaohongshu, the API-key scope must also include social.posts.search; this is checked before direct or historical dispatch, and the default and only Hub-native page size is exactly 20. Compatible first-page requests use the governed direct external-data connector only after an independent rollout gate; previously issued opaque mxec2 direct cursors remain on that connector. The response keeps the night-all.data-search.v1 envelope. A non-20 pageSize stays on the historical compatibility path; that path now returns an encrypted, consumer/query/page-size-scoped mxnc1 nextCursor and terminates after page 15. Return that cursor unchanged with a new Idempotency-Key for each page. A pre-migration raw historical cursor returns 400 invalid_cursor and must restart from a cursor-less first page. Hub automatically attempts bounded detail enrichment only for note bodies at the provider preview boundary; it keeps a detail body only when it is strictly longer and reports unresolved enrichment as response warnings. public_opinion and every data_center_saved_records_* platform are Hub-stored and deliberately rejected by this live-compatible route; use the province feed, /data/stored/search or /data/canonical/search. The caller never selects an external provider; cursors cannot move between paths, queries or page sizes. Replay the same body with the same Idempotency-Key.',
        'x-mx-error-codes': {
          400: ['invalid_request', 'invalid_platform', 'invalid_query', 'invalid_cursor', 'invalid_page_size', 'cursor_scope_mismatch', 'page_size_exceeded', 'unsupported_fields', 'unsupported_match_mode', 'invalid_result_type', 'idempotency_key_required', 'invalid_idempotency_key', 'platform_operation_unsupported'],
          401: ['api_key_required', 'invalid_api_key'],
          403: ['platform_not_granted', 'capability_not_granted', 'test_key_not_supported'],
          409: ['request_in_progress', 'idempotency_conflict', 'request_outcome_unknown', 'external_platform_response_unusable'],
          410: ['search_cursor_expired'],
          429: [...QUOTA_429_CODES, 'external_platform_busy', 'external_platform_rate_limited', 'external_platform_capacity_exceeded', 'external_platform_cost_budget_exhausted', 'external_platform_subsidy_budget_exhausted'],
          502: ['night_all_rejected', 'upstream_outcome_unknown', 'external_platform_response_unusable', 'external_platform_outcome_unknown', 'external_platform_rejected'],
          503: ['stored_search_unavailable', 'search_cursor_unavailable', 'external_platform_unavailable', 'external_platform_not_configured', 'external_platform_contract_unverified', 'external_platform_circuit_open', 'external_platform_capacity_unavailable', 'external_platform_cost_control_unavailable', 'external_platform_cost_evidence_incomplete', 'external_platform_operation_disabled', 'external_platform_operation_shadow', 'external_platform_operation_paused', 'external_platform_operation_canary', 'external_platform_operation_blocked'],
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
      post: nightAllCompatibilityOperation(),
    },
    '/search/{operation}': {
      post: nightAllCompatibilityOperation({ historicalAlias: true }),
    },
    '/data/stored/search': {
      post: {
        tags: ['Search'],
        operationId: 'searchStoredData',
        summary: 'Search Hub canonical data without calling an upstream provider',
        description: 'Requires the explicit platform grant. datasetId and objectType are exact filters, not separate authorization grants: every consumer granted a platform can search the complete Hub canonical corpus for that platform. For platform=public_opinion the default is formal-only. Every data_center_saved_records_* platform returns only records whose governed crawler publication eligibility is candidate; internal, missing and unknown eligibility never pass. Candidate and exact geography/time controls are accepted only with explicit platform=public_opinion; includeCandidates=all requires from, to and at least one of province, countryCode or location. Other platforms are unaffected. Explicit public-opinion candidate responses expose only bounded Hub quality/location metadata and omit candidate author/contentType and upstream source identity. Elasticsearch content-v6 is preferred; an older projection or a first-page transport failure falls back to the same visibility rules in PostgreSQL. A pre-visibility crawler cursor has an obsolete HMAC query binding and returns 400 invalid_cursor; restart from a cursor-less first page with a new Idempotency-Key. A current-contract Elasticsearch cursor never changes backend: if its content-v6 projection is unavailable, Hub returns 503 search_cursor_unavailable and callers retry the same cursor later. Physical databases, indices and query DSL are not accepted. The applicable publication-visibility contract is bound to the cursor and idempotency fingerprint; after upgrading to this contract, use a new Idempotency-Key instead of reusing a pre-upgrade key.',
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
        description: 'Searches the shared Hub canonical current-state projection once; it does not fan out to source APIs. Omitting platform searches all platforms currently granted to the consumer. In a mixed-platform result, the public_opinion branch is formal-only by default, and every data_center_saved_records_* crawler branch returns only records whose governed crawler publication eligibility is candidate; other platform branches are unchanged. Candidate and exact geography/time controls require explicit platform=public_opinion; includeCandidates=all requires from, to and at least one of province, countryCode or location. Explicit public-opinion candidate responses expose only bounded Hub quality/location metadata and omit candidate author/contentType and upstream source identity. platform, datasetId and objectType only narrow the authorized scope. searchProfile selects a versioned, server-owned query policy; callers cannot supply analyzers or Elasticsearch DSL. Balanced search uses HanLP/pre-segmented AND only while query segmentation is healthy; degraded Jieba/bigram terms switch the applied profile to raw phrase. The signed cursor is bound to the sorted platform-grant scope, query, filters, page size, resolved search profile, applicable publication-visibility contracts and first-page analysis state so later pages do not re-segment. The independent canonical-search usage bucket always uses the strictest limits across the consumer\'s complete current grant set. Elasticsearch content-v6 is preferred; an older projection or first-page transport failure falls back to the same visibility rules in PostgreSQL. A pre-visibility crawler cursor has an obsolete HMAC query binding and returns 400 invalid_cursor; restart from a cursor-less first page with a new Idempotency-Key. A current-contract Elasticsearch cursor never changes backend: if its content-v6 projection is unavailable, Hub returns 503 search_cursor_unavailable and callers retry the same cursor later. The applicable publication-visibility contracts are part of the idempotency fingerprint whenever the authorized scope can include public_opinion or data_center_saved_records_*; after upgrading to a visibility contract, use a new Idempotency-Key instead of reusing a pre-upgrade key.',
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
          429: [...QUOTA_429_CODES],
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
          429: [...QUOTA_429_CODES],
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
          429: [...QUOTA_429_CODES],
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
          429: [...QUOTA_429_CODES],
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
          429: [...QUOTA_429_CODES],
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
          429: [...QUOTA_429_CODES],
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
          429: [...QUOTA_429_CODES],
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
          429: [...QUOTA_429_CODES],
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
          429: [...QUOTA_429_CODES],
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
          429: [...QUOTA_429_CODES],
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
          429: [...QUOTA_429_CODES],
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
          429: [...QUOTA_429_CODES],
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
          429: [...QUOTA_429_CODES],
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
          429: [...QUOTA_429_CODES],
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
          429: [...QUOTA_429_CODES],
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
          429: [...QUOTA_429_CODES],
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
          429: [...QUOTA_429_CODES],
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
          429: [...QUOTA_429_CODES],
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
          429: [...QUOTA_429_CODES],
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
    '/requests/by-idempotency-key': {
      get: {
        tags: ['Evidence'],
        operationId: 'getPublicRequestStatusByIdempotencyKey',
        summary: 'Find this consumer\'s request by its original idempotency key',
        description: 'Recovery path for a client that retained its Idempotency-Key but did not receive the durable request UUID. Send the value only in the Idempotency-Key header. This consumer-scoped GET creates no usage, returns no stored response body or idempotency key and cannot dispatch an upstream call. Any current active key for the same consumer may perform the lookup; another consumer receives request_not_found.',
        parameters: [{
          name: 'Idempotency-Key', in: 'header', required: true,
          schema: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' },
          description: 'The exact key retained for the original request. Do not put it in a URL query or path.',
        }],
        responses: {
          200: {
            description: 'Caller-owned request status. data.id is the original durable request UUID; the envelope requestId identifies this lookup.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RequestStatusEnvelope' } } },
          },
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    '/requests/{requestId}': {
      get: {
        tags: ['Evidence'],
        operationId: 'getPublicRequestStatus',
        summary: 'Read the outcome of a request owned by this consumer',
        description: 'Use x-mx-insight-request-id from a search response. This GET creates no usage and cannot dispatch an upstream call. reserved and unknown never permit replay of the old POST; committed permits exact replay and released closes the prior intent. An unknown ecommerce request may be referenced by X-MX-Insight-Retry-Of only for one separate, explicitly confirmed refresh with a different Idempotency-Key; reserved cannot.',
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
    '/acquisitions/{requestId}': {
      get: {
        tags: ['Evidence'],
        operationId: 'getPublicAcquisitionHistory',
        summary: 'Replay the exact committed delivery created by this API key',
        description: 'Read-only evidence lookup. It returns the response body that the Hub previously delivered, its stable semantic hash, downstream charge and ordered canonical references. It never dispatches or re-runs an upstream request. Only the same API key that created the request may read the full delivery; a rotated, zero-scope or foreign key receives acquisition_query_run_not_found. The Admin Token is the recovery path.',
        parameters: [{
          name: 'requestId', in: 'path', required: true,
          schema: { type: 'string', format: 'uuid' },
        }],
        responses: {
          200: {
            description: 'Caller-owned exact delivery and safe lineage evidence.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AcquisitionHistoryEnvelope' } } },
          },
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
          409: errorResponse,
          503: errorResponse,
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
        description: 'Authorization: Bearer <ordinary Hub Public API key issued through API Keys>. The key resolves to one consumer. Hub resolves grants and quotas for that identity; future customer pricing will resolve through its versioned subscription and price-book snapshot without requiring another credential.',
      },
      apiKeyHeader: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description: 'The same ordinary Hub Public API key as bearerKey, supplied through x-api-key instead of Authorization. This is not a provider credential or a product-specific key.',
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
          pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Defaults to 20. Xiaohongshu uses the Hub-native connector only when this value is exactly 20.' },
          cursor: { type: 'string', minLength: 1, maxLength: 8192, description: 'Opaque nextCursor from the prior page. Return it unchanged with the same path, platform, query and pageSize.' },
          type: resultTypeProperty,
        },
      },
      ExternalCommerceProductSearchRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['marketplace', 'query'],
        not: { required: ['page', 'cursor'] },
        description: 'Provider-neutral product search. deliveryMode controls only whether Hub may dispatch external acquisition; it never selects a provider. page and cursor are mutually exclusive. The server owns result-size policy; pageSize is intentionally unsupported.',
        properties: {
          marketplace: {
            type: 'string',
            enum: ['taobao', 'tmall', 'jd', 'xiaohongshu_ec', 'xianyu'],
          },
          query: { type: 'string', minLength: 1, maxLength: 200 },
          deliveryMode: {
            type: 'string',
            enum: [...ECOMMERCE_DELIVERY_MODES],
            default: 'cache_first',
            description: 'cache_only reads only an exact Hub snapshot and never dispatches externally; cache_first reuses a fresh snapshot before acquisition; refresh bypasses a fresh snapshot, requires Idempotency-Key and may fall back to an exact stored snapshot after an acquisition failure; live_only also bypasses a fresh snapshot and requires Idempotency-Key, but never serves stored data -- an acquisition that cannot complete returns its error instead of a fallback.',
          },
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
                description: 'Bounded reason category present only for stored_fallback. Retained for compatibility; prefer `reason`.',
              },
              reason: {
                type: 'object',
                additionalProperties: false,
                required: ['code', 'scope', 'summary', 'degraded', 'liveAttempted'],
                description:
                  'Why this delivery looks the way it does. Present on every delivery, including healthy ones, so the absence of a field never has to be interpreted. `scope` names the subsystem that made the decision, `degraded` says whether the caller received less than a live upstream read, and `liveAttempted` says whether an upstream call was actually started (and therefore possibly billed).',
                properties: {
                  code: { type: 'string', maxLength: 160 },
                  scope: {
                    type: 'string',
                    enum: [
                      'upstream', 'delivery_policy', 'operation_control', 'provider_credential',
                      'circuit_breaker', 'dispatch_dedup', 'concurrency', 'rate_limit', 'idempotency',
                    ],
                  },
                  summary: { type: 'string', maxLength: 400 },
                  degraded: { type: 'boolean' },
                  liveAttempted: { type: 'boolean' },
                  detail: {
                    type: 'object',
                    description: 'Optional machine-readable evidence, such as the operation-control blockers that refused dispatch.',
                  },
                },
              },
            },
          },
          requestId: { type: 'string', format: 'uuid' },
        },
      },
      XiaohongshuPostRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['platform', 'url'],
        properties: {
          platform: { type: 'string', const: 'xiaohongshu' },
          url: {
            type: 'string', format: 'uri', minLength: 1, maxLength: 2048,
            description: 'Official xiaohongshu.com explore/discovery note URL with a 24-character note ID, or an xhslink.com/xhslink.cn share URL. Credentials, ports and fragments are rejected.',
          },
          deliveryMode: {
            type: 'string', enum: [...XIAOHONGSHU_POST_DELIVERY_MODES], default: 'cache_first',
          },
        },
      },
      XiaohongshuPostCompatibilityRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: {
          platform: { type: 'string', const: 'xiaohongshu', default: 'xiaohongshu' },
          url: { $ref: '#/components/schemas/XiaohongshuPostRequest/properties/url' },
          deliveryMode: { $ref: '#/components/schemas/XiaohongshuPostRequest/properties/deliveryMode' },
        },
      },
      ExternalSocialPostMedia: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'url'],
        properties: {
          type: { type: 'string', const: 'image' },
          url: {
            type: 'string', format: 'uri',
            description: 'Accepted source business-media URL preserved without Hub filtering or replacement.',
          },
          hubRelayUrl: {
            type: 'string', format: 'uri-reference', maxLength: 2048,
            pattern: '^/api/v1/data/posts/media\\?requestId=[0-9a-f-]+&mediaIndex=(?:[0-9]|1[0-9])$',
            description: 'Optional additive same-origin authenticated Hub media relay locator, present for media indexes 0..19 and bound to this response requestId and media index. Later source media remain intact without an unusable locator.',
          },
        },
      },
      ExternalSocialPost: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id', 'externalId', 'platform', 'contentType', 'url', 'title', 'text',
          'tags', 'author', 'metrics', 'media', 'publishedAt', 'collectedAt',
        ],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 256 },
          externalId: { type: 'string', pattern: '^[0-9a-f]{24}$' },
          platform: { type: 'string', const: 'xiaohongshu' },
          contentType: { type: 'string', const: 'post' },
          url: { type: 'string', format: 'uri' },
          title: { type: ['string', 'null'] },
          text: { type: ['string', 'null'] },
          tags: {
            type: 'array', uniqueItems: true,
            items: { type: 'string', minLength: 1 },
          },
          author: {
            type: 'object', additionalProperties: false,
            required: ['id', 'name', 'avatarUrl'],
            properties: {
              id: { type: ['string', 'null'] },
              name: { type: ['string', 'null'] },
              avatarUrl: {
                type: ['string', 'null'], format: 'uri',
                description: 'Accepted source avatar URL preserved as business data; null only when the source did not provide one.',
              },
            },
          },
          metrics: {
            type: 'object', additionalProperties: false,
            required: ['liked', 'collected', 'comments', 'shared'],
            properties: Object.fromEntries(
              ['liked', 'collected', 'comments', 'shared']
                .map((field) => [field, { type: ['integer', 'null'], minimum: 0 }]),
            ),
          },
          media: {
            type: 'array',
            items: { $ref: '#/components/schemas/ExternalSocialPostMedia' },
          },
          publishedAt: { type: ['string', 'null'], format: 'date-time' },
          collectedAt: { type: 'string', format: 'date-time' },
        },
      },
      ExternalSocialPostEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['contractVersion', 'data', 'meta', 'requestId'],
        properties: {
          contractVersion: { type: 'string', const: 'mx-insight-hub.social-post.v1' },
          data: {
            type: 'object', additionalProperties: false, required: ['item'],
            properties: { item: { $ref: '#/components/schemas/ExternalSocialPost' } },
          },
          meta: {
            type: 'object', additionalProperties: false,
            required: ['capturedAt', 'servedAt', 'sourceMode', 'ageSeconds'],
            properties: {
              capturedAt: { type: 'string', format: 'date-time' },
              servedAt: { type: 'string', format: 'date-time' },
              sourceMode: {
                type: 'string',
                enum: ['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay'],
              },
              ageSeconds: { type: 'integer', minimum: 0 },
              fallbackReason: { type: 'string', maxLength: 160 },
              reason: {
                type: 'object',
                additionalProperties: false,
                required: ['code', 'scope', 'summary', 'degraded', 'liveAttempted'],
                description:
                  'Why this delivery looks the way it does. Present on every delivery, including healthy ones, so the absence of a field never has to be interpreted. `scope` names the subsystem that made the decision, `degraded` says whether the caller received less than a live upstream read, and `liveAttempted` says whether an upstream call was actually started (and therefore possibly billed).',
                properties: {
                  code: { type: 'string', maxLength: 160 },
                  scope: {
                    type: 'string',
                    enum: [
                      'upstream', 'delivery_policy', 'operation_control', 'provider_credential',
                      'circuit_breaker', 'dispatch_dedup', 'concurrency', 'rate_limit', 'idempotency',
                    ],
                  },
                  summary: { type: 'string', maxLength: 400 },
                  degraded: { type: 'boolean' },
                  liveAttempted: { type: 'boolean' },
                  detail: {
                    type: 'object',
                    description: 'Optional machine-readable evidence, such as the operation-control blockers that refused dispatch.',
                  },
                },
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
          page: { oneOf: [{ type: 'integer', minimum: 1, maximum: 15 }, { type: 'string', pattern: '^(?:[1-9]|1[0-5])$' }] },
          cursor: { type: 'string', minLength: 1, maxLength: 8192, description: 'Only an opaque Hub cursor returned by the preceding page is accepted. Historical raw provider cursors fail closed with invalid_cursor; restart without cursor and use a new Idempotency-Key.' },
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
          params: { type: 'object', additionalProperties: true, description: 'Safe non-continuation platform values are accepted on the first page. For continuation, return the exact Hub-issued nextParams object (currently {cursor: mxnc1...}); raw provider continuation values fail closed. Rejected keys and workload overrides are listed by x-mx-rejected-params.' },
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
          cursor: { type: 'string', minLength: 1, maxLength: 8192, description: 'HMAC-signed opaque nextCursor bound to query, platform, datasetId, objectType, page size and every applicable public_opinion or data_center_saved_records_* publication-visibility contract.' },
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
          cursor: { type: 'string', minLength: 1, maxLength: 8192, description: 'HMAC-signed opaque nextCursor bound to the query, filters, page size, resolved search profile, requested sort, authorized platform scope, bounded first-page analysis state and every applicable public_opinion or data_center_saved_records_* publication-visibility contract.' },
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
              raw_info: { type: 'string', contentMediaType: 'application/json', description: 'JSON-string array retained for compatibility. Hub-native Xiaohongshu raw uses the same type; Night-All-owned results remain unchanged.' },
              raw_data: { type: 'string', contentMediaType: 'application/json', description: 'JSON-string array retained for compatibility. Hub-native Xiaohongshu raw uses the same type; Night-All-owned results remain unchanged.' },
              page: { type: 'object', additionalProperties: true, description: 'Business-neutral pagination controls. Historical provider continuation is replaced by an encrypted mxnc1 Hub cursor and page 15 is terminal; content fields are not filtered or truncated.' },
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
        description: 'Hub-pinned, grant-filtered Night-All-owned operation dispatch entry. readyPlatforms is always a subset of supportedPlatforms and means the deployed Hub contract permits historical dispatch. It is not populated by live Night-All discovery and does not prove handler, endpoint, provider, credential, or upstream health. A historical operation may dispatch only when its platform appears in both arrays; a Hub-native contract advertised under data.platforms is independent.',
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
                    source: { type: 'string', enum: ['hub'], description: 'Present only when the complete top-level platform entry is Hub-owned. A mixed Xiaohongshu compatibility row may omit it; use nested search/postDetail source for direct readiness.' },
                    servingMode: {
                      type: 'string',
                      enum: ['stored', 'live_with_stored_fallback'],
                      description: 'Present for wholly Hub-owned stored or governed live-with-fallback entries. A mixed Xiaohongshu row may retain its existing top-level identity and publish direct serving mode only in nested search/postDetail.',
                    },
                    contractVersion: { type: 'string', description: 'Stable Hub contract version when the platform exposes one.' },
                    marketplaces: {
                      type: 'array',
                      items: { type: 'string', enum: ['taobao', 'tmall', 'jd', 'xiaohongshu_ec', 'xianyu'] },
                    },
                    pagination: { type: 'string', enum: ['opaque_cursor'] },
                    idempotencyKey: { type: 'string', enum: ['optional'] },
                    deliveryModes: {
                      type: 'array',
                      // The union of values any platform may advertise. A given
                      // platform lists only the subset its contract implements.
                      items: { type: 'string', enum: [...ECOMMERCE_DELIVERY_MODES] },
                    },
                    freshnessModes: {
                      type: 'array',
                      items: {
                        type: 'string',
                        enum: ['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay'],
                      },
                    },
                    input: { type: 'string', enum: ['official_note_url'] },
                    postDetail: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['ready', 'source', 'servingMode', 'contractVersion', 'input', 'deliveryModes'],
                      properties: {
                        ready: { type: 'boolean' },
                        source: { type: 'string', const: 'hub' },
                        servingMode: { type: 'string', const: 'live_with_stored_fallback' },
                        contractVersion: { type: 'string', const: 'mx-insight-hub.social-post.v1' },
                        input: { type: 'string', const: 'official_note_url' },
                        deliveryModes: {
                          type: 'array',
                          items: { type: 'string', enum: [...XIAOHONGSHU_POST_DELIVERY_MODES] },
                        },
                      },
                    },
                    search: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['ready', 'source', 'servingMode', 'contractVersion'],
                      description: 'Hub-native Xiaohongshu search contract. It is advertised only after the independent first-page rollout gate is enabled. Dispatch requires both the xiaohongshu data domain and social.posts.search operation; post_detail remains independently gated by social.posts.resolve.',
                      properties: {
                        ready: { type: 'boolean' },
                        source: { type: 'string', const: 'hub' },
                        servingMode: { type: 'string', const: 'live_with_stored_fallback' },
                        contractVersion: { type: 'string', const: 'night-all.data-search.v1' },
                      },
                    },
                    context: { $ref: '#/components/schemas/CanonicalContextCapability' },
                    timeline: { $ref: '#/components/schemas/CanonicalTimelineCapability' },
                  },
                },
              },
              legacySearch: {
                description: 'Hub-pinned, grant-filtered historical dispatch matrix, or null when the consumer has no granted platform eligible for the Night-All-owned path. It is authoritative only for Hub routing on that historical path and is not a live Night-All capability or provider-readiness result. A platform may appear here and under data.platforms: direct search takes only its compatible subset and does not remove non-direct shapes from legacy dispatch. Null fails closed for historical dispatch but does not disable a Hub-native contract advertised under data.platforms.',
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
                      enum: ['compat.xiaohongshu.app_v2', 'ecommerce.products.search', 'nlp.tokenize', 'public_opinion.all_ingested.read', 'public_opinion.diagnostics.read', 'social.posts.resolve', 'social.posts.search', 'social.users.resolve', 'social.users.posts'],
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
      AcquisitionHistoryEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'requestId'],
        properties: {
          data: {
            type: 'object',
            additionalProperties: false,
            required: ['contractVersion', 'requestId', 'status', 'scope', 'units', 'delivered', 'customerCharge', 'items'],
            properties: {
              contractVersion: { type: 'string', const: 'mx-insight-hub.acquisition-query-run.v1' },
              requestId: { type: 'string', format: 'uuid' },
              status: { type: 'string', const: 'committed' },
              scope: { type: 'object', additionalProperties: true },
              units: { type: 'object', additionalProperties: true },
              delivered: {
                type: 'object',
                additionalProperties: false,
                required: ['responseStatus', 'sourceMode', 'capturedAt', 'completedAt', 'responseHash', 'responseHashContract', 'responseBody', 'gatewayEvents'],
                properties: {
                  responseStatus: { type: 'integer', minimum: 100, maximum: 599 },
                  sourceMode: { type: ['string', 'null'] },
                  capturedAt: { type: ['string', 'null'], format: 'date-time' },
                  completedAt: { type: ['string', 'null'], format: 'date-time' },
                  responseHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
                  responseHashContract: { type: 'string', const: 'sha256-canonical-json-v1' },
                  responseBody: {},
                  gatewayEvents: { type: 'array', items: { type: 'object', additionalProperties: true } },
                },
              },
              customerCharge: { type: ['object', 'null'], additionalProperties: true },
              items: { type: 'array', items: { type: 'object', additionalProperties: true } },
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

PUBLIC_OPENAPI_DOCUMENT.paths['/data/topic-reports'] = {
  post: {
    operationId: 'createTopicReport',
    summary: 'Create an asynchronous topic insight report',
    description: 'Creates a durable report from the caller\'s currently granted saved-record platforms. The immutable authorization snapshot is stored with the task. Generation reads PostgreSQL canonical truth, exposes only publication-eligible records, never invokes an upstream source, and does not require or trigger an Elasticsearch rebuild or HanLP run. Idempotency-Key is required and one accepted task consumes one usage unit.',
    parameters: [{
      name: 'Idempotency-Key', in: 'header', required: true,
      schema: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' },
    }],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateTopicReportRequest' } } },
    },
    responses: {
      202: {
        description: 'The durable task was accepted. Poll the returned id with GET /data/topic-reports/{id}.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/TopicReportEnvelope' } } },
      },
      ...publicErrors,
    },
  },
}

PUBLIC_OPENAPI_DOCUMENT.paths['/data/topic-reports/{id}'] = {
  get: {
    operationId: 'getTopicReport',
    summary: 'Read topic report progress or result',
    description: 'Returns only a task owned by the authenticated consumer. Status polling does not dispatch upstream collection, invoke a model, or create another usage charge. A succeeded result contains bounded public-safe evidence and deterministic co-occurrence associations; associations are not causal claims.',
    parameters: [{
      name: 'id', in: 'path', required: true,
      schema: { type: 'string', format: 'uuid' },
    }],
    responses: {
      200: {
        description: 'Current durable task state and, once succeeded, its report.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/TopicReportEnvelope' } } },
      },
      ...publicErrors,
    },
  },
}

Object.assign(PUBLIC_OPENAPI_DOCUMENT.components.schemas, {
  CreateTopicReportRequest: {
    type: 'object', additionalProperties: false, required: ['topic'],
    properties: {
      topic: { type: 'string', minLength: 2, maxLength: 300 },
      language: { type: 'string', enum: ['zh-CN', 'en'], default: 'zh-CN' },
      range: { type: 'string', enum: ['24h', '7d', '30d', '90d', 'custom'], default: '7d' },
      from: { type: 'string', format: 'date-time', description: 'Required only when range=custom.' },
      to: { type: 'string', format: 'date-time', description: 'Required only when range=custom.' },
      sourceScope: { type: 'string', enum: ['all_granted', 'selected'], default: 'all_granted' },
      platforms: {
        type: 'array', minItems: 1, maxItems: 13, uniqueItems: true,
        description: 'Required when sourceScope=selected. Every value must be a granted data_center_saved_records_* platform.',
        items: { type: 'string', pattern: '^data_center_saved_records_[a-z_]+$' },
      },
      sampleLimit: { type: 'integer', minimum: 20, maximum: 500, default: 240 },
    },
  },
  TopicReportTask: {
    type: 'object', additionalProperties: false,
    required: ['id', 'contractVersion', 'topic', 'language', 'range', 'sourceScope', 'sampleLimit', 'status', 'phase', 'progress', 'result', 'error', 'createdAt', 'startedAt', 'completedAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      contractVersion: { type: 'string', const: 'mx-insight-hub.data-products.topic-report.v1' },
      topic: { type: 'string' },
      language: { type: 'string', enum: ['zh-CN', 'en'] },
      range: {
        type: 'object', additionalProperties: false, required: ['from', 'to'],
        properties: { from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' } },
      },
      sourceScope: {
        type: 'object', additionalProperties: false, required: ['mode', 'platforms', 'categories'],
        properties: {
          mode: { type: 'string', enum: ['all_granted', 'selected'] },
          platforms: { type: 'array', items: { type: 'string' } },
          categories: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'label'], properties: { id: { type: 'string' }, label: { type: 'string' } } } },
        },
      },
      sampleLimit: { type: 'integer', minimum: 20, maximum: 500 },
      status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed'] },
      phase: { type: 'string', enum: ['queued', 'selecting_evidence', 'building_associations', 'complete', 'failed'] },
      progress: { type: 'integer', minimum: 0, maximum: 100 },
      result: { oneOf: [{ type: 'null' }, { $ref: '#/components/schemas/TopicReportResult' }] },
      error: {
        oneOf: [
          { type: 'null' },
          { type: 'object', additionalProperties: false, required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' } } },
        ],
      },
      createdAt: { type: 'string', format: 'date-time' },
      startedAt: { type: ['string', 'null'], format: 'date-time' },
      completedAt: { type: ['string', 'null'], format: 'date-time' },
    },
  },
  TopicReportResult: {
    type: 'object', additionalProperties: false,
    required: ['contractVersion', 'generatedAt', 'topic', 'language', 'window', 'coverage', 'executiveSummary', 'timeline', 'dimensions', 'associations', 'evidence', 'methodology'],
    properties: {
      contractVersion: { type: 'string', const: 'mx-insight-hub.data-products.topic-report.v1' },
      generatedAt: { type: 'string', format: 'date-time' },
      topic: { type: 'string' },
      language: { type: 'string' },
      window: { type: 'object', additionalProperties: true },
      coverage: { type: 'object', additionalProperties: false, required: ['matchedRecords', 'analyzedRecords', 'evidenceRecords', 'categoryCount', 'truncated'], properties: { matchedRecords: { type: 'integer', minimum: 0 }, analyzedRecords: { type: 'integer', minimum: 0, maximum: 500 }, evidenceRecords: { type: 'integer', minimum: 0, maximum: 80 }, categoryCount: { type: 'integer', minimum: 0, maximum: 13 }, truncated: { type: 'boolean' } } },
      executiveSummary: { type: 'object', additionalProperties: true },
      timeline: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['date', 'count'], properties: { date: { type: 'string', format: 'date' }, count: { type: 'integer', minimum: 1 } } } },
      dimensions: { type: 'object', additionalProperties: true },
      associations: { type: 'object', additionalProperties: true },
      evidence: { type: 'array', maxItems: 80, items: { type: 'object', additionalProperties: true } },
      methodology: { type: 'object', additionalProperties: true },
    },
  },
  TopicReportEnvelope: {
    type: 'object', additionalProperties: false, required: ['data', 'requestId'],
    properties: {
      data: { $ref: '#/components/schemas/TopicReportTask' },
      requestId: { type: 'string', format: 'uuid' },
    },
  },
})

export const PUBLIC_DOCS_ROUTES = Object.freeze([
  { key: 'start', path: '/docs', label: '开始调用', section: '基础' },
  { key: 'rules', path: '/docs/auth', label: '认证与调用规则', section: '基础' },
  { key: 'source-catalog', path: '/docs/source-catalog', label: '数据源目录', section: '数据目录' },
  // Data products first, then the platform-shaped passthroughs. Sections are
  // rendered in declaration order, so a native entry in the middle of this list
  // would split the product group into two headings with the same name.
  //
  // No vendor names here: these docs are the tenant-facing contract. The admin
  // console is where a provider is named, on the page whose subject it is.
  { key: 'ecommerce-treasure-box', path: '/docs/ecommerce-treasure-box', label: '电商数据', section: '数据产品' },
  { key: 'social-accounts', path: '/docs/social-accounts', label: '社交账号搜索', section: '数据产品' },
  { key: 'xiaohongshu-note', path: '/docs/xiaohongshu-note', label: '小红书笔记', section: '数据产品' },
  { key: 'virtual-supermarket', path: '/docs/virtual-supermarket', label: '虚拟超市', section: '数据产品' },
  { key: 'telegram', path: '/docs/telegram', label: 'Telegram 会话', section: '数据产品' },
  { key: 'public-opinion', path: '/docs/public-opinion', label: '全国舆情', section: '数据产品' },
  { key: 'topic-reports', path: '/docs/topic-reports', label: '专题洞察', section: '数据产品' },
  { key: 'taobao-tmall', path: '/docs/taobao-tmall', label: '淘宝天猫', section: '平台原生接口' },
  { key: 'jd-native', path: '/docs/jd-native', label: '京东', section: '平台原生接口' },
  { key: 'xianyu-native', path: '/docs/xianyu-native', label: '闲鱼', section: '平台原生接口' },
  { key: 'xiaohongshu-ec-native', path: '/docs/xiaohongshu-ec-native', label: '小红书电商', section: '平台原生接口' },
  { key: 'search', path: '/docs/search', label: '通用搜索', section: '通用能力' },
  { key: 'night-all', path: '/docs/night-all', label: 'Night-All 兼容层', section: '通用能力' },
  { key: 'tools', path: '/docs/tools', label: '通用工具', section: '通用能力' },
  { key: 'discovery', path: '/docs/evidence', label: '能力与证据', section: '运维契约' },
  { key: 'errors', path: '/docs/errors', label: '错误与重试', section: '运维契约' },
])

const PUBLIC_DOCS_ROUTE_ALIASES = Object.freeze({
  '/docs/authentication': '/docs/auth',
  '/docs/operations': '/docs/evidence',
})

// Render the same per-version registry the request validator dispatches.
function nativeParameterTables(marketplace) {
  return Object.values(JUSTONE_RESOURCE_CATALOG).filter(r => r.marketplace === marketplace && r.released).map(r => `
    <h4>${r.label}</h4><p><code>POST ${r.hubPath}</code> · 默认版本 <code>${r.defaultVersion}</code></p>
    ${r.versions.map(v => `<h5>version=${v}</h5><table><thead><tr><th>JSON 参数</th><th>类型</th><th>必填</th><th>默认值 / 约束</th></tr></thead><tbody>${r.variantFor(v).params.map(p => `<tr><td><code>${p.name}</code></td><td>${p.kind === 'page' ? 'integer' : 'string'}</td><td>${p.required ? '是' : '否'}</td><td>${p.required ? '无默认值' : p.defaultValue ?? '省略时使用平台默认'}${p.values ? '；' + p.values.join(' | ') : p.kind === 'page' ? '；1–1000' : '；最长 64 字符'}</td></tr>`).join('')}</tbody></table>`).join('')}`).join('')
}
function marketplaceNativePage(key, label, marketplace, searchDescription) {
  const planned = Object.values(JUSTONE_RESOURCE_CATALOG).filter(r => r.marketplace === marketplace && !r.released)
  return `<section class="doc-page" data-doc-page="${key}">
    <h2>${label}平台接口</h2><p>${searchDescription}</p>
    <p>已开放商品搜索：<code>POST /api/v1/data/ecommerce/products/search</code>，请求 <code>marketplace=${marketplace}</code>。第一页不传 cursor；下一页原样提交响应中的 cursor，每页使用新的 Idempotency-Key。搜索是 Hub 数据产品接口，不等同于原生接口的 page 参数。</p>
    <p><code>deliveryMode</code>：cache_only 只读精确存档，cache_first 优先缓存，refresh 重新采集。原始业务字段保留在受控归档，数据产品返回稳定投影。</p>
    ${nativeParameterTables(marketplace)}
    <h3>原生接口接入状态</h3><p>以下资源尚未发布，不能调用；不会因文档分类而自动开放权限或计费接口。</p>
    <ul>${planned.length ? planned.map(r => `<li>${r.label}：待发布</li>`).join('') : '<li>暂无已发布的独立原生接口。</li>'}</ul>
    <p><a href="/docs/ecommerce-treasure-box">完整商品搜索参数与调用示例</a></p>
  </section>`
}

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
    .nav-section { display:block; margin:17px 10px 4px; color:#5f758b; font-size:10px; font-weight:800; letter-spacing:.13em; text-transform:uppercase; }
    nav .nav-section:first-child { margin-top:0; }
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
      <p class="lead">通过一把 Hub Public API Key 访问该调用身份已授权的平台与通用能力。Telegram 与省级舆情数据由 Hub 的规范化数据层提供，通用搜索和分词工具保持稳定响应结构。</p></header>
    <div class="cards"><div class="card"><strong>Base path</strong><code>/api/v1</code></div><div class="card"><strong>Authentication</strong>Bearer API Key 或 <code>x-api-key</code></div><div class="card"><strong>Machine contract</strong><a href="/docs/openapi.json">OpenAPI 3.1 JSON</a></div></div>
    <script>${PUBLIC_DOCS_LEGACY_ROUTE_SCRIPT}</script>
    </section>

    <section class="doc-page" data-doc-page="rules">
    <h2 id="rules">认证与调用规则</h2>
    <h3>认证及显式授权</h3>
    <p>每个请求必须携带已签发的调用者 API Key。建议使用 Bearer；不要把 Key 放进 URL、日志或前端代码。新 Key 默认是零权限 snapshot，只有签发时显式勾选的数据域、业务操作和兼容接口合同才会进入不可变范围；先调用 capabilities 确认授权与 Hub dispatch eligibility。</p>
    <pre><code>export HUB_URL="https://hub.example.com"
read -rsp 'MX Insight API Key: ' MX_INSIGHT_API_KEY
export MX_INSIGHT_API_KEY
printf '\\n'

curl -sS "$HUB_URL/api/v1/data/capabilities" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" | jq</code></pre>
    <h3>幂等、游标与配额</h3>
    <table><thead><tr><th>规则</th><th>客户端行为</th></tr></thead><tbody>
      <tr><td>POST 搜索</td><td><code>Idempotency-Key</code> 在同一 consumer 内全局唯一，并绑定创建 usage 记录的 Hub API Key。仅用同一把 API Key 重试完全相同的路径和规范化 body；另一把 API Key、新路径、新 body 或新页面必须使用新的 <code>Idempotency-Key</code>。</td></tr>
      <tr><td>舆情可见性契约升级</td><td>可命中 <code>public_opinion</code> 的 stored/canonical 搜索会把 formal/candidate 可见性契约写入幂等指纹。升级后不要复用升级前的 <code>Idempotency-Key</code>；请生成新值。旧值会返回 <code>409 idempotency_conflict</code>，不会回放升级前可能未门禁的响应。</td></tr>
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
    <p>授权入口是 Hub 管理台的“开放能力”：依次选择租户、调用者和“数据源目录”，配置配额后启用。新 Key 在签发时冻结明确范围；撤销 consumer 授权立即收窄旧 Key，新增授权则要签发并显式选择该范围的新 Key。迁移期的 legacy_dynamic Key 应轮换。</p>
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
      <tr><td>429</td><td><code>consumer_quota_exceeded</code></td><td>该调用身份在这个数据域的滑动窗口额度用完；等窗口恢复或让管理员调整 platform policy。Key、套餐窗口、套餐月度与突发速率各有独立错误码，完整对照见<a href="/docs/errors">错误与重试</a>。</td></tr>
      <tr><td>503</td><td><code>stored_data_unavailable</code></td><td>安全 GET 可稍后重试；保留错误响应的 <code>requestId</code> 供排查。</td></tr>
    </tbody></table>
    </section>

    <section class="doc-page" data-doc-page="ecommerce-treasure-box">
    <h2 id="ecommerce-treasure-box">电商数据</h2>
    <p class="lead">面向外部系统的一套稳定商品搜索合同。调用方只认识 Hub 的 <code>ecommerce</code> 授权域、统一商品结构、交付模式与不透明游标，不依赖当前物理数据供应方。</p>
    <div class="notice">产品演示中的角色、球形陈列和动画只是管理端 renderer。外部系统始终调用现有 <code>POST /api/v1/data/ecommerce/products/search</code>；路径和授权规则不变，新增的可选 <code>deliveryMode</code> 只表达 Hub 是否可以访问外部平台，不是供应方选择器。</div>
    <p><code>ecommerce</code> 是稳定的数据域，不是某一家供应方的名字；<code>marketplace</code> 是本次要检索的业务站点，也不是供应方选择器。当前发布只有一个私有合格候选，尚未启用多供应商运行时路由或自动故障转移。第二个候选通过合同验证后，Hub 才会在私有路由层按操作、marketplace、已验证合同版本、凭据健康、熔断/配额、成本和租户策略确定性选择。调用方不能通过请求字段指定供应方，也不需要在新增供应方后修改集成。</p>
    <div class="notice">当前及未来，一次逻辑请求都最多派发给一个外部候选。未来 Hub 只有在尚未创建 provider-call 证据或发出网络请求、且能确定候选不可用时才可改选；一旦外部派发开始，超时、结果未知、可能已消耗供应方额度/内部采购成本或响应不可规范化，都不得自动改投第二家，避免重复成本与语义漂移。</div>

    <h3>1. 授权与运行能力预检</h3>
    <p>使用管理台“API Keys”签发的同一把 Hub Public API Key，而不是任何上游密钥。无需为 ecommerce 再签一把 Key；为其所属调用身份启用 <code>ecommerce</code> 后即可直接调用，轮换 Key 也无需重配。外部电商采集只接受 <code>mih_live_</code>；旧 <code>mih_test_</code> 只是兼容元数据，不是隔离沙箱，capabilities 会把 ecommerce 报为 <code>ready=false</code>。先检查 capabilities 中的 <code>ecommerce</code> 项；Live Key 的 <code>ready=true</code> 表示当前允许实时调度，false 时仍可能按同一请求返回有效存储兜底。</p>
    <pre><code>export HUB_URL="https://hub.example.com"
read -rsp 'MX Insight API Key: ' MX_INSIGHT_API_KEY
export MX_INSIGHT_API_KEY
printf '\n'

curl -sS "$HUB_URL/api/v1/data/capabilities" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  | jq '.data.platforms[] | select(.platform == "ecommerce")'</code></pre>
    <p>当前合同广告 <code>product_search</code>，支持 <code>taobao</code>、<code>tmall</code>、<code>jd</code>、<code>xiaohongshu_ec</code>、<code>xianyu</code>，分页方式是 <code>opaque_cursor</code>，交付方式是 <code>live_with_stored_fallback</code>，请求策略为 <code>cache_only / cache_first / refresh</code>。</p>
    <p><code>401 invalid_api_key</code> 表示认证失败：必须使用同一个 Hub 实例签发时仅展示一次的完整 Hub Public API secret；列表中的掩码、admin token 和外部平台密钥都不能调用公开数据接口。认证通过但 Key snapshot 未包含 ecommerce，或 consumer 已撤销该授权时，返回 <code>403 platform_not_granted</code>；后续补授不会扩大旧 snapshot Key，需签发明确包含 ecommerce 的替代 Key。使用兼容 Test Key 发起正式电商搜索则返回 <code>403 test_key_not_supported</code>，且在建立 usage reservation 或调用供应方前拒绝。</p>
    <div class="notice">管理台百宝箱不要求第二把 Key、UUID、费用复选框或人工 consumer 归属核查。选择 <code>refresh</code> 并点击“重新采集最新数据”即明确授权一次可能产生上游成本的新采集；这个唯一入口会自动完成能力预检与必要的只读请求状态 GET，再决定精确重放或一次受控新采集。</div>

    <h3>2. 发起一次可追踪搜索</h3>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/ecommerce/products/search</code></div><p>需要 API Key 同时包含 <code>ecommerce</code> 数据域和 <code>ecommerce.products.search</code> 业务操作。body 是严格对象，不接受路由供应方、上游 endpoint、原始参数或 <code>pageSize</code>。省略 <code>deliveryMode</code> 时保持兼容，等同 <code>cache_first</code>。</p></div>
    <pre><code>REQUEST_KEY="ecommerce-demo-$(uuidgen)"
REQUEST_BODY='{"marketplace":"jd","query":"便携相机"}'

curl -sS -D /tmp/mx-ecommerce.headers -X POST \
  "$HUB_URL/api/v1/data/ecommerce/products/search" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $REQUEST_KEY" \
  -d "$REQUEST_BODY" | tee /tmp/mx-ecommerce.json | jq</code></pre>
    <table><thead><tr><th>字段</th><th>约束</th><th>平台差异</th></tr></thead><tbody>
      <tr><td><code>marketplace</code></td><td>必填，使用上方五个稳定枚举之一</td><td>决定可用过滤与排序，不决定授权</td></tr>
      <tr><td><code>query</code></td><td>必填，1–200 字符，NFKC 规范化</td><td>所有平台</td></tr>
      <tr><td><code>deliveryMode</code></td><td>可选，默认 <code>cache_first</code></td><td><code>cache_only</code> 绝不发起外部采集；<code>cache_first</code> 新鲜快照优先；<code>refresh</code> 绕过新鲜快照并要求显式 Idempotency-Key</td></tr>
      <tr><td><code>sort</code></td><td>可选；必须是当前 marketplace 支持的值</td><td>淘宝/天猫：<code>relevance|sales_desc|price_asc|price_desc</code>；闲鱼：<code>relevance|recent|seller_credit|price_asc|price_desc|price_drop|newest</code>；京东和小红书电商不接受</td></tr>
      <tr><td><code>price</code></td><td>可选 <code>{min,max}</code>，金额必须是十进制字符串</td><td>只支持淘宝/天猫</td></tr>
      <tr><td><code>page</code></td><td>首批兼容字段，1–1000；不能与 cursor 同时出现</td><td>新客户端优先使用 Hub cursor</td></tr>
      <tr><td><code>cursor</code></td><td>只使用上页返回的不透明签名值</td><td>绑定 marketplace/query/sort/price；不要解析或拼接</td></tr>
    </tbody></table>
    <p>管理台默认列表视图，另保留百宝箱视图。采集只针对一个平台，下一页使用新的 Idempotency-Key，并保持 query/sort/price 不变。有 nextCursor 时下滑加载；没有分页证据时可以明确尝试 page+1（小红书需要 continuation，不能跳页）。返回数量由上游决定，Hub 没有固定 10 条限制，也不接受自定义上游 pageSize。</p>
    <h3>浏览已存电商数据</h3>
    <div class="endpoint"><span class="method">GET</span><code>/api/v1/data/ecommerce/products/items</code><p>需要 live Key 和 ecommerce 授权。只查本调用身份成功提交的商品搜索记录；不会调用上游，与 cache_only 精确请求查询不同。每次 GET 记录只读 usage。</p></div>
    <p>参数 marketplace 可为 all（默认）或五个平台之一；query 是可选标题子串；pageSize 默认 20、上限 100，受调用身份策略进一步约束；cursor 使用本接口上页返回的 nextCursor。按请求入库时间倒序，同一批次保留上游顺序。游标绑定调用身份、筛选条件和页大小，固定请求时间上界；它不是跨请求的数据库事务快照。不同采集请求中的相同商品保留为历史观察，不做跨批去重。</p>
    <p>返回 data.items 中每项含 product、requestId、capturedAt、recordedAt、ordinal；使用该项 requestId 和 product.id 读取受保护媒体。data.pageInfo 提供 hasMore/nextCursor/asOf。全部平台仅适用于这个存量接口，POST 搜索不接受 all。</p>

    <h3>3. 消费统一响应</h3>
    <pre><code>{
  "contractVersion": "mx-insight-hub.ecommerce-products.v1",
  "data": {
    "items": [{
      "id": "platform-native-id",
      "marketplace": "jd",
      "title": "便携相机",
      "url": "https://example.invalid/product",
      "pricing": { "current": "899.00", "original": null, "currency": "CNY" },
      "shop": { "id": "shop-id", "name": "店铺名称" },
      "images": [],
      "signals": { "sales": null, "reviewCount": "120", "location": "杭州" },
      "attributes": { "brand": null, "category": "数码影像" }
    }],
    "page": { "page": 1, "returnedCount": 1, "discardedCount": 0, "hasMore": false, "nextCursor": null }
  },
  "meta": {
    "capturedAt": "2026-09-06T00:00:00.000Z",
    "servedAt": "2026-09-06T00:00:00.010Z",
    "sourceMode": "live",
    "ageSeconds": 0
  },
  "requestId": "00000000-0000-4000-8000-000000000006"
}</code></pre>
    <p>字段没有可靠来源时为 null 或空数组，不由 Hub 猜值。调用方用 <code>contractVersion</code> 选择解析器，用 <code>capturedAt / servedAt / ageSeconds</code> 判断时效，用 <code>sourceMode</code> 判断本次交付路径；不要从响应速度推断是否调用上游。</p>

    <h3>4. 安全读取商品图片</h3>
    <p>搜索响应的 <code>images[]</code> 是归档引用，浏览器不应直接把任意外部 URL 放入 <code>img src</code>。管理端使用同一把 Hub Public API Key、搜索响应的 <code>requestId</code>、商品 <code>id</code> 和图片序号，从 Hub 受控媒体读取接口获得 Blob；接口不接受 URL 参数。</p>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/ecommerce/products/media</code></div><p>只读取属于同一 consumer、已提交且 HTTP 200 的 ecommerce 搜索快照。仅允许公网 HTTPS 栅格图片，并限制重定向、DNS 目标、类型、内容魔数、超时与 4 MiB 大小。</p></div>
    <pre><code>SEARCH_REQUEST_ID=$(jq -r '.requestId' /tmp/mx-ecommerce.json)
ITEM_ID=$(jq -r '.data.items[0].id' /tmp/mx-ecommerce.json)

curl -sS -G "$HUB_URL/api/v1/data/ecommerce/products/media" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  --data-urlencode "requestId=$SEARCH_REQUEST_ID" \
  --data-urlencode "itemId=$ITEM_ID" \
  --data-urlencode 'imageIndex=0' \
  -o /tmp/mx-ecommerce-product-image</code></pre>
    <p>这次媒体读取不创建 Hub usage，也不派发商品搜索或新的外部采集；它可能通过受控中继读取搜索结果已经引用的公网图片。图片不存在或被安全策略拒绝时，客户端应显示占位图，不应回退为直连原始 URL。</p>

    <h3>5. 翻页、返回第一页与幂等重放</h3>
    <p>完全相同的一页在网络重试时必须复用原 <code>Idempotency-Key</code>。下一页携带 <code>nextCursor</code> 并生成新的 <code>Idempotency-Key</code>；用户返回第一页时，可以重放首次 <code>Idempotency-Key</code> 获得完全相同的已提交结果，也可以用新的 <code>Idempotency-Key</code> 发起一次新的首页读取。两种意图不能混用。</p>
    <pre><code>NEXT_CURSOR=$(jq -r '.data.page.nextCursor // empty' /tmp/mx-ecommerce.json)
if [ -n "$NEXT_CURSOR" ]; then
  NEXT_KEY="ecommerce-next-$(uuidgen)"
  jq -n --arg cursor "$NEXT_CURSOR" \
    '{marketplace:"jd",query:"便携相机",cursor:$cursor}' \
    | curl -sS -X POST "$HUB_URL/api/v1/data/ecommerce/products/search" \
        -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
        -H 'Content-Type: application/json' \
        -H "Idempotency-Key: $NEXT_KEY" \
        --data-binary @- | jq
fi</code></pre>
    <div class="notice"><code>hasMore=false</code> 或 <code>hasMore=null</code> 都必须停止。null 表示 Hub 没有足够证据安全地产生 continuation；客户端不能改用自增页码绕过。</div>

    <h3>6. 同一接口的交付与成本语义</h3>
    <p>请求里的 <code>deliveryMode</code> 是调用意图，响应里的 <code>sourceMode</code> 是实际交付证据，两者不能混为一谈。三种请求策略都使用同一把 Hub Public API Key 和同一路径：</p>
    <table><thead><tr><th>deliveryMode</th><th>外部采集</th><th>行为</th></tr></thead><tbody>
      <tr><td><code>cache_only</code></td><td>禁止</td><td>只查同 consumer、同规范化请求的精确 Hub 快照；新鲜返回 <code>fresh_cache</code>，过期但仍在保留期内返回 <code>stored_fallback</code>，没有快照返回 <code>404 stored_snapshot_not_found</code>。</td></tr>
      <tr><td><code>cache_first</code></td><td>按需</td><td>默认兼容模式；有新鲜快照就直接交付，否则允许一次受治理的外部采集，并在失败时使用精确存量兜底。</td></tr>
      <tr><td><code>refresh</code></td><td>明确允许</td><td>绕过新鲜快照尝试重新采集，必须提供调用方 Idempotency-Key；上游失败时仍可能返回精确存量兜底，因此是否真的调用及成功必须看证据。</td></tr>
    </tbody></table>
    <table><thead><tr><th>sourceMode</th><th>新 Hub usage</th><th>新上游调用</th><th>调用方含义</th></tr></thead><tbody>
      <tr><td><code>live</code></td><td>是</td><td>是</td><td>本次完成新的实时采集；上游成本以私有计费证据为准。</td></tr>
      <tr><td><code>fresh_cache</code></td><td>是</td><td>否</td><td>新的客户请求复用仍新鲜的同请求快照。</td></tr>
      <tr><td><code>stored_fallback</code></td><td>是</td><td>可能</td><td>可能在派发前兜底，也可能在一次失败派发后兜底；不能一概写成零上游费用。</td></tr>
      <tr><td><code>idempotent_replay</code></td><td>否</td><td>否</td><td>相同 <code>Idempotency-Key</code>、路径和 body 重放原已提交结果。</td></tr>
    </tbody></table>
    <p>要安全检查存量而不产生新的外部调用，使用新的请求键和 <code>cache_only</code>。命中仍是一笔新的 Hub 请求/usage；未命中返回 404 并释放预留，但两种情况都不会产生 provider-call：</p>
    <pre><code>CACHE_ONLY_KEY="ecommerce-cache-only-$(uuidgen)"
CACHE_ONLY_BODY='{"marketplace":"jd","query":"便携相机","deliveryMode":"cache_only"}'

curl -sS -D - -X POST "$HUB_URL/api/v1/data/ecommerce/products/search" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $CACHE_ONLY_KEY" \
  -d "$CACHE_ONLY_BODY" | jq</code></pre>
    <p>要明确演示一次可能产生外部平台采购成本的新采集，必须由操作者确认后改为 <code>refresh</code>，并创建只属于这次意图的新 Idempotency-Key。不要把它放进 readiness、轮询或自动重试：</p>
    <pre><code>REFRESH_KEY="ecommerce-refresh-$(uuidgen)"
REFRESH_BODY='{"marketplace":"jd","query":"便携相机","deliveryMode":"refresh"}'

curl -sS -D - -X POST "$HUB_URL/api/v1/data/ecommerce/products/search" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $REFRESH_KEY" \
  -d "$REFRESH_BODY" | jq '.meta.sourceMode,.requestId,.data.page'</code></pre>
    <p>只有返回 <code>sourceMode=live</code> 才证明本次成功结果来自新采集；<code>stored_fallback</code> 可能发生在一次失败派发之后，最终采购成本仍以 Internal provider-call 证据为准。若首次结果不确定，页面自动以响应的 requestId 查询 <code>GET /api/v1/requests/{requestId}</code>；旧客户端若只保留原幂等键，则把它放入 <code>Idempotency-Key</code> 请求头并查询 <code>GET /api/v1/requests/by-idempotency-key</code>。两种 GET 都不创建 usage，也不会调用供应方；同一 consumer 当前有效的任一 Key 都可使用。只有 GET 明确返回 <code>unknown</code> 时，选择 <code>refresh</code> 后点击同一主按钮才会发送一个受控新请求：页面从 GET 自动取得旧 requestId，新请求使用新的 <code>Idempotency-Key</code> 并携带 <code>X-MX-Insight-Retry-Of: &lt;old requestId&gt;</code>，用户无需查找或填写 UUID。选择 <code>refresh</code> 并点击重采按钮本身即明确接受旧请求可能已计费而产生第二次采购成本的风险。<code>reserved</code>、状态网络失败、路由/版本不匹配或 succeeded-unusable 隔离都不允许覆盖；页面不会静默重试。只有状态已是 <code>committed</code>，才可原样重放已提交请求：</p>
    <pre><code>curl -sS -D - -X POST "$HUB_URL/api/v1/data/ecommerce/products/search" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $REQUEST_KEY" \
  -d "$REQUEST_BODY" | jq '.meta.sourceMode,.requestId'</code></pre>
    <p>预期 <code>sourceMode=idempotent_replay</code>，并且 requestId 与首次调用一致。Hub usage、供应方采购成本与 Hub 客户计价是三套逻辑；供应方费率、余额、免费额度和采购证据只在 Internal，未来客户费率由独立版本化 Hub price book 决定。当前响应只报告交付事实，不返回发票金额，也不会把未知价格显示成零。</p>

    <h3>7. 错误、重试与数据归档</h3>
    <table><thead><tr><th>HTTP / error.code</th><th>客户端动作</th></tr></thead><tbody>
      <tr><td>400 请求、筛选、游标错误或 <code>invalid_uncertain_retry</code></td><td>修正请求；retry-of 只接受 <code>refresh</code> 和格式正确的旧请求 UUID。不要重复错误 body。</td></tr>
      <tr><td>401 <code>api_key_required / invalid_api_key</code></td><td>提供当前实例签发的完整 Hub Public API Key；仅在失效、过期或撤销时轮换，不要发送上游密钥。</td></tr>
      <tr><td>403 <code>platform_not_granted</code></td><td>Key snapshot 没有 <code>ecommerce</code>，或 consumer 已撤权；配置授权后签发明确包含该范围的新 Key。</td></tr>
      <tr><td>403 <code>test_key_not_supported</code></td><td>改用正式 <code>mih_live_</code> Key。Test 只是兼容标签，不是零成本沙箱；该拒绝发生在 usage reservation 和供应方调用之前。</td></tr>
      <tr><td>404 <code>stored_snapshot_not_found</code></td><td><code>cache_only</code> 没有命中精确存量；本次没有调用外部平台。可修改条件、切换本地安全演示，或在明确确认成本后发起 <code>refresh</code>。</td></tr>
      <tr><td>409 <code>request_in_progress</code></td><td>短暂等待后以原 requestId 调用只读状态 GET；不要 POST 原请求或换键形成第二次派发。</td></tr>
      <tr><td>409 <code>request_in_progress / request_outcome_unknown / external_platform_response_unusable / uncertain_retry_not_allowed</code></td><td>默认防重复策略挡住了本次尝试。停止自动重试；主按钮会自动查询旧状态。仅在服务器明确返回 <code>unknown</code> 且操作者确认新 <code>refresh</code> 的潜在重复成本时，才发送 <code>X-MX-Insight-Retry-Of</code>。不存在、跨 consumer、非 unknown、operation/fingerprint 不匹配均不会泄露为可覆盖状态。</td></tr>
      <tr><td>502 outcome unknown</td><td>本次结果可能已经产生外部采集；保留原 body、<code>Idempotency-Key</code> 和可用的 requestId，页面自动调用状态 GET。无需查找 UUID、费用复选框或人工核查 consumer。<code>committed</code> 精确重放；<code>reserved</code> 继续阻止采集；只有明确 <code>unknown</code> 可在用户再次选择 <code>refresh</code> 并点击重采后发起带专用请求头的新采集。</td></tr>
      <tr><td>502 <code>external_platform_response_unusable</code></td><td>外部平台已返回成功 envelope，但 Hub 无法安全规范化。相同 <code>Idempotency-Key</code> 只重放已提交的原 502，不再次调用上游；保存 requestId，并分别检查普通 credential-safe 证据与受限原始响应归档。</td></tr>
      <tr><td>429 <code>consumer_quota_exceeded</code></td><td>这是 Hub consumer 配额；等待窗口恢复或调整 ecommerce policy，无需更换 API Key。</td></tr>
      <tr><td>429 external platform busy / capacity</td><td>Hub 并发保护和外部容量是不同原因；按响应退避，不要自动生成另一把幂等键。</td></tr>
      <tr><td>503</td><td>可能没有可用实时供应或快照；保存 requestId，稍后仍用原 <code>Idempotency-Key</code> 重试相同请求。</td></tr>
      <tr><td>200 且 <code>items=[]</code></td><td>这是正常空结果，不是接口故障；可以调整关键词或平台。空结果不能用于推断本次上游成本为零。</td></tr>
    </tbody></table>
    <p>管理台“电商数据”会把这些稳定错误码翻译成面向产品操作的中文提示，同时在浏览器未决账本中保留可用的 Request ID 与原 <code>Idempotency-Key</code>。未解决的实时请求不会阻塞本地安全演示或 <code>cache_only</code> 存量浏览，也不会锁死筛选条件。主搜索按钮是唯一入口：页面自动调用状态 GET，没有额外核对按钮、费用复选框，也不要求用户查找或粘贴 UUID、人工核查 consumer 归属。旧版 v1 账本会自动迁移到 v2；没有 Request ID 时，页面使用当前同一 consumer 的有效开放能力 API Key，并把幂等键放在请求头中调用 <code>GET /api/v1/requests/by-idempotency-key</code>。v1 或 v2 本地账本只有在同一 consumer 的查询明确返回 <code>request_not_found</code> 时才清除孤儿记录；路由级 <code>not_found</code> 和其他查询失败继续保留审计。<code>committed</code> 自动精确重放，<code>released</code> 关闭旧记录；只有明确 <code>unknown</code> 可在用户已选择 <code>refresh</code> 并点击重采按钮后，用新幂等键和页面自动填入的 <code>X-MX-Insight-Retry-Of</code> 旧请求 ID 发起一次新采集。<code>reserved</code>、网络失败、路由/版本不匹配和 succeeded-unusable 隔离继续阻止外部调用。切换演示不会删除实时请求账本。</p>
    <p>Hub 私下保存响应级调用证据和逐商品归档，再异步写入 <code>ecommerce.products.v1</code> canonical 数据集并投影到 Elasticsearch。公开响应不包含物理供应方身份、上游 endpoint、凭据、原始 envelope、内部归档路径或成本账本。</p>
    </section>

    ${marketplaceNativePage('jd-native', '京东', 'jd', '商品搜索支持 query 和 cursor，不接受 sort。')}
    ${marketplaceNativePage('xianyu-native', '闲鱼', 'xianyu', '商品搜索支持 query、cursor 和 sort：relevance / recent / seller_credit / price_asc / price_desc / price_drop / newest。')}
    ${marketplaceNativePage('xiaohongshu-ec-native', '小红书电商', 'xiaohongshu_ec', '商品搜索支持 query 和 cursor，不接受 sort。')}
    <section class="doc-page" data-doc-page="taobao-tmall">
    <h2 id="taobao-tmall">淘宝天猫原生接口</h2>
    <p>参数按 2026-09-12 平台文档核对。Hub 接收 POST JSON，原生业务参数按版本映射；Hub URL 与上游 URL 不相同。</p>
    ${nativeParameterTables('taobao')}
    <p>店铺 V1 的 sort 为 _sale / _default；V2 为 sales-des / new-des / credit-des / price-asc / price-des；V4 不接受 sort。各版本 page 默认 1。换页必须更换 Idempotency-Key；相同 Key 与不同 page 返回冲突。</p>
    <p class="lead">Hub 对外提供两层电商接口。这一层是<strong>平台原生合同</strong>：业务参数名按上游版本映射，Hub 使用独立 POST 路径，响应 <code>data</code> 保留上游字段名，调用方按上游文档理解载荷、按 Hub 合同理解交付。另一层是<a href="/docs/ecommerce-treasure-box">电商数据</a>，返回 Hub 归一化的稳定商品结构。</p>

    <div class="notice">两层用同一把 Hub Public API Key、同一套幂等与交付语义，也共用同一份上游调用证据与归档。区别只有一个：原生层不重命名、不裁剪上游字段，稳定性交给上游；数据产品层由 Hub 钉住结构，上游改字段不会打到你身上。</div>

    <h3>1. 何时用哪一层</h3>
    <table><thead><tr><th></th><th>平台原生接口（本页）</th><th>电商数据</th></tr></thead><tbody>
      <tr><td>响应字段</td><td>上游原字段名，随上游变化</td><td>Hub 归一化结构，版本化稳定</td></tr>
      <tr><td>适合</td><td>自己组合产品、需要上游全部字段</td><td>直接消费，不想处理上游差异</td></tr>
      <tr><td>上游 <code>data</code> 类型</td><td>上游 OpenAPI 未发布类型，Hub 不猜也不裁剪</td><td>由 Hub 钉住并逐字段审核</td></tr>
      <tr><td>翻页</td><td>上游自己的分页字段</td><td>Hub 不透明游标</td></tr>
      <tr><td>计费</td><td colspan="2">相同：一次真实上游调用计一次上游成本；命中缓存不产生上游成本</td></tr>
    </tbody></table>

    <h3>2. 授权</h3>
    <p>每个资源族是<strong>独立的业务操作授权</strong>，不随商品搜索一起开通。Key 需要同时具备 <code>ecommerce</code> 数据域和对应操作：<code>ecommerce.products.detail</code>、<code>ecommerce.products.reviews</code>、<code>ecommerce.products.questions</code>、<code>ecommerce.shops.products</code>。缺少时返回 <code>403 capability_not_granted</code>。</p>

    <p>调用前可以逐 operation 预检，不必先花一次调用去试：</p>
    <pre><code>curl -sS "$HUB_URL/api/v1/data/capabilities" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  | jq '.data.platforms[] | select(.platform == "ecommerce") | .operations'</code></pre>
    <p>平台层的 <code>ready</code> 只跟随商品搜索，<strong>不能</strong>当作"这个平台下所有接口都可用"。要判断某个接口能不能调，看 <code>operations</code> 里对应那一行的 <code>ready</code> 与 <code>effectiveState</code>；<code>resources</code> 数组还会列出每个资源的路径与可用版本。四类资源各自独立开关，暂停其中一个不影响其余。</p>

    <h3>3. 接口</h3>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/ecommerce/taobao/product-detail</code></div><p>商品详情。<code>itemId</code> 必填；<code>version</code> 可选 <code>v1|v3|v4|v5|v7|v9</code>，默认 <code>v7</code>。V2 是上游异步工作流，不在本合同内。</p></div>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/ecommerce/taobao/product-reviews</code></div><p>商品评价。<code>itemId</code> 必填；<code>orderType</code> 可选 <code>general|feedbackdate</code>；<code>page</code> 默认 1。</p></div>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/ecommerce/taobao/product-questions</code></div><p>商品问答。<code>itemId</code> 必填；<code>page</code> 默认 1。</p></div>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/ecommerce/taobao/shop-products</code></div><p>店铺商品列表。三个上游版本用不同字段标识店铺，因此参数按版本区分：<code>v4</code>（默认）用 <code>sellerId</code>；<code>v1</code> 用 <code>userId</code>；<code>v2</code> 用 <code>userId</code> + <code>shopId</code>。传了不属于该版本的字段会返回 <code>400 unsupported_request_field</code>。</p></div>

    <h3>4. 调用</h3>
    <pre><code>curl -sS -X POST "$HUB_URL/api/v1/data/ecommerce/taobao/product-detail" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: detail-$(uuidgen)" \
  -d '{"itemId":"778899","version":"v7","deliveryMode":"cache_first"}'</code></pre>

    <p>响应结构：</p>
    <pre><code>{
  "contractVersion": "mx-insight-hub.ecommerce-resource.v1",
  "resource": { "key": "taobao-tmall.product-detail", "version": "v7" },
  "data": { /* 上游原样字段，Hub 不重命名、不裁剪 */ },
  "meta": {
    "capturedAt": "...", "servedAt": "...", "sourceMode": "live", "ageSeconds": 0,
    "reason": { "code": "live", "scope": "upstream", "degraded": false, "liveAttempted": true }
  },
  "requestId": "..."
}</code></pre>

    <h3>5. 交付策略</h3>
    <p><code>deliveryMode</code> 与百宝箱完全一致，默认 <code>cache_first</code>：</p>
    <table><thead><tr><th>模式</th><th>行为</th><th>上游成本</th></tr></thead><tbody>
      <tr><td><code>cache_only</code></td><td>只读精确存量；没有存量时 <code>404 stored_snapshot_not_found</code>。</td><td>0</td></tr>
      <tr><td><code>cache_first</code></td><td><strong>只有快照仍在新鲜窗口内才复用</strong>；超出窗口会去请求上游，上游不可用时才回落到存量。它不是“永远读缓存”。</td><td>缓存命中 0；穿透后 1</td></tr>
      <tr><td><code>refresh</code></td><td>绕过新鲜缓存，明确尝试上游；上游失败且存在精确存量时仍会回落。必须提供 <code>Idempotency-Key</code>。</td><td>1（除非未派发即被拒绝）</td></tr>
      <tr><td><code>live_only</code></td><td><strong>绝不返回存量数据。</strong>绕过新鲜缓存尝试上游，拿不到就返回对应错误，不做任何回落——包括上游失败、并发保护、限流、熔断和 operation 被阻断。必须提供 <code>Idempotency-Key</code>。</td><td>1（除非未派发即被拒绝）</td></tr>
    </tbody></table>
    <p><code>refresh</code> 与 <code>live_only</code> 的区别只有一条：拿不到实时数据时，前者在有精确存量时回落并标记 <code>stored_fallback</code>，后者直接报错。自己组合产品、需要明确知道"这次没拿到新数据"时用 <code>live_only</code>；要尽量有数据可用时用 <code>refresh</code>。<code>live_only</code> 失败后用同一个 <code>Idempotency-Key</code> 重放，返回的仍是那个错误，不会变成快照。</p>
    <p>拿到的是不是实时数据，看 <code>meta.reason</code>，不要靠 <code>sourceMode</code> 猜：<code>reason.degraded=false</code> 才是完整交付；<code>reason.liveAttempted</code> 区分“没有发生上游调用”和“上游调用已发生、可能已计费”。详见<a href="/docs/errors">错误与重试</a>。</p>

    <h3>6. 上游字段的稳定性</h3>
    <p>上游对 <code>data</code> 没有发布类型定义，因此本层<strong>不承诺字段稳定</strong>：Hub 只做结构边界检查与凭据脱敏，不重命名、不补默认值、不删除未知字段。请按缺字段返回 <code>null</code> 的方式消费，不要假设某个字段一定存在。需要稳定结构时用<a href="/docs/ecommerce-treasure-box">电商数据</a>。</p>
    <p>不同 <code>version</code> 是不同的逻辑请求，各自独立缓存与计费；切换版本不会复用另一个版本的快照。</p>
    </section>

    <section class="doc-page" data-doc-page="social-accounts">
    <h2 id="social-accounts">社交账号搜索</h2>
    <p class="lead">按关键词在小红书、抖音、微博、快手四个平台检索账号，返回 Hub 归一化的稳定账号结构。同一个接口覆盖四个平台，调用方不感知背后的供应方。</p>

    <div class="notice">这是<strong>数据产品层</strong>：Hub 钉住账号结构，上游改字段不会打到你身上。与之相对的<a href="/docs/taobao-tmall">平台原生接口</a>不重命名不裁剪，把上游字段原样交给调用方。</div>

    <h3>1. 授权</h3>
    <p>需要 <code>social</code> 数据域与 <code>social.accounts.search</code> 业务操作双授权，两者都<strong>独立于 <code>ecommerce</code></strong>：账号搜索既不占用也不受限于电商配额。缺少时返回 <code>403 platform_not_granted</code> 或 <code>403 capability_not_granted</code>。</p>

    <h3>2. 调用</h3>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/social/accounts/search</code></div><p><code>platform</code> 取 <code>xiaohongshu</code>｜<code>douyin</code>｜<code>weibo</code>｜<code>kuaishou</code>；<code>keyword</code> 必填（≤200 字符）；<code>page</code> 从 1 递增；<code>deliveryMode</code> 与其它采集接口一致。</p></div>

    <pre><code>curl -sS -X POST "$HUB_URL/api/v1/data/social/accounts/search" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: accounts-$(uuidgen)" \
  -d '{"platform":"xiaohongshu","keyword":"品牌词","page":1}'</code></pre>

    <p>响应结构：</p>
    <pre><code>{
  "contractVersion": "mx-insight-hub.social-accounts.v1",
  "data": {
    "accounts": [
      {
        "id": "...", "platform": "xiaohongshu", "userId": "...",
        "secUid": null,            // 抖音/快手才有；主页链接与详情接口依赖它
        "name": "昵称", "handle": "小红书号",
        "fans": 1164,              // 上游未给出精确整数时为 null
        "bio": "简介", "official": true,
        "avatar": "https://...", "profileUrl": null
      }
    ],
    "page": {
      "page": 1, "returnedCount": 20,
      "discardedCount": 0,         // 上游条目无法解析而丢弃的数量
      "duplicateCount": 0,         // 同一页内重复账号（快手混合流常见）
      "hasMore": null, "nextPage": 2
    }
  },
  "meta": { "capturedAt": "...", "sourceMode": "live", "reason": { ... } },
  "requestId": "..."
}</code></pre>

    <h3>3. 翻页：靠空页判定，不靠 hasMore</h3>
    <p>这四个上游接口<strong>都不返回总数或 hasMore</strong>。因此 <code>hasMore</code> 恒为 <code>null</code>，含义是「上游没有声明」，<em>不是</em>「没有更多了」；Hub 不会凭非空页推断下一页。<strong>唯一可靠的终止条件是 <code>returnedCount</code> 为 0</strong>：<code>page</code> 递增直到空页为止。</p>

    <h3>4. 字段的确定性</h3>
    <table><thead><tr><th>字段</th><th>说明</th></tr></thead><tbody>
      <tr><td><code>fans</code></td><td>只有上游给出<strong>精确整数</strong>时才有值。形如「1.2万」的展示串一律为 <code>null</code>，Hub 不做换算——宁可报「未知」也不编造精度。小红书会在 <code>fans</code> 缺失时读取「粉丝 1164」这类精确文案。</td></tr>
      <tr><td><code>secUid</code></td><td>抖音与快手有，小红书与微博为 <code>null</code>。抖音主页链接依赖它，缺失时 <code>profileUrl</code> 为 <code>null</code> 而不是给一个会 404 的链接。</td></tr>
      <tr><td><code>duplicateCount</code></td><td>快手返回的是内容混合流，同一账号会跨条目重复出现。Hub 已按 <code>(platform, userId)</code> 去重并在此报出去重条数。</td></tr>
      <tr><td><code>discardedCount</code></td><td>抖音个别条目内层数据无法解析或缺少 uid，Hub 丢弃该条而不让整页失败。</td></tr>
      <tr><td><code>avatar</code></td><td>微博头像 URL 带签名会过期，需要长期展示请自行转存。</td></tr>
    </tbody></table>

    <h3>5. 数据沉淀</h3>
    <p>每次成功采集都会写入 canonical 数据集 <code>social.accounts.v1</code>，身份是 <code>(platform, userId)</code>。<strong>关键词与页码不参与身份</strong>：同一账号通过不同关键词找到是同一行，重跑关键词也不会产生重复。账号资料真的变了才会记为内容变更。</p>
    </section>

    <section class="doc-page" data-doc-page="xiaohongshu-note">
    <h2 id="xiaohongshu-note">小红书笔记</h2>
    <div class="notice">这条数据产品由 Hub 对接的外部供应方采集，但<strong>公开合同不暴露供应方身份</strong>：请求里没有供应方选择字段，Hub 更换供应方不需要你改集成。要判断一次交付是上游的问题还是 Hub 侧的问题，看 <code>meta.reason.scope</code>（见下文「每次调用消耗什么」），不需要知道是哪一家。</div>
    <div class="notice">Hub 提供两类明确分离的合同：legacy <code>GET /api/v1/xiaohongshu/app/get_note_info</code>、同路径 POST 与 <code>POST /api/v1/data/post</code> 返回稳定的 Hub 数据产品投影；五个 <code>GET /api/v1/xiaohongshu/app_v2/*</code> 入口接受官方字段并返回已采集的 App V2 兼容业务 envelope。两类入口都使用 Live Hub Public API Key、用量/成本准入、幂等、归档和 canonical 入库，不是无治理的裸代理。</div>
    <h3>1. 输入链接，获取正文与标签</h3>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/xiaohongshu/app/get_note_info</code></div><p>推荐把官方笔记链接放入 JSON body，可选 <code>deliveryMode=cache_only|cache_first|refresh|live_only</code>。</p></div>
    <pre><code>XHS_KEY="xhs-note-$(uuidgen)"
NOTE_URL='https://www.xiaohongshu.com/explore/0123456789abcdef01234567'
XHS_BODY=$(jq -cn --arg url "$NOTE_URL" '{url:$url,deliveryMode:"cache_first"}')
curl -sS -X POST "$HUB_URL/api/v1/xiaohongshu/app/get_note_info" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $XHS_KEY" \
  -d "$XHS_BODY" \
  | tee /tmp/mxih-xhs.json \
  | jq '{contractVersion,item:.data.item,meta,requestId}'</code></pre>
    <p>这是 Hub 自己维护的兼容路径，不是对任何外部平台响应的透明转发。返回固定为 <code>mx-insight-hub.social-post.v1</code>；正文与标签分别位于 <code>data.item.text</code> 和 <code>data.item.tags</code>。</p>
    <h3>2. App V2 兼容 GET</h3>
    <p>五个入口都要求 <code>xiaohongshu</code> 数据域与 <code>compat.xiaohongshu.app_v2</code> 兼容合同，并按下表叠加业务操作授权：</p>
    <table><thead><tr><th>App V2 endpoint</th><th>输入</th><th>附加业务操作</th></tr></thead><tbody>
      <tr><td><code>get_image_note_detail</code></td><td><code>note_id|share_text</code></td><td><code>social.posts.resolve</code></td></tr>
      <tr><td><code>search_notes</code></td><td><code>keyword,page,sort_type,note_type,time_filter,search_id,search_session_id,source,ai_mode</code></td><td><code>social.posts.search</code></td></tr>
      <tr><td><code>search_users</code></td><td><code>keyword,page,search_id,source</code></td><td><code>social.users.resolve</code></td></tr>
      <tr><td><code>get_user_info</code></td><td><code>user_id|share_text</code></td><td><code>social.users.resolve</code></td></tr>
      <tr><td><code>get_user_posted_notes</code></td><td><code>user_id|share_text,cursor</code></td><td><code>social.users.posts</code></td></tr>
    </tbody></table>
    <p>完整路径均位于 <code>/api/v1/xiaohongshu/app_v2/</code>。三个 identity 入口都要求对应的 <code>note_id|share_text</code> 或 <code>user_id|share_text</code> 至少提供一个；同时给出时分别以 <code>note_id</code> 或 <code>user_id</code> 优先，并用该规范化 selector 绑定幂等与快照 identity。<code>page</code> 只允许 1..15；用户笔记翻页必须原样返回 Hub 签发的不透明 <code>cursor</code>，第 15 页强制终止。每个 App V2 endpoint 都有独立的兼容合同和“endpoint + 规范化 query”幂等域，不是下方 canonical 三入口的第四种别名；不要跨 endpoint 复用 <code>Idempotency-Key</code>。</p>
    <p>响应保留正文、标题、作者、标签、互动、媒体签名 URL、<code>params</code>、<code>search_id</code> 和 <code>search_session_id</code> 等上游业务字段。Hub 不做字段级长度截断；搜索接口自身可能返回官方预览，调用详情接口获取完整正文。只有上游意外回显的当前 Hub→上游 credential 会按精确值移除；请求的 Authorization、Cookie 或 API key 不会复制到响应。受限 raw archive 保存原始响应字节。<code>Idempotency-Key</code> 可选；省略时每次 HTTP 调用都生成唯一内部 key，独立记录 usage/计费，即使命中缓存也不合并。只有调用方显式复用相同幂等 key 才视为传输重试。</p>
    <h3>3. 每次调用消耗什么</h3>
    <p>一次请求最多产生两笔计量：<strong>Hub 请求</strong>（这条数据产品的服务用量）和<strong>上游调用</strong>（向外部供应方的实际付费采集）。两者不是一回事——命中缓存仍是一笔 Hub 请求，但不产生上游消耗。</p>
    <table><thead><tr><th>deliveryMode</th><th>行为</th><th>Hub 请求</th><th>上游调用</th></tr></thead><tbody>
      <tr><td><code>cache_only</code></td><td>只读精确存量；没有存量时 <code>404 stored_snapshot_not_found</code>。</td><td>1</td><td>0</td></tr>
      <tr><td><code>cache_first</code>（默认）</td><td>快照仍在新鲜窗口内直接复用；过期则尝试上游，上游不可用时回落存量。</td><td>1</td><td>命中缓存 0；穿透后 1</td></tr>
      <tr><td><code>refresh</code></td><td>绕过新鲜缓存尝试上游；失败且有精确存量时仍会回落。需要 <code>Idempotency-Key</code>。</td><td>1</td><td>1（未派发即被拒则 0）</td></tr>
      <tr><td><code>live_only</code></td><td>同样绕过缓存，但<strong>绝不回落</strong>：拿不到实时数据就返回错误原因。需要 <code>Idempotency-Key</code>。</td><td>1</td><td>1（未派发即被拒则 0）</td></tr>
      <tr><td colspan="2">幂等重放（同 Key 同 body）</td><td>0</td><td>0</td></tr>
    </tbody></table>

    <p><strong>不要用 <code>sourceMode</code> 推断是否花了钱。</strong><code>stored_fallback</code> 有两种成因：一种是派发前就被拒（没花钱），另一种是上游调用失败后兜底（可能已计费）。能区分这两者的是 <code>meta.reason</code>：</p>
    <pre><code>curl -sS -X POST "$HUB_URL/api/v1/xiaohongshu/app/get_note_info" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" -H 'Content-Type: application/json' \
  -d '{"platform":"xiaohongshu","url":"https://www.xiaohongshu.com/explore/...","deliveryMode":"cache_first"}' \
  | jq '.meta.reason'</code></pre>
    <table><thead><tr><th>字段</th><th>含义</th></tr></thead><tbody>
      <tr><td><code>liveAttempted</code></td><td><strong>本次是否真的发起了上游调用</strong>，因而是否可能已计费。这是判断消耗的唯一可靠依据。</td></tr>
      <tr><td><code>degraded</code></td><td>本次交付是否低于一次完整的实时读取。<code>live</code> 与 <code>fresh_cache</code> 为 false。</td></tr>
      <tr><td><code>scope</code></td><td>是谁做的决定：<code>upstream</code> 是外部供应方；<code>operation_control</code>／<code>provider_credential</code>／<code>circuit_breaker</code> 是 Hub 侧部署状态，需要运维处理；<code>delivery_policy</code> 是你自己传的 <code>deliveryMode</code>；<code>rate_limit</code>／<code>concurrency</code>／<code>dispatch_dedup</code> 是瞬时状态，稍后重试即可。</td></tr>
    </tbody></table>
    <p>同一个对象也出现在响应头 <code>x-mx-insight-reason</code>（只有 code）和被拒绝时的 <code>error.details.reason</code>，详见<a href="/docs/errors">错误与重试</a>。管理端「小红书笔记画卷」把这些字段直接渲染成本次交付证据。</p>

    <h3>4. 从租户开通到首次调用</h3>
    <ol>
      <li>平台运营方准备 tenant、consumer、<code>xiaohongshu</code> 与 <code>social.posts.resolve</code> grants，并给租户成员建立 membership。</li>
      <li>租户成员使用 Launcher 会话登录 Internal Hub，只看到已授权模块。</li>
      <li>租户在“API Keys”签发同时包含两项 scope 的 Live Key；完整 secret 只显示一次。</li>
      <li>客户后端用该 Key 调用上面的 POST，把自己的笔记链接放入 JSON <code>url</code>，再用稳定的 <code>text</code>/<code>tags</code> 构建自己的产品展示。</li>
      <li>租户从“套餐与配额”和自己的用量视图查看余额、调用与扣费；外部采购凭据和成本证据始终只属于管理域。</li>
    </ol>
    <h3>5. Hub JSON 入口</h3>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/post</code></div><p>body 只接受 <code>platform</code>、<code>url</code>、<code>deliveryMode</code>；只允许官方小红书笔记或分享链接。</p></div>
    <pre><code>XHS_KEY="xhs-note-$(uuidgen)"
XHS_BODY='{"platform":"xiaohongshu","url":"https://www.xiaohongshu.com/explore/0123456789abcdef01234567","deliveryMode":"cache_first"}'
curl -sS -D /tmp/mxih-xhs.headers -X POST "$HUB_URL/api/v1/data/post" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $XHS_KEY" \
  -d "$XHS_BODY" \
  | tee /tmp/mxih-xhs.json \
  | jq '{contractVersion,item:.data.item,meta,requestId}'</code></pre>
    <p>返回合同固定为 <code>mx-insight-hub.social-post.v1</code>。正文、标题、标签、作者、互动量、图片引用、发布时间与采集时间都在 <code>data.item</code>；<code>meta.sourceMode</code> 是 <code>live|fresh_cache|stored_fallback|idempotent_replay</code>。Hub 不对业务数据做脱敏或过滤：<code>media[].url</code> 和 <code>author.avatarUrl</code> 保留已接受的源值；前 20 个媒体项（index <code>0..19</code>）额外获得绑定本次 requestId/index 的同源 <code>media[].hubRelayUrl</code>，后续媒体仍保留源 URL 但不生成不可用 locator。上游密钥、endpoint、raw envelope、诊断缓存 URL、采购价格和客户账单仍严格隔离。</p>
    <p>平台命名的 POST 在未传 platform 时默认 <code>xiaohongshu</code>。legacy GET 与两个 Hub POST 共三个入口共享笔记身份、immutable snapshot（不可变快照）与外采去重；幂等绑定还包含交付策略，因此同一 <code>Idempotency-Key</code> 改变 delivery mode 会返回冲突。切换 URL、method 或参数写法不是第二次付费调用的授权；App V2-compatible GET 不属于这个 canonical 幂等域。</p>
    <h3>6. 并发读取图片</h3>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/posts/media?requestId=...&amp;mediaIndex=0</code></div><p>只读取当前 consumer 已提交响应中的一张图片；不接受任意源 URL、不创建 note usage、不再次派发笔记请求。</p></div>
    <pre><code>REQUEST_ID=$(jq -r '.requestId' /tmp/mxih-xhs.json)
curl -fsS -G "$HUB_URL/api/v1/data/posts/media" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  --data-urlencode "requestId=$REQUEST_ID" \
  --data-urlencode 'mediaIndex=0' \
  -o /tmp/mxih-xhs-0.img</code></pre>
    <p><code>requestId</code> 与 <code>mediaIndex</code> 必须各出现一次，index 为 <code>0..19</code>。响应中的 <code>media[].hubRelayUrl</code> 是该路径的同源 locator；客户端可带同一 consumer 的 Live Key 拉取为 Blob，也可根据业务需要使用原样保留的 <code>media[].url</code>。Admin 画卷固定使用 Hub 中继，并在 consumer/global 并发护栏内并发加载多图；单图失败显示本地占位符。中继返回只允许 JPEG、PNG、WebP，且带 <code>Cache-Control: private, no-store</code>。</p>
    <h3>7. 缓存、429 与重试</h3>
    <p><code>cache_only</code> 绝不外采；<code>cache_first</code> 默认先读同 consumer 的精确新鲜快照；<code>refresh</code> 绕过新鲜快照并强制调用方提供 Idempotency-Key。无效或失效笔记也可能被外部平台接受并消耗容量，所以 request-local miss 会短时 negative-cache，客户端不得自动换 key 重试。</p>
    <table><thead><tr><th>错误</th><th>处理</th></tr></thead><tbody>
      <tr><td><code>400 invalid_post_url / unsupported_fields</code></td><td>只提交官方链接与三个允许字段。</td></tr>
      <tr><td><code>403 platform_not_granted / capability_not_granted</code></td><td>为 consumer 授权后签发同时包含两项 scope 的新 Key。</td></tr>
      <tr><td><code>404 post_not_found / stored_snapshot_not_found</code></td><td>前者是已严格识别的笔记不可用；后者只是 cache_only 未命中。</td></tr>
      <tr><td><code>429 consumer_quota_exceeded</code></td><td>调用身份在该数据域的滑动窗口额度用完。等窗口恢复，或由管理员调整该 consumer 的 policy。</td></tr>
      <tr><td><code>429 api_key_quota_exceeded</code></td><td>这一把 Key 自己的额度用完（比 consumer 更严）。换用同一 consumer 下额度更宽的 Key，或调整这把 Key 的 entitlement。</td></tr>
      <tr><td><code>429 plan_window_quota_exceeded</code></td><td>套餐的滑动窗口额度用完；等窗口恢复。</td></tr>
      <tr><td><code>429 plan_month_quota_exceeded</code></td><td>套餐的<strong>月度</strong>额度用完。<strong>等窗口没有用</strong>——要到下个计费周期，或升级套餐。</td></tr>
      <tr><td><code>429 plan_burst_exceeded</code></td><td>瞬时并发/突发速率超限。降低发起速率即可，额度本身没有用完。</td></tr>
      <tr><td><code>429 external_platform_busy / external_platform_capacity_exceeded</code></td><td>Hub 或供应方的限流与并发保护；paid-ready 请求也仍受这些技术保护，按响应退避，不能换 Key 绕过。</td></tr>
      <tr><td><code>429 external_platform_cost_budget_exhausted / external_platform_subsidy_budget_exhausted</code></td><td>仅可能用于本次请求未形成正价 enforced 按次计费 wallet hold 的 subsidized 流量；已成功预留该 hold 的 paid-ready 请求不会因 Hub 月度采购或补贴上限被拒。</td></tr>
      <tr><td><code>502 response_unusable / outcome_unknown</code></td><td>保留 requestId 和原 key，停止自动重试；相同 key 只重放已提交结论。</td></tr>
      <tr><td><code>503 not_configured / contract_unverified / circuit_open / capacity_unavailable / cost_control_unavailable / cost_evidence_incomplete</code></td><td>由 operator 检查发布门禁和当前 endpoint/当前请求的成本证据；paid-ready 只绕过月度财务线，不绕过这些完整性检查。无关历史成本异常不会阻断该请求。</td></tr>
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

    <section class="doc-page" data-doc-page="topic-reports">
    <h2 id="topic-reports">专题洞察</h2>
    <div class="notice">专题报告是异步数据产品，公开合同为 <code>mx-insight-hub.data-products.topic-report.v1</code>。它只读取调用者已经获准的 <code>data_center_saved_records_*</code> canonical 数据，不调用采集源、不暴露内部连接或供应方身份，不触发 Elasticsearch 索引重建，也不调用 HanLP 分词。</div>
    <p>一个报告会返回时间趋势、类别/标签/地域/作者分布、可视化关系节点与边，以及最多 80 条可回到原文核对的公开安全证据。关系表示同一批证据中的共现强度，不是因果推断或事实认定。</p>
    <h3>1. 创建持久化任务</h3>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/topic-reports</code></div><p>要求至少一个已授权的 saved-record 平台以及唯一 <code>Idempotency-Key</code>。任务创建时固化完整授权平台集合，成功接受返回 HTTP 202，并消耗 1 个 usage unit。</p></div>
    <pre><code>REPORT=$(curl -sS -X POST "$HUB_URL/api/v1/data/topic-reports" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: topic-report-$(uuidgen)" \
  -d '{"topic":"东南亚近期选举与外交政策变化","range":"7d","sourceScope":"all_granted","language":"zh-CN"}')
REPORT_ID=$(printf '%s' "$REPORT" | jq -r '.data.id')
printf '%s\n' "$REPORT" | jq '{id:.data.id,status:.data.status,progress:.data.progress,requestId}'</code></pre>
    <p><code>range</code> 支持 <code>24h|7d|30d|90d|custom</code>；custom 必须同时提供带时区的 <code>from/to</code>，最长 366 天。<code>sourceScope=selected</code> 时必须提供 1–13 个 <code>platforms</code>，且每项都必须已经在当前 API Key 的有效授权快照中。</p>
    <h3>2. 查询进度与结果</h3>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/topic-reports/{id}</code></div><p>只允许创建任务的 consumer 读取；同一 consumer 轮换 Key 后仍可读取。轮询不会再次计费，也不会触发采集、模型调用或索引操作。</p></div>
    <pre><code>curl -sS "$HUB_URL/api/v1/data/topic-reports/$REPORT_ID" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  | jq '{status:.data.status,phase:.data.phase,progress:.data.progress,summary:.data.result.executiveSummary,coverage:.data.result.coverage}'</code></pre>
    <table><thead><tr><th>status / phase</th><th>调用方行为</th></tr></thead><tbody>
      <tr><td><code>queued</code></td><td>任务已经持久化，稍后以原 report id 重试 GET。</td></tr>
      <tr><td><code>running / selecting_evidence</code></td><td>正在 PostgreSQL canonical truth 中筛选公开可发布证据。</td></tr>
      <tr><td><code>running / building_associations</code></td><td>正在构建趋势、维度排行与共现关系。</td></tr>
      <tr><td><code>succeeded / complete</code></td><td>消费 <code>result</code>；同一结果可用于网页、报告卡片或关系图 renderer。</td></tr>
      <tr><td><code>failed</code></td><td>保留 error code；使用新的 Idempotency-Key 创建新任务。</td></tr>
    </tbody></table>
    <h3>3. 外部数据产品实现</h3>
    <p>表单提交后保存 report id，每 2–5 秒读取任务状态；完成后用 <code>executiveSummary</code> 做摘要、<code>timeline</code> 做趋势图、<code>dimensions</code> 做排行、<code>associations.nodes/edges</code> 做关系视图、<code>evidence</code> 做证据列表。必须同时展示 <code>methodology.limitations</code>，并允许用户回到 evidence URL 核验。不要把共现边改写成因果或人物关系。</p>
    <div class="notice">报告以任务运行时可见的 canonical 数据为准。后续新增同步记录不会改写旧结果；要获得新快照，请用新的 Idempotency-Key 创建新任务。</div>
    </section>

    <section class="doc-page" data-doc-page="search">
    <h2 id="search">通用搜索</h2>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/ecommerce/products/search</code></div><p>通过 Hub 的外部数据平台网关检索商品。需要 <code>ecommerce</code> 数据域与 <code>ecommerce.products.search</code> 业务操作双授权；公开合同不会暴露外部平台身份、凭据、接口地址或原始响应。</p></div>
    <div class="notice">body 只接受 <code>marketplace</code>、<code>query</code>、<code>page</code>、<code>cursor</code>、<code>sort</code>、<code>price</code>，没有 <code>pageSize</code>。<code>page</code> 与 <code>cursor</code> 互斥。重试同一页时复用同一个 <code>Idempotency-Key</code>；使用 <code>nextCursor</code> 请求下一页时必须换新的 <code>Idempotency-Key</code>，并保持 marketplace/query/sort/price 不变。</div>
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
      <tr><td><code>idempotent_replay</code></td><td>同 <code>Idempotency-Key</code>、同路径、同 body 的已提交结果重放。</td></tr>
    </tbody></table>
    <p><code>hasMore=null</code> 表示没有足够证据安全继续，调用方必须停止，不能自行拼页码或外部 continuation。<code>capturedAt</code>、<code>servedAt</code> 与 <code>ageSeconds</code> 始终用于判断数据时效。</p>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/search</code></div><p>在一个请求中选择一个已授权平台。<code>platform=telegram</code> 使用 Hub 已清洗数据；<code>platform=xiaohongshu</code> 且 <code>pageSize=20</code>（也是默认值）时，兼容的首屏请求只有在独立 rollout gate 开启后才无感使用 Hub-native direct external-data connector，并保持 <code>night-all.data-search.v1</code> envelope。<code>data_center_saved_records_*</code> 是 Hub-stored 数据，只能走 stored/canonical search；此兼容路径明确拒绝。</p></div>
    <div class="notice">已经签发的小红书 direct cursor 会继续留在 direct connector，且只能原样用于相同 query 与 pageSize；历史 cursor 或非 20 pageSize 保留历史兼容路径。Hub 对 UTF-16、code point 或 grapheme 长度恰好为 60 的正文执行有界详情补全，只采用严格更长的正文；未解决的边界会以 <code>status=partial</code> 和 warning 明示。调用方不选择 provider，自动质量补全也不授予显式 <code>post_detail</code> API。</div>
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
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/stored/search</code></div><p>只搜索 Hub canonical 数据，不调用外部来源。可按逻辑 <code>datasetId</code> 和 <code>objectType</code> 精确过滤；<code>data_center_saved_records_*</code> 平台固定只返回 publication eligibility 为 candidate 的记录；不接受数据库、索引、SQL 或 ES DSL。</p></div>
    <div class="notice">授权边界仍是 <code>platform</code>：<code>datasetId</code> 只是过滤条件，不是独立授权。获得某平台授权的调用者当前可搜索该平台完整 canonical 语料。</div>
    <pre><code>curl -sS -X POST "$HUB_URL/api/v1/data/stored/search" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: stored-$(uuidgen)" \
  -d '{"platform":"xiaohongshu","query":"AI Agent","datasetId":"night-all.search.v1","objectType":"post","pageSize":20}' | jq</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/data/canonical/search</code></div><p>来源无关的统一检索：在一份 canonical 全局索引中直接排序，不逐个调用来源后拼接。省略 <code>platform</code> 时搜索当前调用者已授权的全部平台；混合结果中的 <code>data_center_saved_records_*</code> 分支固定只返回 publication eligibility 为 candidate 的记录，其他平台不受影响；<code>datasetId</code> 与 <code>objectType</code> 只用于收窄。可用 <code>searchProfile</code> 选择版本化搜索策略；不接受任意 analyzer、tokenizer、filter 或 ES DSL。</p></div>
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
    <p>每次调用前读取 <code>GET /api/v1/data/capabilities</code>。小红书平台项包含 <code>search_posts</code> 且 <code>search.ready=true</code> 表示独立的首屏 rollout gate 已开启；此时单 scalar query、有效页大小 20 的 page 1 raw 请求由 Hub-native connector 处理，已签发的 <code>mxec2</code> direct traversal cursor 继续走同一路径。独立 user-activity gate 开启后，单个 <code>username|userId|uid|profileUrl</code> 的 user-info，以及 posts-only、页大小 20、concurrency 1 的 crawl 也由 Hub-native connector 处理；crawl 只接受并返回 Hub 不透明 cursor，最多 15 页。<code>data.legacySearch</code> 仍保留小红书，因为 multi-identifier、channel、非 posts、非 20 页和自定义 params 等尚未迁移形态继续走历史路径。矩阵不会在请求时从 Night-All 的 capability 接口实时发现。</p>
    <p><code>data.legacySearch.contractVersion</code> 固定为 <code>night-all.legacy-search-capabilities.v1</code>。这是 Hub-pinned 的 operation dispatch 策略：目标平台必须同时出现在对应 operation 的 <code>supportedPlatforms</code> 与 <code>readyPlatforms</code>；它不证明 Night-All 当前 handler、endpoint、provider、credential 或上游健康。</p>
    <p><code>/api/v1/search/raw|crawl|user-info</code> 是对应 <code>/api/v1/night-all/search/*</code> 路径的精确别名；两种写法进入同一服务与 paid fingerprint，切换路径不会产生第二次外部派发，也不应更换 <code>Idempotency-Key</code>。</p>
    <p>当 <code>platform=xiaohongshu</code> 时，Key 与 consumer 必须同时拥有平台 grant 和 operation grant：<code>raw → social.posts.search</code>、<code>crawl → social.users.posts</code>、<code>user-info → social.users.resolve</code>。该映射对 Hub-native direct 子集、历史兼容分支以及两组路径别名完全相同。</p>
    <table><thead><tr><th>operation</th><th>示例</th><th>运行时判断字段</th></tr></thead><tbody>
      <tr><td><code>raw</code> direct 子集</td><td><code>xiaohongshu + 单 query + 20</code></td><td><code>data.platforms[xiaohongshu].search</code></td></tr>
      <tr><td><code>raw</code> 历史形状</td><td>非 direct 条件</td><td><code>data.legacySearch.operations.raw</code></td></tr>
      <tr><td><code>crawl</code></td><td><code>twitter + username=openai</code></td><td><code>data.legacySearch.operations.crawl</code></td></tr>
      <tr><td><code>user-info</code></td><td><code>twitter + username=openai</code></td><td><code>data.legacySearch.operations["user-info"]</code></td></tr>
    </tbody></table>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/night-all/search/raw</code></div><p>按关键词搜索平台内容；小红书还要求 <code>social.posts.search</code>。小红书 direct 子集要求恰好一个 scalar <code>keyword|query</code>、有效页大小 20，且省略 plural query、<code>params</code>、cache-age、并发、detail/comment workload 与 continuation 控制。显式 <code>includeDetails:false</code>/<code>includeComments:false</code> 可保留；<code>disableAutoDetails:true</code> 只关闭 60 字符边界自动详情。</p></div>
    <pre><code>curl -i -sS -X POST "$HUB_URL/api/v1/night-all/search/raw" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: night-all-raw-$(uuidgen)" \\
  -d '{"platform":"xiaohongshu","query":"AI Agent","count":20,"includeRaw":false}'</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/night-all/search/crawl</code></div><p>抓取一个账号公开发布的内容；小红书还要求 <code>social.users.posts</code>。</p></div>
    <pre><code>curl -i -sS -X POST "$HUB_URL/api/v1/night-all/search/crawl" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: night-all-crawl-$(uuidgen)" \\
  -d '{"platform":"twitter","username":"openai","count":20,"activityTypes":["posts"]}'</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method post">POST</span><code class="path">/api/v1/night-all/search/user-info</code></div><p>读取账号资料；小红书还要求 <code>social.users.resolve</code>。LinkedIn 必须使用完整的 <code>/in/</code> 个人 profile URL（<code>url</code>、<code>profileUrl</code>、<code>profile_url</code> 或 <code>urls</code>）；公司 URL 和裸 slug 会被拒绝。Hub-native 小红书 crawl/user-info 对非官方 profile URL 返回 <code>400 invalid_user_profile_url</code>，对与 direct crawl cursor 冲突的显式 page 返回 <code>400 cursor_page_mismatch</code>，无法解析用户时返回 <code>404 user_not_found</code>。</p></div>
    <pre><code>curl -i -sS -X POST "$HUB_URL/api/v1/night-all/search/user-info" \\
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: night-all-user-info-$(uuidgen)" \\
  -d '{"platform":"twitter","username":"openai"}'</code></pre>
    <p>历史 Night-All 路径不会向调用方暴露 provider continuation：首屏返回的 cursor、composite/offset params 或页码会被替换成 consumer、operation、platform、查询范围和页码绑定的加密 <code>mxnc1</code> cursor。page 对外改为 cursor mode，offset 对外改为 composite mode；下一页只回传 Hub 给出的 <code>nextCursor</code> 或完整 <code>nextParams</code>，并使用新的 <code>Idempotency-Key</code>；第 15 页强制结束。升级前保存的裸 provider cursor/continuation params 返回 <code>400 invalid_cursor</code>，需去掉 cursor、换新 Key 从首页重启。</p>
    <p>Hub-native 小红书 raw 保持 <code>raw_info</code>/<code>raw_data</code> 为 JSON string，并让 body <code>requestId</code> 与响应头使用同一个 durable Hub UUID。Night-All-owned live/fallback body 的业务字段、长正文和 correlation ID 保持原样；唯一治理改写是上述分页控制。历史路径入库保留完整的解析 JSON 与 legacy raw string；Hub-native provider 调用另有 exact response bytes 受限归档。Legacy transport 的 <code>x-mx-insight-source-mode</code> 始终只返回 <code>live|stale</code>：direct cache/replay 状态映射回 <code>live</code>，stored fallback 及其重放映射为 <code>stale</code>。历史路径遇到网络/超时、不可用的 2xx content-type/JSON/envelope，或真实非 2xx 的 502/503/504 时才会回放相同查询范围的受治理 last-good 快照。</p>
    <p><code>Idempotency-Key</code> 永久绑定一次可能产生供应方采购成本的 live dispatch；重用永远回放该结果，新鲜调用必须换新的 <code>Idempotency-Key</code>。legacy <code>includeRaw:false</code> 可接受但会在 dispatch 前移除，<code>true</code> 被拒绝。调用方不能通过 body 或嵌套 <code>params</code> 注入 provider、token、credential、endpoint、capability/moduleCode、timeout 或工作量覆盖；archive/fullArchive/allTweets、archiveLimit/totalCount、max*Pages、pageCount/chunkSize/budget/crawlDepth 等成本放大控制也会被拒绝。work budget 只限制返回/处理 item，不代表 Night-All provider call 或计费次数。Hub 不过滤、截断或改写已采集的业务数据；普通响应与日志只隔离真实请求凭据。</p>
    <p>这两组 legacy compatibility 路径不返回 <code>410 search_cursor_expired</code>；该错误保留在使用 Elasticsearch PIT 的 Hub search 操作，例如 <code>/data/search</code>、<code>/data/stored/search</code> 和 <code>/data/canonical/search</code>。</p>
    <table><thead><tr><th>HTTP / code</th><th>含义</th></tr></thead><tbody>
      <tr><td><code>400 platform_operation_unsupported</code></td><td>平台不在该 operation 的 <code>supportedPlatforms</code>；Telegram 会走此分支。</td></tr>
      <tr><td><code>503 platform_operation_unavailable</code></td><td>平台在固定支持集内，但当前 Hub dispatch 矩阵未将其列入 <code>readyPlatforms</code>；这不是 provider 健康状态。</td></tr>
      <tr><td><code>503 compatibility_capabilities_unavailable</code></td><td>Hub-pinned legacySearch dispatch 矩阵缺失或无效，Hub fail closed，尚未 dispatch。</td></tr>
      <tr><td><code>503 compatibility_store_unavailable</code></td><td>fallback 所需的 Hub compatibility store 暂不可用。</td></tr>
      <tr><td><code>400 invalid_user_profile_url</code></td><td>Hub-native 小红书 crawl/user-info 收到非官方 profile URL。</td></tr>
      <tr><td><code>400 cursor_page_mismatch</code></td><td>显式 page 与 Hub-native 小红书 crawl cursor 内绑定的页码冲突。</td></tr>
      <tr><td><code>404 user_not_found</code></td><td>Hub-native 小红书 crawl/user-info 无法解析目标用户。</td></tr>
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
      <tr><td>1. 搜索</td><td><code>POST /data/telegram/search</code> 并提供本页唯一的 <code>Idempotency-Key</code>；搜索结果下一页 body 含新 cursor，必须换新的 <code>Idempotency-Key</code>。</td></tr>
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
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/data/capabilities</code></div><p>返回当前调用者已授权的 Hub 数据域、业务操作、兼容合同，以及独立的 Hub-pinned、grant-filtered <code>data.legacySearch</code> operation dispatch 矩阵。该矩阵不证明 Night-All provider readiness。付费获取同时要求数据域与对应业务操作；小红书 raw/crawl/user-info 分别要求 <code>social.posts.search</code>/<code>social.users.posts</code>/<code>social.users.resolve</code>。若小红书已有 compatibility 顶层项，Hub 会保留其 provider-neutral <code>ready</code>/source identity；只有嵌套的 <code>search</code>/<code>postDetail</code> 表达 Hub-direct readiness，不能用顶层 <code>ready</code> 代替。<code>post_detail</code> 仍由独立 <code>social.posts.resolve</code> grant 控制。Telegram 与 <code>public_opinion</code> 平台项使用 <code>source=hub</code>、<code>servingMode=stored</code>；它们不代表 Night-All compatibility。每个已授权的 <code>data_center_saved_records_&lt;source_type&gt;</code> 也使用 <code>source=hub</code>、<code>servingMode=stored</code>，只公布 <code>stored_search</code>/<code>canonical_search</code>；其 <code>ready</code> 要求对应固定叶源 active 且搜索层已配置，但不等于公开授权或新鲜度保证，也永不进入 <code>data.legacySearch</code>。Telegram 的 <code>context.datasets</code> 与 <code>timeline.datasets</code> 分别是 bounded context 和双向时间线支持清单，各自的 <code>ready</code> 是独立服务索引门禁；<code>message_timeline</code> 明示正式时间线能力。</p></div>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/requests/{requestId}</code></div><p>查询当前调用者拥有的持久请求记录。requestId 来自搜索响应头 <code>x-mx-insight-request-id</code>。</p></div>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/requests/by-idempotency-key</code></div><p>旧客户端若保留了原 <code>Idempotency-Key</code>、却没有拿到 UUID，可把原值放在同名请求头中自动找回请求状态。可使用同一 consumer 当前有效的任一 Hub Public API Key；该 GET 不创建 usage、不访问外部平台，也不返回原响应正文或幂等键。</p></div>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/acquisitions/{requestId}</code></div><p>用创建原请求的同一把 Live Hub API Key 读取已提交的精确交付证据：<code>delivered.responseBody</code>、<code>responseHash</code>/<code>sha256-canonical-json-v1</code>、响应状态与时间、下游 <code>customerCharge</code> 以及按交付顺序排列的安全 canonical lineage。该读取不创建 usage，也绝不重新派发或运行上游请求；轮换后的同 consumer Key、零 scope Key、其他 consumer Key 与未知 ID 都返回 <code>404 acquisition_query_run_not_found</code>，未形成可证明提交正文的请求返回 <code>409</code>。管理恢复通道可用于 Key 轮换后的审计。</p></div>
    <pre><code>ACQUISITION_REQUEST_ID='00000000-0000-4000-8000-000000000001'
curl -sS "$HUB_URL/api/v1/acquisitions/$ACQUISITION_REQUEST_ID" \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  | jq '{contractVersion:.data.contractVersion,requestId:.data.requestId,delivered:.data.delivered,customerCharge:.data.customerCharge,items:.data.items}'</code></pre>
    <div class="endpoint"><div class="endpoint-head"><span class="method">GET</span><code class="path">/api/v1/usage?from=...&amp;to=...</code></div><p>读取当前调用者的请求、提交、释放、未知状态与计费单元汇总。</p></div>
    </section>

    <section class="doc-page" data-doc-page="errors">
    <h2 id="errors">错误与重试</h2>
    <div class="notice"><strong>外采财务准入：</strong><code>external_platform_cost_budget_exhausted</code> 与 <code>external_platform_subsidy_budget_exhausted</code> 保留在兼容错误合同中，但只可能用于本次请求未形成正价 enforced 按次计费 wallet hold 的 subsidized 流量。已成功预留该 hold 的 paid-ready 请求不会因 Hub 月度采购或补贴上限被拒。API Key/套餐配额、共享供应方限流、全局与单 consumer 并发、熔断、合同、凭据、幂等和派发安全保护仍然适用。</div>
    <table><thead><tr><th>HTTP</th><th>含义</th><th>建议</th></tr></thead><tbody>
      <tr><td>400</td><td>字段、游标、页大小或幂等 Key 不合法</td><td>修正请求，不原样盲重试</td></tr>
      <tr><td>401 / 403</td><td>Key 无效，或平台未授权</td><td>检查 Key 与 capabilities</td></tr>
      <tr><td>409</td><td>幂等冲突/处理中/结果未知，或该 dataset 不支持上下文/时间线</td><td>搜索请求保持原 body 与原幂等 Key；上下文/时间线请求先检查 capabilities</td></tr>
      <tr><td>410</td><td>搜索游标过期</td><td>从无 cursor 的第一页重新开始，并使用新幂等 Key</td></tr>
      <tr><td>429</td><td>请求或并发配额耗尽</td><td>等待策略窗口恢复</td></tr>
      <tr><td>503</td><td>当前数据/搜索运行时，或本次外采成本证据不可用</td><td>安全 GET 可稍后重试；POST 复用原幂等 Key，并由 operator 检查当前 endpoint/请求证据</td></tr>
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
  let section = null
  return PUBLIC_DOCS_ROUTES.map((route) => {
    const active = route.key === activeKey
    const heading = route.section !== section
      ? `<span class="nav-section">${route.section}</span>`
      : ''
    section = route.section
    // Deliberately no vendor name here. These docs are the tenant-facing
    // contract, which stays provider-neutral so Hub can change vendors without
    // breaking an integration. The admin console names vendors instead, on the
    // External Data Platforms page where that is the actual subject.
    return `${heading}<a href="${route.path}"${active ? ' class="active" aria-current="page"' : ''}>${route.label}</a>`
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
