import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { isPostgresSafeJsonValue } from '../core/postgres-json.mjs'
import { YOUTUBE_COMMENTS_VERSION, YOUTUBE_COMMENT_PATHS } from '../contracts/youtube-comments.mjs'

export const SOCIAL_SEARCH_STATE_VERSION = 'mx-insight-hub.social-compat.v1'

const clone = value => structuredClone(value)
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
const age = value => value != null && Number.isFinite(Date.parse(value)) && Date.now() - Date.parse(value) >= 0 && Date.now() - Date.parse(value) <= 86400000
const fail = () => new AppError(409, 'search_page_unavailable', 'The saved social-account traversal cannot be continued; restart explicitly')
const paths = new Set(['/api/v1/data/social/crawl', '/api/v1/data/social/user-info'])
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0')
const identityValid = (value, allowedPaths = paths) => value && ['tenantId', 'consumerId', 'apiKeyId'].every(key => uuid(value[key])) && allowedPaths.has(value.path)
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const expectedValid = value => object(value) && ['tikhub', 'rapidapi', 'justone'].includes(value.provider)
  && ['operation', 'endpointKey', 'endpointVersion', 'contractVersion'].every(key => id(value[key]))
const businessCode = provider => provider === 'tikhub' ? 200 : provider === 'justone' ? 0 : null
const jobValid = job => job && typeof job === 'object' && !Array.isArray(job)
  && typeof job.query === 'string' && job.query.trim() && job.query.length <= 2048 && !job.query.includes('\0')
  && Number.isInteger(job.providerPage) && job.providerPage >= 1 && job.providerPage <= 16
  && Number.isInteger(job.upstreamPages) && job.upstreamPages >= 0 && job.upstreamPages <= 15
  && typeof job.started === 'boolean' && typeof job.done === 'boolean'
  && (job.dispatchedTokens == null || Array.isArray(job.dispatchedTokens)
    && job.dispatchedTokens.length <= 18 && job.dispatchedTokens.every(sha))
  && (job.resolvedIdentity == null || object(job.resolvedIdentity))
  && (job.profiles == null || Array.isArray(job.profiles) && job.profiles.length <= 1000 && job.profiles.every(object))
  && (job.providerCursor == null || typeof job.providerCursor === 'object' && !Array.isArray(job.providerCursor))
  && (job.buffer == null || typeof job.buffer === 'object' && !Array.isArray(job.buffer)
    && uuid(job.buffer.callId) && sha(job.buffer.hash) && sha(job.buffer.projectionHash)
    && expectedValid(job.buffer.expected) && Number.isSafeInteger(job.buffer.offset) && job.buffer.offset >= 0
    && Number.isInteger(job.buffer.providerPage) && job.buffer.providerPage >= 1 && job.buffer.providerPage <= 15
    && (job.buffer.providerCursor == null || typeof job.buffer.providerCursor === 'object' && !Array.isArray(job.buffer.providerCursor)))
const scopeMatches = (row, input, platform) => row && row.platform === platform && row.tenantId === input.tenantId
  && row.consumerId === input.consumerId && row.apiKeyId === input.apiKeyId && row.acquisitionRequest?.path === input.path

function verifiedArchive(archive, provider) {
  const bytes = archive?.bodyBytes
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(archive.bodySize) || archive.bodySize !== bytes.length
    || !bytes.length || bytes.length > 8388608 || !sha(archive.bodySha256)
    || createHash('sha256').update(bytes).digest('hex') !== archive.bodySha256 || !age(archive.capturedAt)) return null
  try {
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, ''))
    if (!object(payload) || !isPostgresSafeJsonValue(payload)) return null
    if (provider !== 'rapidapi' && (payload.code !== businessCode(provider) || !Object.hasOwn(payload, 'data'))) return null
    if (provider === 'rapidapi' && ((Array.isArray(payload.errors) && payload.errors.length)
      || (Array.isArray(payload.data?.errors) && payload.data.errors.length))) return null
    return { payload, bodySize: bytes.length, bodySha256: archive.bodySha256, capturedAt: new Date(archive.capturedAt).toISOString() }
  } catch { return null }
}

async function transaction(pool, work) {
  const client = await pool.connect()
  let committing = false, releaseError
  try {
    await client.query('BEGIN')
    const result = await work(client)
    committing = true
    await client.query('COMMIT')
    return result
  } catch (error) {
    if (committing) releaseError = error
    else await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release(releaseError) }
}

// Separate from supplier-specific stores: the native operation remains the
// procurement identity, while this manifest owns one public search delivery.
export class SocialSearchStateStore {
  constructor(platformStores, { platform, workflowKind = 'social-account' }) {
    if (!['social-account', 'youtube-comments'].includes(workflowKind) || workflowKind === 'youtube-comments' && platform !== 'youtube') throw new TypeError('Unknown traversal kind')
    this.paths = workflowKind === 'youtube-comments' ? new Set(Object.values(YOUTUBE_COMMENT_PATHS)) : paths
    this.version = workflowKind === 'youtube-comments' ? YOUTUBE_COMMENTS_VERSION : SOCIAL_SEARCH_STATE_VERSION
    this.stores = platformStores instanceof Map ? Object.fromEntries(platformStores) : { ...platformStores }
    const entries = Object.entries(this.stores)
    if (!entries.length || !id(platform) || entries.some(([provider, store]) =>
      !['tikhub', 'rapidapi', 'justone'].includes(provider) || store?.providerKey !== provider)) {
      throw new TypeError('Social account provider stores required')
    }
    this.store = entries[0][1]
    this.usage = this.store.usageStore
    this.pool = this.store.pool
    if (entries.some(([, store]) => store.pool !== this.pool || store.usageStore !== this.usage)) {
      throw new TypeError('Social account provider stores must share usage and database state')
    }
    this.platform = platform
  }

  async readUsage(id, input, client = this.pool, lock = false) {
    if (!this.pool) return this.usage.requests.get(id)
    const row = (await client.query(`SELECT id,tenant_id,consumer_id,api_key_id,platform,status,response_status,
      fingerprint,acquisition_request FROM usage_requests WHERE id=$1 AND tenant_id=$2 AND consumer_id=$3 AND api_key_id=$4
      ${lock ? 'FOR UPDATE' : ''}`, [id, input.tenantId, input.consumerId, input.apiKeyId])).rows[0]
    return row ? { id: row.id, tenantId: row.tenant_id, consumerId: row.consumer_id, apiKeyId: row.api_key_id,
      platform: row.platform, status: row.status, responseStatus: row.response_status,
      fingerprint: row.fingerprint, acquisitionRequest: row.acquisition_request } : null
  }

  async historyFor(input) {
    if (!identityValid(input, this.paths) || !sha(input.scopeHash) || !Number.isInteger(input.jobCount) || input.jobCount < 1 || input.jobCount > 50
      || !Number.isInteger(input.totalLimit) || input.totalLimit < 1 || input.totalLimit > 1000) throw fail()
    const seenIds = Array.from({ length: input.jobCount }, () => new Set()), visited = new Set()
    let current = input.previousDeliveryId, state = null
    while (current != null) {
      if (!uuid(current) || visited.has(current) || visited.size >= 15) throw fail()
      visited.add(current)
      const row = await this.readUsage(current, input)
      const manifest = row?.acquisitionRequest?.socialSearch
      if (!scopeMatches(row, input, this.platform) || row.status !== 'committed' || row.responseStatus !== 200
        || manifest?.version !== this.version || manifest.scopeHash !== input.scopeHash
        || !Array.isArray(manifest.deliveredIds) || manifest.deliveredIds.length !== input.jobCount
        || !Array.isArray(manifest.state?.jobs) || manifest.state.jobs.length !== input.jobCount
        || !manifest.state.jobs.every(jobValid)
        || !age(manifest.capturedAt) || !isPostgresSafeJsonValue(manifest)) throw fail()
      let delivered = 0
      manifest.deliveredIds.forEach((values, index) => {
        if (!Array.isArray(values) || values.some(value => !id(value))) throw fail()
        delivered += values.length
        values.forEach(value => seenIds[index].add(value))
      })
      if (delivered > input.totalLimit || seenIds.reduce((sum, set) => sum + set.size, 0) > input.totalLimit * 15) throw fail()
      if (!state) state = clone(manifest.state)
      current = manifest.previousDeliveryId ?? null
    }
    return { state, seenIds, previousDeliveryId: input.previousDeliveryId ?? null }
  }

  async pageFor(input, client = this.pool, lock = false) {
    if (!identityValid(input, this.paths) || !uuid(input.callId) || !sha(input.scopeHash) || !expectedValid(input.expected)) return null
    const { expected } = input, providerStore = this.stores[expected.provider]
    if (!providerStore) return null
    let call, usage, archive
    if (!this.pool) {
      call = providerStore.calls.get(input.callId)
      usage = this.usage.requests.get(call?.usageRequestId)
      archive = providerStore.restrictedResponseArchives.get(input.callId)
    } else {
      const row = (await client.query(`SELECT call.*,request.status AS usage_status,request.response_status,
        request.platform,request.acquisition_request,raw.body_bytes,raw.body_size,raw.body_sha256,raw.captured_at
        FROM external_platform.provider_calls call JOIN usage_requests request ON request.id=call.usage_request_id
        JOIN control.external_platform_restricted_raw_responses raw ON raw.provider_call_id=call.id
        WHERE call.id=$1 AND call.tenant_id=$2 AND call.consumer_id=$3 AND call.api_key_id=$4
          AND request.tenant_id=$2 AND request.consumer_id=$3 AND request.api_key_id=$4
        ${lock ? 'FOR SHARE OF call,request,raw' : ''}`, [input.callId, input.tenantId, input.consumerId, input.apiKeyId])).rows[0]
      if (!row) return null
      call = { providerKey: row.provider_key, operation: row.operation, endpointKey: row.endpoint_key,
        endpointVersion: row.endpoint_version, contractVersion: row.contract_version, outcome: row.outcome,
        httpStatus: row.http_status, businessCode: row.business_code, completedAt: row.completed_at,
        tenantId: row.tenant_id, consumerId: row.consumer_id, apiKeyId: row.api_key_id, usageRequestId: row.usage_request_id }
      usage = { id: row.usage_request_id, tenantId: row.tenant_id, consumerId: row.consumer_id, apiKeyId: row.api_key_id,
        status: row.usage_status, responseStatus: row.response_status, platform: row.platform, acquisitionRequest: row.acquisition_request }
      archive = { bodyBytes: row.body_bytes, bodySize: Number(row.body_size), bodySha256: row.body_sha256, capturedAt: row.captured_at }
    }
    if (!call || call.providerKey !== expected.provider || call.operation !== expected.operation || call.endpointKey !== expected.endpointKey
      || call.endpointVersion !== expected.endpointVersion || call.contractVersion !== expected.contractVersion
      || call.outcome !== 'succeeded' || call.httpStatus !== 200 || call.businessCode !== businessCode(expected.provider) || !age(call.completedAt)
      || ['tenantId', 'consumerId', 'apiKeyId'].some(key => call[key] !== input[key]) || !scopeMatches(usage, input, this.platform)
      || !(usage.status === 'committed' && usage.responseStatus === 200
        || usage.id === input.ownUsageRequestId && usage.status === 'reserved')
      || usage.id !== input.ownUsageRequestId && (usage.acquisitionRequest?.socialSearch?.version !== this.version
        || usage.acquisitionRequest.socialSearch.scopeHash !== input.scopeHash
        || !age(usage.acquisitionRequest.socialSearch.capturedAt))) return null
    const page = verifiedArchive(archive, expected.provider)
    return page ? { ...page, sourceUsageRequestId: usage.id } : null
  }

  async unknownFor(delivery, path) {
    if (!uuid(delivery.usageRequestId) || !sha(delivery.fingerprint) || !identityValid({ ...delivery, path }, this.paths)) throw fail()
    if (!this.pool) return [...this.usage.requests.values()].some(row => scopeMatches(row, { ...delivery, path }, this.platform)
      && row.status === 'unknown' && row.fingerprint === delivery.fingerprint
      && Date.now() - Date.parse(row.reservedAt ?? row.createdAt ?? new Date().toISOString()) <= 86400000)
    return (await this.pool.query(`SELECT 1 FROM usage_requests WHERE tenant_id=$1 AND consumer_id=$2 AND api_key_id=$3
      AND platform=$4 AND fingerprint=$5 AND status='unknown' AND acquisition_request->>'path'=$6
      AND reserved_at>=now()-interval '24 hours' LIMIT 1`,
    [delivery.tenantId, delivery.consumerId, delivery.apiKeyId, this.platform, delivery.fingerprint, path])).rows.length > 0
  }

  async acquireDeliveryLease(input) {
    const operation = `social.search.${this.platform}`
    if (!uuid(input.consumerId) || !uuid(input.ownerRequestId) || !sha(input.fingerprint)
      || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now()) throw fail()
    if (!this.pool) {
      const key = `${input.consumerId}:${operation}:${input.fingerprint}`
      const previous = this.store.leases.get(key)
      if (previous && Date.parse(previous.expiresAt) > Date.now()) return false
      this.store.leases.set(key, { ownerRequestId: input.ownerRequestId, expiresAt: new Date(input.expiresAt).toISOString() })
      return true
    }
    const rows = (await this.pool.query(`INSERT INTO external_platform.dispatch_leases
      (consumer_id,operation,request_fingerprint,owner_request_id,expires_at) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT(consumer_id,operation,request_fingerprint) DO UPDATE SET owner_request_id=EXCLUDED.owner_request_id,
      expires_at=EXCLUDED.expires_at,created_at=now() WHERE external_platform.dispatch_leases.expires_at<=now()
      RETURNING owner_request_id`, [input.consumerId, operation, input.fingerprint, input.ownerRequestId, input.expiresAt])).rows
    return rows[0]?.owner_request_id === input.ownerRequestId
  }

  async releaseDeliveryLease(input) {
    const operation = `social.search.${this.platform}`
    if (this.pool) await this.pool.query(`DELETE FROM external_platform.dispatch_leases WHERE consumer_id=$1
      AND operation=$2 AND request_fingerprint=$3 AND owner_request_id=$4`,
    [input.consumerId, operation, input.fingerprint, input.ownerRequestId])
    else {
      const key = `${input.consumerId}:${operation}:${input.fingerprint}`
      if (this.store.leases.get(key)?.ownerRequestId === input.ownerRequestId) this.store.leases.delete(key)
    }
  }

  async commitDelivery(input) {
    const { delivery, responseBody, manifest, sources, capturedAt, sourceMode, usageUnitsActual, latencyMs = 0 } = input
    if (!identityValid(input, this.paths) || !sha(input.scopeHash) || !uuid(delivery?.usageRequestId) || !sha(delivery.fingerprint)
      || ['tenantId', 'consumerId', 'apiKeyId'].some(key => delivery[key] !== input[key])
      || manifest?.version !== this.version || manifest.scopeHash !== input.scopeHash
      || manifest.previousDeliveryId != null && !uuid(manifest.previousDeliveryId)
      || !Array.isArray(sources) || !sources.length || sources.length > 100
      || sources.some(source => !object(source) || !expectedValid(source.expected) || !this.stores[source.expected.provider]
        || !Number.isSafeInteger(source.bodySize) || source.bodySize < 1 || source.bodySize > 8388608)
      || sources.reduce((sum, source) => sum + source.bodySize, 0) > 12582912
      || new Set(sources.map(source => source.callId)).size !== sources.length
      || !Array.isArray(manifest.deliveredIds) || manifest.deliveredIds.some(values => !Array.isArray(values) || values.some(value => !id(value)))
      || !Array.isArray(manifest.state?.jobs) || !manifest.state.jobs.length || manifest.state.jobs.length > 50
      || manifest.state.jobs.length !== manifest.deliveredIds.length
      || !manifest.state.jobs.every(jobValid)
      || manifest.deliveredIds.reduce((sum, values) => sum + values.length, 0) > 1000
      || !Number.isSafeInteger(usageUnitsActual) || usageUnitsActual < 0 || usageUnitsActual > 1000
      || !age(capturedAt) || !['live', 'fresh_cache', 'stored_fallback'].includes(sourceMode)
      || !isPostgresSafeJsonValue(responseBody) || !isPostgresSafeJsonValue(manifest)
      || !isPostgresSafeJsonValue(sources)) throw fail()
    const work = async client => {
      const usage = await this.readUsage(delivery.usageRequestId, input, client, true)
      if (!scopeMatches(usage, input, this.platform) || usage.status !== 'reserved' || usage.fingerprint !== delivery.fingerprint) throw fail()
      for (const source of sources) {
        if (!uuid(source.callId) || !sha(source.rowsHash)) throw fail()
        const page = await this.pageFor({ ...input, callId: source.callId, ownUsageRequestId: delivery.usageRequestId, expected: source.expected }, client, true)
        if (!page || page.bodySha256 !== source.bodySha256 || page.bodySize !== source.bodySize || page.capturedAt !== source.capturedAt) throw fail()
      }
      const saved = { ...clone(manifest), capturedAt, sources: clone(sources) }
      const representative = [...sources].reverse().find(source => source.own) ?? sources[0]
      if (!this.pool) {
        await this.usage.commitRequest(delivery.usageRequestId, { responseStatus: 200, responseBody,
          unitsActual: Math.max(1, usageUnitsActual), upstreamLatencyMs: latencyMs,
          deliverySourceMode: sourceMode === 'stored_fallback' ? 'stale' : 'live', capturedAt })
        usage.acquisitionRequest = { ...usage.acquisitionRequest, socialSearch: saved }
        this.stores[representative.expected.provider].requests.push({ id: randomUUID(), ...delivery, providerKey: representative.expected.provider, sourceMode,
          succeeded: true, responseStatus: 200, providerCallId: representative.callId, createdAt: new Date().toISOString() })
      } else {
        await client.query(`UPDATE usage_requests SET status='committed',response_status=200,response_body=$2,
          units_actual=$3,upstream_latency_ms=$4,delivery_source_mode=$5,response_captured_at=$6,completed_at=now(),
          acquisition_request=acquisition_request || jsonb_build_object('socialSearch',$7::jsonb) WHERE id=$1`,
        [delivery.usageRequestId, responseBody, Math.max(1, usageUnitsActual), latencyMs,
          sourceMode === 'stored_fallback' ? 'stale' : 'live', capturedAt, JSON.stringify(saved)])
        await client.query(`INSERT INTO external_platform.gateway_requests
          (id,provider_key,tenant_id,consumer_id,usage_request_id,request_fingerprint,source_mode,succeeded,response_status,provider_call_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,true,200,$8)`,
        [randomUUID(), representative.expected.provider, delivery.tenantId, delivery.consumerId, delivery.usageRequestId, delivery.fingerprint, sourceMode, representative.callId])
      }
    }
    return this.pool ? transaction(this.pool, work) : work(null)
  }
}
