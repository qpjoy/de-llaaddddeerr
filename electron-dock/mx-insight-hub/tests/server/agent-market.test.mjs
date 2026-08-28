import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import { runAdvancedSearchDryRun } from '../../server/agent-market/runner.ts'
import {
  AgentMarketStore,
  builtinAdvancedSearchSnapshot,
} from '../../server/agent-market/store.ts'
import {
  ADVANCED_SEARCH_AGENT_KEY,
} from '../../agent-market/advanced-search/schemas.ts'
import {
  freshAdvancedSearchDefinition,
} from '../../agent-market/advanced-search/manifest.ts'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const ADMIN_TOKEN = 'agent-market-admin-token'

test('Agent Market binds native dragging only to explicit handles', async () => {
  const source = await readFile(new URL('../../src/pages-agent-market.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /<article[^>]*(?:draggable|onDragStart)=/u)
  assert.match(source, /className="mih-market-stage-drag-handle" draggable=\{canEdit\}/u)
  assert.match(source, /className="mih-market-trash__drag-handle" draggable=\{canEdit\}/u)
  assert.match(source, /application\/x-mx-insight-agent-market-stage/u)

  const center = await readFile(new URL('../../src/pages-agent-center.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(center, /<article[^>]*(?:draggable|onDragStart)=/u)
  assert.match(center, /className="mih-sequence-drag-handle" draggable=\{canEdit && !busy\}/u)
  assert.equal(
    [...center.matchAll(/className="mih-sequence-drag-handle" draggable=\{canEdit && !busy\}/gu)].length,
    2,
    'Provider and Proxy palettes each expose one explicit handle implementation that is disabled while busy',
  )
  assert.match(center, /application\/x-mx-insight-provider/u)
  assert.match(center, /application\/x-mx-insight-proxy/u)
})

function requestBody(definition = freshAdvancedSearchDefinition()) {
  return {
    dryRun: true,
    query: '北京 人工智能 数据安全',
    filters: {
      platform: null,
      datasetId: null,
      objectType: null,
      fromTime: null,
      toTime: null,
    },
    definition,
  }
}

function searchRow(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    datasetId: 'public-opinion.province.v1',
    platform: 'public_opinion',
    objectType: 'article',
    externalId: 'private-upstream-id',
    title: '北京发布人工智能数据安全治理方案',
    body: '北京市发布人工智能数据安全治理方案。',
    url: 'https://example.invalid/evidence',
    eventTime: '2026-08-20T00:00:00.000Z',
    collectedAt: '2026-08-20T00:01:00.000Z',
    metrics: {},
    matchEvidence: ['raw_phrase'],
    publication: {
      stage: 'formal',
      status: 'formal',
      displayAdmin1: 'CN-BJ',
      locationLabel: '北京',
      countryCode: 'CN',
    },
    // Both fields must be ignored before evidence can enter a model prompt or
    // trace. They intentionally resemble Admin-only canonical detail.
    extensions: { secret: 'must-never-reach-agent-market' },
    raw_payload: { token: 'must-never-reach-agent-market' },
    ...overrides,
  }
}

test('advanced-search dry run reads ES and PG, validates every stage and emits zero-write evidence', async () => {
  const calls = []
  const search = {
    client: {},
    queries: {
      searchContent: async (query, options) => {
        calls.push({ source: 'elasticsearch', query, options })
        return { mode: 'elasticsearch', items: [searchRow()] }
      },
      semanticSearch: async (query, options) => {
        calls.push({ source: 'semantic', query, options })
        return { mode: 'lexical-only', degraded: 'no embedding provider', items: [] }
      },
    },
    postgresQueries: {
      searchContent: async (query, options) => {
        calls.push({ source: 'postgres', query, options })
        return { mode: 'postgres', items: [searchRow({ score: null })] }
      },
    },
  }
  const result = await runAdvancedSearchDryRun({
    body: requestBody(),
    search,
    agent: { available: false, embeddings: { available: false } },
  })

  assert.equal(result.dryRun, true)
  assert.deepEqual(result.safety, {
    writes: 0,
    queueJobs: 0,
    outboxEvents: 0,
    publicSearchMutations: 0,
    nightAllCalls: 0,
    arbitrarySql: false,
    arbitraryElasticsearchDsl: false,
  })
  assert.deepEqual(calls.map((call) => call.source), ['elasticsearch', 'postgres', 'semantic'])
  for (const call of calls.filter((entry) => entry.source !== 'semantic')) {
    assert.equal(call.options.oneShot, true, 'one-shot mode closes the ES PIT without exact-count work')
    assert.equal(call.options.trackTotalHits, false)
    assert.equal(Object.hasOwn(call.options, 'offset'), false)
  }
  assert.equal(result.final.refused, false)
  assert.ok(result.final.citations.length > 0)
  assert.equal(result.evaluation.failedStages, 0)
  assert.equal(result.evaluation.schemaPassRate, 1)
  assert.ok(result.traces.every((trace) => trace.validation.valid))
  assert.doesNotMatch(JSON.stringify(result), /must-never-reach-agent-market/)
})

test('moving retrieve to the trash bypasses all data tools and produces a grounded refusal', async () => {
  const definition = freshAdvancedSearchDefinition()
  definition.stages.find((stage) => stage.type === 'retrieve').state = 'trashed'
  let searchCalls = 0
  const search = {
    client: {},
    queries: {
      searchContent: async () => {
        searchCalls += 1
        return { mode: 'elasticsearch', items: [searchRow()] }
      },
    },
    postgresQueries: {
      searchContent: async () => {
        searchCalls += 1
        return { mode: 'postgres', items: [searchRow()] }
      },
    },
  }

  const result = await runAdvancedSearchDryRun({
    body: requestBody(definition),
    search,
    agent: { available: false, embeddings: { available: false } },
  })
  assert.equal(searchCalls, 0)
  assert.equal(result.final.refused, true)
  assert.equal(result.final.citations.length, 0)
  assert.equal(
    result.traces.find((trace) => trace.type === 'retrieve').status,
    'skipped',
  )
})

test('clarify is a real no-data branch with a specific grounded response', async () => {
  let searchCalls = 0
  let modelCalls = 0
  const result = await runAdvancedSearchDryRun({
    body: requestBody(),
    search: {
      client: {},
      queries: {
        searchContent: async () => {
          searchCalls += 1
          return { mode: 'elasticsearch', items: [searchRow()] }
        },
      },
    },
    agent: {
      available: true,
      embeddings: { available: false },
      complete: async () => {
        modelCalls += 1
        return {
          provider: 'test',
          model: 'test-chat',
          payload: {
            choices: [{
              message: {
                content: JSON.stringify({
                  route: 'clarify',
                  normalizedQuestion: '相关事件',
                  filters: {
                    platform: null,
                    datasetId: null,
                    objectType: null,
                    fromTime: null,
                    toTime: null,
                  },
                  branchReason: '没有说明事件主题、地区或时间范围。',
                }),
              },
            }],
          },
        }
      },
    },
  })

  assert.equal(searchCalls, 0)
  assert.equal(modelCalls, 1, 'only triage runs; the clarification response is deterministic')
  assert.equal(result.final.refused, true)
  assert.match(result.final.answer, /补充/)
  assert.match(result.final.limitations[0], /地区或时间范围/)
  assert.equal(result.traces.find((trace) => trace.type === 'retrieve').status, 'skipped')
})

test('structured-filter branch keeps bounded filters and bypasses generative rewrite', async () => {
  const definition = freshAdvancedSearchDefinition()
  for (const type of ['grade', 'geo', 'answer']) {
    definition.stages.find((stage) => stage.type === type).state = 'trashed'
  }
  const searchCalls = []
  const result = await runAdvancedSearchDryRun({
    body: requestBody(definition),
    search: {
      client: null,
      queries: {
        searchContent: async (query, options) => {
          searchCalls.push({ query, options })
          return { mode: 'postgres', items: [] }
        },
      },
    },
    agent: {
      available: true,
      embeddings: { available: false },
      complete: async () => ({
        provider: 'test',
        model: 'test-chat',
        payload: {
          choices: [{
            message: {
              content: JSON.stringify({
                route: 'structured_filter',
                normalizedQuestion: '北京人工智能事件',
                filters: {
                  platform: 'public_opinion',
                  datasetId: null,
                  objectType: 'article',
                  fromTime: null,
                  toTime: null,
                },
                branchReason: '问题包含明确平台、类型和地区约束。',
              }),
            },
          }],
        },
      }),
    },
  })

  assert.equal(searchCalls.length, 1)
  assert.equal(searchCalls[0].query, '北京人工智能事件')
  assert.equal(searchCalls[0].options.platform, 'public_opinion')
  assert.equal(searchCalls[0].options.objectType, 'article')
  const rewrite = result.traces.find((trace) => trace.type === 'rewrite')
  assert.equal(rewrite.status, 'skipped')
  assert.match(rewrite.note, /structured_filter/)
})

test('trace distinguishes invalid model JSON from the valid effective fallback', async () => {
  const result = await runAdvancedSearchDryRun({
    body: requestBody(),
    search: {
      client: null,
      queries: {
        searchContent: async () => ({ mode: 'postgres', items: [] }),
      },
    },
    agent: {
      available: true,
      embeddings: { available: false },
      complete: async () => ({
        provider: 'test',
        model: 'schema-breaking-model',
        payload: {
          choices: [{ message: { content: JSON.stringify({ unexpected: true }) } }],
        },
      }),
    },
  })

  const triage = result.traces.find((trace) => trace.type === 'triage')
  assert.equal(triage.status, 'degraded')
  assert.equal(triage.validation.valid, true, 'the safe fallback still satisfies the effective contract')
  assert.equal(triage.model.responseValidation.valid, false)
  assert.equal(triage.model.errorCode, 'agent_schema_validation_failed')
  assert.equal(result.evaluation.effectiveSchemaPassRate, 1)
  assert.equal(result.evaluation.modelSchemaPassRate, 0)
})

test('invalid model date filters degrade through Zod instead of aborting the dry run', async () => {
  let calls = 0
  const result = await runAdvancedSearchDryRun({
    body: requestBody(),
    search: {
      client: null,
      queries: { searchContent: async () => ({ mode: 'postgres', items: [] }) },
    },
    agent: {
      available: true,
      embeddings: { available: false },
      complete: async () => {
        calls += 1
        return {
          provider: 'test',
          model: 'test-chat',
          payload: {
            choices: [{ message: { content: JSON.stringify(calls === 1 ? {
              route: 'knowledge_search',
              normalizedQuestion: '昨天的事件',
              filters: {
                platform: null,
                datasetId: null,
                objectType: null,
                fromTime: '昨天',
                toTime: null,
              },
              branchReason: '模型尝试给出自然语言时间。',
            } : { unexpected: true }) } }],
          },
        }
      },
    },
  })

  const triage = result.traces.find((trace) => trace.type === 'triage')
  assert.equal(triage.status, 'degraded')
  assert.equal(triage.model.responseValidation.valid, false)
  assert.equal(triage.model.errorCode, 'agent_schema_validation_failed')
  assert.equal(result.dryRun, true)
})

test('edited prompts, model controls, and selected Sequence reach provider and trace unchanged', async () => {
  const definition = freshAdvancedSearchDefinition()
  const triage = definition.stages.find((stage) => stage.type === 'triage')
  triage.prompt.system = 'CUSTOM SYSTEM {{query}}'
  triage.prompt.user = 'CUSTOM USER {{filters}}'
  triage.model.temperature = 0.73
  triage.model.maxTokens = 777
  for (const stage of definition.stages.slice(1)) stage.state = 'trashed'
  const body = requestBody(definition)
  body.sequenceKey = 'market-chat-sequence'
  let providerCall = null
  const result = await runAdvancedSearchDryRun({
    body,
    search: null,
    agent: {
      available: true,
      embeddings: { available: false },
      complete: async (messages, options) => {
        providerCall = { messages, options }
        return {
          provider: 'test',
          model: 'test-chat',
          sequenceKey: options.sequenceKey,
          payload: {
            choices: [{ message: { content: JSON.stringify({
              route: 'clarify',
              normalizedQuestion: '北京人工智能数据安全',
              filters: {
                platform: null,
                datasetId: null,
                objectType: null,
                fromTime: null,
                toTime: null,
              },
              branchReason: '测试自定义 Prompt 参数链路。',
            }) } }],
          },
        }
      },
    },
  })

  assert.match(providerCall.messages[0].content, /CUSTOM SYSTEM 北京 人工智能 数据安全/)
  assert.match(providerCall.messages[2].content, /CUSTOM USER/)
  assert.equal(providerCall.options.temperature, 0.73)
  assert.equal(providerCall.options.maxTokens, 777)
  assert.equal(providerCall.options.sequenceKey, 'market-chat-sequence')
  const trace = result.traces.find((entry) => entry.type === 'triage')
  assert.deepEqual(trace.messages, providerCall.messages)
  assert.equal(trace.parameters.temperature, 0.73)
  assert.equal(trace.parameters.maxTokens, 777)
  assert.equal(trace.model.sequenceKey, 'market-chat-sequence')
})

test('dry-run concurrency gate rejects excess work before another read starts', async () => {
  let started = 0
  let notifyStarted
  let releaseReads
  const twoStarted = new Promise((resolve) => { notifyStarted = resolve })
  const holdReads = new Promise((resolve) => { releaseReads = resolve })
  const search = {
    client: null,
    queries: {
      searchContent: async () => {
        started += 1
        if (started === 2) notifyStarted()
        await holdReads
        return { mode: 'postgres', items: [] }
      },
    },
  }
  const first = runAdvancedSearchDryRun({ body: requestBody(), search, agent: { available: false } })
  const second = runAdvancedSearchDryRun({ body: requestBody(), search, agent: { available: false } })
  await twoStarted
  await assert.rejects(
    () => runAdvancedSearchDryRun({ body: requestBody(), search, agent: { available: false } }),
    (error) => error?.status === 429 && error?.code === 'agent_market_busy',
  )
  assert.equal(started, 2)
  releaseReads()
  await Promise.all([first, second])
})

test('ES-to-PG degradation contributes one PG ranking to RRF', async () => {
  const result = await runAdvancedSearchDryRun({
    body: requestBody(),
    search: {
      client: {},
      queries: {
        searchContent: async () => ({ mode: 'postgres', items: [searchRow()], degraded: 'ES unavailable' }),
        semanticSearch: async () => ({ mode: 'lexical-only', items: [] }),
      },
      postgresQueries: {
        searchContent: async () => ({ mode: 'postgres', items: [searchRow()] }),
      },
    },
    agent: { available: false, embeddings: { available: false } },
  })

  const fused = result.traces.find((trace) => trace.type === 'fuse' && trace.attempt === 0).output
  assert.equal(fused.inputCandidates, 1)
  assert.equal(fused.evidence[0].rrfScore, Math.round((1 / 61) * 100_000) / 100_000)
  assert.deepEqual(fused.evidence[0].sources, ['postgres'])
})

test('backend failures and degraded metadata cannot leak connection details into trace', async () => {
  const sentinel = 'db-password=AUDIT_SENTINEL index=private_alias'
  const result = await runAdvancedSearchDryRun({
    body: requestBody(),
    search: {
      client: {},
      queries: {
        searchContent: async () => { throw new Error(sentinel) },
        semanticSearch: async () => ({
          mode: sentinel,
          degraded: sentinel,
          items: [],
        }),
      },
      postgresQueries: {
        searchContent: async () => { throw new Error(sentinel) },
      },
    },
    agent: { available: false, embeddings: { available: false } },
  })

  assert.doesNotMatch(JSON.stringify(result), /AUDIT_SENTINEL|private_alias/)
  const retrieval = result.traces.find((trace) => trace.type === 'retrieve')
  assert.equal(retrieval.status, 'degraded')
  assert.ok(retrieval.output.backends.every((backend) => backend.degraded))
})

test('dry-run flag and the complete recoverable stage set are enforced by Zod', async () => {
  await assert.rejects(
    () => runAdvancedSearchDryRun({
      body: { ...requestBody(), dryRun: false },
      search: null,
      agent: null,
    }),
    (error) => error?.status === 400 && error?.code === 'invalid_agent_market_dry_run',
  )

  const definition = freshAdvancedSearchDefinition()
  definition.stages.pop()
  await assert.rejects(
    () => runAdvancedSearchDryRun({
      body: requestBody(definition),
      search: null,
      agent: null,
    }),
    (error) => error?.status === 400 && error?.code === 'invalid_agent_market_dry_run',
  )

  const reordered = freshAdvancedSearchDefinition()
  reordered.stages.reverse()
  await assert.rejects(
    () => runAdvancedSearchDryRun({
      body: requestBody(reordered),
      search: null,
      agent: null,
    }),
    (error) => error?.status === 400 && error?.code === 'invalid_agent_market_dry_run',
  )
})

test('Agent Market store versions whole definitions with CAS and no canonical/outbox writes', async () => {
  const statements = []
  const client = {
    async query(text, params = []) {
      statements.push({ text, params })
      if (text.includes('SELECT revision') && text.includes('FOR UPDATE')) return { rows: [] }
      if (text.includes('INSERT INTO control.agent_market_agents')) {
        return {
          rows: [{
            agent_key: ADVANCED_SEARCH_AGENT_KEY,
            revision: 1,
            schema_version: 1,
            definition: JSON.parse(params[3]),
            updated_by: params[4],
            updated_at: new Date('2026-08-28T00:00:00.000Z'),
          }],
        }
      }
      return { rows: [] }
    },
    release() {},
  }
  const pool = {
    connect: async () => client,
    query: async () => ({ rows: [] }),
  }
  const store = new AgentMarketStore(pool)
  const definition = freshAdvancedSearchDefinition()
  definition.stages.find((stage) => stage.type === 'geo').state = 'trashed'
  const saved = await store.saveAgent(ADVANCED_SEARCH_AGENT_KEY, {
    expectedRevision: 0,
    definition,
  }, { updatedBy: 'admin-token' })

  assert.equal(saved.revision, 1)
  assert.equal(saved.source, 'database')
  assert.equal(saved.definition.stages.find((stage) => stage.type === 'geo').state, 'trashed')
  assert.ok(statements.some(({ text }) => text.includes('agent_center.agent_market_versions')))
  assert.ok(statements.some(({ text }) => text.includes('pg_advisory_xact_lock')))
  assert.ok(statements.every(({ text }) => !/canonical_records|projection_outbox|analysis_tasks/i.test(text)))
})

test('Agent Market store returns the code-owned revision-0 definition before first save', async () => {
  const store = new AgentMarketStore({
    query: async () => ({ rows: [] }),
  })
  const snapshot = await store.getAgent(ADVANCED_SEARCH_AGENT_KEY)
  assert.deepEqual(snapshot, builtinAdvancedSearchSnapshot())
  assert.equal(snapshot.revision, 0)
  assert.equal(snapshot.definition.dryRunOnly, true)
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

test('Agent Market is Admin-listener-only and readable without creating database state', async () => {
  const store = new MemoryStore()
  const base = {
    service: {},
    store,
    adapter: {},
    adminToken: ADMIN_TOKEN,
    agentMarket: null,
    search: null,
    agent: null,
    identity: {
      enabled: true,
      async resolve(credential) {
        if (credential === 'launcher-platform-admin') {
          return {
            kind: 'launcher-user',
            memberId: 'launcher-admin-1',
            platformAdmin: true,
            tenantIds: null,
            capabilities: [],
            memberships: [],
          }
        }
        if (credential === 'launcher-user') {
          return {
            kind: 'launcher-user',
            memberId: 'launcher-user-1',
            platformAdmin: false,
            tenantIds: [],
            capabilities: [],
            memberships: [],
          }
        }
        return null
      },
    },
  }
  const adminApp = createApp({ ...base, listenerMode: 'admin' })
  await withServer(adminApp, async (baseUrl) => {
    const unauthenticated = await fetch(baseUrl + '/internal/v1/admin/agent-market')
    assert.equal(unauthenticated.status, 401)

    const scopedUser = await fetch(baseUrl + '/internal/v1/admin/agent-market', {
      headers: { authorization: 'Bearer launcher-user' },
    })
    assert.equal(scopedUser.status, 403)
    assert.equal((await scopedUser.json()).error.code, 'platform_admin_required')

    const launcherAdmin = await fetch(baseUrl + '/internal/v1/admin/agent-market', {
      headers: { authorization: 'Bearer launcher-platform-admin' },
    })
    assert.equal(launcherAdmin.status, 200)

    const agentCenter = await fetch(baseUrl + '/internal/v1/admin/agent', {
      headers: { authorization: 'Bearer launcher-platform-admin' },
    })
    assert.equal(agentCenter.status, 200, 'Launcher platform admins retain read-only Agent Center access')

    const sequenceWrite = await fetch(baseUrl + '/internal/v1/admin/agent/sequences/read-only-check', {
      method: 'PUT',
      headers: {
        authorization: 'Bearer launcher-platform-admin',
        'content-type': 'application/json',
      },
      body: '{}',
    })
    assert.equal(sequenceWrite.status, 403)
    assert.equal((await sequenceWrite.json()).error.code, 'admin_token_required')

    const reveal = await fetch(baseUrl + '/internal/v1/admin/agent/providers/chat/provider/reveal', {
      method: 'POST',
      headers: {
        authorization: 'Bearer launcher-platform-admin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ adminToken: ADMIN_TOKEN }),
    })
    assert.equal(reveal.status, 403, 'Launcher sessions can never reveal Provider keys')
    assert.equal((await reveal.json()).error.code, 'admin_token_required')

    for (const [method, suffix] of [
      ['PUT', `/${ADVANCED_SEARCH_AGENT_KEY}`],
      ['POST', `/${ADVANCED_SEARCH_AGENT_KEY}/dry-run`],
    ]) {
      const forbidden = await fetch(baseUrl + '/internal/v1/admin/agent-market' + suffix, {
        method,
        headers: {
          authorization: 'Bearer launcher-platform-admin',
          'content-type': 'application/json',
        },
        body: '{}',
      })
      assert.equal(forbidden.status, 403)
      assert.equal((await forbidden.json()).error.code, 'admin_token_required')
    }

    const response = await fetch(baseUrl + '/internal/v1/admin/agent-market', {
      headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
    })
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.data[0].revision, 0)
    assert.equal(payload.data[0].agentKey, ADVANCED_SEARCH_AGENT_KEY)
  })

  const publicApp = createApp({ ...base, listenerMode: 'public' })
  await withServer(publicApp, async (baseUrl) => {
    const response = await fetch(baseUrl + '/internal/v1/admin/agent-market', {
      headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
    })
    assert.equal(response.status, 404)

    const agentCenter = await fetch(baseUrl + '/internal/v1/admin/agent', {
      headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
    })
    assert.equal(agentCenter.status, 404)
  })
})
