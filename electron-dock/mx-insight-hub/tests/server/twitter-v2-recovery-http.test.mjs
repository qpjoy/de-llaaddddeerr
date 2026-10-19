import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createApp } from '../../server/app.mjs'
import { AppError } from '../../server/core/errors.mjs'
import { PUBLIC_OPENAPI_DOCUMENT, tenantOpenApiDocument } from '../../server/public-docs.mjs'

const KEY = 'mih_live_recovery_http_fixture'
async function fixture(t, listenerMode = 'combined') {
  const reads = [], sends = [], context = { tenant: { id: randomUUID() }, consumer: { id: randomUUID() }, apiKey: { id: randomUUID() } }
  const server = createServer(createApp({ store: {}, adapter: {}, listenerMode,
    service: {
      authenticate: async key => {
        if (key !== KEY) throw new AppError(401, 'invalid_api_key', 'Invalid key')
        return context
      },
      twitterSearchRecovery: async (ctx, id) => {
        reads.push({ ctx, id })
        return { contractVersion: 'mx-insight-hub.data-search-recovery.v1', originalRequestId: id,
          platform: 'twitter', state: 'unknown', successor: null, delivery: null }
      },
      search: async (ctx, input) => {
        sends.push({ ctx, input })
        return { status: 200, requestId: randomUUID(), body: { data: {} }, replay: false }
      },
    }, logger: { error() {} },
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { url: `http://127.0.0.1:${server.address().port}`, reads, sends, context }
}

test('saved Twitter v2 recovery is an authenticated no-store read and never starts a search', async t => {
  const f = await fixture(t), id = randomUUID(), path = `/api/v1/requests/${id}/search-recovery`
  assert.equal((await fetch(f.url + path)).status, 401)
  assert.equal((await fetch(f.url + path, { headers: { authorization: 'Bearer invalid' } })).status, 401)
  assert.equal(f.reads.length, 0)
  const headers = { authorization: `Bearer ${KEY}` }
  const response = await fetch(f.url + path, { headers })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal((await response.json()).data.originalRequestId, id)
  assert.deepEqual(f.reads, [{ ctx: f.context, id }])
  assert.equal((await fetch(f.url + path + '?send=true', { headers })).status, 400)
  assert.equal((await fetch(f.url + path, { method: 'POST', headers })).status, 404)
  assert.equal(f.reads.length, 1)
  assert.equal(f.sends.length, 0)
})

test('saved recovery remains on the Public listener and v2 POST preserves explicit retry identity', async t => {
  const admin = await fixture(t, 'admin'), publicApi = await fixture(t, 'public'), id = randomUUID()
  const headers = { authorization: `Bearer ${KEY}` }
  assert.equal((await fetch(`${admin.url}/api/v1/requests/${id}/search-recovery`, { headers })).status, 404)
  assert.equal(admin.reads.length, 0)
  assert.equal((await fetch(`${publicApi.url}/api/v1/requests/${id}/search-recovery`, { headers })).status, 200)
  const body = { platform: 'twitter', query: 'synthetic recovery fixture', pageSize: 20, type: 'fresh',
    timeWindow: { from: '2026-10-18T00:00:00.000Z', to: '2026-10-19T00:00:00.000Z', timezone: 'Asia/Shanghai', boundary: '[from,to)' } }
  const response = await fetch(publicApi.url + '/api/v2/data/search', { method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': 'v2-retry-fixture-key', 'x-mx-insight-retry-of': id },
    body: JSON.stringify(body) })
  assert.equal(response.status, 200)
  assert.equal(publicApi.sends.length, 1)
  assert.deepEqual(publicApi.sends[0].input.body, body)
  assert.equal(publicApi.sends[0].input.retryOfRequestId, id)
  assert.equal(publicApi.sends[0].input.idempotencyKey, 'v2-retry-fixture-key')
})

test('machine docs distinguish explicit charged Twitter retry from read-only v2 delivery recovery', () => {
  const post = PUBLIC_OPENAPI_DOCUMENT.paths['/api/v2/data/search'].post
  const retry = post.parameters.find(value => value.name === 'X-MX-Insight-Retry-Of')
  assert.equal(retry.required, false)
  assert.match(retry.description, /unknown Twitter v2 request only/)
  assert.match(retry.description, /another charge may occur/)
  assert.match(retry.description, /exact saved normalized v2 body\/window\/cursor/)
  const path = '/requests/{requestId}/search-recovery'
  assert.equal(PUBLIC_OPENAPI_DOCUMENT.paths[path].get.operationId, 'readSearchRecovery')
  assert.match(PUBLIC_OPENAPI_DOCUMENT.paths[path].get.description, /Never reserves, dispatches, reaps, projects or purchases/)
  const twitter = tenantOpenApiDocument([{ platforms: ['twitter'], capabilities: [] }])
  const other = tenantOpenApiDocument([{ platforms: ['facebook'], capabilities: [] }])
  assert.ok(twitter.paths[path])
  assert.equal(other.paths[path], undefined)
})
