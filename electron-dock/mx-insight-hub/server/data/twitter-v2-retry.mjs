import { isDeepStrictEqual } from 'node:util'
import { AppError } from '../core/errors.mjs'
import { requestFingerprint } from '../core/crypto.mjs'
import { createDataSearchV2CursorCodec } from '../external-platforms/cursor.mjs'
import { normalizedTwitterRetryBody, twitterRetryDenied, twitterProtocolRetryIntents,
  validateTwitterManualRetry, twitterManualRetryOwnerFor } from '../external-platforms/twitter-manual-retry.mjs'
import { DATA_SEARCH_V1_PATH, DATA_SEARCH_V2_PATH, normalizeDataSearchV2, prepareDataSearchV2 } from '../contracts/data-search-v2.mjs'

export const twitterRetryUsage = row => row && ({
  id: row.id, tenantId: row.tenantId ?? row.tenant_id, consumerId: row.consumerId ?? row.consumer_id,
  apiKeyId: row.apiKeyId ?? row.api_key_id, platform: row.platform, status: row.status,
  fingerprint: row.fingerprint, idempotencyKey: row.idempotencyKey ?? row.idempotency_key,
  acquisitionRequest: row.acquisitionRequest ?? row.acquisition_request,
})

// Immutable v2 and underlying v1 evidence must agree before any retry can be
// offered. This never reconstructs a missing window from dates or current UI.
export function twitterV2BindingEvidence(rootValue, binding, { apiKeyPepper, requireUnknown = true, allowExpiredCursor = false } = {}) {
  const root = twitterRetryUsage(rootValue)
  const get = (camel, snake) => binding?.[camel] ?? binding?.[snake]
  if (!root || root.platform !== 'twitter' || !binding
    || (requireUnknown && (root.status !== 'unknown' || binding.state !== 'unknown'))
    || get('usageRequestId', 'usage_request_id') !== root.id
    || get('tenantId', 'tenant_id') !== root.tenantId || get('consumerId', 'consumer_id') !== root.consumerId
    || get('apiKeyId', 'api_key_id') !== root.apiKeyId || get('idempotencyKey', 'idempotency_key') !== root.idempotencyKey
    || binding.platform !== 'twitter') throw twitterRetryDenied()
  let body, prepared
  try {
    const saved = binding.body ?? binding.request_body
    body = normalizeDataSearchV2(saved)
    if (!isDeepStrictEqual(saved, body) || body.platform !== 'twitter'
      || requestFingerprint({ method: 'POST', path: DATA_SEARCH_V2_PATH, body }) !== binding.fingerprint) throw twitterRetryDenied()
    if (body.cursor && !apiKeyPepper) throw twitterRetryDenied()
    const codec = createDataSearchV2CursorCodec(apiKeyPepper || 'readonly-no-cursor', `${root.consumerId}:${root.apiKeyId}`)
    prepared = prepareDataSearchV2(body, codec, requireUnknown && !allowExpiredCursor ? Date.now() : 0)
    const inner = normalizedTwitterRetryBody(root.acquisitionRequest)
    if (!isDeepStrictEqual(inner, prepared.upstream)
      || requestFingerprint({ method: 'POST', path: DATA_SEARCH_V1_PATH, body: inner }) !== root.fingerprint) throw twitterRetryDenied()
  } catch { throw twitterRetryDenied() }
  return { body, binding, underlyingBody: prepared.upstream }
}

export async function twitterV2RetryPreparation(queryable, rootValue, options = {}) {
  const root = twitterRetryUsage(rootValue)
  const present = (await queryable.query("SELECT to_regclass('control.data_search_protocol_bindings') IS NOT NULL AS present")).rows[0]?.present
  if (!present) return null
  const bindings = (await queryable.query(`SELECT * FROM control.data_search_protocol_bindings
    WHERE usage_request_id=$1 OR (consumer_id=$2 AND idempotency_key=$3)`,
  [root.id, root.consumerId, root.idempotencyKey])).rows
  if (!bindings.length) return null
  if (bindings.length !== 1) throw twitterRetryDenied()
  let retryIntent = null
  const intentTable = (await queryable.query("SELECT to_regclass('control.data_search_protocol_retries') IS NOT NULL AS present")).rows[0]?.present
  if (!intentTable) throw new AppError(503, 'schema_unavailable', 'Twitter v2 retry schema is unavailable')
  if (intentTable) {
    const intent = (await queryable.query(`SELECT retry.*, binding.state, binding.usage_request_id, binding.lease_expires_at,
        own.status AS usage_status
      FROM control.data_search_protocol_retries retry
      LEFT JOIN control.data_search_protocol_bindings binding ON binding.consumer_id=retry.consumer_id
        AND binding.idempotency_key=retry.successor_idempotency_key AND binding.tenant_id=retry.tenant_id
        AND binding.api_key_id=retry.api_key_id AND binding.fingerprint=retry.request_fingerprint
      LEFT JOIN usage_requests own ON own.id=binding.usage_request_id
      WHERE retry.original_usage_request_id=$1`, [root.id])).rows[0]
    if (intent) {
      let resumeAllowed = false
      if (intent.state === 'retryable' && (!intent.usage_request_id || intent.usage_status === 'released')) {
        const proof = (await queryable.query(`SELECT /* twitter-v2-retry:resume-proof */
          NOT EXISTS (SELECT 1 FROM usage_requests own WHERE own.consumer_id=$1 AND own.idempotency_key=$2
            AND (own.tenant_id IS DISTINCT FROM $3 OR own.api_key_id IS DISTINCT FROM $4
              OR own.platform IS DISTINCT FROM 'twitter' OR own.status IS DISTINCT FROM 'released'))
          AND NOT EXISTS (SELECT 1 FROM external_platform.provider_calls call JOIN usage_requests own ON own.id=call.usage_request_id
            WHERE own.consumer_id=$1 AND own.idempotency_key=$2)
          AND NOT EXISTS (SELECT 1 FROM external_platform.twitter_manual_retries edge
            LEFT JOIN usage_requests own ON own.id=edge.successor_usage_request_id
            WHERE edge.original_usage_request_id=$5 OR (own.consumer_id=$1 AND own.idempotency_key=$2)) AS allowed`,
        [root.consumerId,intent.successor_idempotency_key,root.tenantId,root.apiKeyId,root.id])).rows[0]
        resumeAllowed = proof?.allowed === true
        if (resumeAllowed) {
          try {
            const live = twitterV2BindingEvidence(root,bindings[0],options)
            if (live.underlyingBody.cursor) {
              const {normalizeHubDataSearch} = await import('../contracts/hub-data-search.mjs')
              const {createDataSearchCursorCodec} = await import('../external-platforms/cursor.mjs')
              normalizeHubDataSearch(live.underlyingBody,
                createDataSearchCursorCodec(options.apiKeyPepper,`${root.consumerId}:${root.apiKeyId}`),'stable')
            }
          } catch { resumeAllowed = false }
        }
      }
      retryIntent = { idempotencyKey: intent.successor_idempotency_key, apiKeyId: intent.api_key_id,
      state: intent.state === 'running' && Date.parse(intent.lease_expires_at) <= Date.now() ? 'unknown' : intent.state || 'registered',
      requestId: intent.usage_request_id || null,usageStatus:intent.usage_request_id?intent.usage_status || null:null,resumeAllowed }
    }
  }
  const evidence = twitterV2BindingEvidence(root, bindings[0], { ...options, allowExpiredCursor: Boolean(retryIntent) })
  return { ...evidence, retryIntent }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const withoutCursor = body => { const { cursor: _, ...scope } = body; return scope }

export async function assertTwitterProtocolRetryReference({ usage, client, input, binding }) {
  if (!input.retryOfRequestId || !binding) return
  const intent = client ? (await client.query(`SELECT * FROM control.data_search_protocol_retries
    WHERE consumer_id=$1 AND successor_idempotency_key=$2`, [input.consumerId,input.idempotencyKey])).rows[0]
    : [...twitterProtocolRetryIntents(usage).values()].find(row => row.consumer_id === input.consumerId && row.successor_idempotency_key === input.idempotencyKey)
  if (!intent || intent.original_usage_request_id !== input.retryOfRequestId
    || intent.api_key_id !== input.apiKeyId || intent.tenant_id !== input.tenantId
    || intent.request_fingerprint !== input.fingerprint) throw twitterRetryDenied()
}

// Called under protocol key/query arbitration. Return a deferred intent write
// so an unrelated blocker cannot consume a new acknowledgement.
export async function twitterProtocolRetryMetadata({ usage, client, data, input, retryStore, apiKeyPepper }) {
  if (input.platform !== 'twitter' && !input.retryOfRequestId) {
    return {retryOfRequestId:null,acknowledgedRequestIds:[],claim:async()=>{}}
  }
  const intents = client ? null : twitterProtocolRetryIntents(usage)
  const schema = client ? (await client.query("SELECT to_regclass('control.data_search_protocol_retries') IS NOT NULL AS present")).rows[0]?.present : true
  const byKey = client && schema ? (await client.query(`SELECT * FROM control.data_search_protocol_retries
    WHERE consumer_id=$1 AND successor_idempotency_key=$2`, [input.consumerId, input.idempotencyKey])).rows[0]
    : !client ? [...intents.values()].find(row => row.consumer_id === input.consumerId && row.successor_idempotency_key === input.idempotencyKey) : null
  if (byKey && (byKey.tenant_id !== input.tenantId || byKey.api_key_id !== input.apiKeyId
    || byKey.request_fingerprint !== input.fingerprint || input.retryOfRequestId && input.retryOfRequestId !== byKey.original_usage_request_id)) throw twitterRetryDenied()
  const retryOfRequestId = input.retryOfRequestId || byKey?.original_usage_request_id || null
  if (!retryOfRequestId) {
    let acknowledgedRequestIds = []
    if (input.platform === 'twitter' && input.body.cursor) {
      const parents = client ? (await client.query(`SELECT * FROM control.data_search_protocol_bindings
        WHERE tenant_id=$1 AND consumer_id=$2 AND api_key_id=$3 AND platform='twitter' AND state='complete'
          AND result#>>'{body,data,pageInfo,nextCursor}'=$4 AND request_body-'cursor'=$5::jsonb`,
      [input.tenantId,input.consumerId,input.apiKeyId,input.body.cursor,JSON.stringify(withoutCursor(input.body))])).rows
        : [...data.bindings.values()].filter(row => row.tenantId === input.tenantId && row.consumerId === input.consumerId
          && row.apiKeyId === input.apiKeyId && row.platform === 'twitter' && row.state === 'complete'
          && row.result?.body?.data?.pageInfo?.nextCursor === input.body.cursor && isDeepStrictEqual(withoutCursor(row.body), withoutCursor(input.body)))
      if (parents.length > 1) throw twitterRetryDenied()
      acknowledgedRequestIds = parents[0]?.acknowledgedRequestIds ?? parents[0]?.acknowledged_request_ids ?? []
      if (!Array.isArray(acknowledgedRequestIds) || acknowledgedRequestIds.length > 32
        || acknowledgedRequestIds.some(id => !UUID.test(id))) throw twitterRetryDenied()
      if (acknowledgedRequestIds.length) {
        const parentId=parents[0].usageRequestId ?? parents[0].usage_request_id
        const parentUsage=client?(await client.query('SELECT * FROM usage_requests WHERE id=$1',[parentId])).rows[0]:usage.requests.get(parentId)
        if (twitterRetryUsage(parentUsage)?.status!=='committed') throw twitterRetryDenied()
        twitterV2BindingEvidence(parentUsage,parents[0],{apiKeyPepper,requireUnknown:false})
      }
    }
    return { retryOfRequestId: null, acknowledgedRequestIds, claim: async () => {} }
  }
  if (!schema || input.version !== 2 || input.platform !== 'twitter' || !UUID.test(retryOfRequestId)
    || !retryStore || retryStore.providerKey !== 'rapidapi') throw twitterRetryDenied()
  let source, binding
  if (client) {
    source = (await client.query(`SELECT * FROM usage_requests WHERE id=$1 AND tenant_id=$2
      AND consumer_id=$3 AND api_key_id=$4 AND platform='twitter' FOR UPDATE`,
    [retryOfRequestId,input.tenantId,input.consumerId,input.apiKeyId])).rows[0]
    if (!source) throw twitterRetryDenied()
    binding = (await client.query('SELECT * FROM control.data_search_protocol_bindings WHERE usage_request_id=$1', [retryOfRequestId])).rows
  } else {
    source = usage.requests.get(retryOfRequestId)
    if (!source || source.tenantId!==input.tenantId || source.consumerId!==input.consumerId || source.apiKeyId!==input.apiKeyId) throw twitterRetryDenied()
    binding = [...data.bindings.values()].filter(row => row.usageRequestId === retryOfRequestId)
  }
  if (binding.length !== 1) throw twitterRetryDenied()
  const evidence = twitterV2BindingEvidence(source, binding[0], { apiKeyPepper, allowExpiredCursor: Boolean(byKey) })
  if (!isDeepStrictEqual(evidence.body, input.body)) throw twitterRetryDenied()
  const root = twitterRetryUsage(source)
  if (root.tenantId !== input.tenantId || root.consumerId !== input.consumerId || root.apiKeyId !== input.apiKeyId
    || root.idempotencyKey === input.idempotencyKey) throw twitterRetryDenied()
  const own = client ? twitterRetryUsage((await client.query(`SELECT request.* FROM usage_idempotency_bindings binding
    JOIN usage_requests request ON request.id=binding.current_request_id
    WHERE binding.consumer_id=$1 AND binding.idempotency_key=$2`, [input.consumerId,input.idempotencyKey])).rows[0])
    : await usage.getUsageRequestByIdempotencyKey(input.consumerId, input.idempotencyKey)
  const retryInput = { retryOfRequestId, tenantId:input.tenantId,consumerId:input.consumerId,apiKeyId:input.apiKeyId,
    fingerprint:root.fingerprint,idempotencyKey:input.idempotencyKey,...(own ? {usageRequestId:own.id} : {}) }
  if (evidence.underlyingBody.cursor) {
    // The existing provider validator resolves and verifies the signed carry.
    const { normalizeHubDataSearch } = await import('../contracts/hub-data-search.mjs')
    const { createDataSearchCursorCodec } = await import('../external-platforms/cursor.mjs')
    const normalized = normalizeHubDataSearch(evidence.underlyingBody,
      createDataSearchCursorCodec(apiKeyPepper, `${input.consumerId}:${input.apiKeyId}`), 'stable')
    if (normalized.buffer) retryInput.bufferCallId = normalized.buffer.callId
  }
  const validated = await validateTwitterManualRetry(retryStore, retryInput, client || undefined)
  const inherited = binding[0].acknowledgedRequestIds ?? binding[0].acknowledged_request_ids ?? []
  if (!Array.isArray(inherited) || inherited.length > 32 || inherited.some(id=>!UUID.test(id))) throw twitterRetryDenied()
  for (const id of inherited) {
    const ancestor = client ? (await client.query('SELECT * FROM usage_requests WHERE id=$1',[id])).rows[0] : usage.requests.get(id)
    const ancestorBindings = client ? (await client.query('SELECT * FROM control.data_search_protocol_bindings WHERE usage_request_id=$1',[id])).rows
      : [...data.bindings.values()].filter(row=>row.usageRequestId===id)
    if (ancestorBindings.length!==1) throw twitterRetryDenied()
    const ancestorEvidence = twitterV2BindingEvidence(ancestor,ancestorBindings[0],{apiKeyPepper,allowExpiredCursor:true})
    const ownedAncestor=twitterRetryUsage(ancestor)
    if (ownedAncestor.tenantId!==input.tenantId || ownedAncestor.consumerId!==input.consumerId || ownedAncestor.apiKeyId!==input.apiKeyId
      || !isDeepStrictEqual(withoutCursor(ancestorEvidence.body),withoutCursor(input.body))) throw twitterRetryDenied()
  }
  const acknowledgedRequestIds=[...new Set([...validated.ancestorRequestIds,...inherited])]
  if (acknowledgedRequestIds.length>32) throw twitterRetryDenied()
  const owner = await twitterManualRetryOwnerFor(retryStore, retryOfRequestId, client || undefined)
  if (owner && owner !== own?.id) throw twitterRetryDenied()
  const previous = client ? (await client.query('SELECT * FROM control.data_search_protocol_retries WHERE original_usage_request_id=$1', [retryOfRequestId])).rows[0] : intents.get(retryOfRequestId)
  if (previous && (previous.consumer_id !== input.consumerId || previous.api_key_id !== input.apiKeyId
    || previous.successor_idempotency_key !== input.idempotencyKey || previous.request_fingerprint !== input.fingerprint)) throw twitterRetryDenied()
  const row = { original_usage_request_id:retryOfRequestId,tenant_id:input.tenantId,consumer_id:input.consumerId,
    api_key_id:input.apiKeyId,successor_idempotency_key:input.idempotencyKey,request_fingerprint:input.fingerprint }
  return { retryOfRequestId, acknowledgedRequestIds, claim: async () => {
    if (client) await client.query(`INSERT INTO control.data_search_protocol_retries
      (original_usage_request_id,tenant_id,consumer_id,api_key_id,successor_idempotency_key,request_fingerprint)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(original_usage_request_id) DO NOTHING`, Object.values(row))
    else intents.set(retryOfRequestId, previous || row)
  } }
}
