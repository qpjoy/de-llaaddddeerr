import { AppError } from '../core/errors.mjs'
import { requestFingerprint } from '../core/crypto.mjs'
import { HUB_SOCIAL_VERSION } from '../contracts/hub-social.mjs'
import { normalizeTwitterSearchParameters } from '../contracts/twitter-search-parameters.mjs'

const PATH = '/api/v1/data/search', MAX_ANCESTORS = 32
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const protocolIntents = new WeakMap()
export function twitterProtocolRetryIntents(usageStore) {
  if (!protocolIntents.has(usageStore)) protocolIntents.set(usageStore, new Map())
  return protocolIntents.get(usageStore)
}
export const twitterRetryDenied = () => new AppError(409, 'uncertain_retry_not_allowed',
  'The referenced uncertain Twitter request cannot authorize this retry')

// Reconstruct only the existing standard Twitter search fingerprint. Saved
// omissions, redactions, unsupported shapes and old compatibility paths fail.
export function normalizedTwitterRetryBody(snapshot) {
  const body = snapshot?.body
  if (snapshot?.method !== 'POST' || snapshot.path !== PATH || Object.hasOwn(snapshot, 'bodyOmitted')
    || !body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['platform', 'query', 'pageSize', 'cursor', 'type', 'params'].includes(key))) throw twitterRetryDenied()
  const platform = typeof body.platform === 'string' ? body.platform.trim().toLowerCase() : ''
  const query = typeof body.query === 'string' ? body.query.trim() : ''
  const pageSize = body.pageSize ?? 20, type = body.type ?? 'fresh'
  if (!['twitter', 'x'].includes(platform) || !query || query.length > 500
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || !['fresh', 'stable'].includes(type)) throw twitterRetryDenied()
  let cursor
  if (body.cursor != null) {
    if (typeof body.cursor !== 'string' || !body.cursor.trim() || body.cursor.trim().length > 8192
      || !body.cursor.trim().startsWith('mxds1.')) throw twitterRetryDenied()
    cursor = body.cursor.trim()
  }
  let params
  try { if (body.params !== undefined) params = normalizeTwitterSearchParameters(body.params) } catch { throw twitterRetryDenied() }
  return { platform: 'twitter', query, pageSize, ...(cursor ? { cursor } : {}),
    ...(params !== undefined ? { params } : {}), type }
}

function requestRow(row) {
  return row && { id: row.id, tenantId: row.tenant_id, consumerId: row.consumer_id, apiKeyId: row.api_key_id,
    status: row.status, platform: row.platform, fingerprint: row.fingerprint, idempotencyKey: row.idempotency_key,
    acquisitionRequest: row.acquisition_request }
}
const request = async (store, id, queryable) => store.pool
  ? requestRow((await queryable.query(`SELECT id,tenant_id,consumer_id,api_key_id,status,platform,fingerprint,
      idempotency_key,acquisition_request FROM usage_requests WHERE id=$1`, [id])).rows[0])
  : store.usageStore.requests.get(id)
const edge = async (store, id, queryable, incoming = false) => store.pool
  ? (await queryable.query(`SELECT * FROM external_platform.twitter_manual_retries WHERE ${incoming ? 'successor' : 'original'}_usage_request_id=$1`, [id])).rows[0]
  : [...(store.twitterManualRetries?.values() || [])].find(row => (incoming ? row.successor_usage_request_id : row.original_usage_request_id) === id)

export async function twitterManualRetryOwnerFor(store, id, queryable = store.pool) {
  const recorded = await edge(store, id, queryable)
  const calls = store.pool ? (await queryable.query('SELECT usage_request_id FROM external_platform.provider_calls WHERE retry_of_usage_request_id=$1', [id])).rows
    : [...store.calls.values()].filter(call => call.retryOfRequestId === id).map(call => ({ usage_request_id: call.usageRequestId }))
  const owners = new Set([recorded?.successor_usage_request_id, ...calls.map(call => call.usage_request_id)].filter(Boolean))
  if (owners.size > 1) throw twitterRetryDenied()
  return [...owners][0] ?? null
}

export async function twitterManualRetryOriginalFor(store, id, queryable = store.pool) {
  try { return (await edge(store, id, queryable, true))?.original_usage_request_id ?? null }
  catch (error) {
    // Ordinary searches remain available before this optional feature's
    // migration. Explicit manual retry validation still fails closed above.
    if (error?.code === '42P01') return null
    throw error
  }
}

function assertScope(row, input, status) {
  if (!row || row.status !== status || row.platform !== 'twitter'
    || ['tenantId', 'consumerId', 'apiKeyId', 'fingerprint'].some(key => row[key] !== input[key])) throw twitterRetryDenied()
  const body = normalizedTwitterRetryBody(row.acquisitionRequest)
  if (requestFingerprint({ method: 'POST', path: PATH, body }) !== input.fingerprint) throw twitterRetryDenied()
  return body
}

async function assertCurrentContract(store, row, input, queryable) {
  const rows = store.pool ? (await queryable.query(`SELECT provider_key,operation,contract_version,endpoint_key,endpoint_version,
    tenant_id,consumer_id,api_key_id,outcome FROM external_platform.provider_calls WHERE usage_request_id=$1 LIMIT 16`, [row.id])).rows
    : [...store.calls.values()].filter(call => call.usageRequestId === row.id).slice(0, 16).map(call => ({ provider_key: call.providerKey,
      operation: call.operation, contract_version: call.contractVersion, endpoint_key: call.endpointKey, endpoint_version: call.endpointVersion,
      tenant_id: call.tenantId, consumer_id: call.consumerId, api_key_id: call.apiKeyId, outcome: call.outcome }))
  const matches = call => call.provider_key === 'rapidapi' && call.operation === 'social.content.search'
    && call.contract_version === HUB_SOCIAL_VERSION && call.endpoint_key === 'twitter-aio.search'
    && call.endpoint_version === 'twitter-aio.hub.v1' && call.tenant_id === input.tenantId
    && call.consumer_id === input.consumerId && call.api_key_id === input.apiKeyId
  if (rows.length && rows.length <= 15 && rows.every(matches)) return
  // Buffer-only unknown delivery has no owned call. Its authenticated cursor
  // must identify a current, successfully acquired source before retrying it.
  if (!rows.length && input.bufferCallId && normalizedTwitterRetryBody(row.acquisitionRequest).cursor) {
    const source = store.pool ? (await queryable.query(`SELECT provider_key,operation,contract_version,endpoint_key,endpoint_version,
      tenant_id,consumer_id,api_key_id,outcome FROM external_platform.provider_calls WHERE id=$1`, [input.bufferCallId])).rows[0]
      : (() => { const call = store.calls.get(input.bufferCallId); return call && { provider_key: call.providerKey, operation: call.operation,
        contract_version: call.contractVersion, endpoint_key: call.endpointKey, endpoint_version: call.endpointVersion,
        tenant_id: call.tenantId, consumer_id: call.consumerId, api_key_id: call.apiKeyId, outcome: call.outcome } })()
    if (source && matches(source) && source.outcome === 'succeeded') return
  }
  throw twitterRetryDenied()
}

export async function validateTwitterManualRetry(store, input, queryable = store.pool) {
  if (store.providerKey !== 'rapidapi' || !input || !UUID.test(input.retryOfRequestId || '')
    || !['tenantId', 'consumerId', 'apiKeyId'].every(key => UUID.test(input[key] || ''))
    || !/^[0-9a-f]{64}$/u.test(input.fingerprint || '')) throw twitterRetryDenied()
  // A v2 acknowledgement owns its successor key even before the successor
  // usage row exists. A parallel v1 request must not fork that paid intent.
  let intent
  if (store.pool) {
    const present = (await queryable.query("SELECT to_regclass('control.data_search_protocol_retries') IS NOT NULL AS present")).rows[0]?.present
    if (present) intent = (await queryable.query('SELECT * FROM control.data_search_protocol_retries WHERE original_usage_request_id=$1', [input.retryOfRequestId])).rows[0]
  } else intent = twitterProtocolRetryIntents(store.usageStore).get(input.retryOfRequestId)
  if (intent) {
    const own = input.usageRequestId ? await request(store, input.usageRequestId, queryable) : null
    const key = input.idempotencyKey || own?.idempotencyKey
    if (intent.tenant_id !== input.tenantId || intent.consumer_id !== input.consumerId
      || intent.api_key_id !== input.apiKeyId || intent.successor_idempotency_key !== key) throw twitterRetryDenied()
  }
  const ancestorRequestIds = [], seen = new Set()
  let id = input.retryOfRequestId
  while (id) {
    if (seen.has(id) || ancestorRequestIds.length >= MAX_ANCESTORS) throw twitterRetryDenied()
    seen.add(id)
    const row = await request(store, id, queryable)
    assertScope(row, input, 'unknown')
    if (id === input.retryOfRequestId && input.idempotencyKey && row.idempotencyKey === input.idempotencyKey) throw twitterRetryDenied()
    await assertCurrentContract(store, row, input, queryable)
    ancestorRequestIds.push(id)
    const parent = await edge(store, id, queryable, true)
    if (parent && (parent.tenant_id !== input.tenantId || parent.consumer_id !== input.consumerId
      || parent.api_key_id !== input.apiKeyId || parent.request_fingerprint !== input.fingerprint)) throw twitterRetryDenied()
    id = parent?.original_usage_request_id
  }
  if (input.usageRequestId) {
    const owner = await twitterManualRetryOwnerFor(store, input.retryOfRequestId, queryable)
    if (owner && owner !== input.usageRequestId) throw twitterRetryDenied()
  }
  return { retryOfRequestId: input.retryOfRequestId, ancestorRequestIds }
}

// Called inside the SAME mutation transaction as the first provider INSERT or
// cached delivery commit. The target row lock plus unique keys arbitrate across
// workers; an admission refusal before this point consumes no retry intent.
export async function claimTwitterManualRetry(store, input, queryable = store.pool) {
  if (!UUID.test(input.usageRequestId || '') || input.usageRequestId === input.retryOfRequestId) throw twitterRetryDenied()
  if (store.pool) await queryable.query('SELECT id FROM usage_requests WHERE id=$1 FOR UPDATE', [input.retryOfRequestId])
  const validated = await validateTwitterManualRetry(store, input, queryable)
  assertScope(await request(store, input.usageRequestId, queryable), input, 'reserved')
  const row = { original_usage_request_id: input.retryOfRequestId, successor_usage_request_id: input.usageRequestId,
    tenant_id: input.tenantId, consumer_id: input.consumerId, api_key_id: input.apiKeyId, request_fingerprint: input.fingerprint }
  if (store.pool) {
    const result = await queryable.query(`INSERT INTO external_platform.twitter_manual_retries
      (original_usage_request_id,successor_usage_request_id,tenant_id,consumer_id,api_key_id,request_fingerprint)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING successor_usage_request_id`, Object.values(row))
    if (!result.rows.length && await twitterManualRetryOwnerFor(store, input.retryOfRequestId, queryable) !== input.usageRequestId) throw twitterRetryDenied()
  } else {
    store.twitterManualRetries ??= new Map()
    const existing = store.twitterManualRetries.get(input.retryOfRequestId)
    if (existing && existing.successor_usage_request_id !== input.usageRequestId
      || [...store.twitterManualRetries.values()].some(value => value.successor_usage_request_id === input.usageRequestId
        && value.original_usage_request_id !== input.retryOfRequestId)) throw twitterRetryDenied()
    store.twitterManualRetries.set(input.retryOfRequestId, existing ?? row)
  }
  return validated
}
