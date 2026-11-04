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
  const checks = []
  const server = createServer(createApp({ store, service, adapter, strategySearchRoutingStore: routing,
    platformSearchPolicyStore: { list: async () => [facebook], requestRapidCheck: async input => {
      checks.push(input); return { dispatched: false }
    } }, adminToken: 'fixture-admin',
    identity: { enabled: true, resolve: async () => ({ kind: 'launcher', platformAdmin: true, tenantIds: null }) },
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
  assert.equal(search.platforms.find(row => row.platform === 'twitter').policy.primaryProvider, 'rapidapi')
  assert.equal(search.platforms.find(row => row.platform === 'twitter').policy.fallbackProvider, 'tikhub')
  assert.equal((await fetch(`${base}?provider=tikhub`, { headers })).status, 400)
  const body = { mode: 'fixed', primaryProvider: 'tikhub', fallbackProvider: null, expectedRevision: 1, reason: 'Reviewed alternative' }
  const save = (path, value = body, auth = headers) => fetch(`${base}/${path}`, {
    method: 'PUT', headers: auth, body: JSON.stringify(value),
  })
  assert.equal((await save('search/instagram', body, { 'content-type': 'application/json' })).status, 401)
  assert.equal((await save('search/instagram')).status, 200)
  assert.equal((await save('search/instagram')).status, 409)
  assert.equal((await save('crawl/instagram')).status, 400)
  assert.equal((await save('search/twitter', body, { ...headers, authorization: 'Bearer launcher-admin' })).status, 403)
  assert.equal((await fetch(base, { headers: { authorization: 'Bearer launcher-admin' } })).status, 403)
  assert.equal((await save('search/twitter', body, { ...headers, authorization: 'Bearer mih_live_fixture' })).status, 403)
  assert.equal((await save('search/twitter')).status, 200)
  assert.equal((await save('search/twitter')).status, 409)
  assert.equal((await save('search/twitter', { ...body, expectedRevision: 2, primaryProvider: 'justone' })).status, 400)
  assert.equal((await save('raw/twitter')).status, 400)
  assert.equal((await save('crawl/twitter')).status, 400)
  assert.equal((await save('user-info/twitter')).status, 400)
  assert.equal((await save('search/instagram', { ...body, expectedRevision: 2, primaryProvider: 'rapidapi' })).status, 400)
  assert.equal((await routing.get('search', 'instagram')).primaryProvider, 'tikhub')
  assert.equal((await routing.get('search', 'twitter')).primaryProvider, 'tikhub')
  assert.equal(routing.events.length, 2)
  const accountPause = { mode: 'paused', primaryProvider: 'justone', fallbackProvider: null, expectedRevision: 1, reason: 'Pause Facebook profiles only' }
  for (const interfaceId of ['crawl', 'user-info']) {
    const row = data.interfaces.find(item => item.id === interfaceId).platforms.find(item => item.platform === 'facebook')
    assert.equal(row.editable, true)
    assert.deepEqual(row.allowedModes, ['fixed', 'paused'])
    assert.equal(row.policy.mode, 'fixed')
  }
  assert.equal((await save('user-info/facebook', accountPause, { ...headers, authorization: 'Bearer launcher-admin' })).status, 403)
  assert.equal((await save('user-info/facebook', accountPause, { ...headers, authorization: 'Bearer mih_live_fixture' })).status, 403)
  assert.equal((await save('user-info/facebook', { ...accountPause, primaryProvider: 'rapidapi' })).status, 400)
  assert.equal((await save('user-info/facebook', accountPause)).status, 200)
  assert.equal((await save('user-info/facebook', accountPause)).status, 409)
  const refreshed = (await (await fetch(base, { headers })).json()).data
  assert.equal(refreshed.interfaces.find(item => item.id === 'user-info').platforms.find(item => item.platform === 'facebook').policy.mode, 'paused')
  assert.equal((await routing.get('crawl', 'facebook')).mode, 'fixed')
  assert.deepEqual(refreshed.interfaces.find(item => item.id === 'search').platforms.find(item => item.platform === 'facebook').policy, facebook)
  assert.equal(routing.events.length, 3)
  const checkUrl = base.replace('/strategy-search', '/platform-search-policies/facebook/quota-check')
  const checkBody = { expectedObservedAt: '2026-10-30T00:00:00.000Z', reason: 'One explicit check' }
  const check = (auth, url = checkUrl) => fetch(url, { method: 'POST', headers: auth, body: JSON.stringify(checkBody) })
  assert.equal((await check({ 'content-type': 'application/json' })).status, 401)
  assert.equal((await check({ ...headers, authorization: 'Bearer launcher-admin' })).status, 403)
  assert.equal((await check({ ...headers, authorization: 'Bearer mih_live_fixture' })).status, 403)
  assert.equal((await check(headers, `${checkUrl}?force=true`)).status, 400)
  assert.equal(checks.length, 0)
  const checked = await check(headers)
  assert.equal(checked.status, 200)
  assert.equal((await checked.json()).data.dispatched, false)
  assert.deepEqual(checks, [checkBody])
  assert.equal(store.requests.size, 0)
})
