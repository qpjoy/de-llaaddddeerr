import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { StrategySearchRoutingStore } from '../../server/external-platforms/strategy-search-routing.mjs'

test('strategy search administration is authenticated, revisioned and never dispatches acquisition', async t => {
  const store = new MemoryStore()
  const routing = new StrategySearchRoutingStore()
  const adapter = { search() { throw new Error('administration must not search') } }
  const service = new HubService({ store, adapter, apiKeyPepper: 'strategy-search-offline-fixture-secret' })
  const facebook = { platform: 'facebook', mode: 'auto', revision: 9, monthly_limit: 1000, used: 538, remaining: 462 }
  const server = createServer(createApp({ store, service, adapter, strategySearchRoutingStore: routing,
    platformSearchPolicyStore: { list: async () => [facebook] }, adminToken: 'fixture-admin',
    listenerMode: 'admin', logger: { error() {} } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/internal/v1/admin/strategy-search`
  assert.equal((await fetch(base)).status, 401)
  const headers = { authorization: 'Bearer fixture-admin', 'content-type': 'application/json' }
  const response = await fetch(base, { headers })
  assert.equal(response.status, 200)
  const { data } = await response.json()
  const search = data.interfaces.find(row => row.id === 'search')
  assert.equal(search.platforms.find(row => row.platform === 'instagram').policy.primaryProvider, 'justone')
  assert.deepEqual(search.platforms.find(row => row.platform === 'facebook').policy, facebook)
  assert.equal((await fetch(`${base}?provider=tikhub`, { headers })).status, 400)
  const body = { mode: 'fixed', primaryProvider: 'tikhub', fallbackProvider: null, expectedRevision: 1, reason: 'Reviewed alternative' }
  const save = (path, value = body, auth = headers) => fetch(`${base}/${path}`, {
    method: 'PUT', headers: auth, body: JSON.stringify(value),
  })
  assert.equal((await save('search/instagram', body, { 'content-type': 'application/json' })).status, 401)
  assert.equal((await save('search/instagram')).status, 200)
  assert.equal((await save('search/instagram')).status, 409)
  assert.equal((await save('crawl/instagram')).status, 400)
  assert.equal((await save('search/twitter')).status, 400)
  assert.equal((await save('search/instagram', { ...body, expectedRevision: 2, primaryProvider: 'rapidapi' })).status, 400)
  assert.equal((await routing.get('search', 'instagram')).primaryProvider, 'tikhub')
  assert.equal(routing.events.length, 1)
  assert.equal(store.requests.size, 0)
})
