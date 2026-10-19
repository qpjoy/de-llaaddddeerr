import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { isPostgresSafeJsonValue } from '../core/postgres-json.mjs'
import { canonicalPlatform } from '../hub-service.mjs'

const PATH = '/api/v1/data/search', AGE = 86400000, MAX_BYTES = 12 * 1024 * 1024
const SHA = /^[0-9a-f]{64}$/u, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const DATE_FIELDS = ['start_date', 'startDate', 'start', 'startTime', 'end_date', 'endDate', 'end', 'endTime']
const CONTRACTS = {
  rapidapi: { operation: 'social.facebook.search', endpoint: 'facebook-scraper3.search', version: 'v1', contract: 'mx-insight-hub.facebook-search.v1', maxBytes: 4194304 },
  justone: { operation: 'native.j.facebook_post_search_v1', endpoint: 'native.j.facebook_post_search_v1', version: 'night-all-source-snapshot.2026-09-26', contract: 'mx-insight-hub.native-forwarding.v1', maxBytes: 8388608 },
}
const fail = () => new AppError(409, 'search_page_unavailable', 'The saved Facebook search does not match this request')
const iso = value => new Date(value).toISOString()
const fresh = value => value != null && Number.isFinite(Date.parse(value)) && Date.now() >= Date.parse(value) && Date.now() - Date.parse(value) <= AGE
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
const identity = input => input.path === PATH && ['tenantId', 'consumerId', 'apiKeyId'].every(key => UUID.test(input[key] || ''))
const sourceStore = (store, input, provider) => input.stores?.[provider] || (store.providerKey === provider ? store : null)

function bodyMatches(snapshot, input) {
  try {
    const body = snapshot?.body, params = body?.params || {}
    if (snapshot?.path !== PATH || canonicalPlatform(body?.platform) !== 'facebook' || body?.query?.trim() !== input.query
      || (body.pageSize ?? 20) !== input.pageSize || (body.type ?? 'fresh') !== input.type
      || !params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !DATE_FIELDS.includes(key))) return false
    const dates = Object.fromEntries(DATE_FIELDS.filter(key => params[key] != null).map(key => [key, params[key]]))
    return createHash('sha256').update(JSON.stringify({ query: input.query, pageSize: input.pageSize, dates, format: input.type })).digest('hex') === input.scopeHash
  } catch { return false }
}
function inputMatches(input) {
  return identity(input) && SHA.test(input.scopeHash || '') && ['fresh', 'stable'].includes(input.type)
    && typeof input.query === 'string' && input.query.length > 0 && input.query.length <= 2000
    && Number.isInteger(input.pageSize) && input.pageSize >= 1 && input.pageSize <= 100
    && date(input.startDate) && date(input.endDate) && input.startDate <= input.endDate
}
function decodeArchive(raw, provider) {
  const contract = CONTRACTS[provider], bytes = raw?.bodyBytes
  if (!contract || !(bytes instanceof Uint8Array) || !Number.isSafeInteger(raw.bodySize) || raw.bodySize < 1
    || raw.bodySize !== bytes.byteLength || raw.bodySize > contract.maxBytes || !SHA.test(raw.bodySha256 || '')
    || createHash('sha256').update(bytes).digest('hex') !== raw.bodySha256 || !fresh(raw.capturedAt)) return null
  try {
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, ''))
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !isPostgresSafeJsonValue(payload)
      || provider === 'justone' && (payload.code !== 0 || !payload.data)) return null
    return { payload, capturedAt: iso(raw.capturedAt), bodySize: raw.bodySize, bodySha256: raw.bodySha256, providerKey: provider }
  } catch { return null }
}

async function readPage(store, input, ownUsageRequestId = null, client = null, lock = false) {
  const provider = input.sourceProvider ?? input.providerKey, contract = CONTRACTS[provider]
  if (!contract || !identity(input) || !UUID.test(input.callId || '')) return null
  if (!store.pool) {
    const owner = sourceStore(store, input, provider), call = owner?.calls.get(input.callId)
    const usage = owner?.usageStore.requests.get(call?.usageRequestId)
    if (!call || call.providerKey !== provider || call.operation !== contract.operation || call.endpointKey !== contract.endpoint
      || call.endpointVersion !== contract.version || call.contractVersion !== contract.contract || call.outcome !== 'succeeded'
      || call.httpStatus !== 200 || !fresh(call.completedAt) || provider === 'justone' && call.businessCode !== 0
      || !usage || usage.platform !== 'facebook' || !(usage.status === 'committed' && usage.responseStatus === 200
        || usage.id === ownUsageRequestId && usage.status === 'reserved')
      || ['tenantId', 'consumerId', 'apiKeyId'].some(key => call[key] !== input[key] || usage[key] !== input[key])
      || usage.acquisitionRequest?.path !== PATH) return null
    const page = decodeArchive(owner.restrictedResponseArchives.get(input.callId), provider)
    return page ? { ...page, sourceUsageRequestId: usage.id, acquisitionRequest: usage.acquisitionRequest } : null
  }
  const db = client || store.pool
  const row = (await db.query(`SELECT raw.body_bytes,raw.body_size,raw.body_sha256,raw.captured_at,
      usage.id AS source_usage_request_id,usage.acquisition_request
    FROM external_platform.provider_calls call JOIN usage_requests usage ON usage.id=call.usage_request_id
    JOIN control.external_platform_restricted_raw_responses raw ON raw.provider_call_id=call.id
    WHERE call.id=$1 AND call.provider_key=$2 AND call.operation=$3 AND call.endpoint_key=$4
      AND call.endpoint_version=$5 AND call.contract_version=$6 AND call.outcome='succeeded' AND call.http_status=200
      AND ($2<>'justone' OR call.business_code=0) AND call.completed_at BETWEEN now()-interval '24 hours' AND now()
      AND call.tenant_id=$7 AND call.consumer_id=$8 AND call.api_key_id=$9
      AND usage.tenant_id=$7 AND usage.consumer_id=$8 AND usage.api_key_id=$9 AND usage.platform='facebook'
      AND ((usage.status='committed' AND usage.response_status=200) OR (usage.id=$10::uuid AND usage.status='reserved'))
      AND usage.acquisition_request->>'path'='/api/v1/data/search'
      AND raw.captured_at BETWEEN now()-interval '24 hours' AND now() AND raw.body_size BETWEEN 1 AND $11
      AND octet_length(raw.body_bytes)=raw.body_size ${lock ? 'FOR SHARE OF call,usage,raw' : ''}`,
  [input.callId, provider, contract.operation, contract.endpoint, contract.version, contract.contract,
    input.tenantId, input.consumerId, input.apiKeyId, ownUsageRequestId, contract.maxBytes])).rows[0]
  const page = row && decodeArchive({ bodyBytes: row.body_bytes, bodySize: Number(row.body_size), bodySha256: row.body_sha256, capturedAt: row.captured_at }, provider)
  return page ? { ...page, sourceUsageRequestId: row.source_usage_request_id, acquisitionRequest: row.acquisition_request } : null
}
export async function facebookPageFor(store, input) { return readPage(store, input) }

async function readUsage(store, input, id) {
  if (!store.pool) return store.usageStore.requests.get(id)
  const row = (await store.pool.query(`SELECT id,tenant_id,consumer_id,api_key_id,platform,status,response_status,acquisition_request,
    jsonb_build_object('data',jsonb_build_object('platform',response_body->'data'->'platform','query',response_body->'data'->'query',
      'pageInfo',response_body->'data'->'pageInfo','items',CASE WHEN jsonb_typeof(response_body->'data'->'items')='array' THEN
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id',item->'id')),'[]'::jsonb) FROM
        (SELECT item FROM jsonb_array_elements(response_body->'data'->'items') item LIMIT 101) bounded) ELSE NULL END)) AS response_body
    FROM usage_requests WHERE id=$1 AND tenant_id=$2 AND consumer_id=$3 AND api_key_id=$4`,
  [id,input.tenantId,input.consumerId,input.apiKeyId])).rows[0]
  return row ? { id:row.id,tenantId:row.tenant_id,consumerId:row.consumer_id,apiKeyId:row.api_key_id,platform:row.platform,
    status:row.status,responseStatus:row.response_status,acquisitionRequest:row.acquisition_request,responseBody:row.response_body } : null
}
export async function facebookDeliveredIdsFor(store, input) {
  if (!inputMatches(input)) throw fail()
  const seen = new Set(), ids = new Set(), root = input.previousDeliveryId ?? null
  let id = root
  while (id != null) {
    if (!UUID.test(id) || seen.has(id) || seen.size >= 15) throw fail()
    seen.add(id)
    const row = await readUsage(store, input, id), lineage = row?.acquisitionRequest?.facebookFill
    if (!row || row.status !== 'committed' || row.responseStatus !== 200 || row.platform !== 'facebook'
      || ['tenantId','consumerId','apiKeyId'].some(key => row[key] !== input[key]) || !bodyMatches(row.acquisitionRequest,input)
      || row.responseBody?.data?.platform !== 'facebook' || row.responseBody.data.query !== input.query
      || row.responseBody.data.pageInfo?.pageSize !== input.pageSize || !Array.isArray(row.responseBody.data.items)
      || row.responseBody.data.items.length > input.pageSize) throw fail()
    for (const item of row.responseBody.data.items) {
      if (typeof item?.id !== 'string' || !item.id || item.id.length > 2048) throw fail()
      ids.add(item.id)
      if (ids.size > 1500) throw fail()
    }
    if (lineage == null) id = null
    else {
      if (lineage.version !== 'facebook-fill.v1' || lineage.scopeHash !== input.scopeHash
        || lineage.startDate !== input.startDate || lineage.endDate !== input.endDate
        || !Number.isInteger(lineage.upstreamPages) || lineage.upstreamPages < 0 || lineage.upstreamPages > 15
        || lineage.previousDeliveryId != null && !UUID.test(lineage.previousDeliveryId)) throw fail()
      id = lineage.previousDeliveryId
    }
  }
  return { ids:[...ids],previousDeliveryId:root,deliveries:seen.size }
}
export async function facebookFillUnknownFor(store, delivery) {
  if (!['tenantId','consumerId','apiKeyId'].every(key => UUID.test(delivery[key] || '')) || !SHA.test(delivery.fingerprint || '')) throw fail()
  if (!store.pool) return [...store.usageStore.requests.values()].some(row => row.platform === 'facebook' && row.status === 'unknown'
    && ['tenantId','consumerId','apiKeyId','fingerprint'].every(key => row[key] === delivery[key])
    && row.acquisitionRequest?.path === PATH && Date.now()-Date.parse(row.reservedAt ?? row.createdAt ?? new Date()) <= AGE)
  return (await store.pool.query(`SELECT 1 FROM usage_requests WHERE tenant_id=$1 AND consumer_id=$2 AND api_key_id=$3
    AND platform='facebook' AND fingerprint=$4 AND status='unknown' AND acquisition_request->>'path'='/api/v1/data/search'
    AND reserved_at>=now()-interval '24 hours' LIMIT 1`,[delivery.tenantId,delivery.consumerId,delivery.apiKeyId,delivery.fingerprint])).rows.length > 0
}
export async function acquireFacebookFillDeliveryLease(store, input) {
  if (store.providerKey !== 'rapidapi' || input.operation !== 'social.facebook.search' || !UUID.test(input.consumerId || '')
    || !UUID.test(input.ownerRequestId || '') || !SHA.test(input.fingerprint || '')
    || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now()) throw fail()
  if (!store.pool) {
    const key = `${input.consumerId}\u0000${input.operation}\u0000${input.fingerprint}`
    const current = store.leases.get(key)
    if (current && Date.parse(current.expiresAt)>Date.now()) return {kind:'busy',blockedUntil:current.expiresAt}
    store.leases.set(key,{ownerRequestId:input.ownerRequestId,expiresAt:iso(input.expiresAt)})
    return {kind:'acquired'}
  }
  const rows = (await store.pool.query(`INSERT INTO external_platform.dispatch_leases
    (consumer_id,operation,request_fingerprint,owner_request_id,expires_at) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT(consumer_id,operation,request_fingerprint) DO UPDATE SET owner_request_id=EXCLUDED.owner_request_id,
      expires_at=EXCLUDED.expires_at,created_at=now() WHERE external_platform.dispatch_leases.expires_at<=now()
    RETURNING owner_request_id`,[input.consumerId,input.operation,input.fingerprint,input.ownerRequestId,input.expiresAt])).rows
  return rows[0]?.owner_request_id===input.ownerRequestId ? {kind:'acquired'} : {kind:'busy'}
}

function validateDelivery(input) {
  const {delivery,lineage,sources,responseBody,usageUnitsActual,sourceMode,capturedAt}=input
  if (!inputMatches({...input,...delivery,path:PATH}) || delivery.operation !== 'social.facebook.search'
    || !UUID.test(delivery.usageRequestId || '') || !SHA.test(delivery.fingerprint || '')
    || !lineage || lineage.version !== 'facebook-fill.v1' || lineage.scopeHash !== input.scopeHash
    || lineage.startDate !== input.startDate || lineage.endDate !== input.endDate
    || lineage.previousDeliveryId != null && !UUID.test(lineage.previousDeliveryId)
    || !Number.isInteger(lineage.upstreamPages) || lineage.upstreamPages < 0 || lineage.upstreamPages > 15
    || !Array.isArray(sources) || !sources.length || sources.length>16
    || new Set(sources.map(source=>source.callId)).size !== sources.length || new Set(sources.map(source=>source.providerKey)).size !== 1
    || !['live','fresh_cache','stored_fallback'].includes(sourceMode) || !fresh(capturedAt)
    || !Number.isInteger(usageUnitsActual) || usageUnitsActual<0 || usageUnitsActual>input.pageSize
    || responseBody?.data?.platform !== 'facebook' || responseBody.data.query !== input.query
    || responseBody.data.pageInfo?.pageSize !== input.pageSize || !Array.isArray(responseBody.data.items)
    || responseBody.data.items.length !== usageUnitsActual || responseBody.data.items.some(item=>typeof item?.id!=='string' || !item.id || item.id.length>2048)
    || new Set(responseBody.data.items.map(item=>item.id)).size !== usageUnitsActual) throw fail()
  let bytes=0
  for (const source of sources) {
    if (!CONTRACTS[source.providerKey] || !UUID.test(source.callId || '') || !SHA.test(source.bodySha256 || '')
      || !SHA.test(source.rowsHash || '') || !Number.isSafeInteger(source.bodySize) || source.bodySize<1
      || source.bodySize>CONTRACTS[source.providerKey].maxBytes || !fresh(source.capturedAt)) throw fail()
    bytes+=source.bodySize
  }
  if (bytes>MAX_BYTES) throw fail()
}
export async function commitFacebookFillDelivery(store,input) {
  validateDelivery(input)
  const {delivery,sources,lineage,responseBody,capturedAt,usageUnitsActual,latencyMs=0,sourceMode}=input
  const manifest={...lineage,sources:structuredClone(sources)}
  const validateSources=async client=>{
    let representative=sources[0]
    for (const source of sources) {
      const page=await readPage(store,{...input,...delivery,path:PATH,callId:source.callId,sourceProvider:source.providerKey},delivery.usageRequestId,client,true)
      if (!page || page.bodySize!==source.bodySize || page.bodySha256!==source.bodySha256 || page.capturedAt!==iso(source.capturedAt)
        || !bodyMatches(page.acquisitionRequest,input)) throw fail()
      const previous=page.acquisitionRequest.facebookFill
      if (previous && (previous.scopeHash!==input.scopeHash || previous.startDate!==input.startDate || previous.endDate!==input.endDate)) throw fail()
      if (page.sourceUsageRequestId===delivery.usageRequestId) representative=source
    }
    return representative
  }
  if (!store.pool) {
    const usage=store.usageStore.requests.get(delivery.usageRequestId)
    if (!usage || usage.status!=='reserved' || usage.platform!=='facebook' || usage.fingerprint!==delivery.fingerprint
      || ['tenantId','consumerId','apiKeyId'].some(key=>usage[key]!==delivery[key]) || !bodyMatches(usage.acquisitionRequest,input)) throw fail()
    const representative=await validateSources(null)
    await store.usageStore.commitRequest(delivery.usageRequestId,{responseStatus:200,responseBody,unitsActual:Math.max(1,usageUnitsActual),
      upstreamLatencyMs:latencyMs,deliverySourceMode:sourceMode==='stored_fallback'?'stale':'live',capturedAt})
    usage.acquisitionRequest={...usage.acquisitionRequest,facebookFill:manifest}
    const owner=sourceStore(store,input,representative.providerKey)
    owner.requests.push({id:randomUUID(),providerKey:representative.providerKey,...delivery,sourceMode,succeeded:true,responseStatus:200,
      providerCallId:representative.callId,snapshotId:null,errorCode:null,createdAt:new Date().toISOString()})
    return
  }
  const client=await store.pool.connect()
  let committing=false,releaseError
  try {
    await client.query('BEGIN')
    const usage=(await client.query(`SELECT acquisition_request FROM usage_requests WHERE id=$1 AND status='reserved' AND platform='facebook'
      AND tenant_id=$2 AND consumer_id=$3 AND api_key_id=$4 AND fingerprint=$5 FOR UPDATE`,
    [delivery.usageRequestId,delivery.tenantId,delivery.consumerId,delivery.apiKeyId,delivery.fingerprint])).rows[0]
    if (!usage || !bodyMatches(usage.acquisition_request,input)) throw fail()
    const representative=await validateSources(client)
    await client.query(`UPDATE usage_requests SET status='committed',response_status=200,response_body=$2,units_actual=$3,
      upstream_latency_ms=$4,delivery_source_mode=$5,response_captured_at=$6,completed_at=now(),
      acquisition_request=acquisition_request || jsonb_build_object('facebookFill',$7::jsonb) WHERE id=$1`,
    [delivery.usageRequestId,responseBody,Math.max(1,usageUnitsActual),latencyMs,sourceMode==='stored_fallback'?'stale':'live',capturedAt,JSON.stringify(manifest)])
    await client.query(`INSERT INTO external_platform.gateway_requests
      (id,provider_key,tenant_id,consumer_id,usage_request_id,request_fingerprint,source_mode,succeeded,response_status,provider_call_id,snapshot_id,error_code)
      VALUES ($1,$2,$3,$4,$5,$6,$7,true,200,$8,NULL,NULL)`,
    [randomUUID(),representative.providerKey,delivery.tenantId,delivery.consumerId,delivery.usageRequestId,delivery.fingerprint,sourceMode,representative.callId])
    committing=true
    await client.query('COMMIT')
  } catch(error) {
    if (committing) releaseError=error
    else await client.query('ROLLBACK').catch(error=>{releaseError=error})
    throw error
  } finally { client.release(releaseError) }
}
