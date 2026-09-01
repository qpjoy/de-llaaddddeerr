import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { createApp } from '../../server/app.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const ADMIN_TOKEN = 'database-connection-http-admin-token'
const PASSWORD = 'profile-password-must-not-leak'

async function withServer(options, operation) {
  const server = createServer(createApp({
    service: {},
    store: options.store,
    adapter: { dependencies: async () => ({ status: 'up' }) },
    adminToken: ADMIN_TOKEN,
    identity: options.identity,
    databasePuller: options.databasePuller,
    queue: options.queue,
    logger: { error() {} },
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await operation(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function call(baseUrl, path, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { response, payload: await response.json() }
}

function adminHeaders() {
  return { 'x-mx-insight-admin-token': ADMIN_TOKEN }
}

function assertPasswordSafe(payload) {
  const serialized = JSON.stringify(payload)
  assert.equal(serialized.includes(PASSWORD), false)
  assert.equal(/"password"\s*:/u.test(serialized), false)
}

test('database-connection HTTP CRUD is admin-token-only, revision-fenced and password-safe', async () => {
  const store = new MemoryStore()
  const testedTransports = []
  const lockedSourceKeys = []
  let cursorStatus = 'idle'
  const databasePuller = {
    async testDatabaseConnectionTransport(connection) {
      testedTransports.push({ ...connection })
      return { ok: true, databaseVersion: 'PostgreSQL test' }
    },
    async withSourceLocks(sourceKeys, operation) {
      lockedSourceKeys.push([...sourceKeys])
      return operation()
    },
  }
  const identity = {
    enabled: true,
    async resolve(credential) {
      return credential === 'launcher-platform-admin'
        ? { kind: 'launcher', platformAdmin: true, tenantIds: null, capabilities: [] }
        : null
    },
  }
  const queue = {
    async getCursor() {
      return { status: cursorStatus }
    },
  }

  await withServer({ store, databasePuller, identity, queue }, async (baseUrl) => {
    const created = await call(baseUrl, '/internal/v1/admin/database-connections', {
      method: 'POST',
      headers: adminHeaders(),
      body: {
        connectionKey: 'night-all-primary',
        displayName: 'Night-All primary',
        connection: {
          host: 'database.internal',
          port: 5432,
          database: 'night_all',
          username: 'mx_reader',
          password: PASSWORD,
          sslMode: 'require',
        },
      },
    })
    assert.equal(created.response.status, 201)
    assert.equal(created.payload.data.revision, 1)
    assert.equal(created.payload.data.passwordConfigured, true)
    assert.deepEqual(created.payload.data.references, [])
    assert.equal(created.payload.data.lastTest.ok, true)
    assertPasswordSafe(created.payload)
    const profileId = created.payload.data.id

    for (const invalid of [
      { method: 'POST', path: '/internal/v1/admin/database-connections/not-a-uuid/test' },
      {
        method: 'PUT',
        path: '/internal/v1/admin/database-connections/not-a-uuid',
        body: { revision: 1, displayName: 'Invalid id' },
      },
      { method: 'DELETE', path: '/internal/v1/admin/database-connections/not-a-uuid' },
    ]) {
      const response = await call(baseUrl, invalid.path, { ...invalid, headers: adminHeaders() })
      assert.equal(response.response.status, 400, `${invalid.method} ${invalid.path}`)
      assert.equal(response.payload.error.code, 'invalid_database_connection_id')
    }

    const protectedRequests = [
      { method: 'GET', path: '/internal/v1/admin/database-connections' },
      { method: 'POST', path: '/internal/v1/admin/database-connections', body: {} },
      { method: 'PUT', path: `/internal/v1/admin/database-connections/${profileId}`, body: {} },
      { method: 'POST', path: `/internal/v1/admin/database-connections/${profileId}/test` },
      { method: 'DELETE', path: `/internal/v1/admin/database-connections/${profileId}` },
    ]
    for (const request of protectedRequests) {
      const anonymous = await call(baseUrl, request.path, request)
      assert.equal(anonymous.response.status, 401, `${request.method} ${request.path}`)
      assert.equal(anonymous.payload.error.code, 'admin_auth_required')

      const launcherAdmin = await call(baseUrl, request.path, {
        ...request,
        headers: { authorization: 'Bearer launcher-platform-admin' },
      })
      assert.equal(launcherAdmin.response.status, 403, `${request.method} ${request.path}`)
      assert.equal(launcherAdmin.payload.error.code, 'admin_token_required')
    }

    const listed = await call(baseUrl, '/internal/v1/admin/database-connections', {
      headers: adminHeaders(),
    })
    assert.equal(listed.response.status, 200)
    assert.equal(listed.payload.data[0].id, profileId)
    assert.equal(listed.payload.data[0].passwordConfigured, true)
    assertPasswordSafe(listed.payload)

    const tested = await call(
      baseUrl,
      `/internal/v1/admin/database-connections/${profileId}/test`,
      { method: 'POST', headers: adminHeaders() },
    )
    assert.equal(tested.response.status, 200)
    assert.equal(tested.payload.data.databaseConnectionId, profileId)
    assert.equal(tested.payload.data.revision, 1)
    assert.equal(tested.payload.data.ok, true)
    assertPasswordSafe(tested.payload)

    const updated = await call(baseUrl, `/internal/v1/admin/database-connections/${profileId}`, {
      method: 'PUT',
      headers: adminHeaders(),
      body: {
        revision: 1,
        displayName: 'Night-All shared',
        connection: { host: 'database-2.internal', password: '' },
      },
    })
    assert.equal(updated.response.status, 200)
    assert.equal(updated.payload.data.revision, 2)
    assert.equal(updated.payload.data.host, 'database-2.internal')
    assert.equal(updated.payload.data.passwordConfigured, true)
    assertPasswordSafe(updated.payload)
    assert.equal(testedTransports.at(-1).password, PASSWORD)

    const stale = await call(baseUrl, `/internal/v1/admin/database-connections/${profileId}`, {
      method: 'PUT',
      headers: adminHeaders(),
      body: { revision: 1, displayName: 'Stale update' },
    })
    assert.equal(stale.response.status, 409)
    assert.equal(stale.payload.error.code, 'database_connection_revision_conflict')
    assert.deepEqual(stale.payload.error.details, { expectedRevision: 1, currentRevision: 2 })

    await store.createExternalSource({
      sourceKey: 'shared-profile-source',
      displayName: 'Shared profile source',
      sourceKind: 'database',
      datasetId: 'test.shared-profile.v1',
      platform: 'external',
      objectType: 'record',
      status: 'active',
      connection: { schema: 'public', table: 'items' },
      databaseConnectionId: profileId,
    })

    const referencedDelete = await call(
      baseUrl,
      `/internal/v1/admin/database-connections/${profileId}`,
      { method: 'DELETE', headers: adminHeaders() },
    )
    assert.equal(referencedDelete.response.status, 409)
    assert.equal(referencedDelete.payload.error.code, 'database_connection_in_use')

    const activeUpdate = await call(baseUrl, `/internal/v1/admin/database-connections/${profileId}`, {
      method: 'PUT',
      headers: adminHeaders(),
      body: { revision: 2, connection: { host: 'database-3.internal' } },
    })
    assert.equal(activeUpdate.response.status, 409)
    assert.equal(activeUpdate.payload.error.code, 'database_connection_sources_must_pause')
    assert.deepEqual(activeUpdate.payload.error.details.references, [{
      sourceKey: 'shared-profile-source',
      displayName: 'Shared profile source',
      status: 'active',
    }])

    await store.updateExternalSource('shared-profile-source', { status: 'paused' })
    cursorStatus = 'running'
    const runningUpdate = await call(baseUrl, `/internal/v1/admin/database-connections/${profileId}`, {
      method: 'PUT',
      headers: adminHeaders(),
      body: { revision: 2, connection: { host: 'database-3.internal' } },
    })
    assert.equal(runningUpdate.response.status, 409)
    assert.equal(runningUpdate.payload.error.code, 'source_draining')

    cursorStatus = 'idle'
    const drainedUpdate = await call(baseUrl, `/internal/v1/admin/database-connections/${profileId}`, {
      method: 'PUT',
      headers: adminHeaders(),
      body: { revision: 2, connection: { host: 'database-3.internal' } },
    })
    assert.equal(drainedUpdate.response.status, 200)
    assert.equal(drainedUpdate.payload.data.revision, 3)
    assert.equal(drainedUpdate.payload.data.referenceCount, 1)
    assert.deepEqual(lockedSourceKeys.at(-1), ['shared-profile-source'])
    assertPasswordSafe(drainedUpdate.payload)

    await store.updateExternalSource('shared-profile-source', {
      databaseConnectionId: null,
      connection: {
        host: 'database-3.internal',
        port: 5432,
        database: 'night_all',
        username: 'mx_reader',
        password: PASSWORD,
        sslMode: 'require',
        schema: 'public',
        table: 'items',
      },
    })
    const deleted = await call(baseUrl, `/internal/v1/admin/database-connections/${profileId}`, {
      method: 'DELETE',
      headers: adminHeaders(),
    })
    assert.equal(deleted.response.status, 200)
    assert.equal(deleted.payload.data.id, profileId)
    assert.equal(deleted.payload.data.passwordConfigured, true)
    assertPasswordSafe(deleted.payload)
  })
})
