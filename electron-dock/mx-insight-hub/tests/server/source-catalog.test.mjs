import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createApp } from '../../server/app.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const ADMIN_TOKEN = 'source-catalog-admin-token-with-enough-length'
const quiet = { error() {} }

function adminHeaders() {
  return { 'x-mx-insight-admin-token': ADMIN_TOKEN }
}

async function withServer(operation, { identity = null } = {}) {
  const store = new MemoryStore()
  const app = createApp({
    service: {},
    store,
    adapter: {},
    identity,
    adminToken: ADMIN_TOKEN,
    logger: quiet,
  })
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await operation(`http://127.0.0.1:${server.address().port}`, store)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function call(baseUrl, path, {
  method = 'GET',
  body,
  headers = adminHeaders(),
} = {}) {
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

function assertNoConnectionSecret(value) {
  const forbidden = new Set(['connection', 'password'])
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node)) {
      assert.equal(forbidden.has(key.toLowerCase()), false, `response exposed forbidden key: ${key}`)
      visit(child)
    }
  }
  visit(value)
}

test('MemoryStore seeds the governed catalog from the four source files without losing the known alias', async () => {
  const store = new MemoryStore()
  const entries = await store.listSourceCatalogEntries()

  assert.equal(entries.length, 215)
  assert.equal(entries.filter((entry) => entry.coverageStatus === 'covered').length, 29)
  assert.equal(entries.filter((entry) => entry.coverageStatus === 'not_covered').length, 186)
  assert.equal(entries.filter((entry) => entry.deliveryStatus === 'complete').length, 2)

  const sequence62 = entries.find((entry) => entry.legacySequence === 62)
  assert.ok(sequence62)
  assert.equal(sequence62.canonicalName, '抖音电商')
  assert.deepEqual(sequence62.aliases, ['抖音小店'])
  assertNoConnectionSecret(entries)
})

test('source catalog HTTP contract supports governed CRUD, optimistic revisions, audit events, and archive views', async () => {
  await withServer(async (baseUrl) => {
    const initial = await call(baseUrl, '/internal/v1/admin/source-catalog')
    assert.equal(initial.response.status, 200)
    assert.equal(initial.payload.data.items.length, 215)
    assert.deepEqual({
      total: initial.payload.data.summary.total,
      covered: initial.payload.data.summary.covered,
      uncovered: initial.payload.data.summary.uncovered,
      complete: initial.payload.data.summary.complete,
    }, {
      total: 215,
      covered: 29,
      uncovered: 186,
      complete: 2,
    })
    assertNoConnectionSecret(initial.payload)

    const created = await call(baseUrl, '/internal/v1/admin/source-catalog', {
      method: 'POST',
      body: {
        canonicalName: '测试内容平台',
        sourceKind: 'platform',
        majorCategory: '内部测试',
        scenarios: ['内容/舆情/评论监测'],
        regions: ['中国大陆'],
        priority: 'P1',
        coverageStatus: 'not_covered',
        deliveryStatus: 'exploring',
        reviewStatus: 'needs_review',
        runtimeStatus: 'not_configured',
        owner: '负责人 A',
        connectorHints: ['test-adapter'],
        tags: ['待评估'],
        evidenceRefs: [{ type: 'document', key: 'docs/test-source.md', label: '测试证据' }],
        customFields: { businessUnit: 'insight' },
      },
    })
    assert.equal(created.response.status, 201)
    assert.match(created.payload.data.sourceKey, /^catalog-[0-9a-f-]+$/u)
    assert.equal(created.payload.data.revision, 1)
    assert.equal(created.payload.data.archivedAt, null)
    assertNoConnectionSecret(created.payload)
    const entryId = created.payload.data.id

    const credentialAttempt = await call(baseUrl, '/internal/v1/admin/source-catalog', {
      method: 'POST',
      body: {
        canonicalName: '不安全目录',
        majorCategory: '内部测试',
        scenarios: ['测试'],
        regions: ['中国大陆'],
        customFields: { apiToken: 'must-not-be-stored' },
      },
    })
    assert.equal(credentialAttempt.response.status, 400)
    assert.equal(credentialAttempt.payload.error.code, 'source_catalog_private_field_forbidden')

    const invalidId = await call(baseUrl, '/internal/v1/admin/source-catalog/not-a-uuid', {
      headers: adminHeaders(),
    })
    assert.equal(invalidId.response.status, 400)
    assert.equal(invalidId.payload.error.code, 'invalid_source_catalog_id')

    const fetched = await call(baseUrl, `/internal/v1/admin/source-catalog/${entryId}`)
    assert.equal(fetched.response.status, 200)
    assert.equal(fetched.payload.data.canonicalName, '测试内容平台')

    const updated = await call(baseUrl, `/internal/v1/admin/source-catalog/${entryId}`, {
      method: 'PUT',
      body: {
        revision: 1,
        deliveryStatus: 'doing',
        owner: '负责人 B',
        tags: ['进行中', 'P1'],
      },
    })
    assert.equal(updated.response.status, 200)
    assert.equal(updated.payload.data.revision, 2)
    assert.equal(updated.payload.data.deliveryStatus, 'doing')
    assert.equal(updated.payload.data.owner, '负责人 B')

    const stale = await call(baseUrl, `/internal/v1/admin/source-catalog/${entryId}`, {
      method: 'PUT',
      body: { revision: 1, notes: '过期写入不应生效' },
    })
    assert.equal(stale.response.status, 409)
    assert.equal(stale.payload.error.code, 'source_catalog_revision_conflict')

    const afterConflict = await call(baseUrl, `/internal/v1/admin/source-catalog/${entryId}`)
    assert.equal(afterConflict.payload.data.revision, 2)
    assert.equal(afterConflict.payload.data.notes, null)

    const beforeArchiveEvents = await call(
      baseUrl,
      `/internal/v1/admin/source-catalog/${entryId}/events?limit=10`,
    )
    assert.equal(beforeArchiveEvents.response.status, 200)
    assert.deepEqual(
      new Set(beforeArchiveEvents.payload.data.map((event) => event.eventType)),
      new Set(['create', 'update']),
    )

    const archived = await call(baseUrl, `/internal/v1/admin/source-catalog/${entryId}/archive`, {
      method: 'POST',
      body: { revision: 2 },
    })
    assert.equal(archived.response.status, 200)
    assert.equal(archived.payload.data.revision, 3)
    assert.match(archived.payload.data.archivedAt, /^\d{4}-\d{2}-\d{2}T/u)

    const activeOnly = await call(baseUrl, '/internal/v1/admin/source-catalog')
    assert.equal(activeOnly.payload.data.items.some((entry) => entry.id === entryId), false)
    assert.equal(activeOnly.payload.data.summary.total, 215)

    const includingArchived = await call(
      baseUrl,
      '/internal/v1/admin/source-catalog?includeArchived=true',
    )
    assert.equal(includingArchived.response.status, 200)
    assert.equal(includingArchived.payload.data.items.length, 216)
    assert.equal(includingArchived.payload.data.summary.archived, 1)
    assert.equal(includingArchived.payload.data.items.some((entry) => entry.id === entryId), true)

    const restored = await call(baseUrl, `/internal/v1/admin/source-catalog/${entryId}/restore`, {
      method: 'POST',
      body: { revision: 3 },
    })
    assert.equal(restored.response.status, 200)
    assert.equal(restored.payload.data.revision, 4)
    assert.equal(restored.payload.data.archivedAt, null)

    const finalEvents = await call(baseUrl, `/internal/v1/admin/source-catalog/${entryId}/events`)
    assert.equal(finalEvents.response.status, 200)
    assert.deepEqual(
      new Set(finalEvents.payload.data.map((event) => event.eventType)),
      new Set(['create', 'update', 'archive', 'restore']),
    )
    assertNoConnectionSecret(finalEvents.payload)
  })
})

test('source catalog remains Hub Admin Token-only for anonymous, Launcher user, and Launcher admin callers', async () => {
  const identity = {
    enabled: true,
    async resolve(credential) {
      if (credential === 'launcher-user') {
        return { kind: 'launcher-user', platformAdmin: false, tenantIds: [], capabilities: [] }
      }
      if (credential === 'launcher-admin') {
        return { kind: 'launcher-user', platformAdmin: true, tenantIds: null, capabilities: [] }
      }
      return null
    },
  }

  await withServer(async (baseUrl) => {
    const anonymous = await call(baseUrl, '/internal/v1/admin/source-catalog', { headers: {} })
    assert.equal(anonymous.response.status, 401)
    assert.equal(anonymous.payload.error.code, 'admin_auth_required')

    for (const credential of ['launcher-user', 'launcher-admin']) {
      const denied = await call(baseUrl, '/internal/v1/admin/source-catalog', {
        headers: { authorization: `Bearer ${credential}` },
      })
      assert.equal(denied.response.status, 403, credential)
      assert.equal(denied.payload.error.code, 'admin_token_required', credential)
    }

    const admin = await call(baseUrl, '/internal/v1/admin/source-catalog')
    assert.equal(admin.response.status, 200)
  }, { identity })
})
