import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createApp } from '../../server/app.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

test('Hub limit switch requires Admin Token, stays private on Public, rejects injected flags and checks revisions', async t => {
  const store = new MemoryStore()
  const keyId = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
  const tenantId = '277bf8a4-5ed5-414d-b429-d72fcd7d36b6'
  const consumerId = 'be7d07fe-3d98-4db3-b00d-e5cbe5a76190'
  store.tenants.set(tenantId, { id: tenantId, status: 'active' })
  store.consumers.set(consumerId, { id: consumerId, tenantId, status: 'active' })
  store.apiKeys.set(keyId, { id: keyId, tenantId, consumerId, status: 'active', environment: 'live',
    expiresAt: '2099-01-01', accessProfile: 'managed_full' })
  const siblingId = randomUUID()
  store.apiKeys.set(siblingId, { ...store.apiKeys.get(keyId), id: siblingId, name: 'LCY-delta' })
  async function listen(listenerMode = 'combined') {
    const server = createServer(createApp({ service: {}, store, adapter: {}, listenerMode,
      adminToken: 'local-key-hub-limit-admin', logger: { error() {} },
      identity: { enabled: true, async resolve(token) { return { kind: 'launcher-user', memberId: token,
        platformAdmin: token === 'platform-admin', capabilities: [], memberships: [], tenantIds: [] } } },
    }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    return `http://127.0.0.1:${server.address().port}/internal/v1/admin/api-keys/${keyId}/hub-limits`
  }
  const url = await listen(), publicUrl = await listen('public')
  const headers = { 'x-mx-insight-admin-token': 'local-key-hub-limit-admin', 'content-type': 'application/json' }
  const input = { hubRateLimitExempt: true, revision: 0, reason: 'Explicit operator policy' }
  for (const method of ['GET', 'PUT']) {
    const extra = method === 'PUT' ? { body: JSON.stringify(input) } : {}
    assert.equal((await fetch(url, { method, ...extra })).status, 401)
    for (const token of ['tenant-admin', 'platform-admin', 'mih_live_example']) {
      assert.equal((await fetch(url, { method, headers: { authorization: `Bearer ${token}` }, ...extra })).status, 403)
    }
    assert.equal((await fetch(publicUrl, { method, headers, ...extra })).status, 404)
    assert.equal((await fetch(url.replace(keyId, siblingId), { method, headers, ...extra })).status, 403)
    assert.equal((await fetch(url + '?hubRateLimitExempt=true', { method, headers, ...extra })).status, 400)
  }
  assert.equal(store.keyHubLimitEvents, undefined)
  const read = await fetch(url, { headers })
  assert.equal(read.status, 200)
  assert.match(read.headers.get('cache-control'), /no-store/)
  assert.equal((await read.json()).data.source, 'legacy')
  assert.equal(store.keyHubLimitEvents, undefined)
  for (const body of [{ ...input, accessProfile: 'managed_full' }, { ...input, hubRateLimitExempt: null }]) {
    assert.equal((await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) })).status, 400)
  }
  const saved = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(input) })
  assert.equal(saved.status, 200)
  assert.match(saved.headers.get('cache-control'), /no-store/)
  assert.equal((await saved.json()).data.effectiveExempt, true)
  assert.equal(store.keyHubLimitEvents.length, 1)
  assert.ok(store.keyHubLimitEvents[0].requestId)
  const stale = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(input) })
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).error.code, 'api_key_hub_limits_changed')
  assert.equal(store.keyHubLimitEvents.length, 1)
})
