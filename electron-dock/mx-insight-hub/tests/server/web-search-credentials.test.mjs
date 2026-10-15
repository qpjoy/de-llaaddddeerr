import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import { MultiExternalPlatformAdminService } from '../../server/external-platforms/admin.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { createWebSearchRuntime } from '../../server/web-search/runtime.mjs'
import { WEB_SEARCH_PROVIDERS } from '../../shared/web-search.mjs'

const ADMIN_TOKEN = 'web-search-credential-test-admin-at-least-32-bytes'
const PEPPER = 'web-search-credential-test-pepper-never-live'
const secretFor = key => `synthetic-${key}-supplier-secret`

function fixture() {
  const store = new MemoryStore()
  const runtime = createWebSearchRuntime({
    pool: null,
    store,
    controls: new MemoryExternalPlatformControlStore(),
    config: { apiKeyPepper: PEPPER, listenerMode: 'admin', reservationLeaseMs: 150000 },
  })
  const admin = new MultiExternalPlatformAdminService(runtime.admins)
  return { store, runtime, admin }
}

test('all eight Web Search suppliers retain editable metadata and isolated encrypted credentials', async () => {
  const { admin, runtime } = fixture()
  for (const { key } of WEB_SEARCH_PROVIDERS) {
    const before = await admin.detail(key, '24h')
    assert.deepEqual(before.credential.fields, [{ name: 'apiKey', label: 'API Key' }])
    assert.equal(before.credential.revealable, false)
    await assert.rejects(admin.revealCredential(key), { code: 'external_platform_credential_not_revealable' })

    const saved = await admin.updateCredential(key, {
      credentials: { apiKey: secretFor(key) }, expectedRevision: 0,
    })
    assert.equal(saved.revision, 1)
    assert.equal(saved.source, 'database')
    assert.equal(saved.revealable, true)
    const detail = await admin.detail(key, '24h')
    assert.deepEqual(detail.credential.fields, [{ name: 'apiKey', label: 'API Key' }])
    assert.equal(detail.credential.revision, 1)
    assert.equal(detail.provider.key, key)
    assert.equal(JSON.stringify(detail).includes(secretFor(key)), false)
    assert.equal(JSON.stringify(saved).includes(secretFor(key)), false)

    const credentialStore = runtime.gateways.get(key).credentialStore
    const atRest = await credentialStore.storage.readCredential(key)
    assert.match(atRest, /^bundle1\./)
    assert.equal(atRest.includes(secretFor(key)), false)
    assert.deepEqual(await admin.revealCredential(key), { credentials: { apiKey: secretFor(key) } })
    await assert.rejects(admin.updateCredential(key, {
      credentials: { apiKey: `replacement-${key}-secret` }, expectedRevision: 0,
    }), { code: 'external_platform_credential_revision_conflict' })
    assert.deepEqual(await admin.revealCredential(key), { credentials: { apiKey: secretFor(key) } })
    assert.equal(runtime.gateways.get(key).adapter, null, 'Admin management never instantiates an upstream adapter')
  }
  const overview = await admin.overview('24h')
  for (const { key } of WEB_SEARCH_PROVIDERS) assert.equal(JSON.stringify(overview).includes(secretFor(key)), false)
})

test('Web Search credential ciphertext cannot be reused across providers or echoed in errors', async () => {
  const { admin, runtime } = fixture()
  await admin.updateCredential('baidu', { credentials: { apiKey: secretFor('baidu') }, expectedRevision: 0 })
  const baiduStore = runtime.gateways.get('baidu').credentialStore
  const exaStore = runtime.gateways.get('exa').credentialStore
  const ciphertext = await baiduStore.storage.readCredential('baidu')
  await exaStore.storage.updateCredential('exa', { apiKey: ciphertext, expectedRevision: 0 })
  await assert.rejects(admin.revealCredential('exa'), error => {
    assert.equal(error.code, 'external_platform_credential_store_unavailable')
    assert.equal(error.status, 503)
    assert.equal(JSON.stringify(error).includes(secretFor('baidu')), false)
    assert.equal(JSON.stringify(error).includes(ciphertext), false)
    return true
  })
  assert.deepEqual(await admin.revealCredential('baidu'), { credentials: { apiKey: secretFor('baidu') } })
})

test('every supplier reveal requires an Admin Token session and a second token check without cache or secret errors', async () => {
  const { admin, store } = fixture()
  const logs = []
  const server = createServer(createApp({
    service: {}, store, adapter: {}, externalPlatformAdmin: admin, adminToken: ADMIN_TOKEN,
    identity: {
      enabled: true,
      async resolve(credential) {
        return credential === 'launcher-platform-admin'
          ? { kind: 'launcher-user', platformAdmin: true, memberId: 'member-fixture', tenantIds: null, capabilities: [], memberships: [] }
          : null
      },
    },
    logger: { error(...args) { logs.push(args) }, warn(...args) { logs.push(args) } },
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const headers = { 'x-mx-insight-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' }
    for (const { key } of WEB_SEARCH_PROVIDERS) {
      const path = `${base}/internal/v1/admin/external-platforms/${key}/credential`
      const save = await fetch(path, { method: 'PUT', headers, body: JSON.stringify({ credentials: { apiKey: secretFor(key) }, expectedRevision: 0 }) })
      assert.equal(save.status, 200)
      assert.equal((await save.text()).includes(secretFor(key)), false)

      for (const candidate of [
        { headers, body: { adminToken: 'wrong-token' }, status: 403 },
        { headers, body: { adminToken: ADMIN_TOKEN, apiKey: secretFor(key) }, status: 400 },
        { headers: { authorization: 'Bearer launcher-platform-admin', 'content-type': 'application/json' }, body: { adminToken: ADMIN_TOKEN }, status: 403 },
        { headers: { authorization: 'Bearer mih_live_synthetic-key', 'content-type': 'application/json' }, body: { adminToken: ADMIN_TOKEN }, status: 403 },
      ]) {
        const denied = await fetch(`${path}/reveal`, { method: 'POST', headers: candidate.headers, body: JSON.stringify(candidate.body) })
        assert.equal(denied.status, candidate.status)
        const output = await denied.text()
        assert.equal(output.includes(secretFor(key)), false)
        assert.equal(output.includes(ADMIN_TOKEN), false)
      }
      const reveal = await fetch(`${path}/reveal`, { method: 'POST', headers, body: JSON.stringify({ adminToken: ADMIN_TOKEN }) })
      assert.equal(reveal.status, 200)
      assert.match(reveal.headers.get('cache-control'), /no-store/)
      assert.deepEqual((await reveal.json()).data, { credentials: { apiKey: secretFor(key) } })
    }
    for (const { key } of WEB_SEARCH_PROVIDERS) assert.equal(JSON.stringify(logs).includes(secretFor(key)), false)
    assert.equal(JSON.stringify(logs).includes(ADMIN_TOKEN), false)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
