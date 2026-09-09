import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'

import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const PEPPER = 'customer-billing-test-pepper-at-least-32-bytes'

async function fixture({ mode = 'enforced', multiplierPpm = 1_200_000 } = {}) {
  const store = new MemoryStore()
  const service = new HubService({ store, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Wallet tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Billing caller' })
  await service.putPlatformConfiguration('xiaohongshu', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
    maxRequests: 1_000,
    windowSeconds: 3_600,
    maxPageSize: 100,
  })
  const key = await service.createApiKey({
    consumerId: consumer.id,
    name: 'Billing key',
    platforms: ['xiaohongshu'],
    capabilities: [],
  })
  const plan = await service.publishPlanVersion({
    key: `prepaid-${randomUUID()}`,
    name: 'Prepaid customer plan',
    limits: { monthlyRequests: 10_000, maxPageSize: 100, burstRps: 100 },
    priceBook: {
      key: `customer-xhs-${randomUUID()}`,
      currency: 'CNY',
      defaultMultiplierPpm: 1_000_000,
      entries: [{ meterKey: 'social.posts.search', unitPriceMinor: 25 }],
    },
  }, 'test-admin')
  const current = await service.getConsumerPlan(consumer.id)
  await service.assignConsumerPlan(consumer.id, {
    planVersionId: plan.versionId,
    expectedRevision: current.revision,
  }, 'test-admin')
  await service.setTenantBillingProfile(tenant.id, { mode, multiplierPpm }, 'test-admin')
  const context = await service.authenticate(key.secret)
  return { store, service, tenant, consumer, key, context }
}

function reserveInput(context, overrides = {}) {
  return {
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    fingerprint: randomUUID().replaceAll('-', '').padEnd(64, '0'),
    tenantId: context.tenant.id,
    consumerId: context.consumer.id,
    apiKeyId: context.apiKey.id,
    platform: 'xiaohongshu',
    meterKey: 'social.posts.search',
    unitsReserved: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    windowStart: new Date(Date.now() - 3_600_000),
    maxRequests: 1_000,
    ...overrides,
  }
}

test('enforced tenant wallet holds, captures, releases, and preserves idempotency', async () => {
  const { store, service, tenant, context } = await fixture()
  const first = reserveInput(context)
  await assert.rejects(
    () => store.reserve(first),
    (error) => error?.status === 402 && error?.code === 'insufficient_credit',
  )
  assert.equal(store.requests.size, 0, 'credit rejection happens before a usage row or upstream dispatch')

  const topupKey = `topup:${randomUUID()}`
  const topup = await service.addTenantCredit(tenant.id, {
    amountMinor: 100,
    currency: 'CNY',
    reason: 'Test credit',
    externalReference: 'test-order-1',
  }, { idempotencyKey: topupKey, actor: 'test-admin' })
  const replayedTopup = await service.addTenantCredit(tenant.id, {
    amountMinor: 100,
    currency: 'CNY',
    reason: 'Test credit',
    externalReference: 'test-order-1',
  }, { idempotencyKey: topupKey, actor: 'test-admin' })
  assert.equal(replayedTopup.id, topup.id)

  const reserved = await store.reserve(first)
  assert.equal(reserved.kind, 'reserved')
  let billing = await service.getTenantBilling(tenant.id)
  assert.equal(billing.account.availableMinor, 70)
  assert.equal(billing.account.heldMinor, 30)
  assert.equal(billing.ledger.filter((entry) => entry.kind === 'hold').length, 1)
  assert.equal(store.customerCharges.get(first.requestId).pricingSnapshot.quotedMinor, 30)

  const duplicate = await store.reserve(first)
  assert.equal(duplicate.kind, 'in_progress')
  billing = await service.getTenantBilling(tenant.id)
  assert.equal(billing.account.availableMinor, 70)
  assert.equal(billing.account.heldMinor, 30)
  const duringHold = await store.usage({ tenantId: tenant.id })
  assert.equal(duringHold.customerBilling.requests, 1)
  assert.equal(duringHold.customerBilling.capturedRequests, 0)
  assert.equal(duringHold.customerBilling.heldRequests, 1)
  assert.equal(duringHold.customerBilling.releasedRequests, 0)
  assert.equal(duringHold.customerBilling.shadowRequests, 0)
  assert.equal(duringHold.customerBilling.byCurrency.CNY.requests, 1)
  assert.equal(duringHold.customerBilling.byMeter['social.posts.search'].requests, 1)

  await store.commitRequest(first.requestId, {
    responseStatus: 200,
    responseBody: { data: { items: [] } },
    unitsActual: 1,
    upstreamLatencyMs: 20,
  })
  billing = await service.getTenantBilling(tenant.id)
  assert.equal(billing.account.availableMinor, 70)
  assert.equal(billing.account.heldMinor, 0)
  assert.equal(billing.ledger.filter((entry) => entry.kind === 'capture').length, 1)

  const second = reserveInput(context)
  await store.reserve(second)
  await store.releaseRequest(second.requestId, 'pre_dispatch_failure')
  billing = await service.getTenantBilling(tenant.id)
  assert.equal(billing.account.availableMinor, 70)
  assert.equal(billing.account.heldMinor, 0)
  assert.equal(billing.ledger.filter((entry) => entry.kind === 'release').length, 1)

  const usage = await store.usage({ tenantId: tenant.id })
  assert.equal(usage.customerBilling.requests, 2)
  assert.equal(usage.customerBilling.quotedMinor, 60)
  assert.equal(usage.customerBilling.chargedMinor, 30)
  assert.equal(usage.customerBilling.heldMinor, 0)
  assert.equal(usage.customerBilling.capturedRequests, 1)
  assert.equal(usage.customerBilling.heldRequests, 0)
  assert.equal(usage.customerBilling.releasedRequests, 1)
  assert.equal(usage.customerBilling.shadowRequests, 0)
  assert.deepEqual(usage.customerBilling.byCurrency.CNY, {
    requests: 2,
    capturedRequests: 1,
    heldRequests: 0,
    releasedRequests: 1,
    shadowRequests: 0,
    quotedMinor: 60,
    chargedMinor: 30,
    heldMinor: 0,
    shadowQuotedMinor: 0,
  })
  assert.deepEqual(usage.customerBilling.byMeter['social.posts.search'], {
    requests: 2,
    capturedRequests: 1,
    heldRequests: 0,
    releasedRequests: 1,
    shadowRequests: 0,
    quotedMinor: 60,
    chargedMinor: 30,
    heldMinor: 0,
    currency: 'CNY',
    mixedCurrencies: false,
  })
})

test('unknown customer charge reconciliation is audited, idempotent, and leaves delivery truth unknown', async () => {
  const { store, service, tenant, context } = await fixture()
  await service.addTenantCredit(tenant.id, {
    amountMinor: 100,
    currency: 'CNY',
    reason: 'Reconciliation test credit',
  }, { idempotencyKey: `topup:${randomUUID()}`, actor: 'test-admin' })

  const captureRequest = reserveInput(context)
  const releaseRequest = reserveInput(context)
  await store.reserve(captureRequest)
  await store.reserve(releaseRequest)
  await store.markRequestUnknown(captureRequest.requestId, 'delivery_outcome_unknown')
  await store.markRequestUnknown(releaseRequest.requestId, 'delivery_outcome_unknown')
  const pendingUsage = await store.usage({ tenantId: tenant.id })
  assert.equal(pendingUsage.customerBilling.capturedRequests, 0)
  assert.equal(pendingUsage.customerBilling.heldRequests, 2)
  assert.equal(pendingUsage.customerBilling.releasedRequests, 0)

  const captureKey = `reconcile:${randomUUID()}`
  const captured = await service.reconcileUnknownCustomerCharge(captureRequest.requestId, {
    disposition: 'capture',
    reason: 'Operator confirmed customer delivery',
  }, { idempotencyKey: captureKey, actor: 'billing-operator' })
  assert.equal(captured.status, 'captured')
  assert.equal(captured.chargedMinor, 30)
  const replayed = await service.reconcileUnknownCustomerCharge(captureRequest.requestId, {
    disposition: 'capture',
    reason: 'Operator confirmed customer delivery',
  }, { idempotencyKey: captureKey, actor: 'billing-operator' })
  assert.equal(replayed.id, captured.id)
  await assert.rejects(
    () => service.reconcileUnknownCustomerCharge(captureRequest.requestId, {
      disposition: 'capture',
      reason: 'Changed evidence',
    }, { idempotencyKey: captureKey, actor: 'billing-operator' }),
    (error) => error?.status === 409 && error?.code === 'reconciliation_idempotency_conflict',
  )

  const releaseKey = `reconcile:${randomUUID()}`
  const released = await service.reconcileUnknownCustomerCharge(releaseRequest.requestId, {
    disposition: 'release',
    reason: 'Operator confirmed no customer delivery',
  }, { idempotencyKey: releaseKey, actor: 'billing-operator' })
  assert.equal(released.status, 'released')
  assert.equal(released.chargedMinor, 0)

  assert.equal((await store.getRequest(captureRequest.requestId, context.consumer.id)).status, 'unknown')
  assert.equal((await store.getRequest(releaseRequest.requestId, context.consumer.id)).status, 'unknown')
  const billing = await service.getTenantBilling(tenant.id)
  assert.equal(billing.account.availableMinor, 70)
  assert.equal(billing.account.heldMinor, 0)
  assert.deepEqual(billing.ledger.map((entry) => entry.accountRevision), [5, 4, 3, 2, 1])
  assert.equal(billing.ledger.filter((entry) => entry.kind === 'capture').length, 1)
  assert.equal(billing.ledger.filter((entry) => entry.kind === 'release').length, 1)
  const captureEntry = billing.ledger.find((entry) => entry.kind === 'capture')
  assert.equal(captureEntry.idempotencyKey, captureKey)
  assert.equal(captureEntry.actor, 'billing-operator')
  assert.equal(captureEntry.reason, 'Operator confirmed customer delivery')
  const settledUsage = await store.usage({ tenantId: tenant.id })
  assert.equal(settledUsage.customerBilling.capturedRequests, 1)
  assert.equal(settledUsage.customerBilling.heldRequests, 0)
  assert.equal(settledUsage.customerBilling.releasedRequests, 1)
})

test('unknown customer charge reconciliation HTTP route is platform-admin only', async (t) => {
  const { store, service, tenant, context } = await fixture()
  await service.addTenantCredit(tenant.id, {
    amountMinor: 100,
    currency: 'CNY',
    reason: 'HTTP reconciliation credit',
  }, { idempotencyKey: `topup:${randomUUID()}`, actor: 'test-admin' })
  const usageRequest = reserveInput(context)
  await store.reserve(usageRequest)
  await store.markRequestUnknown(usageRequest.requestId, 'delivery_outcome_unknown')

  const identity = {
    enabled: true,
    async resolve(token) {
      if (token !== 'scoped-billing-member') return null
      return {
        kind: 'launcher-user',
        memberId: 'tenant-billing-member',
        displayName: 'Tenant billing member',
        platformAdmin: false,
        tenantIds: [tenant.id],
        capabilities: [],
        memberships: [{ tenantId: tenant.id, capabilities: ['usage.read'] }],
      }
    },
  }
  const app = createApp({
    service,
    store,
    adapter: {},
    identity,
    adminToken: 'customer-billing-http-admin-token',
    logger: { error() {} },
  })
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const path = `/internal/v1/admin/usage/${usageRequest.requestId}/customer-charge/reconciliation`
  const body = {
    disposition: 'release',
    reason: 'Operator confirmed no customer delivery',
  }
  const idempotencyKey = `reconcile:${randomUUID()}`
  const call = async (scoped) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        ...(scoped
          ? { authorization: 'Bearer scoped-billing-member' }
          : { 'x-mx-insight-admin-token': 'customer-billing-http-admin-token' }),
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(body),
    })
    return { response, payload: await response.json() }
  }

  const denied = await call(true)
  assert.equal(denied.response.status, 403)
  assert.equal(denied.payload.error.code, 'platform_admin_required')
  const reconciled = await call(false)
  assert.equal(reconciled.response.status, 200)
  assert.equal(reconciled.payload.data.status, 'released')
  assert.equal((await store.getRequest(usageRequest.requestId, context.consumer.id)).status, 'unknown')
  const terminal = store.creditLedgerEntries.find((entry) => entry.idempotencyKey === idempotencyKey)
  assert.equal(terminal.actor, 'admin-token')
  assert.equal(terminal.reason, body.reason)
})

test('shadow pricing records a quote without touching tenant credit', async () => {
  const { store, service, tenant, context } = await fixture({ mode: 'shadow' })
  const request = reserveInput(context)
  await store.reserve(request)
  await store.commitRequest(request.requestId, {
    responseStatus: 200,
    responseBody: null,
    unitsActual: 1,
    upstreamLatencyMs: 1,
  })
  const billing = await service.getTenantBilling(tenant.id)
  assert.equal(billing.account, null)
  const usage = await store.usage({ tenantId: tenant.id })
  assert.equal(usage.customerBilling.quotedMinor, 30)
  assert.equal(usage.customerBilling.shadowQuotedMinor, 30)
  assert.equal(usage.customerBilling.chargedMinor, 0)
  assert.equal(usage.customerBilling.capturedRequests, 0)
  assert.equal(usage.customerBilling.heldRequests, 0)
  assert.equal(usage.customerBilling.releasedRequests, 0)
  assert.equal(usage.customerBilling.shadowRequests, 1)
  assert.equal(usage.customerBilling.byMeter['social.posts.search'].shadowRequests, 1)
})

test('legacy plans remain non-monetary without a billing profile or price book', async () => {
  const store = new MemoryStore()
  const service = new HubService({ store, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Legacy tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Legacy caller' })
  await service.putPlatformConfiguration('xiaohongshu', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
  })
  await service.putCapabilityConfiguration('social.posts.search', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
  })
  const key = await service.createApiKey({
    consumerId: consumer.id,
    name: 'Legacy key',
    platforms: ['xiaohongshu'],
    capabilities: ['social.posts.search'],
  })
  const context = await service.authenticate(key.secret)
  const request = reserveInput(context)
  const reservation = await store.reserve(request)
  assert.equal(reservation.kind, 'reserved')
  assert.equal(store.customerCharges.size, 0)
})

test('billing administration is platform-only while tenant views expose effective rates without procurement details', async (t) => {
  const { store, service, tenant, consumer } = await fixture({ mode: 'shadow', multiplierPpm: 1_500_000 })
  const identity = {
    enabled: true,
    async resolve(token) {
      if (token !== 'scoped-billing-member') return null
      return {
        kind: 'launcher-user',
        memberId: 'tenant-billing-member',
        displayName: 'Tenant billing member',
        platformAdmin: false,
        tenantIds: [tenant.id],
        capabilities: [],
        memberships: [{
          tenantId: tenant.id,
          capabilities: ['tenant.read', 'consumer.read', 'usage.read'],
        }],
      }
    },
  }
  const app = createApp({
    service,
    store,
    adapter: {},
    identity,
    adminToken: 'customer-billing-http-admin-token',
    logger: { error() {} },
  })
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const request = async (path, { method = 'GET', scoped = false, body, idempotencyKey } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(scoped
          ? { authorization: 'Bearer scoped-billing-member' }
          : { 'x-mx-insight-admin-token': 'customer-billing-http-admin-token' }),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { response, payload: await response.json() }
  }

  const credit = await request(`/internal/v1/admin/tenants/${tenant.id}/billing/credits`, {
    method: 'POST',
    idempotencyKey: `http-credit:${randomUUID()}`,
    body: {
      amountMinor: 1_000,
      currency: 'CNY',
      reason: 'HTTP contract credit',
      externalReference: 'private-transfer-reference',
    },
  })
  assert.equal(credit.response.status, 201)

  const denied = await request(`/internal/v1/admin/tenants/${tenant.id}/billing/credits`, {
    method: 'POST',
    scoped: true,
    idempotencyKey: `denied-credit:${randomUUID()}`,
    body: { amountMinor: 100, currency: 'CNY', reason: 'Must be denied' },
  })
  assert.equal(denied.response.status, 403)

  const billing = await request(`/internal/v1/admin/tenants/${tenant.id}/billing`, { scoped: true })
  assert.equal(billing.response.status, 200)
  assert.equal(billing.payload.data.profile.mode, 'shadow')
  assert.equal('multiplierPpm' in billing.payload.data.profile, false)
  assert.equal(billing.payload.data.account.availableMinor, 1_000)
  assert.equal('actor' in billing.payload.data.ledger[0], false)
  assert.equal('externalReference' in billing.payload.data.ledger[0], false)

  const plans = await request(`/internal/v1/admin/plans?consumerId=${consumer.id}`, { scoped: true })
  assert.equal(plans.response.status, 200)
  assert.equal(plans.payload.data.currentPlan.priceBook, null)
  assert.deepEqual(plans.payload.data.currentPlan.customerRates, [{
    meterKey: 'social.posts.search',
    billingUnit: 'request',
    unitPriceMinor: 38,
    currency: 'CNY',
  }])
  assert.equal(JSON.stringify(plans.payload).includes('tikhub'), false)
  assert.equal(JSON.stringify(plans.payload).includes('priceBookKey'), false)
})

test('Postgres tenant billing uses one repeatable snapshot and causal ledger ordering', async () => {
  const tenantId = '11111111-1111-4111-8111-111111111111'
  const accountId = '22222222-2222-4222-8222-222222222222'
  const calls = []
  let released = false
  const client = {
    async query(sql, values) {
      const normalized = sql.replace(/\s+/gu, ' ').trim()
      calls.push({ sql: normalized, values })
      if (normalized === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') {
        return { rows: [], rowCount: 0 }
      }
      if (normalized.includes('FROM billing.tenant_billing_profiles')) {
        return {
          rows: [{
            tenant_id: tenantId,
            mode: 'enforced',
            multiplier_ppm: '1200000',
            revision: '1',
            updated_by: 'billing-admin',
            updated_at: '2026-09-08T00:00:00.000Z',
          }],
          rowCount: 1,
        }
      }
      if (normalized.includes('FROM billing.credit_accounts')) {
        return {
          rows: [{
            id: accountId,
            tenant_id: tenantId,
            currency: 'CNY',
            available_minor: '70',
            held_minor: '0',
            status: 'active',
            revision: '2',
            created_at: '2026-09-08T00:00:00.000Z',
            updated_at: '2026-09-08T00:00:01.000Z',
          }],
          rowCount: 1,
        }
      }
      if (normalized.includes('FROM billing.credit_ledger_entries')) {
        return {
          rows: [
            {
              id: '44444444-4444-4444-8444-444444444444',
              account_id: accountId,
              tenant_id: tenantId,
              charge_id: '55555555-5555-4555-8555-555555555555',
              usage_request_id: '66666666-6666-4666-8666-666666666666',
              kind: 'capture',
              amount_minor: '30',
              available_delta_minor: '0',
              held_delta_minor: '-30',
              available_after_minor: '70',
              held_after_minor: '0',
              account_revision: '2',
              currency: 'CNY',
              idempotency_key: 'usage:capture:test',
              external_reference: null,
              actor: 'usage-settlement',
              reason: null,
              created_at: '2026-09-08T00:00:00.000Z',
            },
            {
              id: '33333333-3333-4333-8333-333333333333',
              account_id: accountId,
              tenant_id: tenantId,
              charge_id: '55555555-5555-4555-8555-555555555555',
              usage_request_id: '66666666-6666-4666-8666-666666666666',
              kind: 'hold',
              amount_minor: '30',
              available_delta_minor: '-30',
              held_delta_minor: '30',
              available_after_minor: '70',
              held_after_minor: '30',
              account_revision: '1',
              currency: 'CNY',
              idempotency_key: 'usage:hold:test',
              external_reference: null,
              actor: 'usage-reservation',
              reason: null,
              created_at: '2026-09-08T00:00:00.000Z',
            },
          ],
          rowCount: 2,
        }
      }
      if (normalized === 'COMMIT') return { rows: [], rowCount: 0 }
      throw new Error(`Unexpected SQL: ${normalized}`)
    },
    release() { released = true },
  }
  const store = new PostgresStore({ async connect() { return client } })

  const billing = await store.getTenantBilling(tenantId, { ledgerLimit: 25 })

  assert.equal(calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.match(calls[3].sql, /ORDER BY account_revision DESC, id DESC/)
  assert.deepEqual(calls[3].values, [tenantId, 25])
  assert.equal(calls.at(-1).sql, 'COMMIT')
  assert.equal(released, true)
  assert.equal(billing.account.balanceMinor, 70)
  assert.deepEqual(billing.ledger.map((entry) => entry.accountRevision), [2, 1])
})

test('Postgres unknown charge reconciliation calls the audited database primitive once', async () => {
  const usageRequestId = '11111111-1111-4111-8111-111111111111'
  const idempotencyKey = 'reconcile:postgres-test'
  const calls = []
  let released = false
  const client = {
    async query(sql, values) {
      const normalized = sql.replace(/\s+/gu, ' ').trim()
      calls.push({ sql: normalized, values })
      if (normalized === 'BEGIN' || normalized === 'COMMIT') return { rows: [], rowCount: 0 }
      if (normalized.includes('billing.reconcile_unknown_customer_charge')) {
        return {
          rows: [{
            id: '22222222-2222-4222-8222-222222222222',
            usage_request_id: usageRequestId,
            tenant_id: '33333333-3333-4333-8333-333333333333',
            consumer_id: '44444444-4444-4444-8444-444444444444',
            api_key_id: '55555555-5555-4555-8555-555555555555',
            account_id: '66666666-6666-4666-8666-666666666666',
            meter_key: 'social.posts.search',
            billing_unit: 'request',
            price_book_id: '77777777-7777-4777-8777-777777777777',
            price_book_key: 'customer-xhs',
            price_book_version: '1',
            unit_price_minor: '25',
            multiplier_ppm: '1200000',
            quoted_minor: '30',
            charged_minor: '30',
            currency: 'CNY',
            enforcement_mode: 'enforced',
            status: 'captured',
            pricing_snapshot: { quotedMinor: 30 },
            created_at: '2026-09-08T00:00:00.000Z',
            settled_at: '2026-09-08T00:00:01.000Z',
          }],
          rowCount: 1,
        }
      }
      throw new Error(`Unexpected SQL: ${normalized}`)
    },
    release() { released = true },
  }
  const store = new PostgresStore({ async connect() { return client } })

  const charge = await store.reconcileUnknownCustomerCharge({
    usageRequestId,
    disposition: 'capture',
    idempotencyKey,
    actor: 'billing-operator',
    reason: 'Provider evidence confirmed delivery',
  })

  const functionCalls = calls.filter(({ sql }) => sql.includes('reconcile_unknown_customer_charge'))
  assert.equal(functionCalls.length, 1)
  assert.deepEqual(functionCalls[0].values, [
    usageRequestId,
    'capture',
    idempotencyKey,
    'billing-operator',
    'Provider evidence confirmed delivery',
  ])
  assert.deepEqual(calls.map(({ sql }) => sql.split(' ')[0]), ['BEGIN', 'SELECT', 'COMMIT'])
  assert.equal(released, true)
  assert.equal(charge.status, 'captured')
  assert.equal(charge.chargedMinor, 30)
  assert.deepEqual(charge.pricingSnapshot, { quotedMinor: 30 })
})
