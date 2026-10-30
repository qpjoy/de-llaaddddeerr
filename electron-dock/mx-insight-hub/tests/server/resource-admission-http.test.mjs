import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createApp } from '../../server/app.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { ResourcePolicy } from '../../server/core/resource-policy.mjs'
import { resourceCatalog } from '../../server/core/resource-catalog.mjs'
import { PUBLIC_OPENAPI_DOCUMENT } from '../../server/public-docs.mjs'
const key = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
const resources = resourceCatalog(PUBLIC_OPENAPI_DOCUMENT)

test('HTTP resource rules include LCY, retain running slots after disconnect and preserve admin recovery', async t => {
  let started, finish
  const entered = new Promise(resolve => { started = resolve })
  const held = new Promise(resolve => { finish = resolve })
  let calls = 0
  const policy = new ResourcePolicy({ catalog: resources.catalog })
  await policy.save({ expectedRevision: 0, reason: 'test', defaults: { maxConcurrency: 1, maxKeyConcurrency: 1, requestsPerSecond: 100, keyRequestsPerSecond: 100 }, rules: [] }, { actor: 'admin-token', requestId: randomUUID() })
  const service = { async authenticate() { return { apiKey: { id: key, hubRateLimitExempt: true } } }, async tokenize() {
    calls++; started(); if (calls === 1) await held
    return { status: 200, body: { tokens: [] }, requestId: randomUUID(), replay: false }
  } }
  const server = createServer(createApp({ service, store: new MemoryStore(), adapter: {}, resourcePolicy: policy, adminToken: 'test-admin', logger: { error() {} } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { finish(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const root = `http://127.0.0.1:${server.address().port}`, path = '/api/v1/tools/tokenize'
  const headers = { 'x-api-key': 'synthetic', 'content-type': 'application/json' }
  const abort = new AbortController()
  const first = fetch(root + path, { method: 'POST', headers, body: '{"text":"a"}', signal: abort.signal }).catch(() => null)
  await entered
  const second = await fetch(root + path, { method: 'POST', headers, body: '{}' })
  assert.equal(second.status, 429); assert.equal(second.headers.get('retry-after'), '1')
  assert.equal((await second.json()).error.code, 'resource_admission_limited'); assert.equal(calls, 1)
  abort.abort(); await first
  assert.equal((await fetch(root + path, { method: 'POST', headers, body: '{}' })).status, 429)
  const admin = { 'x-mx-insight-admin-token': 'test-admin', 'content-type': 'application/json' }
  assert.equal((await fetch(root + '/internal/v1/admin/data-products/resource-limits', { headers: admin })).status, 200)
  finish()
  // The handler's settlement/finally must finish, not merely the HTTP abort.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await fetch(root + path, { method: 'POST', headers, body: '{}' })).status, 200)
  assert.equal((await fetch(root + '/internal/v1/admin/data-products/resource-limits')).status, 401)
  const invalid = await fetch(root + '/internal/v1/admin/data-products/resource-limits', { method: 'PUT', headers: admin, body: JSON.stringify({ expectedRevision: 0, reason: 'stale', defaults: policy.value.defaults, rules: [] }) })
  assert.equal(invalid.status, 409)
})
