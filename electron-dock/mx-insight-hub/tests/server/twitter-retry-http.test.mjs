import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createApp } from '../../server/app.mjs'
import { AppError } from '../../server/core/errors.mjs'

const ADMIN = 'twitter-retry-admin-test', KEY = 'mih_live_retry_test'
async function fixture(t, listenerMode = 'combined', available = true) {
  const reads = [], dispatches = [], context = { consumer: { id: randomUUID() }, apiKey: { id: randomUUID() } }
  const server = createServer(createApp({ store: {}, adapter: {}, adminToken: ADMIN, listenerMode,
    identity: { enabled: true, resolve: async () => ({ kind: 'launcher-user', memberId: 'admin', platformAdmin: true, capabilities: [], memberships: [], tenantIds: null }) },
    service: {
      authenticate: async secret => { if (secret !== KEY) throw new AppError(401, 'invalid_api_key', 'Invalid key'); return context },
      search: async (ctx, input) => { dispatches.push({ ctx, input }); return { status: 200, requestId: randomUUID(), body: { data: [] }, replay: false } },
    },
    acquisitionHistory: available ? { getAdminTwitterRetryPreparation: async id => { reads.push(id); return { requestId: id } } } : null,
    logger: { error() {} },
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { url: `http://127.0.0.1:${server.address().port}`, reads, dispatches, context }
}

test('Twitter retry preparation is Admin-token only, no-store, GET-only and never dispatches', async t => {
  const f = await fixture(t), id = randomUUID(), path = `/internal/v1/admin/acquisitions/${id}/twitter-retry`
  assert.equal((await fetch(f.url + path)).status, 401)
  assert.equal((await fetch(f.url + path, { headers: { authorization: 'Bearer launcher-session' } })).status, 403)
  assert.ok([401,403].includes((await fetch(f.url + path, { headers: { authorization: `Bearer ${KEY}` } })).status))
  assert.deepEqual(f.reads, [])
  const headers = { 'x-mx-insight-admin-token': ADMIN }
  const response = await fetch(f.url + path, { headers })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal((await response.json()).data.requestId, id)
  assert.equal((await fetch(f.url + path + '?send=true', { headers })).status, 400)
  assert.equal((await fetch(f.url + path, { method: 'POST', headers })).status, 404)
  assert.deepEqual(f.reads, [id])
  assert.deepEqual(f.dispatches, [])
  const hidden = await fixture(t, 'public'), unavailable = await fixture(t, 'combined', false)
  assert.equal((await fetch(hidden.url + path, { headers })).status, 404)
  assert.equal((await fetch(unavailable.url + path, { headers })).status, 503)
})

test('standard search passes explicit Retry-Of and new Idempotency-Key through authenticated public boundary', async t => {
  const f = await fixture(t), retryOfRequestId = randomUUID()
  const body = { platform: 'twitter', query: '("US semiconductor export" OR SMIC) AND #chipban', pageSize: 20 }
  const response = await fetch(f.url + '/api/v1/data/search', { method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json',
      'idempotency-key': 'twitter-manual-retry-new', 'x-mx-insight-retry-of': retryOfRequestId }, body: JSON.stringify(body) })
  assert.equal(response.status, 200)
  assert.equal(f.dispatches.length, 1)
  assert.equal(f.dispatches[0].ctx, f.context)
  assert.equal(f.dispatches[0].input.retryOfRequestId, retryOfRequestId)
  assert.equal(f.dispatches[0].input.idempotencyKey, 'twitter-manual-retry-new')
  assert.deepEqual(f.dispatches[0].input.body, body)
})
