import { isHubRateLimitExempt, isLcyHubLimitIdentity } from '../core/internal-traffic-policy.mjs'

const contextFor = row => ({ apiKey: { id: row.apiKeyId, hubRateLimitExempt: row.exempt },
  tenant: { id: row.tenantId }, consumer: { id: row.consumerId } })
const activeExemption = row => row && isHubRateLimitExempt(contextFor(row))
  && row.keyStatus === 'active' && row.environment === 'live'
  && Date.parse(row.expiresAt) > Date.now()
  && row.tenantStatus === 'active' && row.consumerStatus === 'active'

// Read the current stored Key, not a request flag or a stale authentication
// snapshot. Scope is checked again at both reservation and paid dispatch.
export function memoryBudgetExempt(store, usage) {
  const key = store?.apiKeys?.get(usage?.apiKeyId)
  const consumer = store?.consumers?.get(usage?.consumerId)
  if (!key || key.tenantId !== usage.tenantId || key.consumerId !== usage.consumerId
    || consumer?.tenantId !== usage.tenantId) return false
  return Boolean(activeExemption({ ...usage, exempt: key.hubRateLimitExempt,
    keyStatus: key.status, environment: key.environment, expiresAt: key.expiresAt,
    tenantStatus: store.tenants?.get(usage.tenantId)?.status, consumerStatus: consumer.status }))
}

export async function postgresBudgetExempt(client, input) {
  // Ordinary Keys incur no extra query. These IDs only select the read; the
  // stored request and current Key independently prove the exemption below.
  if (!input || !isLcyHubLimitIdentity(contextFor(input))) return false
  const { rows: [row] } = await client.query(`SELECT key.id AS "apiKeyId", key.tenant_id AS "tenantId",
      key.consumer_id AS "consumerId", key.hub_rate_limit_exempt AS exempt,
      key.status AS "keyStatus", key.environment, key.expires_at AS "expiresAt",
      tenant.status AS "tenantStatus", consumer.status AS "consumerStatus"
    FROM usage_requests request
    JOIN api_keys key ON key.id=request.api_key_id AND key.tenant_id=request.tenant_id AND key.consumer_id=request.consumer_id
    JOIN tenants tenant ON tenant.id=key.tenant_id
    JOIN consumers consumer ON consumer.id=key.consumer_id AND consumer.tenant_id=tenant.id
    WHERE request.id=$1 AND request.status='reserved'
      AND request.api_key_id=$2 AND request.tenant_id=$3 AND request.consumer_id=$4`,
  [input.usageRequestId, input.apiKeyId, input.tenantId, input.consumerId])
  return Boolean(activeExemption(row))
}

// Inline the current stored authority into the existing cost-evidence read.
// No extra DB round trip, no cached privilege, and no query change for other Keys.
export function budgetExemptionProjection(input) {
  if (!input || !isLcyHubLimitIdentity(contextFor(input))) return ''
  return `, EXISTS (
    SELECT 1 FROM usage_requests request
    JOIN api_keys key ON key.id=request.api_key_id AND key.tenant_id=request.tenant_id AND key.consumer_id=request.consumer_id
    JOIN tenants tenant ON tenant.id=key.tenant_id
    JOIN consumers consumer ON consumer.id=key.consumer_id AND consumer.tenant_id=tenant.id
    WHERE request.id=$3 AND request.status='reserved'
      AND key.id='fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
      AND key.tenant_id='277bf8a4-5ed5-414d-b429-d72fcd7d36b6'
      AND key.consumer_id='be7d07fe-3d98-4db3-b00d-e5cbe5a76190'
      AND key.hub_rate_limit_exempt=true AND key.status='active'
      AND key.environment='live' AND key.expires_at>clock_timestamp()
      AND tenant.status='active' AND consumer.status='active'
  ) AS budget_exempt`
}
