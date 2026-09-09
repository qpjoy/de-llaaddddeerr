import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { mergeUsageSummaries } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const PEPPER = 'request-metering-test-pepper-at-least-32-bytes'

async function memoryFixture() {
  const store = new MemoryStore()
  const service = new HubService({ store, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Unpriced usage tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Metered caller' })
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
    name: 'Unpriced metering key',
    platforms: ['xiaohongshu'],
    capabilities: [],
  })
  return { store, service, tenant, context: await service.authenticate(key.secret) }
}

function reserveInput(context, meterKey) {
  const requestId = randomUUID()
  return {
    requestId,
    idempotencyKey: randomUUID(),
    fingerprint: requestId.replaceAll('-', '').padEnd(64, '0'),
    tenantId: context.tenant.id,
    consumerId: context.consumer.id,
    apiKeyId: context.apiKey.id,
    platform: 'xiaohongshu',
    meterKey,
    unitsReserved: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    windowStart: new Date(Date.now() - 3_600_000),
    maxRequests: 1_000,
  }
}

test('logical request metering counts every state without a customer price', async () => {
  const { store, service, tenant, context } = await memoryFixture()
  const requests = Array.from({ length: 4 }, () => reserveInput(context, 'social.users.resolve'))
  for (const request of requests) assert.equal((await store.reserve(request)).kind, 'reserved')

  await store.commitRequest(requests[0].requestId, {
    responseStatus: 200,
    responseBody: { data: { user: { id: 'user-1' } } },
    unitsActual: 3,
    upstreamLatencyMs: 12,
  })
  await store.releaseRequest(requests[1].requestId, 'pre_dispatch_failure')
  await store.markRequestUnknown(requests[2].requestId, 'delivery_outcome_unknown')

  const usage = await service.usage({ tenantId: tenant.id })
  assert.deepEqual(usage.requestMetering.byMeter['social.users.resolve'], {
    requests: 4,
    committed: 1,
    released: 1,
    unknown: 1,
    reserved: 1,
    units: 3,
  })
  assert.deepEqual(usage.customerBilling.byMeter, {})
  assert.equal(usage.customerBilling.quotedMinor, 0)
  assert.deepEqual({
    capturedRequests: usage.customerBilling.capturedRequests,
    heldRequests: usage.customerBilling.heldRequests,
    releasedRequests: usage.customerBilling.releasedRequests,
    shadowRequests: usage.customerBilling.shadowRequests,
  }, {
    capturedRequests: 0,
    heldRequests: 0,
    releasedRequests: 0,
    shadowRequests: 0,
  })

  assert.equal((await store.reserve(requests[0])).kind, 'replay')
  const afterReplay = await service.usage({ tenantId: tenant.id })
  assert.deepEqual(afterReplay.requestMetering, usage.requestMetering)
})

test('Memory usage keeps customer money separated by currency while counts remain additive', async () => {
  const store = new MemoryStore()
  const now = new Date().toISOString()
  const tenantId = randomUUID()
  const meterKey = 'social.posts.search'
  const fixtures = [
    {
      currency: 'CNY',
      requestStatus: 'committed',
      chargeStatus: 'captured',
      quotedMinor: 30,
      chargedMinor: 30,
    },
    {
      currency: 'USD',
      requestStatus: 'unknown',
      chargeStatus: 'unknown',
      quotedMinor: 50,
      chargedMinor: 0,
    },
  ]
  for (const fixture of fixtures) {
    const id = randomUUID()
    store.requests.set(id, {
      id,
      tenantId,
      consumerId: randomUUID(),
      apiKeyId: randomUUID(),
      platform: 'xiaohongshu',
      capability: null,
      billingMeterKey: meterKey,
      status: fixture.requestStatus,
      unitsActual: fixture.requestStatus === 'committed' ? 1 : 0,
      upstreamLatencyMs: null,
      createdAt: now,
      completedAt: fixture.requestStatus === 'committed' ? now : null,
    })
    store.customerCharges.set(id, {
      usageRequestId: id,
      meterKey,
      currency: fixture.currency,
      quotedMinor: fixture.quotedMinor,
      chargedMinor: fixture.chargedMinor,
      status: fixture.chargeStatus,
      enforcementMode: 'enforced',
    })
  }

  const billing = (await store.usage({ tenantId })).customerBilling
  assert.equal(billing.requests, 2)
  assert.equal(billing.capturedRequests, 1)
  assert.equal(billing.heldRequests, 1)
  assert.equal(billing.releasedRequests, 0)
  assert.equal(billing.shadowRequests, 0)
  assert.equal(billing.currency, null)
  assert.equal(billing.mixedCurrencies, true)
  assert.equal(billing.quotedMinor, null)
  assert.equal(billing.chargedMinor, null)
  assert.equal(billing.heldMinor, null)
  assert.equal(billing.shadowQuotedMinor, null)
  assert.deepEqual(billing.byCurrency, {
    CNY: {
      requests: 1,
      capturedRequests: 1,
      heldRequests: 0,
      releasedRequests: 0,
      shadowRequests: 0,
      quotedMinor: 30,
      chargedMinor: 30,
      heldMinor: 0,
      shadowQuotedMinor: 0,
    },
    USD: {
      requests: 1,
      capturedRequests: 0,
      heldRequests: 1,
      releasedRequests: 0,
      shadowRequests: 0,
      quotedMinor: 50,
      chargedMinor: 0,
      heldMinor: 50,
      shadowQuotedMinor: 0,
    },
  })
  assert.deepEqual(billing.byMeter[meterKey], {
    requests: 2,
    capturedRequests: 1,
    heldRequests: 1,
    releasedRequests: 0,
    shadowRequests: 0,
    quotedMinor: null,
    chargedMinor: null,
    heldMinor: null,
    currency: null,
    mixedCurrencies: true,
  })
})

test('Postgres request metering is aggregated from usage_requests independently of charges', async () => {
  const tenantId = randomUUID()
  const calls = []
  let released = false
  const client = {
    async query(sql, values) {
      calls.push({ sql, values })
      if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' || sql === 'COMMIT') {
        return { rows: [] }
      }
      if (sql.includes(' AS meter_key')) {
        return { rows: [{
          meter_key: 'social.users.posts',
          requests: '5',
          committed: '2',
          released: '1',
          unknown: '1',
          reserved: '1',
          units: '7',
        }] }
      }
      if (sql.includes('LEFT JOIN billing.customer_charges')) return { rows: [] }
      if (sql.includes('JOIN billing.customer_charges')) return { rows: [] }
      if (sql.includes('GROUP BY request.platform, request.capability')) {
        return { rows: [{
          platform: 'xiaohongshu',
          capability: null,
          requests: '5',
          committed: '2',
          released: '1',
          unknown: '1',
          units: '7',
          average_latency: '12',
        }] }
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
    release() { released = true },
  }
  const pool = {
    async connect() { return client },
    async query() { throw new Error('usage queries must use one checked-out client') },
  }
  const store = new PostgresStore(pool)
  const usage = await store.usage({ tenantId, from: '2026-09-01T00:00:00.000Z' })

  assert.equal(usage.requests, 5)
  assert.equal(usage.byPlatform.xiaohongshu.committed, 2)
  assert.equal(usage.averageUpstreamLatencyMs, 12)
  assert.deepEqual(usage.requestMetering.byMeter['social.users.posts'], {
    requests: 5,
    committed: 2,
    released: 1,
    unknown: 1,
    reserved: 1,
    units: 7,
  })
  assert.deepEqual(usage.customerBilling.byMeter, {})
  const meterQuery = calls.find((call) => call.sql.includes(' AS meter_key'))
  assert.match(meterQuery.sql, /FROM usage_requests request/u)
  assert.doesNotMatch(meterQuery.sql, /customer_charges/u)
  assert.deepEqual(meterQuery.values, [tenantId, '2026-09-01T00:00:00.000Z'])
  assert.equal(calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(calls.at(-1).sql, 'COMMIT')
  assert.equal(calls.filter((call) => /^\s*SELECT/u.test(call.sql)).length, 4)
  for (const call of calls.filter((entry) => entry.sql.includes('count('))) {
    assert.doesNotMatch(
      call.sql,
      /\)::integer AS (?:requests|committed|released|unknown|reserved|units)/u,
    )
  }
  assert.equal(released, true)
})

test('Postgres usage rejects unsafe bigint aggregates and rolls back the snapshot', async () => {
  const calls = []
  let released = false
  const client = {
    async query(sql) {
      calls.push(sql)
      if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' || sql === 'ROLLBACK') {
        return { rows: [] }
      }
      if (sql.includes('GROUP BY request.platform, request.capability')) return { rows: [] }
      if (sql.includes(' AS meter_key')) {
        return { rows: [{
          meter_key: 'social.users.resolve',
          requests: '9007199254740992',
          committed: '0',
          released: '0',
          unknown: '0',
          reserved: '0',
          units: '0',
        }] }
      }
      if (sql.includes('JOIN billing.customer_charges')) return { rows: [] }
      if (sql.includes('LEFT JOIN billing.customer_charges')) return { rows: [] }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
    release() { released = true },
  }
  const store = new PostgresStore({ async connect() { return client } })

  await assert.rejects(
    () => store.usage(),
    (error) => (
      error?.status === 500
      && error.code === 'usage_aggregate_out_of_range'
      && /requestMetering\.social\.users\.resolve\.requests/u.test(error.message)
    ),
  )
  assert.equal(calls.includes('COMMIT'), false)
  assert.equal(calls.at(-1), 'ROLLBACK')
  assert.equal(released, true)
})

test('Postgres customer billing reports lifecycle counts while separating currencies', async () => {
  const client = {
    async query(sql) {
      if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' || sql === 'COMMIT') {
        return { rows: [] }
      }
      if (sql.includes('GROUP BY request.platform, request.capability')) return { rows: [] }
      if (sql.includes(' AS meter_key')) return { rows: [] }
      if (sql.includes('LEFT JOIN billing.customer_charges')) return { rows: [] }
      if (sql.includes('JOIN billing.customer_charges')) {
        return { rows: [
          {
            meter_key: 'social.posts.search',
            currency: 'CNY',
            requests: '4',
            captured_requests: '1',
            held_requests: '1',
            released_requests: '1',
            shadow_requests: '1',
            quoted_minor: '9007199254740991',
            charged_minor: '30',
            held_minor: '30',
            shadow_quoted_minor: '30',
          },
          {
            meter_key: 'social.posts.search',
            currency: 'USD',
            requests: '2',
            captured_requests: '1',
            held_requests: '1',
            released_requests: '0',
            shadow_requests: '0',
            quoted_minor: '9007199254740991',
            charged_minor: '40',
            held_minor: '60',
            shadow_quoted_minor: '0',
          },
        ] }
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new PostgresStore({ async connect() { return client } })
  const usage = await store.usage()

  assert.equal(usage.customerBilling.requests, 6)
  assert.equal(usage.customerBilling.capturedRequests, 2)
  assert.equal(usage.customerBilling.heldRequests, 2)
  assert.equal(usage.customerBilling.releasedRequests, 1)
  assert.equal(usage.customerBilling.shadowRequests, 1)
  assert.equal(usage.customerBilling.currency, null)
  assert.equal(usage.customerBilling.mixedCurrencies, true)
  assert.equal(usage.customerBilling.quotedMinor, null)
  assert.equal(usage.customerBilling.chargedMinor, null)
  assert.equal(usage.customerBilling.heldMinor, null)
  assert.equal(usage.customerBilling.shadowQuotedMinor, null)
  assert.deepEqual(usage.customerBilling.byCurrency, {
    CNY: {
      requests: 4,
      capturedRequests: 1,
      heldRequests: 1,
      releasedRequests: 1,
      shadowRequests: 1,
      quotedMinor: Number.MAX_SAFE_INTEGER,
      chargedMinor: 30,
      heldMinor: 30,
      shadowQuotedMinor: 30,
    },
    USD: {
      requests: 2,
      capturedRequests: 1,
      heldRequests: 1,
      releasedRequests: 0,
      shadowRequests: 0,
      quotedMinor: Number.MAX_SAFE_INTEGER,
      chargedMinor: 40,
      heldMinor: 60,
      shadowQuotedMinor: 0,
    },
  })
  assert.deepEqual(usage.customerBilling.byMeter['social.posts.search'], {
    requests: 6,
    capturedRequests: 2,
    heldRequests: 2,
    releasedRequests: 1,
    shadowRequests: 1,
    quotedMinor: null,
    chargedMinor: null,
    heldMinor: null,
    currency: null,
    mixedCurrencies: true,
  })
})

test('tenant summary merge preserves exact request meter states and old summaries remain compatible', () => {
  const merged = mergeUsageSummaries([
    {
      requests: 2,
      committed: 1,
      requestMetering: { byMeter: {
        'social.users.resolve': {
          requests: 2, committed: 1, released: 0, unknown: 0, reserved: 1, units: 2,
        },
      } },
      customerBilling: {
        currency: 'CNY',
        capturedRequests: 1,
        heldRequests: 1,
        releasedRequests: 0,
        shadowRequests: 0,
        byMeter: {
          'social.users.resolve': {
            requests: 2,
            capturedRequests: 1,
            heldRequests: 1,
            releasedRequests: 0,
            shadowRequests: 0,
            currency: 'CNY',
          },
        },
      },
    },
    {
      requests: 3,
      committed: 1,
      requestMetering: { byMeter: {
        'social.users.resolve': {
          requests: 2, committed: 0, released: 1, unknown: 1, reserved: 0, units: 0,
        },
        'social.users.posts': {
          requests: 1, committed: 1, released: 0, unknown: 0, reserved: 0, units: 4,
        },
      } },
      customerBilling: {
        currency: 'CNY',
        capturedRequests: 1,
        heldRequests: 0,
        releasedRequests: 1,
        shadowRequests: 1,
        byMeter: {
          'social.users.resolve': {
            requests: 2,
            capturedRequests: 0,
            heldRequests: 0,
            releasedRequests: 1,
            shadowRequests: 1,
            currency: 'CNY',
          },
          'social.users.posts': {
            requests: 1,
            capturedRequests: 1,
            heldRequests: 0,
            releasedRequests: 0,
            shadowRequests: 0,
            currency: 'CNY',
          },
        },
      },
    },
    { requests: 1, committed: 0 },
  ])

  assert.deepEqual(merged.requestMetering.byMeter, {
    'social.users.resolve': {
      requests: 4, committed: 1, released: 1, unknown: 1, reserved: 1, units: 2,
    },
    'social.users.posts': {
      requests: 1, committed: 1, released: 0, unknown: 0, reserved: 0, units: 4,
    },
  })
  assert.equal(merged.customerBilling.capturedRequests, 2)
  assert.equal(merged.customerBilling.heldRequests, 1)
  assert.equal(merged.customerBilling.releasedRequests, 1)
  assert.equal(merged.customerBilling.shadowRequests, 1)
  assert.deepEqual(
    {
      requests: merged.customerBilling.byMeter['social.users.resolve'].requests,
      capturedRequests: merged.customerBilling.byMeter['social.users.resolve'].capturedRequests,
      heldRequests: merged.customerBilling.byMeter['social.users.resolve'].heldRequests,
      releasedRequests: merged.customerBilling.byMeter['social.users.resolve'].releasedRequests,
      shadowRequests: merged.customerBilling.byMeter['social.users.resolve'].shadowRequests,
    },
    {
      requests: 4,
      capturedRequests: 1,
      heldRequests: 1,
      releasedRequests: 1,
      shadowRequests: 1,
    },
  )
})

test('tenant summary merge exposes reconciliable currency buckets without adding mixed money', () => {
  const merged = mergeUsageSummaries([
    {
      requests: 2,
      committed: 1,
      customerBilling: {
        currency: 'CNY',
        mixedCurrencies: false,
        requests: 2,
        capturedRequests: 1,
        heldRequests: 1,
        releasedRequests: 0,
        shadowRequests: 0,
        quotedMinor: Number.MAX_SAFE_INTEGER,
        chargedMinor: 30,
        heldMinor: 30,
        shadowQuotedMinor: 0,
        byCurrency: {
          CNY: {
            requests: 2,
            capturedRequests: 1,
            heldRequests: 1,
            releasedRequests: 0,
            shadowRequests: 0,
            quotedMinor: Number.MAX_SAFE_INTEGER,
            chargedMinor: 30,
            heldMinor: 30,
            shadowQuotedMinor: 0,
          },
        },
        byMeter: {
          'social.posts.search': {
            requests: 2,
            capturedRequests: 1,
            heldRequests: 1,
            releasedRequests: 0,
            shadowRequests: 0,
            quotedMinor: Number.MAX_SAFE_INTEGER,
            chargedMinor: 30,
            heldMinor: 30,
            currency: 'CNY',
            mixedCurrencies: false,
          },
        },
      },
    },
    {
      requests: 2,
      committed: 1,
      customerBilling: {
        currency: 'USD',
        mixedCurrencies: false,
        requests: 2,
        capturedRequests: 1,
        heldRequests: 0,
        releasedRequests: 1,
        shadowRequests: 0,
        quotedMinor: Number.MAX_SAFE_INTEGER,
        chargedMinor: 40,
        heldMinor: 0,
        shadowQuotedMinor: 0,
        byCurrency: {
          USD: {
            requests: 2,
            capturedRequests: 1,
            heldRequests: 0,
            releasedRequests: 1,
            shadowRequests: 0,
            quotedMinor: Number.MAX_SAFE_INTEGER,
            chargedMinor: 40,
            heldMinor: 0,
            shadowQuotedMinor: 0,
          },
        },
        byMeter: {
          'social.posts.search': {
            requests: 2,
            capturedRequests: 1,
            heldRequests: 0,
            releasedRequests: 1,
            shadowRequests: 0,
            quotedMinor: Number.MAX_SAFE_INTEGER,
            chargedMinor: 40,
            heldMinor: 0,
            currency: 'USD',
            mixedCurrencies: false,
          },
        },
      },
    },
  ])

  assert.equal(merged.customerBilling.requests, 4)
  assert.equal(merged.customerBilling.capturedRequests, 2)
  assert.equal(merged.customerBilling.heldRequests, 1)
  assert.equal(merged.customerBilling.releasedRequests, 1)
  assert.equal(merged.customerBilling.shadowRequests, 0)
  assert.equal(merged.customerBilling.currency, null)
  assert.equal(merged.customerBilling.mixedCurrencies, true)
  assert.equal(merged.customerBilling.quotedMinor, null)
  assert.equal(merged.customerBilling.chargedMinor, null)
  assert.equal(merged.customerBilling.heldMinor, null)
  assert.equal(merged.customerBilling.shadowQuotedMinor, null)
  assert.deepEqual(merged.customerBilling.byCurrency, {
    CNY: {
      requests: 2,
      capturedRequests: 1,
      heldRequests: 1,
      releasedRequests: 0,
      shadowRequests: 0,
      quotedMinor: Number.MAX_SAFE_INTEGER,
      chargedMinor: 30,
      heldMinor: 30,
      shadowQuotedMinor: 0,
    },
    USD: {
      requests: 2,
      capturedRequests: 1,
      heldRequests: 0,
      releasedRequests: 1,
      shadowRequests: 0,
      quotedMinor: Number.MAX_SAFE_INTEGER,
      chargedMinor: 40,
      heldMinor: 0,
      shadowQuotedMinor: 0,
    },
  })
  assert.deepEqual(merged.customerBilling.byMeter['social.posts.search'], {
    requests: 4,
    capturedRequests: 2,
    heldRequests: 1,
    releasedRequests: 1,
    shadowRequests: 0,
    quotedMinor: null,
    chargedMinor: null,
    heldMinor: null,
    currency: null,
    mixedCurrencies: true,
  })
})

test('tenant summary merge rejects a request-meter total beyond the safe integer range', () => {
  assert.throws(
    () => mergeUsageSummaries([
      {
        requests: Number.MAX_SAFE_INTEGER,
        committed: 0,
        requestMetering: { byMeter: {
          'social.users.resolve': {
            requests: Number.MAX_SAFE_INTEGER,
            committed: 0,
            released: 0,
            unknown: 0,
            reserved: 0,
            units: 0,
          },
        } },
      },
      {
        requests: 1,
        committed: 0,
        requestMetering: { byMeter: {
          'social.users.resolve': {
            requests: 1,
            committed: 0,
            released: 0,
            unknown: 0,
            reserved: 0,
            units: 0,
          },
        } },
      },
    ]),
    (error) => error?.status === 500 && error.code === 'usage_aggregate_out_of_range',
  )
})

test('usage page presents unpriced Hub meter counts with user operation labels', async () => {
  const pages = await readFile(new URL('../../src/pages.jsx', import.meta.url), 'utf8')
  const usagePage = pages.match(/export function UsagePage[\s\S]*?\nexport function RuntimePage/u)?.[0] || ''

  assert.match(pages, /'social\.users\.resolve': '小红书用户资料'/u)
  assert.match(pages, /'social\.users\.posts': '小红书用户笔记'/u)
  assert.match(usagePage, /usage\.requestMetering\?\.byMeter/u)
  assert.match(usagePage, /按 Hub 计量键/u)
  assert.match(usagePage, /不依赖价目表、客户扣费或上游调用数/u)
  assert.match(usagePage, /请求.*成功.*处理中.*已释放.*结果未知.*工作单元/u)
  assert.match(usagePage, /成功扣费次数.*冻结次数.*释放次数.*影子次数/u)
  assert.match(usagePage, /计费状态次数与金额分别统计/u)
  assert.match(usagePage, /usage\.customerBilling \|\| \{\}/u)
  assert.match(usagePage, /customerBilling\.requests.*条计价记录/u)
  assert.match(usagePage, /customerBilling\.byCurrency/u)
  assert.match(usagePage, /客户计费按币种/u)
  assert.match(usagePage, /跨币种不换汇、不相加/u)
  assert.match(usagePage, /多币种，见按币种汇总/u)
})

test('static usage contract documents billing counts and nullable mixed-currency money', async () => {
  const source = await readFile(new URL('../../docs/contracts/openapi.yaml', import.meta.url), 'utf8')
  const usageContract = source.slice(source.indexOf('  /usage:'), source.indexOf('\ncomponents:'))

  assert.match(usageContract, /customerBilling:/u)
  assert.match(usageContract, /Request and lifecycle counts are additive across currencies/u)
  assert.match(usageContract, /Hub does not apply an implicit FX rate/u)
  assert.match(usageContract, /byCurrency:/u)
  assert.match(usageContract, /byMeter:/u)
  for (const field of [
    'requests',
    'capturedRequests',
    'heldRequests',
    'releasedRequests',
    'shadowRequests',
  ]) {
    assert.match(usageContract, new RegExp(`${field}: \\{ type: integer \\}`, 'u'))
  }
  for (const field of ['quotedMinor', 'chargedMinor', 'heldMinor', 'shadowQuotedMinor']) {
    assert.match(usageContract, new RegExp(`${field}: \\{ type: \\[integer, "null"\\] \\}`, 'u'))
  }
})
