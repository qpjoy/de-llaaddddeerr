import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRuntime } from '../../server/index.mjs'
import { loadConfig } from '../../server/config.mjs'
import { parseIpHistoryQuery } from '../../server/external-platforms/ip-risk-history.mjs'
import { ipRiskHistoryRows, ipRiskHistorySummary, ipRiskHistoryCsv, ipRiskBatchRows } from '../../src/ip-risk-view.js'
import { tenantOpenApiDocument } from '../../server/public-docs.mjs'

test('history filters bound pages, reject malformed cursors and refuse identity parameters', () => {
  assert.equal(parseIpHistoryQuery({}).limit, 10)
  for (const query of [{ limit: 0 }, { limit: 51 }, { q: 'x'.repeat(101) }, { state: 'safe' }, { consumerId: 'other' }, { cursor: 'bad' }, { cursor: Buffer.from('[null,"single:123",0]').toString('base64url') }]) {
    assert.throws(() => parseIpHistoryQuery(query), { status: 400 })
  }
})

test('history without a stored portrait preserves failed versus unknown outcomes and docs require both scopes', () => {
  const detail = { kind: 'single', id: 'saved-request', request: { ip: '1.1.1.1' },
    payload: { requestId: 'saved-request', error: { code: 'saved_failure' } },
    hasStoredResponse: false, requestState: 'released', status: 503 }
  assert.equal(ipRiskHistoryRows(detail)[0].status, 'failed')
  assert.equal(ipRiskHistoryRows({ ...detail, requestState: 'unknown', status: 409 })[0].status, 'unknown')
  assert.equal(ipRiskHistoryRows(detail)[0].profile, null)
  assert.equal(ipRiskHistorySummary({ state: 'error', httpStatus: null }).status, 'failed')
  const csv = ipRiskHistoryCsv([ipRiskHistorySummary({ state: 'success', index: 0, createdAt: '2026-10-01T00:00:00Z', profile: { risk_score: 0, proxy_type: '=FORMULA' } })])
  assert.match(csv, /提交时间/)
  assert.match(csv, /2026-10-01T00:00:00Z/)
  assert.match(csv, /"0"/)
  assert.match(csv, /'=FORMULA/)
  assert.doesNotMatch(csv, /字段警告|风险标签|真人概率/, 'summary exports do not claim unrequested fields are empty')
  const allowed = tenantOpenApiDocument([{ platforms: ['ip_risk'], capabilities: ['ip.risk.query'] }])
  const denied = tenantOpenApiDocument([{ platforms: ['ip_risk'], capabilities: [] }, { platforms: [], capabilities: ['ip.risk.query'] }])
  for (const path of ['/data/ip/risk/history', '/data/ip/risk/history/{kind}/{id}']) {
    assert.ok(allowed.paths[path]?.get)
    assert.equal(denied.paths[path], undefined)
  }
})

test('HTTP history survives page-client recreation, restores batches, isolates keys and never dispatches or charges', async () => {
  const runtime = await createRuntime(loadConfig({ MX_INSIGHT_STORE: 'memory', MX_INSIGHT_LISTENER_MODE: 'public',
    MX_INSIGHT_API_KEY_PEPPER: 'ip-history-test-pepper-at-least-32-characters', MX_INSIGHT_IPSEARCH_ENABLED: '1', MX_INSIGHT_IPSEARCH_API_KEY: 'synthetic-only' }))
  let calls = 0
  runtime.ipRiskGateway.adapter.fetch = async (_url, options) => {
    calls++
    const ip = new URLSearchParams(options.body).get('ip')
    if (ip === '9.9.9.9') throw new Error('simulated transport loss')
    if (ip === '4.4.4.4') return Response.json({ code: 500 })
    return Response.json({ code: 200, data: ip === '8.8.8.8' ? null : { risk: { proxy: '是', risk_score: 90, risk_level: '中风险', mb_rate: '0%', real: '51%', risk_tag: [{ label: 'device', label_name: '设备标签', last_time: '2024-05-10 12:17:26' }] } } })
  }
  const server = createServer(runtime.app)
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const tenant = await runtime.service.createTenant({ name: 'History fixture' })
    const consumer = await runtime.service.createConsumer({ tenantId: tenant.id, name: 'History consumer' })
    await runtime.store.setPlatformGrant(consumer.id, 'ip_risk', true)
    await runtime.service.putCapabilityConfiguration('ip.risk.query', { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
    const key = await runtime.service.createApiKey({ consumerId: consumer.id, name: 'owner', platforms: ['ip_risk'], capabilities: ['ip.risk.query'] })
    const otherKey = await runtime.service.createApiKey({ consumerId: consumer.id, name: 'other', platforms: ['ip_risk'], capabilities: ['ip.risk.query'] })
    const client = secret => async (path, body) => {
      const response = await fetch(origin + '/api/v1/data/ip/risk' + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: response.status, headers: response.headers, body: await response.json() }
    }
    const beforeRefresh = client(key.secret)
    const single = await beforeRefresh('', { ip: '1.1.1.1' })
    const ips = ['1.1.1.1', '8.8.8.8', '1.1.1.1', '9.9.9.9', '4.4.4.4']
    const batch = await beforeRefresh('/batch', { ips })
    assert.equal(batch.status, 200)
    const dispatchCount = calls, requestCount = runtime.store.requests.size, chargeCount = runtime.store.customerCharges.size
    const afterRefresh = client(key.secret)
    runtime.ipRiskGateway.enabled = false
    runtime.ipRiskGateway.adapter.apiKey = ''
    const all = []; let cursor = ''
    do {
      const page = await afterRefresh('/history?limit=2' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''))
      assert.equal(page.status, 200)
      assert.equal(page.headers.get('cache-control'), 'private, no-store')
      assert.equal(page.body.storage, 'memory')
      all.push(...page.body.items); cursor = page.body.nextCursor
    } while (cursor)
    assert.equal(all.length, 6, 'batch children are not duplicated as standalone calls')
    assert.equal(new Set(all.map(row => row.id)).size, 6)
    const children = all.filter(row => row.batchId === batch.body.batchId)
    assert.deepEqual(children.map(row => row.ip), ips)
    assert.deepEqual(children.map(row => row.state), ['success', 'no_data', 'success', 'unknown', 'error'])
    assert.equal((await afterRefresh('/history?q=设备标签')).body.items.length, 3)
    assert.equal((await afterRefresh('/history?q=8.8.8.8&state=no_data')).body.items.length, 1)
    assert.equal((await afterRefresh('/history?state=error')).body.items.length, 1)
    const detail = await afterRefresh(`/history/batch/${batch.body.batchId}`)
    assert.deepEqual(detail.body.payload, batch.body, 'original response remains unchanged')
    const restored = ipRiskHistoryRows(detail.body)
    assert.ok(restored.every(row => row.historical))
    assert.deepEqual(ipRiskBatchRows(restored, restored[2]).map(row => row.ip), ips)
    assert.equal(restored[3].status, 'unknown')
    assert.deepEqual((await afterRefresh(`/history/single/${single.body.requestId}`)).body.payload, single.body)
    const outsider = client(otherKey.secret)
    assert.deepEqual((await outsider('/history')).body.items, [])
    assert.equal((await outsider(`/history/batch/${batch.body.batchId}`)).status, 404)
    assert.equal((await outsider(`/history/single/${single.body.requestId}`)).status, 404)
    const context = await runtime.service.authenticate(key.secret)
    const claimed = await runtime.ipRiskGateway.batch.claim(context, 'pending-test', 'fingerprint')
    const pending = await afterRefresh('/history?q=' + claimed.row.id)
    assert.equal(pending.body.items[0].available, false)
    assert.equal((await afterRefresh(`/history/batch/${claimed.row.id}`)).status, 409)
    await runtime.store.setPlatformGrant(consumer.id, 'ip_risk', false)
    assert.equal((await afterRefresh('/history')).status, 403)
    assert.equal((await afterRefresh(`/history/batch/${batch.body.batchId}`)).status, 403)
    assert.equal(calls, dispatchCount)
    assert.equal(runtime.store.requests.size, requestCount)
    assert.equal(runtime.store.customerCharges.size, chargeCount)
    assert.doesNotMatch(JSON.stringify(all), /ipsearch|ipdatacloud|synthetic-only|idempotencyKey|tenantId|consumerId|apiKeyId/)
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve))
    runtime.agent.close(); await runtime.store.close()
  }
})
