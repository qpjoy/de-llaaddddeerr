import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../../server/index.mjs'
import { loadConfig } from '../../server/config.mjs'
import { HUB_SOCIAL_COMPAT_PLATFORMS } from '../../shared/social-account-contract.mjs'

test('social account runtime owns every declared platform route and never selects the Night-All compatibility adapter', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Offline routing must not dispatch') })
  const runtime = await createRuntime(loadConfig({ MX_INSIGHT_STORE: 'memory', MX_INSIGHT_LISTENER_MODE: 'public',
    MX_INSIGHT_API_KEY_PEPPER: 'social-runtime-fixture-pepper-at-least-32-characters' }))
  t.after(async () => { runtime.agent.close(); await runtime.store.close(); assert.equal(network.mock.callCount(), 0) })
  for (const platform of HUB_SOCIAL_COMPAT_PLATFORMS) {
    const gateway = runtime.socialAccountDataGateways[platform]
    assert.equal(gateway.platformStore.authorizationPlatform, platform)
    assert.equal(gateway.providerKey, platform === 'twitter' ? 'rapidapi' : platform === 'facebook' ? 'justone' : 'tikhub')
    const calls = []
    gateway.socialAccountData = async (context, input) => { calls.push({ context, input }); return platform }
    for (const operation of ['crawl', 'user-info']) {
      const context = { fixture: platform }, input = { operation, path: `/api/v1/data/social/${operation}`, body: { platform, userId: '42' } }
      assert.equal(await runtime.socialDataGateway.socialData(context, input), platform)
      assert.deepEqual(calls.at(-1), { context, input })
    }
  }
  runtime.hubSocialGateway.socialData = async () => 'existing-social-search'
  assert.equal(await runtime.socialDataGateway.socialData({}, { operation: 'search' }), 'existing-social-search')
  assert.throws(() => runtime.socialDataGateway.socialData({}, { operation: 'crawl', body: { platform: 'unreviewed', userId: '42' } }), { status: 400 })
})
