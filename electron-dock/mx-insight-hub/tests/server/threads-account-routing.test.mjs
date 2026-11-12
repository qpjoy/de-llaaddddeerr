import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../../server/config.mjs'
import { createRuntime } from '../../server/index.mjs'
import { nativeForwardingEndpoint } from '../../server/contracts/native-forwarding.mjs'
import { normalizeHubSocialCompatRequest } from '../../server/contracts/hub-social-compat.mjs'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import { withSinglePage } from '../../server/contracts/single-page-delivery.mjs'
import { createDataSearchCursorCodec } from '../../server/external-platforms/cursor.mjs'

const pepper = 'offline-threads-routing-fixture-at-least-32-bytes'
const context = { tenant: { id: 'tenant' }, consumer: { id: 'consumer', businessId: 'example' }, apiKey: { id: 'key' } }
const recent = '/api/user/replies', reposts = '/api/user/reposts', lookup = '/api/search/profiles'
const tik = '/api/v1/threads/web/'

async function harness(t, disabled = []) {
  const runtime = await createRuntime(loadConfig({ MX_INSIGHT_STORE: 'memory', MX_INSIGHT_LISTENER_MODE: 'public', MX_INSIGHT_API_KEY_PEPPER: pepper }))
  t.after(async () => { runtime.agent.close(); await runtime.store.close() })
  const checks = []
  for (const [provider, gateway] of Object.entries(runtime.threadsGateways)) {
    gateway.nativeReadiness = async ({ consumerId, operationKeys }) => {
      assert.equal(consumerId, context.consumer.id)
      const paths = operationKeys.map(key => nativeForwardingEndpoint(key.slice('native.'.length)).path)
      checks.push({ provider, paths })
      return Object.fromEntries(operationKeys.map((key, index) => [key, !disabled.includes(paths[index])]))
    }
    gateway.socialAccountData = async () => provider
  }
  const send = (operation, body, idempotencyKey) => runtime.socialDataGateway.socialData(context, {
    operation, body: { platform: 'threads', ...body }, path: `/api/v1/data/social/${operation}`, idempotencyKey,
  })
  return { checks, runtime, send }
}

test('account routing checks requested activities and handle lookup for the whole batch', async t => {
  const h = await harness(t, [reposts])
  assert.equal(await h.send('crawl', { username: 'alice', userId: '42', activityTypes: ['replies', 'reposts'] }), 'tikhub')
  assert.deepEqual(h.checks.map(row => row.paths.sort()), [
    [lookup, recent, reposts].sort(),
    ['fetch_user_replies', 'fetch_user_reposts', 'fetch_user_info'].map(name => tik + name).sort(),
  ])
  h.checks.length = 0
  assert.equal(await h.send('crawl', { userId: '42', activityTypes: ['replies'] }), 'rapidapi')
  assert.deepEqual(h.checks, [{ provider: 'rapidapi', paths: [recent] }])
})

test('numeric profile and handle resolution use their own readiness controls on both suppliers', async t => {
  const h = await harness(t, [lookup, '/api/user/info'])
  assert.equal(await h.send('user-info', { userId: '42' }), 'tikhub')
  assert.deepEqual(h.checks.map(row => row.paths), [['/api/user/info'], [tik + 'fetch_user_info_by_id']])
  h.checks.length = 0
  assert.equal(await h.send('user-info', { profileUrl: 'https://www.threads.com/@alice' }), 'tikhub')
  assert.deepEqual(h.checks.map(row => row.paths), [[lookup, '/api/user/info'], [tik + 'fetch_user_info']])
})

test('a signed continuation and a saved first-page receipt stay on the original supplier', async t => {
  const h = await harness(t)
  const codec = createDataSearchCursorCodec(pepper, 'consumer:key:social:crawl')
  const cursor = codec.encode({ provider: 'tikhub' })
  assert.equal(await h.send('crawl', { userId: '42', params: { cursor } }), 'tikhub')
  const body = { platform: 'threads', userId: '42' }, path = '/api/v1/data/social/crawl'
  const original = normalizeHubSocialCompatRequest('crawl', body, { businessId: 'example', provider: 'tikhub' })
  const saved = { platform: 'threads', tenantId: 'tenant', apiKeyId: 'key', acquisitionRequest: { path },
    fingerprint: requestFingerprint({ method: 'POST', path, body: withSinglePage(original, true).fingerprintBody }) }
  t.mock.method(h.runtime.store, 'getUsageRequestByIdempotencyKey', async () => saved)
  assert.equal(await h.send('crawl', body, 'existing-account-delivery'), 'tikhub')
  assert.deepEqual(h.checks, [], 'replay and continuations are independent of current provider readiness')
})
