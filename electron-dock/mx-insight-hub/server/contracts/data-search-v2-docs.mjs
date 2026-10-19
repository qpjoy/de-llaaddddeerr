import { DATA_SEARCH_V2_PLATFORMS, DATA_SEARCH_V2_VERSION } from './data-search-v2.mjs'

export const TWITTER_SEARCH_PARAMETERS_SCHEMA = {
  type: 'object', additionalProperties: false,
  description: 'Twitter content-search options only. New searches default to Latest; query remains required even with filters. People returns accounts and is unsupported. Native count is no longer supported; use Hub pageSize. Return only the signed Hub nextCursor in the top-level cursor. The selected route must support every supplied option or fail before acquisition; options are never silently dropped.',
  properties: {
    category: { type: 'string', enum: ['Top', 'Latest', 'Photos', 'Videos'], default: 'Latest' },
    filters: { type: 'string', maxLength: 2048, pattern: '^[^\\u0000]*$', description: 'Optional native filter expression; surrounding whitespace is trimmed and an empty value is omitted.' },
    includeTimestamp: { type: 'boolean', default: false },
  },
}

const windowSchema = { type: 'object', additionalProperties: false, required: ['from', 'to', 'timezone', 'boundary'],
  properties: { from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' },
    timezone: { type: 'string', examples: ['Asia/Shanghai'] }, boundary: { const: '[from,to)' } } }

export const DATA_SEARCH_V2_OPENAPI = {
  servers: [{ url: '/', description: 'Explicit v2 path; existing v1 operations retain their original base path.' }],
  post: {
    tags: ['Search'], operationId: 'searchDataV2', summary: 'Search one platform with a frozen explicit time window',
    description: 'Opt-in content search using the same Live API key, platform/operation grants, limits, customer pricing and procurement controls as v1. Requires a nonempty [from,to) timeWindow with timezone-aware timestamps (millisecond precision) and an IANA timezone. Facebook uses Shanghai calendar-date parameters followed by exact delivery filtering; source date-boundary inclusivity is unverified. Other listed platforms currently filter only delivered items and report upstreamFiltering=unsupported and partial coverage. No source guarantees complete historical coverage. Missing publication timestamps are excluded and disclosed; complete acquired evidence and existing acquisition billing units are preserved. Twitter alone accepts params.category (Top/Latest/Photos/Videos, default Latest), filters (up to 2048 characters) and includeTimestamp (default false). query remains required; People and native count/cursor are unsupported. Other platforms retain their existing params rejection. mxds2 cursors bind Key/query/pageSize/type/window/params and the original inner cursor; never exchange v1/v2 cursors. An empty filtered page may still have continuation. At most 15 public pages and 24 hours. Each next page uses a new key; retries keep the original body/key. All v2 keys permanently identify one attempt, including type=fresh; fresh never authorizes re-purchase with the same key. Same-key version changes conflict. Unresolved outcomes cannot be bypassed by changing version/key/window/cursor for the same caller/platform/query. v1-v1 concurrency and historical v1 bodies/cursors remain. Request status lookups expose searchProtocol.deliveryConfirmed; acquisition status=committed alone does not prove v2 delivery. Deploy the additive migration and every Public instance before enabling v2.',
    parameters: [{ name: 'Idempotency-Key', in: 'header', required: true,
      schema: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' } },
    { name: 'X-MX-Insight-Retry-Of', in: 'header', required: false, schema: { type: 'string', format: 'uuid' },
      description: 'Explicit manual acknowledgement for an unknown Twitter v2 request only; another charge may occur. Use the original active API Key, exact saved normalized v2 body/window/cursor and a new permanent Idempotency-Key. The original unknown and charges remain. One durable successor intent is allowed; retain that new key across lost responses and never automatically create another retry. Missing evidence, a running request, another platform/supplier or committed acquisition with uncertain projection cannot authorize re-purchase. GET /api/v1/requests/{requestId}/search-recovery reads the exact saved v2 delivery without acquisition.' }],
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', additionalProperties: false, required: ['platform', 'query', 'timeWindow'],
      allOf: [{ if: { properties: { platform: { const: 'twitter' } }, required: ['platform'] },
        else: { not: { required: ['params'] } } }],
      properties: { platform: { type: 'string', enum: DATA_SEARCH_V2_PLATFORMS }, query: { type: 'string', minLength: 1, maxLength: 500 },
        pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, type: { type: 'string', enum: ['fresh', 'stable'], default: 'fresh' },
        cursor: { type: 'string', maxLength: 16384, pattern: '^mxds2\\.' }, timeWindow: windowSchema,
        params: TWITTER_SEARCH_PARAMETERS_SCHEMA },
    }, example: { platform: 'facebook', query: 'regional cooperation', pageSize: 20, type: 'stable', timeWindow: {
      from: '2026-10-16T08:00:00.000+08:00', to: '2026-10-17T08:00:00.000+08:00', timezone: 'Asia/Shanghai', boundary: '[from,to)',
    } } } } },
    responses: {
      200: { description: 'Saved v2 delivery; an empty filtered page does not prove complete historical coverage.',
        content: { 'application/json': { schema: { type: 'object', required: ['data', 'requestId'], properties: {
          requestId: { type: 'string', format: 'uuid' }, data: { type: 'object', required: ['contractVersion', 'items', 'pageInfo', 'meta'], properties: {
            contractVersion: { const: DATA_SEARCH_V2_VERSION }, items: { type: 'array', items: { type: 'object' } },
            pageInfo: { type: 'object', required: ['returnedCount', 'hasMore', 'nextCursor'], properties: {
              returnedCount: { type: 'integer' }, hasMore: { type: 'boolean' }, nextCursor: { type: ['string', 'null'] } } },
            status: { type: 'string', enum: ['ok', 'partial'] }, meta: { type: 'object', required: ['requestedWindow', 'effectiveWindow', 'capabilities', 'limitations'],
              properties: { requestedWindow: windowSchema, effectiveWindow: { type: 'object' }, capabilities: { type: 'object', properties: {
                upstreamFiltering: { enum: ['calendar_date', 'unsupported'] }, deliveryFiltering: { const: 'exact' }, coverageComplete: { const: false }, idempotency: { const: 'permanent' } } },
              limitations: { type: 'array', items: { type: 'object', required: ['code'], properties: { code: { type: 'string' }, message: { type: 'string' } } } } } },
          } } } } } } },
      400: { description: 'Invalid explicit window, fields, key or version-bound cursor; no acquisition. Twitter invalid_twitter_search_parameters rejects unknown options, People, native count/cursor or invalid values. twitter_search_parameters_unsupported means the current route cannot preserve the requested options; no silent option removal.' },
      401: { description: 'API-key authentication required.' }, 403: { description: 'Current platform/operation/Live-key grant required.' },
      409: { description: 'search_admission_blocked permits delayed retry of the same body/key only when details dispatchState=not_started, automaticRetryAllowed=true and retrySameRequest=true. idempotency_conflict, request_in_progress and request_outcome_unknown retain their original protections; never fall back to v1.' },
      422: { description: 'search_v2_platform_unsupported; no fallback or silent omission of the window.' },
      429: { description: 'Existing quota, provider admission or financial limit.' },
      502: { description: 'Retained source failure; inspect the original request.' },
      503: { description: 'Search capability, storage, provider or admission unavailable.' },
    },
  },
}

export const DATA_SEARCH_RECOVERY_OPENAPI = {
  get: {
    tags: ['Search'], operationId: 'readSearchRecovery', summary: 'Read a saved Twitter v2 delivery or its linked manual retry',
    description: 'Read-only recovery for the original API Key and tenant/consumer scope. Never reserves, dispatches, reaps, projects or purchases. The original request stays unchanged. Returns the original saved normalized v2 request and only a durably linked successor; delivery is present only when a complete exact v2 result has been saved. Inner usage committed alone is insufficient. A missing or pending delivery never authorizes another POST or a new key.',
    parameters: [{ name: 'requestId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    responses: {
      200: { description: 'Owned recovery metadata; delivery=null until a verified v2 delivery is complete.',
        content: { 'application/json': { schema: { type: 'object', required: ['data', 'requestId'], properties: {
          requestId: { type: 'string', format: 'uuid' },
          data: { type: 'object', required: ['contractVersion', 'originalRequestId', 'platform', 'state', 'request', 'successor', 'delivery'], properties: {
            contractVersion: { const: 'mx-insight-hub.data-search-recovery.v1' },
            originalRequestId: { type: 'string', format: 'uuid' }, platform: { const: 'twitter' },
            state: { type: 'string', enum: ['running', 'retryable', 'complete', 'failed', 'unknown'] },
            request: { type: 'object', required: ['method', 'path', 'body'], properties: {
              method: { const: 'POST' }, path: { const: '/api/v2/data/search' }, body: { type: 'object' } } },
            successor: { type: ['object', 'null'], properties: {
              requestId: { type: ['string', 'null'], format: 'uuid' }, idempotencyKey: { type: 'string' }, state: { type: 'string' } } },
            delivery: { type: ['object', 'null'], properties: {
              requestId: { type: 'string', format: 'uuid' }, status: { type: 'integer' }, body: { type: 'object' } } },
          } },
        } } } } },
      400: { description: 'Invalid request UUID or unexpected query parameters.' },
      401: { description: 'Original active API Key required.' },
      403: { description: 'Current authorization required.' },
      404: { description: 'No matching owned Twitter v2 request.' },
      409: { description: 'Saved evidence or retry linkage cannot establish a safe recovery.' },
      503: { description: 'Required migration or storage is unavailable; no acquisition is attempted.' },
    },
  },
}
