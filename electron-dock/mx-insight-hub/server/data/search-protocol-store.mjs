import { randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { requestFingerprint } from '../core/crypto.mjs'
import { DATA_SEARCH_V1_PATH, DATA_SEARCH_V2_PATH, dataSearchQueryHash } from '../contracts/data-search-v2.mjs'
import { assertTwitterProtocolRetryReference, twitterProtocolRetryMetadata, twitterV2BindingEvidence, twitterRetryUsage } from './twitter-v2-retry.mjs'
import { twitterProtocolRetryIntents, twitterRetryDenied } from '../external-platforms/twitter-manual-retry.mjs'
import { isDeepStrictEqual } from 'node:util'

const memory = new WeakMap()
const LEASE_MS = 300000
export const SEARCH_ADMISSION_POLICY_REVISION = 'known-query.v1'
// Match String.prototype.trim used by the actual public query normalizers.
// PostgreSQL btrim's default removes only ASCII spaces, allowing a historical
// newline/NBSP spelling of the same dispatched query to evade the v2 guard.
const QUERY_TRIM_CHARACTERS = ' \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
const conflict = () => new AppError(409, 'idempotency_conflict', 'Idempotency-Key belongs to a different search contract or request')
const blocked = (code, requestId) => new AppError(409, code, code === 'request_outcome_unknown'
  ? 'A search outcome is unresolved; changing API version, key, window or cursor cannot authorize another acquisition'
  : 'A search using the other protocol version is still running', { ...(requestId ? { requestId } : {}), automaticRetryAllowed: false })
// Only a new, unowned v2 page can be labelled safe to retry at admission.
// This never settles the blocker or permits changing this page's identity.
const admissionBlocked = (version, keyOwned, code, requestId) => version !== 2 || keyOwned
  ? blocked(code, requestId)
  : new AppError(409, 'search_admission_blocked',
    'This search was not admitted; retry only the same request and Idempotency-Key after the blocking request is resolved',
    { dispatchState: 'not_started', automaticRetryAllowed: true, retrySameRequest: true, retryAfterSeconds: 300,
      ...(requestId ? { blockingRequestId: requestId } : {}) })
const sameScope = (left, right) => ['tenantId', 'consumerId', 'apiKeyId', 'platform', 'queryHash'].every(key => left[key] === right[key])
const rowRecord = row => row && ({ consumerId: row.consumer_id, idempotencyKey: row.idempotency_key, tenantId: row.tenant_id,
  apiKeyId: row.api_key_id, platform: row.platform, queryHash: row.query_hash, fingerprint: row.fingerprint,
  body: row.request_body, state: row.state, ownerId: row.owner_id, leaseExpiresAt: row.lease_expires_at,
  result: row.result, error: row.error, usageRequestId: row.usage_request_id,
  acknowledgedRequestIds: row.acknowledged_request_ids || [] })

function memoryState(store) {
  if (!memory.has(store)) memory.set(store, { bindings: new Map(), leases: new Map(), tail: Promise.resolve() })
  return memory.get(store)
}
async function serialized(store, action) {
  const state = memoryState(store), previous = state.tail
  let unlock
  state.tail = new Promise(resolve => { unlock = resolve })
  await previous
  try { return await action(state) } finally { unlock() }
}

function existingBinding(binding, input) {
  if (!binding) return null
  if (input.version === 1 || binding.fingerprint !== input.fingerprint || binding.apiKeyId !== input.apiKeyId
    || binding.tenantId !== input.tenantId) throw conflict()
  if (binding.state === 'complete') return { kind: 'replay', result: structuredClone(binding.result) }
  if (binding.state === 'failed') return { kind: 'failure', error: binding.error }
  if (binding.state === 'unknown' || binding.state === 'running' && Date.parse(binding.leaseExpiresAt) <= Date.now()) {
    throw blocked('request_outcome_unknown', binding.usageRequestId)
  }
  if (binding.state === 'running') throw blocked('request_in_progress', binding.usageRequestId)
  return null
}

export class SearchProtocolStore {
  constructor(usageStore) { this.usage = usageStore; this.pool = usageStore.pool }

  async begin(context, { version, body, idempotencyKey, retryOfRequestId = null, retryStore = null, apiKeyPepper = null }) {
    if (retryOfRequestId != null && (version !== 2 || body.platform !== 'twitter'
      || typeof retryOfRequestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(retryOfRequestId))) {
      throw new AppError(400, 'invalid_uncertain_retry', 'Explicit v2 retry requires a Twitter request UUID')
    }
    const input = { version, body, idempotencyKey, ownerId: randomUUID(), tenantId: context.tenant.id,
      consumerId: context.consumer.id, apiKeyId: context.apiKey.id, platform: body.platform,
      queryHash: dataSearchQueryHash(body.query), leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
      fingerprint: requestFingerprint({ method: 'POST', path: DATA_SEARCH_V2_PATH, body }), retryOfRequestId }
    if (!this.pool) return serialized(this.usage, async state => {
      const key = `${input.consumerId}:${idempotencyKey}`, binding = state.bindings.get(key)
      await assertTwitterProtocolRetryReference({usage:this.usage,input,binding})
      const existing = existingBinding(binding, input)
      if (existing) return existing
      const original = await this.usage.getUsageRequestByIdempotencyKey(input.consumerId, idempotencyKey)
      if (version === 1 && original && (['unknown', 'reserved'].includes(original.status)
        || original.status === 'committed' && body.type === 'stable')) return { kind: 'legacy' }
      const keyLease = [...state.leases.values()].find(lease => lease.consumerId === input.consumerId
        && lease.idempotencyKey === idempotencyKey && (version === 2 || lease.version === 2))
      if (keyLease) throw blocked(Date.parse(keyLease.leaseExpiresAt) <= Date.now() ? 'request_outcome_unknown' : 'request_in_progress')
      const keyOwned = Boolean(binding || original || this.usage.requestsByScope?.has(key)
        || [...this.usage.requests.values()].some(row => row.consumerId === input.consumerId && row.idempotencyKey === idempotencyKey))
      if (version === 2 && !binding && keyOwned) throw conflict()
      const retry = version === 2 ? await twitterProtocolRetryMetadata({usage:this.usage,data:state,input,retryStore,apiKeyPepper})
        : {acknowledgedRequestIds:[],claim:async()=>{}}
      const excluded = retry.acknowledgedRequestIds
      const unknown = [...state.bindings.values()].find(row => sameScope(row, input) &&
        !excluded.includes(row.usageRequestId) && (row.state === 'unknown' || row.state === 'running' && Date.parse(row.leaseExpiresAt) <= Date.now()))
      if (unknown) throw admissionBlocked(version, keyOwned, 'request_outcome_unknown', unknown.usageRequestId)
      if (version === 2) {
        // A legacy receipt can block this query only when its saved identity
        // establishes the same standard search. Missing snapshots do not turn
        // one unresolved request into a platform-wide ban; its own key remains
        // protected above and no historical outcome is changed here.
        const usages = [...this.usage.requests.values()].filter(row => row.tenantId === input.tenantId && row.consumerId === input.consumerId
          && row.apiKeyId === input.apiKeyId && row.platform === input.platform
          && row.acquisitionRequest?.path === DATA_SEARCH_V1_PATH
          && typeof row.acquisitionRequest?.body?.query === 'string' && row.acquisitionRequest.body.query.trim()
          && row.acquisitionRequest.body.query.trim() === body.query.trim() && !excluded.includes(row.id))
        const unresolved = usages.find(row => row.status === 'unknown') || usages.find(row => row.status === 'reserved')
        if (unresolved) throw admissionBlocked(version, keyOwned, unresolved.status === 'unknown' ? 'request_outcome_unknown' : 'request_in_progress', unresolved.id)
      }
      const other = [...state.leases.values()].find(lease => sameScope(lease, input) && (version === 2 || lease.version === 2))
      if (other) throw admissionBlocked(version, keyOwned, Date.parse(other.leaseExpiresAt) <= Date.now() ? 'request_outcome_unknown' : 'request_in_progress')
      await retry.claim()
      input.acknowledgedRequestIds = excluded
      state.leases.set(input.ownerId, input)
      if (version === 2) state.bindings.set(key, { ...input, state: 'running', result: null, error: null, usageRequestId: binding?.usageRequestId || null })
      return { kind: 'acquired', input, retryOfRequestId:retry.retryOfRequestId, acknowledgedRequestIds:excluded }
    })
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // Same-key and same-query guards are separate: two versions must not race
      // the same key with different queries before the original usage reserve.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`search-protocol-key:${input.consumerId}:${idempotencyKey}`])
      const binding = rowRecord((await client.query('SELECT * FROM control.data_search_protocol_bindings WHERE consumer_id=$1 AND idempotency_key=$2 FOR UPDATE',
        [input.consumerId, idempotencyKey])).rows[0])
      await assertTwitterProtocolRetryReference({usage:this.usage,client,input,binding})
      const existing = existingBinding(binding, input)
      if (existing) { await client.query('COMMIT'); return existing }
      const original = (await client.query(`SELECT request.status FROM usage_idempotency_bindings binding
        JOIN usage_requests request ON request.id=binding.current_request_id WHERE binding.consumer_id=$1 AND binding.idempotency_key=$2`,
      [input.consumerId, idempotencyKey])).rows[0]
      if (version === 1 && original && (['unknown', 'reserved'].includes(original.status)
        || original.status === 'committed' && body.type === 'stable')) { await client.query('COMMIT'); return { kind: 'legacy' } }
      const keyLease = (await client.query(`SELECT expires_at FROM control.data_search_protocol_leases
        WHERE consumer_id=$1 AND idempotency_key=$2 AND ($3::int=2 OR version=2) LIMIT 1`,
      [input.consumerId, idempotencyKey, version])).rows[0]
      if (keyLease) throw blocked(Date.parse(keyLease.expires_at) <= Date.now() ? 'request_outcome_unknown' : 'request_in_progress')
      const args = [input.tenantId, input.consumerId, input.apiKeyId, input.platform, input.queryHash]
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`search-protocol-query:${args.join(':')}`])
      // Old rows can lack a current idempotency binding (and vice versa).
      // Key ownership remains protected even when no other query blocks entry.
      const keyOwned = Boolean(binding || original || version === 2 && (await client.query(`SELECT
        EXISTS(SELECT 1 FROM usage_requests WHERE consumer_id=$1 AND idempotency_key=$2)
        OR EXISTS(SELECT 1 FROM usage_idempotency_bindings WHERE consumer_id=$1 AND idempotency_key=$2) AS owned`,
      [input.consumerId, idempotencyKey])).rows[0]?.owned !== false)
      if (version === 2 && !binding && keyOwned) throw conflict()
      const retry = version === 2 ? await twitterProtocolRetryMetadata({usage:this.usage,client,input,retryStore,apiKeyPepper})
        : {acknowledgedRequestIds:[],claim:async()=>{}}
      const excluded = retry.acknowledgedRequestIds
      const otherRequestBlocked = (code, requestId) => admissionBlocked(version, keyOwned, code, requestId)
      const unknown = (await client.query(`SELECT usage_request_id FROM control.data_search_protocol_bindings
        WHERE tenant_id=$1 AND consumer_id=$2 AND api_key_id=$3 AND platform=$4 AND query_hash=$5
        AND NOT (coalesce(usage_request_id,'00000000-0000-0000-0000-000000000000'::uuid)=ANY($6::uuid[]))
        AND (state='unknown' OR (state='running' AND lease_expires_at<=now())) LIMIT 1`, [...args,excluded])).rows[0]
      if (unknown) throw await otherRequestBlocked('request_outcome_unknown', unknown.usage_request_id)
      if (version === 2) {
        const unresolved = (await client.query(`SELECT request.id,request.status FROM usage_requests request
          WHERE request.tenant_id=$1 AND request.consumer_id=$2 AND request.api_key_id=$3 AND request.platform=$4
          AND request.acquisition_request->>'path'=$5
          AND jsonb_typeof(request.acquisition_request->'body'->'query')='string'
          AND btrim(request.acquisition_request->'body'->>'query',$7)<>''
          AND btrim(request.acquisition_request->'body'->>'query',$7)=$6
          AND NOT (request.id=ANY($8::uuid[]))
          AND request.status IN ('unknown','reserved') ORDER BY CASE WHEN request.status='unknown' THEN 0 ELSE 1 END LIMIT 1`,
        [...args.slice(0, 4), DATA_SEARCH_V1_PATH, body.query.trim(), QUERY_TRIM_CHARACTERS,excluded])).rows[0]
        if (unresolved) throw await otherRequestBlocked(unresolved.status === 'unknown' ? 'request_outcome_unknown' : 'request_in_progress', unresolved.id)
      }
      const other = (await client.query(`SELECT expires_at FROM control.data_search_protocol_leases WHERE tenant_id=$1 AND consumer_id=$2 AND api_key_id=$3
        AND platform=$4 AND query_hash=$5 AND ($6::int=2 OR version=2) LIMIT 1`, [...args, version])).rows[0]
      if (other) throw await otherRequestBlocked(Date.parse(other.expires_at) <= Date.now() ? 'request_outcome_unknown' : 'request_in_progress')
      await retry.claim()
      input.acknowledgedRequestIds = excluded
      await client.query(`INSERT INTO control.data_search_protocol_leases(owner_id,tenant_id,consumer_id,api_key_id,platform,query_hash,idempotency_key,version,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [input.ownerId, ...args, idempotencyKey, version, input.leaseExpiresAt])
      if (version === 2) await client.query(`INSERT INTO control.data_search_protocol_bindings
        (consumer_id,idempotency_key,tenant_id,api_key_id,platform,query_hash,fingerprint,request_body,state,owner_id,lease_expires_at${excluded.length?',acknowledged_request_ids':''})
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,$10${excluded.length?',$11':''})
        ON CONFLICT(consumer_id,idempotency_key) DO UPDATE SET state='running',owner_id=EXCLUDED.owner_id,
          lease_expires_at=EXCLUDED.lease_expires_at,updated_at=now()${excluded.length?',acknowledged_request_ids=EXCLUDED.acknowledged_request_ids':''} WHERE data_search_protocol_bindings.state='retryable'`,
      [input.consumerId, idempotencyKey, input.tenantId, input.apiKeyId, input.platform, input.queryHash, input.fingerprint,
        JSON.stringify(body), input.ownerId, input.leaseExpiresAt,...(excluded.length?[excluded]:[])])
      await client.query('COMMIT')
      return { kind: 'acquired', input, retryOfRequestId:retry.retryOfRequestId, acknowledgedRequestIds:excluded }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      // A binary installed before its additive migration cannot serve v2. An
      // absent table contains no v2 state, so unrelated v1 traffic stays usable.
      if (version === 1 && error.code === '42P01') return { kind: 'legacy' }
      throw error
    } finally { client.release() }
  }

  async finish(input, { state, result = null, error = null, usageRequestId = null } = {}) {
    if (!this.pool) return serialized(this.usage, data => {
      if (input.version === 2) {
        const binding = data.bindings.get(`${input.consumerId}:${input.idempotencyKey}`)
        if (!binding || binding.ownerId !== input.ownerId || binding.state !== 'running') throw new Error('search_protocol_owner_changed')
        Object.assign(binding, { state, result: structuredClone(result), error: structuredClone(error), usageRequestId })
      }
      data.leases.delete(input.ownerId)
    })
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      if (input.version === 2) {
        const rows = (await client.query(`UPDATE control.data_search_protocol_bindings SET state=$4,result=$5,error=$6,usage_request_id=$7,updated_at=now()
          WHERE consumer_id=$1 AND idempotency_key=$2 AND owner_id=$3 AND state='running' RETURNING consumer_id`,
        [input.consumerId, input.idempotencyKey, input.ownerId, state, result && JSON.stringify(result), error && JSON.stringify(error), usageRequestId])).rows
        if (rows.length !== 1) throw new Error('search_protocol_owner_changed')
      }
      await client.query('DELETE FROM control.data_search_protocol_leases WHERE owner_id=$1', [input.ownerId])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }

  async binding(context, idempotencyKey) {
    if (!this.pool) {
      const record = memoryState(this.usage).bindings.get(`${context.consumer.id}:${idempotencyKey}`)
      return record?.tenantId === context.tenant.id && record.apiKeyId === context.apiKey.id ? structuredClone(record) : null
    }
    try { return rowRecord((await this.pool.query(`SELECT * FROM control.data_search_protocol_bindings
      WHERE consumer_id=$1 AND idempotency_key=$2 AND tenant_id=$3 AND api_key_id=$4`,
    [context.consumer.id, idempotencyKey, context.tenant.id, context.apiKey.id])).rows[0]) }
    catch (error) { if (error.code === '42P01') return null; throw error }
  }

  async bindingForUsage(context, requestId) {
    if (!this.pool) {
      const usage = this.usage.requests.get(requestId)
      return structuredClone([...memoryState(this.usage).bindings.values()].find(record => record.consumerId === context.consumer.id
        && record.tenantId === context.tenant.id && record.apiKeyId === context.apiKey.id
        && (record.usageRequestId === requestId || usage?.consumerId === context.consumer.id && usage.apiKeyId === context.apiKey.id
          && record.idempotencyKey === usage.idempotencyKey)) || null)
    }
    try { return rowRecord((await this.pool.query(`SELECT binding.* FROM control.data_search_protocol_bindings binding
      LEFT JOIN usage_requests usage ON usage.id=$2 AND usage.consumer_id=$1 AND usage.tenant_id=$3 AND usage.api_key_id=$4
      WHERE binding.consumer_id=$1 AND binding.tenant_id=$3 AND binding.api_key_id=$4
      AND (binding.usage_request_id=$2 OR binding.idempotency_key=usage.idempotency_key)`,
    [context.consumer.id, requestId, context.tenant.id, context.apiKey.id])).rows[0]) }
    catch (error) { if (error.code === '42P01') return null; throw error }
  }

  async twitterRecovery(context, requestId, {apiKeyPepper} = {}) {
    const read = async client => {
      const scopedUsage = async id => {
        const row = this.pool ? (await client.query(`SELECT * FROM usage_requests WHERE id=$1 AND tenant_id=$2
          AND consumer_id=$3 AND api_key_id=$4 AND platform='twitter'`,
        [id,context.tenant.id,context.consumer.id,context.apiKey.id])).rows[0] : this.usage.requests.get(id)
        const usage = twitterRetryUsage(row)
        return usage && usage.tenantId === context.tenant.id && usage.consumerId === context.consumer.id
          && usage.apiKeyId === context.apiKey.id && usage.platform === 'twitter' ? usage : null
      }
      const bindingByUsage = async id => this.pool ? (await client.query(`SELECT * FROM control.data_search_protocol_bindings
        WHERE usage_request_id=$1 AND tenant_id=$2 AND consumer_id=$3 AND api_key_id=$4`,
      [id,context.tenant.id,context.consumer.id,context.apiKey.id])).rows.map(rowRecord)
        : [...memoryState(this.usage).bindings.values()].filter(row => row.usageRequestId === id
          && row.tenantId === context.tenant.id && row.consumerId === context.consumer.id && row.apiKeyId === context.apiKey.id)
      const root = await scopedUsage(requestId)
      if (!root) throw new AppError(404, 'request_not_found', 'Request was not found')
      const roots = await bindingByUsage(requestId)
      if (roots.length !== 1) throw twitterRetryDenied()
      const original = roots[0]
      const evidence = twitterV2BindingEvidence(root, original, {apiKeyPepper,requireUnknown:false})
      const stateOf = binding => binding.state === 'running' && Date.parse(binding.leaseExpiresAt) <= Date.now() ? 'unknown' : binding.state
      const deliveryOf = (usage, binding) => {
        if (binding.state !== 'complete') return null
        const result = binding.result
        if (usage.status !== 'committed' || result?.status !== 200 || result.requestId !== usage.id
          || result.body?.requestId && result.body.requestId !== usage.id
          || result.body?.data?.contractVersion !== 'mx-insight-hub.data-search.v2'
          || result.body.data.platform !== 'twitter' || result.body.data.query !== evidence.body.query
          || !Array.isArray(result.body.data.items) || typeof result.body.data.pageInfo?.hasMore !== 'boolean'
          || !isDeepStrictEqual(result.body.data.meta?.requestedWindow, evidence.body.timeWindow)) throw twitterRetryDenied()
        return {requestId:usage.id,status:200,body:structuredClone(result.body)}
      }
      let current = root, binding = original, successor = null, delivery = deliveryOf(root,original)
      const visited = new Set([requestId])
      for (let depth=0; !delivery && depth<32; depth++) {
        const intent = this.pool ? (await client.query('SELECT * FROM control.data_search_protocol_retries WHERE original_usage_request_id=$1', [current.id])).rows[0]
          : twitterProtocolRetryIntents(this.usage).get(current.id)
        if (!intent) break
        if (intent.tenant_id !== context.tenant.id || intent.consumer_id !== context.consumer.id || intent.api_key_id !== context.apiKey.id
          || intent.request_fingerprint !== original.fingerprint || current.status !== 'unknown' || binding.state !== 'unknown') throw twitterRetryDenied()
        binding = this.pool ? rowRecord((await client.query(`SELECT * FROM control.data_search_protocol_bindings
          WHERE consumer_id=$1 AND idempotency_key=$2`, [context.consumer.id,intent.successor_idempotency_key])).rows[0])
          : memoryState(this.usage).bindings.get(`${context.consumer.id}:${intent.successor_idempotency_key}`)
        if (!binding || binding.tenantId !== context.tenant.id || binding.apiKeyId !== context.apiKey.id
          || binding.fingerprint !== original.fingerprint || !isDeepStrictEqual(binding.body,evidence.body)) throw twitterRetryDenied()
        successor = {requestId:binding.usageRequestId || null,idempotencyKey:binding.idempotencyKey,state:stateOf(binding)}
        if (!binding.usageRequestId) break
        if (visited.has(binding.usageRequestId)) throw twitterRetryDenied()
        visited.add(binding.usageRequestId)
        current = await scopedUsage(binding.usageRequestId)
        twitterV2BindingEvidence(current,binding,{apiKeyPepper,requireUnknown:false})
        delivery = deliveryOf(current,binding)
      }
      return {contractVersion:'mx-insight-hub.data-search-recovery.v1',originalRequestId:requestId,platform:'twitter',
        request:{method:'POST',path:DATA_SEARCH_V2_PATH,body:evidence.body},state:stateOf(original),successor,delivery}
    }
    if (!this.pool) return serialized(this.usage,()=>read(null))
    const client = await this.pool.connect()
    let releaseError = null
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await client.query("SET LOCAL statement_timeout = '5s'")
      const result = await read(client)
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK').catch(error=>{releaseError=error});throw error }
    finally {client.release(releaseError)}
  }
}
