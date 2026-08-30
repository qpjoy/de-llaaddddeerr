import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import {
  ADVANCED_SEARCH_CATALOG_AGENT_KEY,
  ADVANCED_SEARCH_EXECUTOR_KEY,
  KNOWLEDGE_QA_CATALOG_AGENT_KEY,
  builtinAgentMarketCatalog,
} from '../../server/agent-market/catalog.ts'
import { AgentMarketStore } from '../../server/agent-market/store.ts'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const ADMIN_TOKEN = 'agent-market-catalog-admin-token'
const NOW = new Date('2026-08-31T00:00:00.000Z')

function categoryRow(overrides = {}) {
  return {
    category_key: 'custom-category',
    display_name: 'Custom Category',
    description: 'Custom category description',
    sort_order: 30,
    system_owned: false,
    revision: 1,
    created_by: 'admin-token',
    updated_by: 'admin-token',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  }
}

function catalogAgentRow(overrides = {}) {
  return {
    agent_key: 'custom-agent',
    category_key: 'custom-category',
    display_name: 'Custom Agent',
    description: 'A custom Agent without an executor.',
    tags: ['Custom'],
    executor_key: null,
    enabled: true,
    sort_order: 20,
    system_owned: false,
    revision: 1,
    created_by: 'admin-token',
    updated_by: 'admin-token',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  }
}

function scriptedPool(query) {
  const statements = []
  const client = {
    async query(text, params = []) {
      statements.push({ text, params })
      return query(text, params)
    },
    release() {},
  }
  return {
    statements,
    pool: {
      connect: async () => client,
      query: async (text, params = []) => {
        statements.push({ text, params })
        return query(text, params)
      },
    },
  }
}

test('migration seeds truthful categories and Agents without run or Launcher data', async () => {
  const sql = await readFile(new URL('../../migrations/045_agent_market_catalog.sql', import.meta.url), 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS control\.agent_market_categories/u)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS control\.agent_market_catalog/u)
  assert.match(sql, /'knowledge-qa', '知识问答'/u)
  assert.match(sql, /'demo', 'Demo Agent'/u)
  assert.match(sql, /'advanced-search', 'demo'/u)
  assert.match(sql, /'advanced-search-dry-run'/u)
  assert.match(sql, /'knowledge-qa', 'knowledge-qa'[\s\S]*?NULL, true/u)
  assert.match(sql, /'\["RAG", "Hybrid Search", "RRF"\]'::jsonb/u)
  assert.match(sql, /'\["Knowledge QA"\]'::jsonb/u)
  assert.match(sql, /CHECK \(executor_key IS NULL OR system_owned\)/u)
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS agent_market_catalog_executor_unique_idx/u)
  assert.doesNotMatch(sql, /canonical_records|projection_outbox|launcher|run_count|accuracy|latency|health/iu)
})

test('built-in fallback catalog reports real executor state and no synthetic metrics', () => {
  const catalog = builtinAgentMarketCatalog()
  assert.deepEqual(catalog.categories.map((item) => [item.categoryKey, item.name]), [
    ['knowledge-qa', '知识问答'],
    ['demo', 'Demo Agent'],
  ])

  const advanced = catalog.agents.find((item) => item.agentKey === ADVANCED_SEARCH_CATALOG_AGENT_KEY)
  assert.equal(advanced.executorKey, ADVANCED_SEARCH_EXECUTOR_KEY)
  assert.equal(advanced.runnable, true)
  assert.equal(advanced.lifecycle, 'published')
  assert.equal(advanced.dryRunOnly, true)
  assert.deepEqual(advanced.tags, ['RAG', 'Hybrid Search', 'RRF'])

  const knowledge = catalog.agents.find((item) => item.agentKey === KNOWLEDGE_QA_CATALOG_AGENT_KEY)
  assert.equal(knowledge.executorKey, null)
  assert.equal(knowledge.runnable, false)
  assert.equal(knowledge.executionStatus, 'executor-not-configured')
  assert.equal(knowledge.lifecycle, 'draft')
  assert.equal(knowledge.lastRun, null)
  assert.deepEqual(knowledge.tags, ['Knowledge QA'])

  const serialized = JSON.stringify(catalog)
  assert.doesNotMatch(serialized, /runCount|accuracy|latency|health|metrics/u)
})

test('Agent Market UI preserves draft truth and executor-based restore semantics', async () => {
  const source = await readFile(new URL('../../src/pages-agent-market.tsx', import.meta.url), 'utf8')
  assert.match(source, /value\.lifecycle === 'draft'/u)
  assert.match(source, /lifecycleConfirm\.executorKey \? 'published' : 'draft'/u)
  assert.match(source, /Catalog Only · 未配置执行器/u)
  assert.match(source, /categoryEditor === 'create' \|\| categoryEditor\.builtin/u)
  assert.match(source, /setResult\(null\)[\s\S]*?setPreviousResult\(null\)[\s\S]*?setRunError\(null\)/u)
})

test('custom inputs reject reserved keys and client-owned execution or fake status fields before SQL', async () => {
  const store = new AgentMarketStore({
    connect: async () => { throw new Error('validation must run before database access') },
  })
  for (const reserved of ['catalog', 'categories', 'agents']) {
    await assert.rejects(
      () => store.createCategory({ categoryKey: reserved, name: 'Reserved' }, { updatedBy: 'admin-token' }),
      (error) => error?.status === 400 && error?.code === 'invalid_agent_market_category',
    )
    await assert.rejects(
      () => store.createCatalogAgent({
        agentKey: reserved,
        categoryKey: 'demo',
        name: 'Reserved',
        summary: '',
        tags: [],
      }, { updatedBy: 'admin-token' }),
      (error) => error?.status === 400 && error?.code === 'invalid_agent_market_catalog_agent',
    )
  }
  await assert.rejects(
    () => store.createCatalogAgent({
      agentKey: 'forged-agent',
      categoryKey: 'demo',
      name: 'Forged Agent',
      summary: 'Must not become runnable.',
      tags: [],
      executorKey: ADVANCED_SEARCH_EXECUTOR_KEY,
      runnable: true,
      metrics: { accuracy: 1 },
      health: 'healthy',
    }, { updatedBy: 'admin-token' }),
    (error) => {
      assert.equal(error?.status, 400)
      assert.equal(error?.code, 'invalid_agent_market_catalog_agent')
      assert.match(JSON.stringify(error?.details), /executorKey|runnable|metrics|health/u)
      return true
    },
  )
})

test('custom Agent creation persists metadata with a NULL executor and no unrelated writes', async () => {
  const scripted = scriptedPool((text, params) => {
    if (/^BEGIN|^COMMIT|^ROLLBACK/u.test(text)) return { rows: [] }
    if (text.includes('pg_advisory_xact_lock')) return { rows: [] }
    if (text.includes('SELECT 1 FROM control.agent_market_catalog')) return { rows: [] }
    if (text.includes('SELECT 1 FROM control.agent_market_categories')) return { rows: [{ exists: true }] }
    if (text.includes('INSERT INTO control.agent_market_catalog')) {
      assert.match(text, /executor_key,[\s\S]*VALUES \([^)]*NULL, true/u)
      return {
        rows: [catalogAgentRow({
          agent_key: params[0],
          category_key: params[1],
          display_name: params[2],
          description: params[3],
          tags: JSON.parse(params[4]),
          sort_order: params[5],
          updated_by: params[6],
        })],
      }
    }
    throw new Error(`unexpected SQL: ${text}`)
  })
  const store = new AgentMarketStore(scripted.pool)
  const saved = await store.createCatalogAgent({
    agentKey: 'custom-agent',
    categoryKey: 'custom-category',
    name: 'Custom Agent',
    summary: 'A custom Agent without an executor.',
    tags: ['Custom'],
  }, { updatedBy: 'admin-token' })

  assert.equal(saved.executorKey, null)
  assert.equal(saved.enabled, true)
  assert.equal(saved.runnable, false)
  assert.equal(saved.executionStatus, 'executor-not-configured')
  assert.equal(saved.lifecycle, 'draft')
  assert.equal(saved.kind, 'custom')
  assert.equal(saved.lastRun, null)
  assert.ok(scripted.statements.every(({ text }) => (
    !/canonical_records|projection_outbox|launcher|agent_market_agents|agent_market_versions/iu.test(text)
  )))
})

test('catalog reads categories and Agents from one repeatable-read snapshot', async () => {
  const scripted = scriptedPool((text) => {
    if (text === 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY' || text === 'COMMIT') {
      return { rows: [] }
    }
    if (text.includes('FROM control.agent_market_categories')) {
      return { rows: [categoryRow()] }
    }
    if (text.includes('FROM control.agent_market_catalog')) {
      return { rows: [catalogAgentRow()] }
    }
    throw new Error(`unexpected SQL: ${text}`)
  })
  const catalog = await new AgentMarketStore(scripted.pool).listCatalog()
  assert.equal(catalog.source, 'database')
  assert.equal(catalog.categories[0].agentCount, 1)
  assert.equal(catalog.agents[0].categoryKey, catalog.categories[0].categoryKey)
  assert.deepEqual(
    scripted.statements.map(({ text }) => text.trim().split(/\s+/u).slice(0, 3).join(' ')),
    ['BEGIN TRANSACTION ISOLATION', 'SELECT category_key, display_name,', 'SELECT agent_key, category_key,', 'COMMIT'],
  )
})

test('catalog writes fail closed with 503 while migration 045 is unavailable', async () => {
  const missing = Object.assign(new Error('relation missing'), { code: '42P01' })
  const scripted = scriptedPool((text) => {
    if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [] }
    throw missing
  })
  await assert.rejects(
    () => new AgentMarketStore(scripted.pool).createCategory({
      categoryKey: 'new-category',
      name: 'New Category',
    }, { updatedBy: 'admin-token' }),
    (error) => error?.status === 503 && error?.code === 'agent_market_store_unavailable',
  )
})

test('custom Agent lifecycle supports disable and restore but cannot publish without an executor', async () => {
  let row = catalogAgentRow()
  const scripted = scriptedPool((text, params) => {
    if (/^BEGIN|^COMMIT|^ROLLBACK/u.test(text)) return { rows: [] }
    if (text.includes('pg_advisory_xact_lock')) return { rows: [] }
    if (text.includes('FROM control.agent_market_catalog') && text.includes('FOR UPDATE')) {
      return { rows: [{ ...row }] }
    }
    if (text.includes('UPDATE control.agent_market_catalog')) {
      row = catalogAgentRow({
        ...row,
        category_key: params[1],
        display_name: params[2],
        description: params[3],
        tags: JSON.parse(params[4]),
        executor_key: params[5],
        enabled: params[6],
        sort_order: params[7],
        revision: Number(row.revision) + 1,
        updated_by: params[8],
      })
      return { rows: [{ ...row }] }
    }
    throw new Error(`unexpected SQL: ${text}`)
  })
  const store = new AgentMarketStore(scripted.pool)
  const disabled = await store.updateCatalogAgent('custom-agent', {
    expectedRevision: 1,
    lifecycle: 'disabled',
  }, { updatedBy: 'admin-token' })
  assert.equal(disabled.lifecycle, 'disabled')
  assert.equal(disabled.runnable, false)

  const restored = await store.updateCatalogAgent('custom-agent', {
    expectedRevision: 2,
    lifecycle: 'draft',
  }, { updatedBy: 'admin-token' })
  assert.equal(restored.lifecycle, 'draft')
  assert.equal(restored.enabled, true)
  assert.equal(restored.runnable, false)

  await assert.rejects(
    () => store.updateCatalogAgent('custom-agent', {
      expectedRevision: 3,
      lifecycle: 'published',
    }, { updatedBy: 'admin-token' }),
    (error) => error?.status === 409 && error?.code === 'agent_market_executor_unavailable',
  )
  assert.ok(scripted.statements.every(({ text }) => !/^DELETE/iu.test(text.trim())))
})

test('category deletion enforces CAS, built-in protection and live Agent references', async () => {
  async function rejectionFor(row, expectedRevision, referenceRows) {
    const scripted = scriptedPool((text) => {
      if (/^BEGIN|^ROLLBACK/u.test(text)) return { rows: [] }
      if (text.includes('pg_advisory_xact_lock')) return { rows: [] }
      if (text.includes('FROM control.agent_market_categories') && text.includes('FOR UPDATE')) {
        return { rows: [row] }
      }
      if (text.includes('FROM control.agent_market_catalog') && text.includes('FOR SHARE')) {
        return { rows: referenceRows }
      }
      throw new Error(`unexpected SQL: ${text}`)
    })
    const store = new AgentMarketStore(scripted.pool)
    let error
    try {
      await store.deleteCategory(row.category_key, { expectedRevision })
    } catch (caught) {
      error = caught
    }
    assert.ok(error)
    assert.ok(scripted.statements.every(({ text }) => !text.startsWith('DELETE FROM control.agent_market_categories')))
    return error
  }

  const stale = await rejectionFor(categoryRow({ revision: 2 }), 1, [])
  assert.equal(stale.code, 'agent_market_category_revision_conflict')
  const protectedError = await rejectionFor(categoryRow({ category_key: 'demo', system_owned: true }), 1, [])
  assert.equal(protectedError.code, 'agent_market_category_protected')
  const inUse = await rejectionFor(categoryRow(), 1, [{ agent_key: 'custom-agent' }])
  assert.equal(inUse.code, 'agent_market_category_in_use')
  assert.deepEqual(inUse.details.agentKeys, ['custom-agent'])
})

async function withServer(app, run) {
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run('http://127.0.0.1:' + server.address().port)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function appBase(agentMarket, overrides = {}) {
  return {
    service: {},
    store: new MemoryStore(),
    adapter: {},
    adminToken: ADMIN_TOKEN,
    agentMarket,
    search: null,
    agent: null,
    listenerMode: 'admin',
    identity: {
      enabled: true,
      async resolve(credential) {
        if (credential !== 'launcher-platform-admin') return null
        return {
          kind: 'launcher-user',
          memberId: 'launcher-admin-1',
          platformAdmin: true,
          tenantIds: null,
          capabilities: [],
          memberships: [],
        }
      },
    },
    ...overrides,
  }
}

test('catalog API routes decode reserved paths, keep writes Admin-Token-only and never hit legacy Agent lookup', async () => {
  const catalog = builtinAgentMarketCatalog()
  const calls = []
  let legacyLookups = 0
  const agentMarket = {
    listCatalog: async () => catalog,
    getAgent: async () => { legacyLookups += 1; throw new Error('must not use legacy route') },
    createCategory: async (body, context) => { calls.push(['create-category', body, context]); return catalog.categories[0] },
    updateCategory: async (key, body, context) => { calls.push(['update-category', key, body, context]); return catalog.categories[0] },
    deleteCategory: async (key, body) => { calls.push(['delete-category', key, body]); return catalog.categories[0] },
    createCatalogAgent: async (body, context) => { calls.push(['create-agent', body, context]); return catalog.agents[1] },
    updateCatalogAgent: async (key, body, context) => { calls.push(['update-agent', key, body, context]); return catalog.agents[1] },
  }
  await withServer(createApp(appBase(agentMarket)), async (baseUrl) => {
    for (const path of ['/catalog', '/catalog/', '/%63atalog']) {
      const response = await fetch(baseUrl + '/internal/v1/admin/agent-market' + path, {
        headers: { authorization: 'Bearer launcher-platform-admin' },
      })
      assert.equal(response.status, 200, path)
      assert.equal((await response.json()).data.agents.length, 2)
    }
    const malformedPath = await fetch(baseUrl + '/internal/v1/admin/agent-market/%ZZ', {
      headers: { authorization: 'Bearer launcher-platform-admin' },
    })
    assert.equal(malformedPath.status, 404)

    const forbidden = await fetch(baseUrl + '/internal/v1/admin/agent-market/categories', {
      method: 'POST',
      headers: { authorization: 'Bearer launcher-platform-admin', 'content-type': 'application/json' },
      body: JSON.stringify({ categoryKey: 'new-category', name: 'New' }),
    })
    assert.equal(forbidden.status, 403)
    assert.equal((await forbidden.json()).error.code, 'admin_token_required')

    const adminHeaders = { 'x-mx-insight-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' }
    const requests = [
      ['POST', '/categories', { categoryKey: 'new-category', name: 'New' }, 201],
      ['PUT', '/categories/new-category', { expectedRevision: 1, name: 'Updated' }, 200],
      ['DELETE', '/categories/new-category', { expectedRevision: 2 }, 200],
      ['POST', '/agents', { agentKey: 'new-agent', categoryKey: 'demo', name: 'New', summary: '', tags: [] }, 201],
      ['PUT', '/agents/new-agent', { expectedRevision: 1, lifecycle: 'disabled' }, 200],
    ]
    for (const [method, path, body, expectedStatus] of requests) {
      const response = await fetch(baseUrl + '/internal/v1/admin/agent-market' + path, {
        method,
        headers: adminHeaders,
        body: JSON.stringify(body),
      })
      assert.equal(response.status, expectedStatus, `${method} ${path}`)
    }
    const physicalAgentDelete = await fetch(baseUrl + '/internal/v1/admin/agent-market/agents/new-agent', {
      method: 'DELETE',
      headers: adminHeaders,
      body: JSON.stringify({ expectedRevision: 2 }),
    })
    assert.equal(physicalAgentDelete.status, 404)
  })
  assert.equal(legacyLookups, 0)
  assert.deepEqual(calls.map((entry) => entry[0]), [
    'create-category', 'update-category', 'delete-category', 'create-agent', 'update-agent',
  ])
  assert.ok(calls.filter((entry) => entry[0] !== 'delete-category')
    .every((entry) => entry.at(-1).updatedBy === 'admin-token'))
})

test('disabled advanced-search executor is rejected before search or model execution', async () => {
  let modelCalls = 0
  let searchCalls = 0
  const catalog = builtinAgentMarketCatalog()
  catalog.agents = catalog.agents.map((item) => item.executorKey === ADVANCED_SEARCH_EXECUTOR_KEY
    ? { ...item, enabled: false, runnable: false, lifecycle: 'disabled', executionStatus: 'disabled' }
    : item)
  const agentMarket = { listCatalog: async () => catalog }
  const app = createApp(appBase(agentMarket, {
    agent: {
      available: true,
      embeddings: { available: false },
      complete: async () => { modelCalls += 1; throw new Error('must not run') },
    },
    search: {
      queries: {
        searchContent: async () => { searchCalls += 1; throw new Error('must not run') },
      },
    },
  }))
  await withServer(app, async (baseUrl) => {
    const response = await fetch(baseUrl + '/internal/v1/admin/agent-market/' + ADVANCED_SEARCH_EXECUTOR_KEY + '/dry-run', {
      method: 'POST',
      headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error.code, 'agent_market_executor_unavailable')

    const custom = await fetch(baseUrl + '/internal/v1/admin/agent-market/knowledge-qa/dry-run', {
      method: 'POST',
      headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(custom.status, 404)
    assert.equal((await custom.json()).error.code, 'agent_market_not_found')
  })
  assert.equal(modelCalls, 0)
  assert.equal(searchCalls, 0)
})
