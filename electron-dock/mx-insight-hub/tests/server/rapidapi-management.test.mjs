import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { createApp } from '../../server/app.mjs'
import { ExternalPlatformAdminService } from '../../server/external-platforms/admin.mjs'
import { MemoryExternalPlatformCredentialStore } from '../../server/external-platforms/credentials-store.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { RAPIDAPI_METADATA, rapidApiConfig } from '../../server/external-platforms/rapidapi-config.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { normalizeHubSocialRequest } from '../../server/contracts/hub-social.mjs'
import { createRapidApiProxyFetch } from '../../server/external-platforms/proxy.mjs'

const ADMIN = 'synthetic-management-admin-token-at-least-32-bytes'
const SECRET = 'synthetic-rapidapi-management-secret'

test('RapidAPI credential save/reveal and proxy update require Admin Token; detail remains secretless', async () => {
  const credentials = new MemoryExternalPlatformCredentialStore({ providerKey: 'rapidapi' })
  const updates = []
  const proxy = { mode: 'system-egress', sequenceKey: null, revision: 1, sequences: [] }
  const externalPlatformAdmin = new ExternalPlatformAdminService({
    store: new MemoryExternalPlatformStore({ providerKey: 'rapidapi' }), config: rapidApiConfig(),
    providerKey: 'rapidapi', metadata: RAPIDAPI_METADATA, credentialStore: credentials,
    proxyStore: { describe: async () => proxy, update: async body => { updates.push(body); return { ...proxy, revision: 2 } } },
  })
  const app = createApp({ service: {}, store: { ping: async () => true }, adapter: {}, adminToken: ADMIN, externalPlatformAdmin,
    identity: { enabled: true, resolve: async credential => credential === 'launcher-admin-fixture' ? { kind: 'launcher-user', memberId: 'fixture', platformAdmin: true, tenantIds: null, capabilities: [], memberships: [] } : null },
    logger: { error() {}, warn() {} },
  })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/internal/v1/admin/external-platforms/rapidapi`
  const headers = { 'x-mx-insight-admin-token': ADMIN, 'content-type': 'application/json' }
  try {
    const saved = await fetch(base+'/credential', { method: 'PUT', headers, body: JSON.stringify({ apiKey: SECRET, expectedRevision: 0 }) })
    assert.equal(saved.status, 200)
    assert.doesNotMatch(await saved.text(), new RegExp(SECRET))
    const detail = await fetch(base+'?range=24h', { headers })
    const dto = await detail.json()
    assert.equal(dto.data.credential.revealable, true)
    assert.equal(dto.data.proxy.mode, 'system-egress')
    assert.doesNotMatch(JSON.stringify(dto), new RegExp(SECRET))
    const wrong = await fetch(base+'/credential/reveal', { method: 'POST', headers, body: JSON.stringify({ adminToken: 'wrong' }) })
    assert.equal(wrong.status, 403)
    const reveal = await fetch(base+'/credential/reveal', { method: 'POST', headers, body: JSON.stringify({ adminToken: ADMIN }) })
    assert.equal(reveal.status, 200)
    assert.match(reveal.headers.get('cache-control'), /no-store/)
    assert.deepEqual((await reveal.json()).data, { apiKey: SECRET })
    for (const path of ['/credential/reveal','/proxy']) {
      const denied = await fetch(base+path, { method: path === '/proxy' ? 'PUT' : 'POST', headers: { authorization: 'Bearer launcher-admin-fixture', 'content-type': 'application/json' }, body: JSON.stringify({ adminToken: ADMIN }) })
      assert.equal(denied.status, 403)
    }
    const body = { mode: 'inherit', expectedRevision: 1, reason: 'synthetic proxy setting' }
    assert.equal((await fetch(base+'/proxy', { method: 'PUT', headers, body: JSON.stringify(body) })).status, 200)
    assert.deepEqual(updates, [body])
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('RapidAPI unreachable proxy is a known unbilled pre-dispatch failure, with no secret in diagnostics', async () => {
  let paid = 0
  const failures = []
  const proxyFetch = createRapidApiProxyFetch({
    route: async () => ({ proxyUrls: ['http://user:proxy-secret@proxy:7788'], directFallback: false }),
    recordProbeFailure: async value => failures.push(value),
  }, {
    makeAgent: () => ({ close: async () => {} }),
    fetchImpl: async (url, options) => {
      if (String(url).includes('/search/')) paid++
      assert.equal(options.headers, undefined)
      return new Response('', { status: 502 })
    },
  })
  const adapter = new RapidApiAdapter({ apiKey: SECRET, fetchImpl: proxyFetch })
  await assert.rejects(adapter.execute(normalizeHubSocialRequest('search', { platform: 'twitter', query: 'test' })), error => {
    assert.equal(error.evidence.outcome, 'rejected')
    assert.equal(error.evidence.billed, false)
    assert.equal(error.evidence.errorCode, 'social_egress_unavailable')
    assert.doesNotMatch(JSON.stringify(error), /proxy-secret|synthetic-rapidapi-management-secret/)
    return true
  })
  assert.equal(paid, 0)
  assert.equal(failures[0].providerKey, 'rapidapi')
  assert.doesNotMatch(JSON.stringify(failures), /proxy-secret/)
})
