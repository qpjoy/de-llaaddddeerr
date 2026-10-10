#!/usr/bin/env node
// Read-only, content-free diagnostics. Run from the Hub root or via Admin Pod stdin.
import pg from 'pg'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const LCY_WECHAT_IDENTITY = {
  tenantId: '277bf8a4-5ed5-414d-b429-d72fcd7d36b6',
  consumerId: 'be7d07fe-3d98-4db3-b00d-e5cbe5a76190',
  apiKeyId: 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83',
}

export async function checkAccess() {
  if (!process.env.DATABASE_URL || !process.env.MX_INSIGHT_ADMIN_TOKEN) throw new Error('configuration_missing')
  const { PostgresStore } = await import(pathToFileURL(resolve('server/stores/postgres-store.mjs')).href)
  const { customerRequestPrice } = await import(pathToFileURL(resolve('server/billing/contracts.mjs')).href)
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000, statement_timeout: 15000 })
  try {
    const { tenantId, consumerId, apiKeyId } = LCY_WECHAT_IDENTITY
    const key = (await pool.query(`SELECT id,status,environment,scope_mode,expires_at FROM api_keys
      WHERE id=$1 AND tenant_id=$2 AND consumer_id=$3`, [apiKeyId, tenantId, consumerId])).rows[0]
    if (!key) throw new Error('original_key_missing')
    const store = new PostgresStore(pool)
    const [tenant, consumer, platforms, capabilities, plan, billing] = await Promise.all([
      store.getTenant(tenantId), store.getConsumer(consumerId), store.listEffectiveGrants(consumerId, apiKeyId),
      store.listEffectiveCapabilityGrants(consumerId, apiKeyId), store.getConsumerPlan(consumerId),
      store.getTenantBilling(tenantId, { ledgerLimit: 0 }),
    ])
    const port = process.env.MX_INSIGHT_PORT || '18151'
    if (!/^\d{1,5}$/.test(port)) throw new Error('invalid_admin_port')
    const response = await fetch(`http://127.0.0.1:${port}/internal/v1/admin/external-platforms/tikhub?range=24h`, {
      headers: { authorization: `Bearer ${process.env.MX_INSIGHT_ADMIN_TOKEN}` },
      signal: AbortSignal.timeout(30000), redirect: 'error',
    })
    if (!response.ok) throw new Error(`admin_http_${response.status}`)
    const payload = await response.json()
    const inventory = payload.data?.operations
    if (!Array.isArray(inventory)) throw new Error('operation_inventory_missing')
    const operations = inventory.filter(row => row.operationKey?.startsWith('native.wechat.mp.') || row.operationKey === 'native.wechat.search.search')
    if (operations.length !== 12) throw new Error('wechat_contract_inventory_changed')
    const identityUsable = tenant?.status === 'active' && consumer?.status === 'active'
      && key.status === 'active' && key.environment === 'live' && Date.parse(key.expires_at) > Date.now()
    return {
      ...LCY_WECHAT_IDENTITY, identityUsable, scopeMode: key.scope_mode, effectiveSocial: platforms.includes('social'),
      billingMode: billing.profile?.mode, planStatus: plan?.status, planVersionStatus: plan?.versionStatus,
      wallet: billing.account ? { currency: billing.account.currency, availableMinor: billing.account.availableMinor } : null,
      operations: operations.map(row => ({
        operation: row.operationKey, granted: platforms.includes('social') && capabilities.includes(row.operationKey),
        state: row.effectiveState, desiredState: row.desiredState,
        consumerInCanary: row.desiredState !== 'canary' || row.canaryConsumerIds?.includes(consumerId) === true,
        blockers: (row.blockers || []).map(item => item.code),
        procurementCurrency: row.priceBook?.currency,
        procurementMinor: row.priceBook?.endpointPrices?.[row.operationKey] ?? null,
        customerPrice: customerRequestPrice(plan?.priceBook, billing.profile, row.operationKey),
      })),
      upstreamVerified: false,
    }
  } finally { await pool.end() }
}

if (process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)) {
  checkAccess().then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
    // Do not print driver/fetch details, DSNs, headers or credentials.
    const safe = /^(configuration_missing|original_key_missing|invalid_admin_port|admin_http_\d+|operation_inventory_missing|wechat_contract_inventory_changed)$/.test(error.message)
    console.error(`[wechat-access] ${safe ? error.message : 'diagnostic_failed'}; no upstream request sent`)
    process.exitCode = 1
  })
}
