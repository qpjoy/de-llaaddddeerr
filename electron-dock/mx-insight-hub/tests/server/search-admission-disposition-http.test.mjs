import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createApp } from '../../server/app.mjs'

test('historical search admission disposition requires Admin Token and never dispatches', async t => {
  const events = [], dispatches = [], id = randomUUID()
  const path = `/internal/v1/admin/acquisitions/${id}/search-admission-disposition`
  async function listen({ listenerMode = 'combined', available = true } = {}) {
    const server = createServer(createApp({
      store: {}, adapter: {}, adminToken: 'local-disposition-admin', listenerMode,
      service: { search: async () => { dispatches.push('search') } },
      identity: { enabled: true, async resolve(token) { return { kind: 'launcher-user', memberId: token,
        platformAdmin: token === 'platform-admin', capabilities: [], memberships: [], tenantIds: [] } } },
      searchAdmissionDisposition: available ? {
        async prepare(requestId) { events.push(['read', requestId]); return { requestId, disposition: null } },
        async resolve(requestId, body, actor) {
          events.push(['resolve', requestId, body, actor]); return { requestId, upstreamDispatched: false }
        },
      } : null,
      logger: { error() {} },
    }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    return `http://127.0.0.1:${server.address().port}${path}`
  }
  const url = await listen(), hidden = await listen({ listenerMode: 'public' }), missing = await listen({ available: false })
  const headers = { 'x-mx-insight-admin-token': 'local-disposition-admin', 'content-type': 'application/json' }
  for (const method of ['GET', 'POST']) {
    assert.equal((await fetch(url, { method })).status, 401)
    for (const token of ['platform-admin', 'tenant-user', 'mih_live_example']) {
      assert.equal((await fetch(url, { method, headers: { authorization: `Bearer ${token}` } })).status, 403)
    }
    assert.equal((await fetch(hidden, { method, headers })).status, 404)
    assert.equal((await fetch(missing, { method, headers })).status, 503)
    assert.equal((await fetch(url + '?send=true', { method, headers })).status, 400)
  }
  assert.deepEqual(events, [])
  const read = await fetch(url, { headers })
  assert.equal(read.status, 200)
  assert.equal(read.headers.get('cache-control'), 'private, no-store')
  assert.equal((await read.json()).data.requestId, id)
  assert.deepEqual(events, [['read', id]])
  const body = { revision: 'reviewed-evidence', reason: 'Continue future collection', acceptUnknownRisk: true }
  const saved = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  assert.equal(saved.status, 200)
  assert.equal(saved.headers.get('cache-control'), 'private, no-store')
  assert.equal((await saved.json()).data.upstreamDispatched, false)
  assert.deepEqual(events[1].slice(0, 3), ['resolve', id, body])
  assert.equal(events[1][3].actor, 'admin-token')
  assert.ok(events[1][3].requestId)
  assert.deepEqual(dispatches, [])
})
