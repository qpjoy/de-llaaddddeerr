import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, request } from 'node:http'
import { createApp } from '../../server/app.mjs'
import { ConcurrencyAdmissionQueue } from '../../server/external-platforms/concurrency-admission.mjs'

const context = { tenant: { id: 'tenant' }, consumer: { id: 'consumer' }, apiKey: { id: 'key' } }
function bounded(promise) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('HTTP admission did not finish')), 2000) })])
    .finally(() => clearTimeout(timer))
}

test('public HTTP disconnect cancels admission across enterprise, search and IP entrances before dispatch', async t => {
  let started, finished
  const queue = new ConcurrencyAdmissionQueue()
  let dispatched = 0
  const waiting = async (_context, { signal }) => {
    started(signal)
    try {
      await queue.enter({ signal, maxPending: 32, deadline: Date.now() + 1500, tryEnter: () => false })
      dispatched++
      assert.fail('request must remain queued')
    } catch (error) { finished(error); throw error }
  }
  const service = { authenticate: async () => context, aggregateSearch: waiting, nightAllCompatibilitySearch: waiting, search: waiting }
  const app = createApp({ service, store: {}, adapter: {}, listenerMode: 'public', logger: { error() {} },
    enterpriseGateway: { queryEnterprise: waiting }, externalPlatformGateway: { search: waiting },
    socialAccountGateway: { searchAccounts: waiting }, socialAccountTikHubGateway: { searchAccounts: waiting },
    webSearchService: { search: waiting }, ipRiskProduct: { query: waiting }, ipRiskChannels: { query: waiting },
    ipRiskGateway: { query: waiting, batch: { query: waiting } } })
  const server = createServer(app)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  try {
    for (const [path, body] of [
      ['/api/v1/data/enterprise/1.31/query', {}],
      ['/api/v1/data/ecommerce/products/search', {}],
      ['/api/v1/data/social/accounts/search', { platform: 'xiaohongshu' }],
      ['/api/v1/data/web-search/search', {}],
      ['/api/v1/data/web-search/compatible/baidu', {}],
      ['/api/v1/data/ip/risk', {}], ['/api/v1/data/ip/risk/batch', {}],
      ['/api/v1/data/ip/risk/v2', {}], ['/api/v1/data/ip/risk/v2/batch', {}],
      ['/api/v1/data/ip/risk/service', {}], ['/api/v1/data/ip/risk/service/batch', {}],
      ['/api/v1/night-all/search/user-info', {}], ['/api/v1/search/raw', { platform: 'weibo' }],
      ['/api/v1/data/search', {}], ['/api/v1/data/aggregate/search', {}],
    ]) await t.test(path, async () => {
      const begin = new Promise(resolve => { started = resolve })
      const end = new Promise(resolve => { finished = resolve })
      const client = request({ host: '127.0.0.1', port: server.address().port, path, method: 'POST',
        headers: { authorization: 'Bearer mih_live_local_fixture', 'content-type': 'application/json' } })
      client.on('error', () => {})
      client.end(JSON.stringify(body))
      try {
        const signal = await bounded(begin)
        assert.ok(signal instanceof AbortSignal)
        assert.equal(queue.entries.length, 1)
        client.destroy()
        assert.equal((await bounded(end)).code, 'request_cancelled')
        assert.equal(signal.aborted, true)
        assert.equal(queue.entries.length, 0)
        assert.equal(dispatched, 0)
      } finally { client.destroy() }
    })
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
