import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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

function assertNoSensitiveConnectionFields(value) {
  const forbidden = /^(?:connection|password|passwd|secret|token|credential|authorization|api.?key|access.?key|private.?key|cookie|session|dsn|connection.?string)$/iu
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node)) {
      assert.equal(forbidden.test(key), false, `response exposed sensitive connection key: ${key}`)
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
  const nameOwners = new Map()
  for (const entry of entries) {
    for (const name of [entry.canonicalName, ...(entry.aliases || [])]) {
      const normalized = name.normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
      const owner = nameOwners.get(normalized)
      assert.ok(!owner || owner === entry.id, `${name} is owned by more than one catalog entry`)
      nameOwners.set(normalized, entry.id)
    }
  }
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
        canonicalName: '测试内容平台新版',
        coverageStatus: 'partial',
        deliveryStatus: 'doing',
        owner: '负责人 B',
        tags: ['进行中', 'P1'],
      },
    })
    assert.equal(updated.response.status, 200)
    assert.equal(updated.payload.data.revision, 2)
    assert.equal(updated.payload.data.canonicalName, '测试内容平台新版')
    assert.ok(updated.payload.data.aliases.includes('测试内容平台'))
    assert.equal(updated.payload.data.coverageStatus, 'partial')
    assert.equal(updated.payload.data.deliveryStatus, 'doing')
    assert.equal(updated.payload.data.runtimeStatus, 'not_configured')
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
    const manualStatusEvent = beforeArchiveEvents.payload.data.find((event) => event.eventType === 'update')
    assert.ok(manualStatusEvent)
    assert.equal(manualStatusEvent.actor, 'admin-token')
    assert.deepEqual({
      coverageStatus: manualStatusEvent.changes.before.coverageStatus,
      deliveryStatus: manualStatusEvent.changes.before.deliveryStatus,
      runtimeStatus: manualStatusEvent.changes.before.runtimeStatus,
    }, {
      coverageStatus: 'not_covered',
      deliveryStatus: 'exploring',
      runtimeStatus: 'not_configured',
    })
    assert.deepEqual({
      coverageStatus: manualStatusEvent.changes.after.coverageStatus,
      deliveryStatus: manualStatusEvent.changes.after.deliveryStatus,
      runtimeStatus: manualStatusEvent.changes.after.runtimeStatus,
    }, {
      coverageStatus: 'partial',
      deliveryStatus: 'doing',
      runtimeStatus: 'not_configured',
    })

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

test('source catalog taxonomy supports managed terms, facet discovery, guarded archive, and restore', async () => {
  await withServer(async (baseUrl) => {
    const initial = await call(baseUrl, '/internal/v1/admin/source-catalog/taxonomy')
    assert.equal(initial.response.status, 200)
    assert.equal(initial.payload.data.summary.archived, 0)
    assert.ok(initial.payload.data.summary.byKind.major_category > 0)
    assert.ok(initial.payload.data.items.some((term) => term.kind === 'region' && term.usageCount > 0))

    const created = await call(baseUrl, '/internal/v1/admin/source-catalog/taxonomy', {
      method: 'POST',
      body: {
        kind: 'region',
        displayName: '火星试验区',
        description: '尚未被目录引用的测试区域',
        color: '#1fdac5',
        sortOrder: 90,
      },
    })
    assert.equal(created.response.status, 201)
    assert.match(created.payload.data.termKey, /^term-[0-9a-f-]+$/u)
    assert.equal(created.payload.data.usageCount, 0)
    assert.equal(created.payload.data.revision, 1)
    const termId = created.payload.data.id

    const catalogWithUnusedTerm = await call(baseUrl, '/internal/v1/admin/source-catalog')
    assert.equal(catalogWithUnusedTerm.response.status, 200)
    assert.ok(catalogWithUnusedTerm.payload.data.facets.regions.includes('火星试验区'))

    const updated = await call(baseUrl, `/internal/v1/admin/source-catalog/taxonomy/${termId}`, {
      method: 'PUT',
      body: { revision: 1, displayName: '火星候选区', sortOrder: 91 },
    })
    assert.equal(updated.response.status, 200)
    assert.equal(updated.payload.data.displayName, '火星候选区')
    assert.equal(updated.payload.data.revision, 2)

    const archived = await call(baseUrl, `/internal/v1/admin/source-catalog/taxonomy/${termId}/archive`, {
      method: 'POST',
      body: { revision: 2 },
    })
    assert.equal(archived.response.status, 200)
    assert.equal(archived.payload.data.revision, 3)
    assert.match(archived.payload.data.archivedAt, /^\d{4}-\d{2}-\d{2}T/u)

    const activeTerms = await call(baseUrl, '/internal/v1/admin/source-catalog/taxonomy')
    assert.equal(activeTerms.payload.data.items.some((term) => term.id === termId), false)
    const allTerms = await call(baseUrl, '/internal/v1/admin/source-catalog/taxonomy?includeArchived=true')
    assert.equal(allTerms.payload.data.items.some((term) => term.id === termId), true)
    assert.equal(allTerms.payload.data.summary.archived, 1)

    const catalogWithoutArchivedTerm = await call(baseUrl, '/internal/v1/admin/source-catalog')
    assert.equal(catalogWithoutArchivedTerm.payload.data.facets.regions.includes('火星候选区'), false)

    const restored = await call(baseUrl, `/internal/v1/admin/source-catalog/taxonomy/${termId}/restore`, {
      method: 'POST',
      body: { revision: 3 },
    })
    assert.equal(restored.response.status, 200)
    assert.equal(restored.payload.data.archivedAt, null)
    assert.equal(restored.payload.data.revision, 4)

    const archivedEntryUsingRestoredTerm = await call(baseUrl, '/internal/v1/admin/source-catalog', {
      method: 'POST',
      body: {
        canonicalName: '归档条目仍引用区域',
        majorCategory: '内部测试',
        scenarios: ['目录治理测试'],
        regions: ['火星候选区'],
      },
    })
    assert.equal(archivedEntryUsingRestoredTerm.response.status, 201)
    const archivedReference = await call(
      baseUrl,
      `/internal/v1/admin/source-catalog/${archivedEntryUsingRestoredTerm.payload.data.id}/archive`,
      { method: 'POST', body: { revision: 1 } },
    )
    assert.equal(archivedReference.response.status, 200)
    const blockedByArchivedEntry = await call(
      baseUrl,
      `/internal/v1/admin/source-catalog/taxonomy/${termId}/archive`,
      { method: 'POST', body: { revision: 4 } },
    )
    assert.equal(blockedByArchivedEntry.response.status, 409)
    assert.equal(blockedByArchivedEntry.payload.error.code, 'source_catalog_term_in_use')
    assert.equal(blockedByArchivedEntry.payload.error.details.usageCount, 1)

    const usedTerm = initial.payload.data.items.find((term) => term.usageCount > 0)
    assert.ok(usedTerm)
    const blockedArchive = await call(
      baseUrl,
      `/internal/v1/admin/source-catalog/taxonomy/${usedTerm.id}/archive`,
      { method: 'POST', body: { revision: usedTerm.revision } },
    )
    assert.equal(blockedArchive.response.status, 409)
    assert.equal(blockedArchive.payload.error.code, 'source_catalog_term_in_use')
    assert.equal(blockedArchive.payload.error.details.usageCount, usedTerm.usageCount)

    const blockedRename = await call(baseUrl, `/internal/v1/admin/source-catalog/taxonomy/${usedTerm.id}`, {
      method: 'PUT',
      body: { revision: usedTerm.revision, displayName: `${usedTerm.displayName}（重命名）` },
    })
    assert.equal(blockedRename.response.status, 409)
    assert.equal(blockedRename.payload.error.code, 'source_catalog_term_in_use')

    const duplicateOne = await call(baseUrl, '/internal/v1/admin/source-catalog/taxonomy', {
      method: 'POST',
      body: { kind: 'tag', displayName: ' Ｇｌｏｂａｌ ' },
    })
    assert.equal(duplicateOne.response.status, 201)
    const duplicateTwo = await call(baseUrl, '/internal/v1/admin/source-catalog/taxonomy', {
      method: 'POST',
      body: { kind: 'tag', displayName: 'global' },
    })
    assert.equal(duplicateTwo.response.status, 409)
    assert.equal(duplicateTwo.payload.error.code, 'source_catalog_term_exists')

    const normalizedUsageTerm = await call(baseUrl, '/internal/v1/admin/source-catalog/taxonomy', {
      method: 'POST',
      body: { kind: 'region', displayName: 'Risk Zone' },
    })
    assert.equal(normalizedUsageTerm.response.status, 201)
    const normalizedReference = await call(baseUrl, '/internal/v1/admin/source-catalog', {
      method: 'POST',
      body: {
        canonicalName: '归一化区域引用测试',
        majorCategory: '内部测试',
        scenarios: ['目录治理测试'],
        regions: [' risk zone '],
      },
    })
    assert.equal(normalizedReference.response.status, 201)
    const normalizedUsage = await call(
      baseUrl,
      `/internal/v1/admin/source-catalog/taxonomy/${normalizedUsageTerm.payload.data.id}`,
    )
    assert.equal(normalizedUsage.response.status, 200)
    assert.equal(normalizedUsage.payload.data.usageCount, 1)
    const normalizedArchiveBlocked = await call(
      baseUrl,
      `/internal/v1/admin/source-catalog/taxonomy/${normalizedUsageTerm.payload.data.id}/archive`,
      { method: 'POST', body: { revision: 1 } },
    )
    assert.equal(normalizedArchiveBlocked.response.status, 409)
    assert.equal(normalizedArchiveBlocked.payload.error.code, 'source_catalog_term_in_use')

    const assignableTerm = await call(baseUrl, '/internal/v1/admin/source-catalog/taxonomy', {
      method: 'POST',
      body: { kind: 'region', displayName: 'Archived Zone' },
    })
    assert.equal(assignableTerm.response.status, 201)
    const archivedAssignableTerm = await call(
      baseUrl,
      `/internal/v1/admin/source-catalog/taxonomy/${assignableTerm.payload.data.id}/archive`,
      { method: 'POST', body: { revision: 1 } },
    )
    assert.equal(archivedAssignableTerm.response.status, 200)
    const createWithArchivedTerm = await call(baseUrl, '/internal/v1/admin/source-catalog', {
      method: 'POST',
      body: {
        canonicalName: '归档区域新建阻断测试',
        majorCategory: '内部测试',
        scenarios: ['目录治理测试'],
        regions: ['Ａｒｃｈｉｖｅｄ　Ｚｏｎｅ'],
      },
    })
    assert.equal(createWithArchivedTerm.response.status, 409)
    assert.equal(createWithArchivedTerm.payload.error.code, 'source_catalog_term_archived')
    const updateWithArchivedTerm = await call(
      baseUrl,
      `/internal/v1/admin/source-catalog/${normalizedReference.payload.data.id}`,
      {
        method: 'PUT',
        body: { revision: 1, regions: ['archived zone'] },
      },
    )
    assert.equal(updateWithArchivedTerm.response.status, 409)
    assert.equal(updateWithArchivedTerm.payload.error.code, 'source_catalog_term_archived')

    const events = await call(baseUrl, `/internal/v1/admin/source-catalog/taxonomy/${termId}/events`)
    assert.equal(events.response.status, 200)
    assert.deepEqual(
      new Set(events.payload.data.map((event) => event.eventType)),
      new Set(['create', 'update', 'archive', 'restore']),
    )
  })
})

test('source catalog related data matches canonical names and aliases without exposing source connections', async () => {
  await withServer(async (baseUrl, store) => {
    const created = await call(baseUrl, '/internal/v1/admin/source-catalog', {
      method: 'POST',
      body: {
        canonicalName: '测试视频平台',
        aliases: ['Video Alias'],
        sourceKind: 'platform',
        majorCategory: '内部测试',
        scenarios: ['内容监测'],
        regions: ['全球'],
      },
    })
    assert.equal(created.response.status, 201)
    const entry = created.payload.data

    const conflictingCreate = await call(baseUrl, '/internal/v1/admin/source-catalog', {
      method: 'POST',
      body: {
        canonicalName: ' video alias ',
        majorCategory: '内部测试',
        scenarios: ['内容监测'],
        regions: ['全球'],
      },
    })
    assert.equal(conflictingCreate.response.status, 409)
    assert.equal(conflictingCreate.payload.error.code, 'source_catalog_name_conflict')

    const secondEntry = await call(baseUrl, '/internal/v1/admin/source-catalog', {
      method: 'POST',
      body: {
        canonicalName: '另一个测试平台',
        majorCategory: '内部测试',
        scenarios: ['内容监测'],
        regions: ['全球'],
      },
    })
    assert.equal(secondEntry.response.status, 201)
    const conflictingUpdate = await call(
      baseUrl,
      `/internal/v1/admin/source-catalog/${secondEntry.payload.data.id}`,
      {
        method: 'PUT',
        body: { revision: 1, aliases: ['VIDEO ALIAS'] },
      },
    )
    assert.equal(conflictingUpdate.response.status, 409)
    assert.equal(conflictingUpdate.payload.error.code, 'source_catalog_name_conflict')

    const activeRecordId = randomUUID()
    const deletedRecordId = randomUUID()
    store.canonicalRecords.set(activeRecordId, {
      id: activeRecordId,
      datasetId: 'external.video-alias.v1',
      platform: 'VIDEO ALIAS',
      objectType: 'post',
      contentType: 'text',
      externalId: 'post-1',
      title: '平台关联内容',
      currentRevision: 2,
      eventTime: '2026-08-27T02:00:00.000Z',
      collectedAt: '2026-08-27T02:01:00.000Z',
      deletedAt: null,
      password: 'must-never-leak',
      connection: { dsn: 'postgres://must-never-leak' },
      rawPayload: { authorization: 'Bearer must-never-leak' },
      extensions: { apiToken: 'must-never-leak' },
    })
    store.canonicalRecords.set(deletedRecordId, {
      id: deletedRecordId,
      datasetId: 'external.video-alias.v1',
      platform: 'video alias',
      objectType: 'post',
      contentType: 'text',
      externalId: 'post-2',
      title: '已删除内容',
      currentRevision: 1,
      eventTime: '2026-08-27T01:00:00.000Z',
      collectedAt: '2026-08-27T01:01:00.000Z',
      deletedAt: '2026-08-27T03:00:00.000Z',
    })
    store.recordChunks.set(randomUUID(), {
      id: randomUUID(), recordId: activeRecordId, embeddedAt: '2026-08-27T02:02:00.000Z',
      projectedAt: '2026-08-27T02:03:00.000Z',
    })
    store.recordChunks.set(randomUUID(), {
      id: randomUUID(), recordId: activeRecordId, embeddedAt: null, projectedAt: null,
    })
    await store.createExternalSource({
      sourceKey: 'video-alias-source',
      displayName: 'Video Alias physical source',
      sourceKind: 'database',
      datasetId: 'external.video-alias.v1',
      platform: 'video alias',
      objectType: 'post',
      connection: {
        host: 'private-db.internal',
        password: 'must-never-leak',
        apiToken: 'must-never-leak',
      },
    })

    const related = await call(
      baseUrl,
      `/internal/v1/admin/source-catalog/${entry.id}/related-data?pageSize=1`,
    )
    assert.equal(related.response.status, 200)
    assert.deepEqual(related.payload.data.matchKeys, ['测试视频平台', 'Video Alias'])
    assert.deepEqual(related.payload.data.stats, {
      datasetCount: 1,
      externalSourceCount: 1,
      recordCount: 2,
      activeRecordCount: 1,
      deletedRecordCount: 1,
      revisionCount: 3,
      chunkCount: 2,
      embeddedChunkCount: 1,
      projectedChunkCount: 1,
    })
    assert.equal(related.payload.data.datasets[0].datasetId, 'external.video-alias.v1')
    assert.equal(related.payload.data.datasets[0].chunkCount, 2)
    assert.equal(related.payload.data.recentRecords.length, 1)
    assert.deepEqual(
      Object.keys(related.payload.data.recentRecords[0]).sort(),
      [
        'id', 'datasetId', 'platform', 'objectType', 'contentType', 'externalId',
        'title', 'currentRevision', 'eventTime', 'collectedAt', 'deletedAt',
      ].sort(),
    )
    assert.equal(related.payload.data.hasMore, true)
    assert.equal(related.payload.data.searchProjection.state, 'partial')
    assertNoSensitiveConnectionFields(related.payload)

    const invalidPageSize = await call(
      baseUrl,
      `/internal/v1/admin/source-catalog/${entry.id}/related-data?pageSize=101`,
    )
    assert.equal(invalidPageSize.response.status, 400)
    assert.equal(invalidPageSize.payload.error.code, 'invalid_page_size')

    const archived = await call(baseUrl, `/internal/v1/admin/source-catalog/${entry.id}/archive`, {
      method: 'POST',
      body: { revision: entry.revision },
    })
    assert.equal(archived.response.status, 200)
    const conflictWithArchivedOwner = await call(baseUrl, '/internal/v1/admin/source-catalog', {
      method: 'POST',
      body: {
        canonicalName: 'VIDEO ALIAS',
        majorCategory: '内部测试',
        scenarios: ['内容监测'],
        regions: ['全球'],
      },
    })
    assert.equal(conflictWithArchivedOwner.response.status, 409)
    assert.equal(conflictWithArchivedOwner.payload.error.code, 'source_catalog_name_conflict')
    const relatedAfterArchive = await call(
      baseUrl,
      `/internal/v1/admin/source-catalog/${entry.id}/related-data`,
    )
    assert.equal(relatedAfterArchive.response.status, 200)
    assert.ok(relatedAfterArchive.payload.data.entry.archivedAt)
    assert.equal(relatedAfterArchive.payload.data.stats.recordCount, 2)
    assert.equal(store.canonicalRecords.size, 2)
    assert.equal(store.recordChunks.size, 2)
    assert.equal(store.externalSources.size, 1)
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

  await withServer(async (baseUrl, store) => {
    const [entry] = await store.listSourceCatalogEntries()
    const [term] = await store.listSourceCatalogTerms()
    const protectedOperations = [
      { method: 'GET', path: '/internal/v1/admin/source-catalog' },
      { method: 'GET', path: '/internal/v1/admin/source-catalog/taxonomy' },
      {
        method: 'POST',
        path: '/internal/v1/admin/source-catalog/taxonomy',
        body: { kind: 'region', displayName: '未授权区域' },
      },
      { method: 'GET', path: `/internal/v1/admin/source-catalog/taxonomy/${term.id}` },
      {
        method: 'PUT',
        path: `/internal/v1/admin/source-catalog/taxonomy/${term.id}`,
        body: { revision: term.revision, description: '未授权修改' },
      },
      { method: 'GET', path: `/internal/v1/admin/source-catalog/taxonomy/${term.id}/events` },
      {
        method: 'POST',
        path: `/internal/v1/admin/source-catalog/taxonomy/${term.id}/archive`,
        body: { revision: term.revision },
      },
      {
        method: 'POST',
        path: `/internal/v1/admin/source-catalog/taxonomy/${term.id}/restore`,
        body: { revision: term.revision },
      },
      { method: 'GET', path: `/internal/v1/admin/source-catalog/${entry.id}/related-data` },
    ]
    for (const operation of protectedOperations) {
      const label = `${operation.method} ${operation.path}`
      const anonymous = await call(baseUrl, operation.path, { ...operation, headers: {} })
      assert.equal(anonymous.response.status, 401, label)
      assert.equal(anonymous.payload.error.code, 'admin_auth_required', label)
    }

    for (const credential of ['launcher-user', 'launcher-admin']) {
      for (const operation of protectedOperations) {
        const label = `${credential} ${operation.method} ${operation.path}`
        const denied = await call(baseUrl, operation.path, {
          ...operation,
          headers: { authorization: `Bearer ${credential}` },
        })
        assert.equal(denied.response.status, 403, label)
        assert.equal(denied.payload.error.code, 'admin_token_required', label)
      }
    }

    const admin = await call(baseUrl, '/internal/v1/admin/source-catalog')
    assert.equal(admin.response.status, 200)
  }, { identity })
})
