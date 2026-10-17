import { DATA_SEARCH_V2_PLATFORMS, DATA_SEARCH_V2_VERSION } from './data-search-v2.mjs'

const windowSchema = { type: 'object', additionalProperties: false, required: ['from', 'to', 'timezone', 'boundary'],
  properties: { from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' },
    timezone: { type: 'string', examples: ['Asia/Shanghai'] }, boundary: { const: '[from,to)' } } }

export const DATA_SEARCH_V2_OPENAPI = {
  servers: [{ url: '/', description: 'Explicit v2 path; existing v1 operations retain their original base path.' }],
  post: {
    tags: ['Search'], operationId: 'searchDataV2', summary: 'Search one platform with a frozen explicit time window',
    description: 'Opt-in content search using the same Live API key, platform/operation grants, limits, customer pricing and procurement controls as v1. Requires a nonempty [from,to) timeWindow with timezone-aware timestamps (millisecond precision) and an IANA timezone. Facebook uses Shanghai calendar-date parameters followed by exact delivery filtering; source date-boundary inclusivity is unverified. Other listed platforms currently filter only delivered items and report upstreamFiltering=unsupported and partial coverage. No source guarantees complete historical coverage. Missing publication timestamps are excluded and disclosed; complete acquired evidence and existing acquisition billing units are preserved. mxds2 cursors bind Key/query/pageSize/type/window and the original inner cursor; never exchange v1/v2 cursors. An empty filtered page may still have continuation. At most 15 public pages and 24 hours. Each next page uses a new key; retries keep the original body/key. All v2 keys permanently identify one attempt, including type=fresh; fresh never authorizes re-purchase with the same key. Same-key version changes conflict. Unresolved outcomes cannot be bypassed by changing version/key/window/cursor for the same caller/platform/query. v1-v1 concurrency and historical v1 bodies/cursors remain. Request status lookups expose searchProtocol.deliveryConfirmed; acquisition status=committed alone does not prove v2 delivery. Deploy the additive migration and every Public instance before enabling v2.',
    parameters: [{ name: 'Idempotency-Key', in: 'header', required: true,
      schema: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' } }],
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', additionalProperties: false, required: ['platform', 'query', 'timeWindow'],
      properties: { platform: { type: 'string', enum: DATA_SEARCH_V2_PLATFORMS }, query: { type: 'string', minLength: 1, maxLength: 500 },
        pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, type: { type: 'string', enum: ['fresh', 'stable'], default: 'fresh' },
        cursor: { type: 'string', maxLength: 16384, pattern: '^mxds2\\.' }, timeWindow: windowSchema },
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
      400: { description: 'Invalid explicit window, fields, key or version-bound cursor; no acquisition.' },
      401: { description: 'API-key authentication required.' }, 403: { description: 'Current platform/operation/Live-key grant required.' },
      409: { description: 'search_admission_blocked permits delayed retry of the same body/key only when details dispatchState=not_started, automaticRetryAllowed=true and retrySameRequest=true. idempotency_conflict, request_in_progress and request_outcome_unknown retain their original protections; never fall back to v1.' },
      422: { description: 'search_v2_platform_unsupported; no fallback or silent omission of the window.' },
      429: { description: 'Existing quota, provider admission or financial limit.' },
      502: { description: 'Retained source failure; inspect the original request.' },
      503: { description: 'Search capability, storage, provider or admission unavailable.' },
    },
  },
}
