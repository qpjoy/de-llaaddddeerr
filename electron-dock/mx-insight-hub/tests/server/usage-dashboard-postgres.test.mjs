import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'

import { HubService } from '../../server/hub-service.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const connectionString = process.env.MX_INSIGHT_TEST_DATABASE_URL || ''
const skip = connectionString ? false : 'MX_INSIGHT_TEST_DATABASE_URL is not configured'
const BILLING_SECTION = /GROUP BY (?:charge\.)?meter_key, (?:charge\.)?currency/u
const billingColumns = `charge.meter_key, charge.currency, count(*)::bigint AS requests,
  count(*) FILTER (WHERE charge.enforcement_mode = 'enforced' AND charge.status = 'captured' AND charge.quoted_minor > 0)::bigint AS captured_requests,
  count(*) FILTER (WHERE charge.enforcement_mode = 'enforced' AND charge.status IN ('reserved', 'unknown') AND charge.quoted_minor > 0)::bigint AS held_requests,
  count(*) FILTER (WHERE charge.enforcement_mode = 'enforced' AND charge.status = 'released' AND charge.quoted_minor > 0)::bigint AS released_requests,
  count(*) FILTER (WHERE charge.enforcement_mode = 'shadow')::bigint AS shadow_requests,
  coalesce(sum(charge.quoted_minor), 0)::bigint AS quoted_minor, coalesce(sum(charge.charged_minor), 0)::bigint AS charged_minor,
  coalesce(sum(charge.quoted_minor) FILTER (WHERE charge.enforcement_mode = 'enforced' AND charge.status IN ('reserved', 'unknown')), 0)::bigint AS held_minor,
  coalesce(sum(charge.quoted_minor) FILTER (WHERE charge.enforcement_mode = 'shadow'), 0)::bigint AS shadow_quoted_minor`

// Records every statement and can turn the billing section into a genuine
// PostgreSQL statement timeout (SQLSTATE 57014) inside usage()'s transaction.
function instrumentedPool(pool) {
  const statements = []
  let timeoutBilling = false
  return {
    statements,
    timeoutBilling(value) { timeoutBilling = value },
    query: (...args) => pool.query(...args),
    async connect() {
      const client = await pool.connect()
      return new Proxy(client, { get(target, property) {
        if (property !== 'query') return Reflect.get(target, property)
        return async (sql, values) => {
          const text = typeof sql === 'string' ? sql : sql?.text
          statements.push(text)
          if (timeoutBilling && BILLING_SECTION.test(text)) {
            await target.query("SET LOCAL statement_timeout = '20ms'")
            return target.query('SELECT pg_sleep(1)')
          }
          return target.query(sql, values)
        }
      } })
    },
  }
}

async function billedTraffic(service, store) {
  const tenant = await service.createTenant({ name: `Usage dashboard ${randomUUID()}` })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Dashboard caller' })
  await service.putPlatformConfiguration('weibo', { tenantId: tenant.id, consumerId: consumer.id, enabled: true, maxRequests: 1000, maxPageSize: 100 })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Dashboard key', platforms: ['weibo'], capabilities: [] })
  await service.setTenantBillingProfile(tenant.id, { mode: 'enforced', defaultUnitPriceMinor: 7, defaultCurrency: 'CNY' }, 'test-admin')
  await service.addTenantCredit(tenant.id, { amountMinor: 1000, currency: 'CNY', reason: 'Isolated dashboard test credit' }, { actor: 'test', idempotencyKey: randomUUID() })
  const request = () => ({ requestId: randomUUID(), idempotencyKey: randomUUID(), fingerprint: randomUUID().replaceAll('-', '').padEnd(64, '0'),
    tenantId: tenant.id, consumerId: consumer.id, apiKeyId: key.id, platform: 'weibo', meterKey: 'weibo', unitsReserved: 1, maxRequests: 1000,
    windowStart: new Date(Date.now() - 3600000), leaseExpiresAt: new Date(Date.now() + 60000) })
  const committed = request(), released = request(), unknown = request(), reserved = request()
  for (const input of [committed, released, unknown, reserved]) await store.reserve(input)
  await store.commitRequest(committed.requestId, { responseStatus: 200, responseBody: { data: { items: [] } }, unitsActual: 1 })
  await store.releaseRequest(released.requestId, 'definitive_failure')
  await store.markRequestUnknown(unknown.requestId, 'outcome_unknown')
  return { tenant }
}

test('history queries: platform billing totals read charges alone and equal the request-joined totals', { skip }, async () => {
  const pool = new pg.Pool({ connectionString })
  const instrumented = instrumentedPool(pool)
  const store = new PostgresStore(instrumented)
  const service = new HubService({ store, adapter: {}, apiKeyPepper: 'usage-dashboard-postgres-pepper-at-least-32-bytes' })
  try {
    const { tenant } = await billedTraffic(service, store)
    const joined = (await pool.query(`SELECT ${billingColumns} FROM usage_requests request
      JOIN billing.customer_charges charge ON charge.usage_request_id = request.id
      GROUP BY charge.meter_key, charge.currency ORDER BY charge.meter_key, charge.currency`)).rows
    const direct = (await pool.query(`SELECT ${billingColumns} FROM billing.customer_charges charge
      GROUP BY charge.meter_key, charge.currency ORDER BY charge.meter_key, charge.currency`)).rows
    assert.ok(joined.length > 0)
    assert.deepEqual(direct, joined)

    instrumented.statements.length = 0
    const platform = await store.usage({}, { rollup: false })
    const billingSql = instrumented.statements.find(text => BILLING_SECTION.test(text))
    assert.doesNotMatch(billingSql, /usage_requests/u, 'unfiltered totals do not read request history')
    assert.equal(platform.customerBilling.requests, joined.reduce((sum, row) => sum + Number(row.requests), 0))
    assert.equal(platform.unavailableStatistics, undefined)

    instrumented.statements.length = 0
    const scoped = await store.usage({ tenantId: tenant.id }, { rollup: false })
    assert.match(instrumented.statements.find(text => BILLING_SECTION.test(text)), /JOIN billing\.customer_charges/u, 'filters keep the request join')
    const billing = scoped.customerBilling
    assert.deepEqual({ requests: billing.requests, captured: billing.capturedRequests, held: billing.heldRequests, released: billing.releasedRequests },
      { requests: 4, captured: 1, held: 2, released: 1 })
  } finally { await pool.end() }
})

test('a timed-out dashboard section is reported as unavailable while the rest of the summary is served', { skip }, async () => {
  const pool = new pg.Pool({ connectionString })
  const instrumented = instrumentedPool(pool)
  const store = new PostgresStore(instrumented)
  const service = new HubService({ store, adapter: {}, apiKeyPepper: 'usage-dashboard-postgres-pepper-at-least-32-bytes' })
  try {
    await billedTraffic(service, store)
    const complete = await store.dashboard()
    instrumented.timeoutBilling(true)
    const degraded = await store.dashboard()
    assert.deepEqual(degraded.unavailableStatistics, ['customerBilling'])
    assert.equal(degraded.customerBilling, null, 'an unavailable total is null, never zero')
    // Sections after the timed-out one still run in the same snapshot.
    assert.ok(Array.isArray(degraded.recentRequests) && degraded.recentRequests.length > 0)
    for (const field of ['tenants', 'consumers', 'activeApiKeys', 'requests', 'committed', 'units']) assert.equal(degraded[field], complete[field], field)
    assert.deepEqual(degraded.requestMetering, complete.requestMetering)

    // Every other caller keeps the strict behaviour: the timeout fails the call.
    await assert.rejects(store.usage({}), { code: '57014' })
    await assert.rejects(store.usage({}, { rollup: false }), { code: '57014' })
    instrumented.timeoutBilling(false)
    assert.equal((await store.dashboard()).unavailableStatistics, undefined)
  } finally { await pool.end() }
})
