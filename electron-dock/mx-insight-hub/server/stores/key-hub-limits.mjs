import { AppError } from '../core/errors.mjs'
import { isHubRateLimitExempt, isInternalTraffic, isLcyHubLimitIdentity, isLcySupplierPriority } from '../core/internal-traffic-policy.mjs'

const contextFor = key => ({ apiKey: key, tenant: { id: key.tenantId }, consumer: { id: key.consumerId } })
const fromRow = row => row && ({
  id: row.id, tenantId: row.tenant_id, consumerId: row.consumer_id,
  accessProfile: row.access_profile, status: row.status, environment: row.environment,
  expiresAt: row.expires_at, tenantStatus: row.tenant_status, consumerStatus: row.consumer_status,
  hubRateLimitExempt: row.hub_rate_limit_exempt ?? null,
  hubRateLimitRevision: Number(row.hub_rate_limit_revision ?? 0),
  hubRateLimitUpdatedAt: row.hub_rate_limit_updated_at,
  hubSupplierAdmission: row.hub_supplier_admission === 'priority' ? 'priority' : 'bypass',
})
const SUPPLIER_ADMISSION = ['bypass', 'priority']

function assertSupported(key) {
  if (!key) throw new AppError(404, 'api_key_not_found', 'API key not found')
  if (!isLcyHubLimitIdentity(contextFor(key))) {
    throw new AppError(403, 'api_key_hub_limits_not_supported', 'This switch is restricted to the original LCY-delta Key identity')
  }
}

function assertAvailable(key) {
  if (key.status !== 'active' || key.environment !== 'live' || !key.expiresAt || new Date(key.expiresAt).getTime() <= Date.now()) {
    throw new AppError(409, 'api_key_unavailable', 'Key is expired, revoked or not live')
  }
  if (key.tenantStatus !== 'active' || key.consumerStatus !== 'active') {
    throw new AppError(403, 'identity_inactive', 'Tenant or consumer is inactive')
  }
}

function project(store, key) {
  const context = contextFor(key)
  const inherited = key.hubRateLimitExempt == null
  return {
    apiKeyId: key.id,
    policyVersion: 2,
    hubRateLimitExempt: key.hubRateLimitExempt ?? null,
    effectiveExempt: isHubRateLimitExempt(context),
    // Saved on its own; it only takes effect while the exemption is on.
    hubSupplierAdmission: key.hubSupplierAdmission === 'priority' ? 'priority' : 'bypass',
    effectiveSupplierPriority: isLcySupplierPriority(context),
    inheritedQuotaExempt: inherited && isInternalTraffic(store, context),
    source: inherited ? 'legacy' : 'explicit',
    revision: Number(key.hubRateLimitRevision ?? 0),
    updatedAt: key.hubRateLimitUpdatedAt ? new Date(key.hubRateLimitUpdatedAt).toISOString() : null,
  }
}

async function readKey(store, id, client = store.pool, lock = false) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) {
    throw new AppError(400, 'invalid_key_hub_limits', 'A valid API key ID is required')
  }
  if (!store.pool) {
    const key = store.apiKeys.get(id)
    return key && { ...key, tenantStatus: store.tenants.get(key.tenantId)?.status,
      consumerStatus: store.consumers.get(key.consumerId)?.status }
  }
  const { rows } = await client.query(`SELECT key.*, tenant.status AS tenant_status, consumer.status AS consumer_status
    FROM api_keys key JOIN tenants tenant ON tenant.id=key.tenant_id
    JOIN consumers consumer ON consumer.id=key.consumer_id AND consumer.tenant_id=key.tenant_id
    WHERE key.id=$1 ${lock ? 'FOR UPDATE OF key, tenant, consumer' : ''}`, [id])
  return fromRow(rows[0])
}

export async function readKeyHubLimits(store, id) {
  const key = await readKey(store, id)
  assertSupported(key)
  return project(store, key)
}

export async function saveKeyHubLimits(store, id, input, { actor, requestId } = {}) {
  if (actor !== 'admin-token') throw new AppError(403, 'admin_token_required', 'Only the Hub admin token may change Hub limits')
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(field => !['hubRateLimitExempt', 'hubSupplierAdmission', 'revision', 'reason'].includes(field))
    || typeof input.hubRateLimitExempt !== 'boolean'
    || (input.hubSupplierAdmission !== undefined && !SUPPLIER_ADMISSION.includes(input.hubSupplierAdmission))
    || !Number.isSafeInteger(input.revision) || input.revision < 0 || input.revision >= 2147483647
    || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 500
    || ![id, requestId].every(value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || ''))) {
    throw new AppError(400, 'invalid_key_hub_limits', 'A boolean switch, an optional supplier admission of bypass or priority, current revision and a reason of 1–500 characters are required')
  }
  const reason = input.reason.trim()
  // Older clients send only the exemption; they keep the stored supplier mode.
  const supplierAdmission = key => input.hubSupplierAdmission ?? (key.hubSupplierAdmission === 'priority' ? 'priority' : 'bypass')
  const apply = key => {
    assertSupported(key)
    assertAvailable(key)
    if (Number(key.hubRateLimitRevision ?? 0) !== input.revision) {
      throw new AppError(409, 'api_key_hub_limits_changed', 'Hub limits changed; reload before saving')
    }
    return { ...key, hubRateLimitExempt: input.hubRateLimitExempt, hubSupplierAdmission: supplierAdmission(key),
      hubRateLimitRevision: input.revision + 1, hubRateLimitUpdatedAt: new Date().toISOString() }
  }
  if (!store.pool) {
    // No await between reading the current revision and writing the memory record.
    const stored = store.apiKeys.get(id)
    const key = stored && { ...stored, tenantStatus: store.tenants.get(stored.tenantId)?.status,
      consumerStatus: store.consumers.get(stored.consumerId)?.status }
    const next = apply(key)
    Object.assign(stored, { hubRateLimitExempt: next.hubRateLimitExempt, hubSupplierAdmission: next.hubSupplierAdmission,
      hubRateLimitRevision: next.hubRateLimitRevision, hubRateLimitUpdatedAt: next.hubRateLimitUpdatedAt })
    store.keyHubLimitEvents ||= []
    store.keyHubLimitEvents.push({ apiKeyId: id, previousExempt: key.hubRateLimitExempt ?? null,
      nextExempt: next.hubRateLimitExempt, previousSupplierAdmission: key.hubSupplierAdmission ?? 'bypass',
      nextSupplierAdmission: next.hubSupplierAdmission, revision: next.hubRateLimitRevision, reason, actor, requestId })
    return project(store, next)
  }
  const client = await store.pool.connect()
  try {
    await client.query('BEGIN')
    const current = await readKey(store, id, client)
    assertSupported(current)
    // Match usage reservation lock order before taking the Key row lock.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${current.tenantId}:${current.consumerId}:plan-month`])
    const key = await readKey(store, id, client, true)
    const next = apply(key)
    const { rows } = await client.query(`UPDATE api_keys SET hub_rate_limit_exempt=$2, hub_supplier_admission=$4,
      hub_rate_limit_revision=$3, hub_rate_limit_updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
    [id, next.hubRateLimitExempt, next.hubRateLimitRevision, next.hubSupplierAdmission])
    await client.query(`INSERT INTO control.api_key_hub_limit_events
      (api_key_id,previous_exempt,next_exempt,previous_supplier_admission,next_supplier_admission,revision,reason,actor,request_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, key.hubRateLimitExempt, next.hubRateLimitExempt, key.hubSupplierAdmission, next.hubSupplierAdmission,
      next.hubRateLimitRevision, reason, actor, requestId])
    await client.query('COMMIT')
    return project(store, fromRow(rows[0]))
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}
