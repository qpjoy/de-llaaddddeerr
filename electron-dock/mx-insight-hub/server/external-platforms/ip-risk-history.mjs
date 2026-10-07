import { AppError } from '../core/errors.mjs'
import { IP_RISK_PLATFORM, IP_RISK_OPERATION, IP_RISK_VERSION } from '../contracts/ip-risk.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATES = ['success', 'partial', 'no_data', 'unknown', 'error']
const scoped = (row, context) => row.tenantId === context.tenant.id && row.consumerId === context.consumer.id && row.apiKeyId === context.apiKey.id
const invalid = () => new AppError(400, 'invalid_ip_history_query', 'Invalid history filters or cursor')
const missing = () => new AppError(404, 'ip_history_not_found', 'IP history record not found')
const recordKey = row => `${row.kind}:${row.recordId}`
const cursorFor = row => Buffer.from(JSON.stringify([row.createdAt, recordKey(row), row.index])).toString('base64url')
const permittedSingle = (row, capabilities) => capabilities.includes(row.billingMeterKey === 'ip.risk.subscription.v2' ? 'ip.risk.query.v2' : IP_RISK_OPERATION)
const permittedBatch = (row, capabilities) => !row.response || row.response.data.every(item => capabilities.includes(item.channel === 'baidu-v2' ? 'ip.risk.query.v2' : IP_RISK_OPERATION))

export function parseIpHistoryQuery(query = {}) {
  if (Object.keys(query).some(key => !['q', 'state', 'level', 'limit', 'cursor'].includes(key))) throw invalid()
  const q = String(query.q || '').trim(), state = String(query.state || ''), level = String(query.level || '').trim()
  const limit = query.limit == null ? 10 : Number(query.limit)
  if (q.length > 100 || level.length > 256 || (state && !STATES.includes(state)) || !Number.isInteger(limit) || limit < 1 || limit > 50) throw invalid()
  let cursor = null
  if (query.cursor) {
    try {
      if (typeof query.cursor !== 'string' || query.cursor.length > 512 || !/^[\w-]+$/.test(query.cursor)) throw invalid()
      cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString())
      if (!Array.isArray(cursor) || cursor.length !== 3 || typeof cursor[0] !== 'string' || cursor[0].length > 64
        || !Number.isFinite(Date.parse(cursor[0])) || typeof cursor[1] !== 'string'
        || !/^(single|batch):[0-9a-f-]{36}$/.test(cursor[1]) || !UUID.test(cursor[1].split(':')[1])
        || !Number.isInteger(cursor[2]) || cursor[2] < -1 || cursor[2] > 99) throw invalid()
    } catch { throw invalid() }
  }
  return { q, state, level, limit, cursor }
}

function itemState(row) {
  if (['success', 'partial', 'no_data'].includes(row.envelope?.data?.status)) return row.envelope.data.status
  if (['reserved', 'unknown'].includes(row.requestState) || row.httpStatus === 409
    || /unknown|pending|in_progress|ip_response_(unusable|too_large)/.test(row.errorCode || '')) return 'unknown'
  return 'error'
}
function summary(row) {
  const profile = row.envelope?.data?.data
  return { kind: row.kind, recordId: row.recordId, index: row.index, id: `${recordKey(row)}:${row.index}`,
    ip: row.ip || null, requestId: row.requestId || null, batchId: row.kind === 'batch' ? row.recordId : null,
    createdAt: row.createdAt, capturedAt: row.envelope?.meta?.capturedAt || null,
    state: row.state || itemState(row), httpStatus: row.httpStatus, errorCode: row.errorCode || null,
    available: row.available !== false,
    profile: profile ? { risk_level: profile.risk_level, risk_score: profile.risk_score, proxy_type: profile.proxy_type } : null }
}
const compare = (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
  || (recordKey(a) < recordKey(b) ? 1 : recordKey(a) > recordKey(b) ? -1 : 0) || a.index - b.index

// Only existing customer deliveries are read. Never reserve, replay via POST,
// access restricted supplier archives, or require the supplier to be ready.
export class IpRiskHistory {
  constructor(gateway) { this.gateway = gateway; this.pool = gateway.platformStore.pool }
  async authorize(context) {
    const [platforms, capabilities] = await Promise.all([
      this.gateway.usageStore.listEffectiveGrants(context.consumer.id, context.apiKey.id),
      this.gateway.usageStore.listEffectiveCapabilityGrants(context.consumer.id, context.apiKey.id),
    ])
    if (!platforms.includes(IP_RISK_PLATFORM) || !capabilities.includes(IP_RISK_OPERATION) && !capabilities.includes('ip.risk.query.v2')) throw new AppError(403, 'capability_not_granted', 'IP risk history is not granted')
    if (context.apiKey.environment === 'test' || context.apiKey.prefix?.startsWith('mih_test_')) throw new AppError(403, 'test_key_not_supported', 'Use a Live Hub key')
    return capabilities
  }
  memoryRows(context, capabilities) {
    const allBatches = [...this.gateway.batch.rows.values()].filter(row => scoped(row, context))
    const batches = allBatches.filter(row => permittedBatch(row, capabilities))
    const completed = allBatches.filter(row => row.response)
    const singles = [...this.gateway.usageStore.requests.values()].filter(row => scoped(row, context) && row.platform === IP_RISK_PLATFORM
      && permittedSingle(row, capabilities)
      && !completed.some(batch => row.idempotencyKey?.startsWith(`ip-batch-${batch.id}-`)))
    return [...singles.map(row => ({ kind: 'single', recordId: row.id, index: 0, createdAt: row.createdAt,
      ip: row.responseBody?.data?.ip || row.acquisitionRequest?.body?.ip, envelope: row.responseBody,
      requestId: row.id, requestState: row.status, httpStatus: row.responseStatus, errorCode: row.responseBody?.error?.code || row.errorCode })),
    ...batches.flatMap(batch => batch.response ? batch.response.data.map((item, index) => ({
      kind: 'batch', recordId: batch.id, index, createdAt: batch.createdAt, ip: item.ip, envelope: item.response,
      requestId: item.response?.requestId || item.requestId, httpStatus: item.status, errorCode: item.error?.code || item.response?.error?.code,
    })) : [{ kind: 'batch', recordId: batch.id, index: -1, createdAt: batch.createdAt, requestState: 'unknown', available: false }])]
  }
  async list(context, query) {
    const capabilities = await this.authorize(context)
    const { q, state, level, limit, cursor } = parseIpHistoryQuery(query)
    let rows
    if (!this.pool) {
      rows = this.memoryRows(context, capabilities).filter(row => (!state || itemState(row) === state)
        && (!level || row.envelope?.data?.data?.risk_level === level)
        && (!q || [row.ip, row.requestId, row.kind === 'batch' ? row.recordId : '', JSON.stringify(row.envelope?.data?.data || {})].join(' ').toLowerCase().includes(q.toLowerCase()))
        && (!cursor || compare(row, { createdAt: cursor[0], kind: cursor[1].split(':')[0], recordId: cursor[1].split(':')[1], index: cursor[2] }) > 0))
        .sort(compare).slice(0, limit + 1).map(summary)
    } else {
      const escaped = q.replace(/[\\%_]/g, '\\$&')
      const result = await this.pool.query(`WITH scoped_batches AS (
        SELECT id, created_at, response FROM external_platform.ipsearch_batches
        WHERE tenant_id=$1 AND consumer_id=$2 AND api_key_id=$3
          AND ($4::timestamptz IS NULL OR created_at <= $4)
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(response->'data','[]'::jsonb)) entry
            WHERE NOT CASE WHEN entry->>'channel'='baidu-v2' THEN $12::boolean ELSE $11::boolean END)
      ), items AS (
        SELECT 'single'::text AS kind, r.id AS record_id, 0 AS item_index, r.created_at,
          COALESCE(r.response_body#>>'{data,ip}',r.acquisition_request#>>'{body,ip}') AS ip,
          r.response_body AS envelope, r.id::text AS request_id, r.status AS request_state,
          r.response_status AS http_status, COALESCE(r.response_body#>>'{error,code}',r.error_code) AS error_code, true AS available
        FROM public.usage_requests r
        WHERE r.tenant_id=$1 AND r.consumer_id=$2 AND r.api_key_id=$3 AND r.platform='ip_risk'
          AND CASE WHEN r.billing_meter_key='ip.risk.subscription.v2' THEN $12::boolean ELSE $11::boolean END
          AND ($4::timestamptz IS NULL OR r.created_at <= $4)
          AND NOT EXISTS (SELECT 1 FROM external_platform.ipsearch_batches b
            WHERE b.tenant_id=$1 AND b.consumer_id=$2 AND b.api_key_id=$3 AND b.response IS NOT NULL
              AND b.id=substring(r.idempotency_key from '^ip-batch-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-[0-9]+$')::uuid)
        UNION ALL
        SELECT 'batch', b.id, (i.ordinality-1)::integer, b.created_at, i.value->>'ip', i.value->'response',
          COALESCE(i.value#>>'{response,requestId}',i.value->>'requestId'), NULL,
          (i.value->>'status')::integer, COALESCE(i.value#>>'{error,code}',i.value#>>'{response,error,code}'), true
        FROM scoped_batches b CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(b.response->'data')='array' THEN b.response->'data' ELSE '[]'::jsonb END) WITH ORDINALITY i(value,ordinality)
        UNION ALL
        SELECT 'batch', b.id, -1, b.created_at, NULL, NULL, NULL, 'unknown', NULL, 'batch_pending_or_unknown', false
        FROM scoped_batches b WHERE b.response IS NULL
      ), classified AS (
        SELECT *, kind||':'||record_id AS record_key,
          CASE WHEN envelope#>>'{data,status}' IN ('success','partial','no_data') THEN envelope#>>'{data,status}'
            WHEN request_state IN ('reserved','unknown') OR http_status=409
              OR error_code ~ 'unknown|pending|in_progress|ip_response_(unusable|too_large)' THEN 'unknown'
            ELSE 'error' END AS state
        FROM items
      ) SELECT kind,record_id AS "recordId",item_index AS index,created_at::text AS "createdAt",ip,
          request_id AS "requestId",http_status AS "httpStatus",error_code AS "errorCode",available,state,
          jsonb_build_object('data',jsonb_build_object('data',jsonb_build_object(
            'risk_level',envelope#>'{data,data,risk_level}','risk_score',envelope#>'{data,data,risk_score}',
            'proxy_type',envelope#>'{data,data,proxy_type}')),'meta',jsonb_build_object('capturedAt',envelope#>'{meta,capturedAt}')) AS envelope
        FROM classified WHERE ($5='' OR state=$5) AND ($6='' OR envelope#>>'{data,data,risk_level}'=$6)
          AND ($7='' OR concat_ws(' ',ip,request_id,CASE WHEN kind='batch' THEN record_id::text END,envelope#>'{data,data}') ILIKE $7 ESCAPE '\\')
          AND ($4::timestamptz IS NULL OR created_at<$4 OR (created_at=$4 AND record_key<$8)
            OR (created_at=$4 AND record_key=$8 AND item_index>$9))
        ORDER BY created_at DESC,record_key DESC,item_index ASC LIMIT $10`,
      [context.tenant.id, context.consumer.id, context.apiKey.id, cursor?.[0] || null, state, level,
        q ? `%${escaped}%` : '', cursor?.[1] || '', cursor?.[2] ?? -1, limit + 1,
        capabilities.includes(IP_RISK_OPERATION), capabilities.includes('ip.risk.query.v2')])
      rows = result.rows.map(summary)
    }
    const more = rows.length > limit, items = rows.slice(0, limit)
    return { items, nextCursor: more ? cursorFor(items.at(-1)) : null, storage: this.pool ? 'persistent' : 'memory', readOnly: true }
  }
  async detail(context, kind, id) {
    const capabilities = await this.authorize(context)
    if (!['single', 'batch'].includes(kind) || !UUID.test(id)) throw missing()
    let row
    if (this.pool) {
      row = (await this.pool.query(kind === 'batch'
        ? `SELECT id,created_at AS "createdAt",response FROM external_platform.ipsearch_batches WHERE id=$1 AND tenant_id=$2 AND consumer_id=$3 AND api_key_id=$4`
        : `SELECT id,created_at AS "createdAt",billing_meter_key AS "billingMeterKey",response_body AS response,response_status AS "httpStatus",status,error_code AS "errorCode",acquisition_request AS request
           FROM public.usage_requests WHERE id=$1 AND tenant_id=$2 AND consumer_id=$3 AND api_key_id=$4 AND platform='ip_risk'`,
      [id, context.tenant.id, context.consumer.id, context.apiKey.id])).rows[0]
    } else if (kind === 'batch') row = [...this.gateway.batch.rows.values()].find(value => value.id === id && scoped(value, context))
    else {
      const value = this.gateway.usageStore.requests.get(id)
      if (value && scoped(value, context) && value.platform === IP_RISK_PLATFORM) row = { ...value, response: value.responseBody, httpStatus: value.responseStatus, request: value.acquisitionRequest }
    }
    if (!row) throw missing()
    if (!(kind === 'batch' ? permittedBatch(row, capabilities) : permittedSingle(row, capabilities))) throw missing()
    if (kind === 'batch' && !row.response) throw new AppError(409, 'ip_history_incomplete', 'Batch has no complete stored response; do not redispatch')
    const response = row.response || { requestId: id, error: { code: row.errorCode || (row.status === 'released' ? 'ip_risk_unavailable' : 'ip_query_outcome_unknown'), message: 'No stored portrait; inspect the original request outcome' } }
    return { kind, id, createdAt: row.createdAt, status: kind === 'batch' ? 200 : row.httpStatus || (row.status === 'released' ? 503 : 409),
      request: kind === 'batch' ? { ips: response.data.map(item => item.ip) } : { ip: response.data?.ip || row.request?.body?.ip || null },
      payload: structuredClone(response), requestState: row.status || null, hasStoredResponse: !!row.response,
      readOnly: true, contractVersion: response.contractVersion || IP_RISK_VERSION }
  }
}
