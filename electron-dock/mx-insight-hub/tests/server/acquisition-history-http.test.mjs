import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import { AppError } from '../../server/core/errors.mjs'

const ADMIN_TOKEN = 'acquisition-history-admin-token'
const API_KEY = 'mih_live_acquisition_history_test'
const CONSUMER_ID = randomUUID()
const API_KEY_ID = randomUUID()

test('request diagnostics is explicit, admin-token only, no-store and hidden on Public listener', async () => {
  const calls = []
  const acquisitionHistory = { async getAdminDiagnostics(identifier) {
    calls.push(identifier)
    return { identifier, runs: [] }
  } }
  const server = await listen(fixtureApp({ acquisitionHistory }))
  const publicServer = await listen(fixtureApp({ acquisitionHistory, listenerMode: 'public' }))
  const unavailableServer = await listen(fixtureApp())
  const path = '/internal/v1/admin/request-diagnostics/req_abc_123'
  const headers = { 'x-mx-insight-admin-token': ADMIN_TOKEN }
  try {
    assert.equal((await fetch(server.baseUrl + path)).status, 401)
    const keyResponse = await fetch(server.baseUrl + path, { headers: { authorization: `Bearer ${API_KEY}` } })
    assert.ok([401, 403].includes(keyResponse.status))
    assert.equal(calls.length, 0)
    const response = await fetch(server.baseUrl + path, { headers })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('cache-control'), /no-store/)
    assert.equal((await response.json()).data.identifier, 'req_abc_123')
    assert.equal((await fetch(server.baseUrl + path + '?raw=true', { headers })).status, 400)
    assert.equal((await fetch(publicServer.baseUrl + path, { headers })).status, 404)
    assert.equal((await fetch(unavailableServer.baseUrl + path, { headers })).status, 503)
    assert.deepEqual(calls, ['req_abc_123'])
  } finally {
    await Promise.all([server.close(), publicServer.close(), unavailableServer.close()])
  }
})

test('Launcher sessions including platform administrators cannot access request diagnostics', async () => {
  const server = await listen(fixtureApp({
    identity: { enabled: true, async resolve(token) {
      return { kind: 'launcher-user', memberId: token, platformAdmin: token === 'platform-admin',
        capabilities: [], memberships: [], tenantIds: token === 'platform-admin' ? null : [] }
    } },
    acquisitionHistory: { async getAdminDiagnostics() { assert.fail('diagnostics accessed') } },
  }))
  try {
    for (const token of ['tenant-admin', 'platform-admin']) {
      const response = await fetch(`${server.baseUrl}/internal/v1/admin/request-diagnostics/req_abc_123`, {
        headers: { authorization: `Bearer ${token}` },
      })
      assert.equal(response.status, 403)
      assert.equal((await response.json()).error.code, 'admin_token_required')
    }
  } finally { await server.close() }
})

async function listen(app) {
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function fixtureApp({ listenerMode = 'combined', acquisitionHistory = null, identity = null } = {}) {
  return createApp({
    service: {
      async authenticate(secret) {
        if (secret !== API_KEY) throw new AppError(401, 'invalid_api_key', 'invalid API key')
        return { consumer: { id: CONSUMER_ID }, apiKey: { id: API_KEY_ID } }
      },
    },
    store: {},
    adapter: {},
    adminToken: ADMIN_TOKEN,
    acquisitionHistory,
    identity,
    listenerMode,
    logger: { error() {} },
  })
}

test('acquisition history routes keep admin evidence separate from owner-scoped public history', async () => {
  const requestId = randomUUID()
  const calls = []
  const acquisitionHistory = {
    async getAdminDeliveredRun(value) {
      calls.push({ audience: 'admin', requestId: value })
      return { requestId: value, owner: { consumerId: CONSUMER_ID }, costLineage: { providerCalls: [] } }
    },
    async getPublicDeliveredRun(value) {
      calls.push({ audience: 'public', ...value })
      return { requestId: value.requestId, delivered: { responseBody: { data: 'original' } } }
    },
  }
  const server = await listen(fixtureApp({ acquisitionHistory }))
  try {
    const unauthorizedAdmin = await fetch(`${server.baseUrl}/internal/v1/admin/acquisitions/${requestId}`)
    assert.equal(unauthorizedAdmin.status, 401)

    const admin = await fetch(`${server.baseUrl}/internal/v1/admin/acquisitions/${requestId}`, {
      headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
    })
    assert.equal(admin.status, 200)
    const adminBody = await admin.json()
    assert.equal(adminBody.data.owner.consumerId, CONSUMER_ID)
    assert.deepEqual(calls[0], { audience: 'admin', requestId })

    const unauthorizedPublic = await fetch(`${server.baseUrl}/api/v1/acquisitions/${requestId}`)
    assert.equal(unauthorizedPublic.status, 401)

    const publicResponse = await fetch(`${server.baseUrl}/api/v1/acquisitions/${requestId}`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    })
    assert.equal(publicResponse.status, 200)
    const publicBody = await publicResponse.json()
    assert.deepEqual(publicBody.data.delivered.responseBody, { data: 'original' })
    assert.deepEqual(calls[1], {
      audience: 'public',
      requestId,
      consumerId: CONSUMER_ID,
      apiKeyId: API_KEY_ID,
    })

    const queryRejected = await fetch(`${server.baseUrl}/api/v1/acquisitions/${requestId}?consumerId=${randomUUID()}`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    })
    assert.equal(queryRejected.status, 400)
    assert.equal((await queryRejected.json()).error.code, 'unsupported_fields')
    assert.equal(calls.length, 2)
  } finally {
    await server.close()
  }
})

test('acquisition history is explicit when PostgreSQL evidence is unavailable and respects listener split', async () => {
  const requestId = randomUUID()
  const combined = await listen(fixtureApp())
  const publicOnly = await listen(fixtureApp({ listenerMode: 'public', acquisitionHistory: {} }))
  const adminOnly = await listen(fixtureApp({ listenerMode: 'admin', acquisitionHistory: {} }))
  try {
    const unavailable = await fetch(`${combined.baseUrl}/api/v1/acquisitions/${requestId}`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    })
    assert.equal(unavailable.status, 503)
    assert.equal((await unavailable.json()).error.code, 'acquisition_history_unavailable')

    const hiddenAdmin = await fetch(`${publicOnly.baseUrl}/internal/v1/admin/acquisitions/${requestId}`, {
      headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
    })
    assert.equal(hiddenAdmin.status, 404)

    const hiddenPublic = await fetch(`${adminOnly.baseUrl}/api/v1/acquisitions/${requestId}`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    })
    assert.equal(hiddenPublic.status, 404)
  } finally {
    await Promise.all([combined.close(), publicOnly.close(), adminOnly.close()])
  }
})
