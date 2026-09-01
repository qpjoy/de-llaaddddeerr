import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import { compileAgentDraft } from '../../server/agent-studio/compiler.mjs'
import { definitionHash } from '../../server/agent-studio/contracts.mjs'
import { listNodeTypes } from '../../server/agent-studio/registry.mjs'
import { AgentStudioStore } from '../../server/agent-studio/store.mjs'
import { listTemplates, templateDefinition } from '../../server/agent-studio/templates.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const ADMIN_TOKEN = 'agent-studio-test-admin-token'
const DRAFT_ID = '10000000-0000-4000-8000-000000000001'

async function withServer(app, operation) {
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await operation(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function requestOptions(token = ADMIN_TOKEN, { method = 'GET', body } = {}) {
  return {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
}

test('migration 046 seeds only truthful compile-only portfolio drafts', async () => {
  const sql = await readFile(new URL('../../migrations/046_agent_studio_p1.sql', import.meta.url), 'utf8')
  const metadataSql = await readFile(
    new URL('../../migrations/047_agent_studio_project_metadata.sql', import.meta.url),
    'utf8',
  )
  assert.match(sql, /CREATE TABLE IF NOT EXISTS control\.agent_studio_agents/u)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS control\.agent_studio_drafts/u)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS agent_center\.agent_studio_draft_versions/u)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS control\.agent_compiled_artifacts/u)
  assert.match(metadataSql, /archived boolean NOT NULL DEFAULT false/u)
  assert.match(sql, /'public-opinion-mapping', '全国舆情多源接入与字段映射'/u)
  assert.match(sql, /'enterprise-registry-intelligence', '企业登记数据映射'/u)
  assert.match(sql, /'news-normalization', '新闻内容标准化'/u)
  assert.match(sql, /'search-result-normalization', '搜索结果标准化'/u)
  assert.match(sql, /source:\/\/hub\/public-opinion\.province\.v1/u)
  assert.match(sql, /P1 ends at a reviewed mapping proposal/u)
  const embedded = sql.match(/\$definition\$\s*([\s\S]*?)\s*\$definition\$/u)
  assert.ok(embedded)
  const embeddedDefinition = JSON.parse(embedded[1])
  assert.deepEqual(embeddedDefinition, templateDefinition('public-opinion-mapping'))
  assert.equal(definitionHash(embeddedDefinition), '943925cedd6d86d75065aa4321c9e6fd7fcbd5a37b8fde7ff47be82da50f0973')
  assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS [a-z_.]*(?:runs|evals|releases|deployments)/iu)
  assert.doesNotMatch(sql, /\b(?:run_count|accuracy|latency|health)\s+(?:bigint|integer|numeric|real|text)/iu)
})

test('the public-opinion template compiles to a non-runnable reviewed mapping artifact', () => {
  const definition = templateDefinition('public-opinion-mapping')
  const first = compileAgentDraft(definition)
  const second = compileAgentDraft(structuredClone(definition))

  assert.equal(first.valid, true)
  assert.equal(first.artifactHash, second.artifactHash)
  assert.equal(first.normalizedPlan.entryNodeId, 'source')
  assert.deepEqual(first.normalizedPlan.terminalNodeIds, ['mapping_output'])
  assert.equal(first.normalizedPlan.policy.runnable, false)
  assert.equal(first.normalizedPlan.policy.arbitraryNetwork, false)
  assert.equal(first.normalizedPlan.policy.arbitrarySql, false)
  assert.equal(first.assurance.contractVersion, 'mx-insight.agent-static-assurance.v1')
  assert.equal(first.assurance.owner, 'mx-insight-hub')
  assert.equal(first.assurance.status, 'passed')
  assert.equal(first.assurance.checks.length, 6)
  assert.ok(first.assurance.checks.every((check) => check.status === 'passed'))
  assert.deepEqual(first.normalizedPlan.assurance, first.assurance)
  assert.equal(first.normalizedPlan.assurance.limitations.runtimeEvents, false)
  assert.equal(first.normalizedPlan.assurance.limitations.evaluationResults, false)
  assert.equal(first.normalizedPlan.ui, undefined)
  assert.equal(
    first.normalizedPlan.nodes.find((node) => node.nodeId === 'human_review').approvalClass,
    'human-required',
  )
  assert.deepEqual(
    first.normalizedPlan.edges.map((edge) => `${edge.from.port}:${edge.to.port}`).sort(),
    [
      'candidate:mappingProposal',
      'proposal:proposal',
      'validated:validated',
      'profile:profile',
      'profile:profile',
      'source:source',
      'postgresql:source',
    ].sort(),
  )
  assert.equal(first.summary.modelNodeCount, 1)
  assert.equal(first.summary.readOnlyToolNodeCount, 1)
})

test('the mobile-commerce template preserves fixed-pipeline semantics in an authoring-only proposal', () => {
  const listed = listTemplates().find((item) => item.templateKey === 'mobile-commerce-data-processing')
  assert.ok(listed)
  assert.equal(listed.availability, 'authoring-only')
  assert.equal(listed.runtimeAvailable, false)

  const definition = templateDefinition('mobile-commerce-data-processing')
  const compiled = compileAgentDraft(definition)
  assert.equal(compiled.valid, true)
  assert.equal(compiled.normalizedPlan.policy.runnable, false)
  assert.equal(compiled.normalizedPlan.policy.arbitraryNetwork, false)
  assert.equal(compiled.normalizedPlan.policy.arbitrarySql, false)
  assert.deepEqual(compiled.normalizedPlan.terminalNodeIds, ['mapping_output'])
  assert.deepEqual(
    definition.nodes.map((node) => node.nodeId),
    [
      'source',
      'source_route',
      'schema_profile',
      'mapping_proposal',
      'mapping_validation',
      'human_review',
      'mapping_output',
    ],
  )
  assert.ok(compiled.dependencyManifest.logicalRefs.some((item) => (
    item.kind === 'source'
    && item.key === 'source://hub/mobile-commerce.collected-items.v1'
  )))
  assert.equal(
    compiled.normalizedPlan.nodes.find((node) => node.nodeId === 'human_review').approvalClass,
    'human-required',
  )

  const mappingNode = definition.nodes.find((node) => node.nodeId === 'mapping_proposal')
  const instructions = `${mappingNode.config.systemPrompt} ${mappingNode.config.taskTemplate}`
  for (const expected of [
    'mobile_commerce as the authorization domain',
    'governed source catalog',
    'keep it unknown',
    'id only as capture identity',
    'goods_id as product identity only when non-empty',
    'never fuzzy-deduplicate by title or price',
    'brand as a possible monitoring-campaign label',
    'product_link and shop_link as share text',
    'Asia/Shanghai collection timestamp',
    'never as publication time',
    'only when append-only, late-commit, uniqueness, immutability, and index evidence are all explicit',
    'Exclude task_run_id, device_serial, is_reported, and arbitrary metadata from public output',
    'Preserve raw lineage and source generation',
    'Evidence every schema-drift or quality finding and require human approval',
    'never import, index, publish, remotely fetch',
    'fixed mapping remains the production import and Elasticsearch indexing path',
  ]) {
    assert.match(instructions, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  }
  assert.match(
    definition.ui.annotations[0].text,
    /deterministic fixed mapping is the current production path/u,
  )
  assert.match(definition.ui.annotations[0].text, /future candidate for human review/u)
})

test('the code-owned registry advertises no write/runtime node capability', () => {
  const registry = listNodeTypes()
  assert.equal(registry.execution.status, 'unavailable')
  assert.ok(registry.items.some((item) => item.nodeType === 'core.input.source'))
  assert.ok(registry.items.find((item) => item.nodeType === 'core.input.source')
    .configSpec.fields[0].values.includes('source://hub/mobile-commerce.collected-items.v1'))
  assert.ok(registry.items.some((item) => (
    item.nodeType === 'core.review.mapping-required'
    && item.approvalClass === 'human-required'
  )))
  assert.ok(registry.items.every((item) => ['none', 'read'].includes(item.effect)))
  assert.ok(registry.items.every((item) => item.runtimeAvailable === false))
  assert.ok(registry.items.every((item) => !/(?:import|publish|deploy|sql|code)/iu.test(item.nodeType)))
})

test('the compiler rejects unknown nodes, capability injection, type mismatches, cycles and budget bypasses', () => {
  const base = templateDefinition('public-opinion-mapping')

  const unknown = structuredClone(base)
  unknown.nodes[2].nodeType = 'hub.schema.user-defined'
  const unknownResult = compileAgentDraft(unknown)
  assert.ok(unknownResult.diagnostics.some((item) => item.code === 'unknown_node_type'))
  assert.equal(unknownResult.assurance.status, 'failed')
  assert.equal(
    unknownResult.assurance.checks.find((check) => check.key === 'registry-and-config').status,
    'failed',
  )

  for (const forbiddenKey of ['url', 'sql', 'code', 'runtimeFactoryId']) {
    const injected = structuredClone(base)
    injected.nodes[0].config[forbiddenKey] = 'attacker-controlled'
    const codes = compileAgentDraft(injected).diagnostics.map((item) => item.code)
    assert.ok(codes.includes('forbidden_definition_capability'), forbiddenKey)
  }

  const mismatched = structuredClone(base)
  mismatched.edges[0].to = { nodeId: 'mapping_proposal', port: 'profile' }
  assert.ok(compileAgentDraft(mismatched).diagnostics.some((item) => item.code === 'port_type_mismatch'))

  const cyclic = templateDefinition('starter-governed-agent')
  cyclic.edges.push({
    from: { nodeId: 'route', port: 'knowledge' },
    to: { nodeId: 'normalize', port: 'query' },
  })
  assert.ok(compileAgentDraft(cyclic).diagnostics.some((item) => item.code === 'graph_cycle_forbidden'))

  const bypass = structuredClone(base)
  bypass.budgets.maxLoopIterations = 1
  bypass.budgets.maxModelCalls = 0
  const budgetCodes = compileAgentDraft(bypass).diagnostics.map((item) => item.code)
  assert.ok(budgetCodes.includes('budget_limit_exceeded'))
  assert.ok(budgetCodes.includes('budget_insufficient'))

  const clientEffect = structuredClone(base)
  clientEffect.nodes[0].effect = 'write'
  assert.ok(compileAgentDraft(clientEffect).diagnostics.some((item) => item.code === 'definition_schema_invalid'))
})

test('layout-only edits do not change artifact identity, while execution config does', () => {
  const base = templateDefinition('public-opinion-mapping')
  const layout = structuredClone(base)
  layout.ui.positions.source = { x: 999, y: -100 }
  const changedPrompt = structuredClone(base)
  changedPrompt.nodes.find((node) => node.nodeId === 'mapping_proposal').config.taskTemplate += ' Keep a confidence score.'

  assert.equal(compileAgentDraft(base).artifactHash, compileAgentDraft(layout).artifactHash)
  assert.notEqual(compileAgentDraft(base).artifactHash, compileAgentDraft(changedPrompt).artifactHash)
})

test('createProject accepts a template and atomically creates its revision-one draft', async () => {
  const queries = []
  const client = {
    async query(text, values = []) {
      queries.push({ text, values })
      return { rows: [] }
    },
    release() {},
  }
  const store = new AgentStudioStore(
    { async connect() { return client } },
    { idFactory: () => DRAFT_ID },
  )
  store.getProject = async (agentKey) => ({ agentKey, draft: { draftId: DRAFT_ID, revision: 1 } })
  store.getDraft = async (agentKey, draftId) => ({ agentKey, draftId, revision: 1 })

  const result = await store.createProject({
    agentKey: 'public-opinion-review',
    displayName: 'Public Opinion Review',
    summary: 'Compile-only mapping project',
    riskClass: 'medium',
    tags: ['mapping'],
    templateKey: 'public-opinion-mapping',
  }, { updatedBy: 'test-admin' })

  assert.equal(result.draft.draftId, DRAFT_ID)
  const projectInsert = queries.find((query) => query.text.includes('agent_studio_agents'))
  const draftInsert = queries.find((query) => query.text.includes('agent_studio_drafts'))
  const versionInsert = queries.find((query) => query.text.includes('agent_studio_draft_versions'))
  assert.ok(projectInsert)
  assert.equal(projectInsert.values[4], 'template-derived')
  assert.equal(projectInsert.values[5], 'Hub governed data')
  assert.ok(draftInsert)
  assert.equal(draftInsert.values[0], DRAFT_ID)
  assert.equal(compileAgentDraft(JSON.parse(draftInsert.values[2])).valid, true)
  assert.ok(versionInsert)
  assert.equal(queries.at(-1).text, 'COMMIT')
})

test('draft saving is CAS-protected before any mutable or version write', async () => {
  const queries = []
  const client = {
    async query(text) {
      queries.push(text)
      if (text.includes('SELECT current_revision')) return { rows: [{ current_revision: 3 }] }
      return { rows: [] }
    },
    release() {},
  }
  const store = new AgentStudioStore({ async connect() { return client } })

  await assert.rejects(
    () => store.updateDraft(
      'public-opinion-mapping',
      DRAFT_ID,
      {
        expectedRevision: 2,
        definition: templateDefinition('public-opinion-mapping'),
      },
      { updatedBy: 'test-admin' },
    ),
    (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.code, 'agent_studio_revision_conflict')
      assert.deepEqual(error.details, { expectedRevision: 2, currentRevision: 3 })
      return true
    },
  )
  assert.ok(queries.includes('ROLLBACK'))
  assert.ok(queries.every((text) => !text.includes('UPDATE control.agent_studio_drafts')))
  assert.ok(queries.every((text) => !text.includes('INSERT INTO agent_center.agent_studio_draft_versions')))
})

test('project metadata update is strict, CAS-protected, and never mutates drafts or artifacts', async () => {
  const statements = []
  const client = {
    async query(text, values = []) {
      statements.push({ text, values })
      if (text.includes('SELECT revision')) return { rows: [{ revision: 4 }] }
      return { rows: [] }
    },
    release() {},
  }
  const store = new AgentStudioStore({ async connect() { return client } })
  store.getProject = async (agentKey) => ({ agentKey, revision: 5, archived: true })

  const updated = await store.updateProject(
    'public-opinion-mapping',
    {
      expectedRevision: 4,
      displayName: 'Public Opinion Mapping v2',
      summary: 'Updated metadata only',
      owner: 'data-governance',
      dataScope: 'Governed nationwide opinion sources',
      riskClass: 'high',
      tags: ['mapping', 'reviewed'],
      archived: true,
    },
    { updatedBy: 'test-admin' },
  )
  assert.deepEqual(updated, {
    agentKey: 'public-opinion-mapping', revision: 5, archived: true,
  })
  const update = statements.find(({ text }) => text.includes('UPDATE control.agent_studio_agents'))
  assert.ok(update)
  assert.match(update.text, /WHERE agent_key = \$1 AND revision = \$2/u)
  assert.deepEqual(update.values, [
    'public-opinion-mapping', 4, 'Public Opinion Mapping v2',
    'Updated metadata only', 'data-governance',
    'Governed nationwide opinion sources', 'high',
    JSON.stringify(['mapping', 'reviewed']), true, 'test-admin',
  ])
  assert.ok(statements.every(({ text }) => !/agent_studio_drafts|agent_compiled_artifacts/u.test(text)))

  const conflictClient = {
    async query(text) {
      if (text.includes('SELECT revision')) return { rows: [{ revision: 6 }] }
      return { rows: [] }
    },
    release() {},
  }
  const conflictStore = new AgentStudioStore({ async connect() { return conflictClient } })
  await assert.rejects(
    () => conflictStore.updateProject(
      'public-opinion-mapping',
      { expectedRevision: 5, archived: false },
      { updatedBy: 'test-admin' },
    ),
    (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.code, 'agent_studio_project_revision_conflict')
      assert.deepEqual(error.details, { expectedRevision: 5, currentRevision: 6 })
      return true
    },
  )

  const validationStore = new AgentStudioStore({
    async connect() { throw new Error('validation must run before database access') },
  })
  for (const body of [
    { expectedRevision: 1 },
    { expectedRevision: 1, lifecycle: 'published' },
    { expectedRevision: 1, draft: null },
    { expectedRevision: 1, tags: ['duplicate', 'duplicate'] },
  ]) {
    await assert.rejects(
      () => validationStore.updateProject('public-opinion-mapping', body, { updatedBy: 'test-admin' }),
      (error) => error.status === 400 && error.code === 'invalid_agent_studio_project_update',
    )
  }
})

test('portfolio exposes an artifact only for the current draft revision', async () => {
  const statements = []
  const store = new AgentStudioStore({
    async query(text) {
      statements.push(text)
      return { rows: [] }
    },
  })

  assert.deepEqual(await store.listProjects(), [])
  assert.equal(statements.length, 1)
  assert.match(statements[0], /compiled\.draft_revision = d\.current_revision/u)
})

test('compileDraft persists one immutable server-owned artifact and no execution record', async () => {
  const definition = templateDefinition('public-opinion-mapping')
  const statements = []
  const compiledAt = new Date('2026-08-31T00:00:00.000Z')
  const artifactId = '20000000-0000-4000-8000-000000000001'
  const client = {
    async query(text, values = []) {
      statements.push({ text, values })
      if (text.includes('SELECT current_revision, definition')) {
        return { rows: [{ current_revision: 1, definition }] }
      }
      if (text.includes('INSERT INTO control.agent_compiled_artifacts')) {
        return {
          rows: [{
            artifact_id: values[0],
            agent_key: values[1],
            draft_id: values[2],
            draft_revision: values[3],
            compiler_version: values[4],
            node_registry_version: values[5],
            normalized_plan: JSON.parse(values[6]),
            dependency_manifest: JSON.parse(values[7]),
            diagnostics: JSON.parse(values[8]),
            artifact_hash: values[9],
            created_by: values[10],
            created_at: compiledAt,
          }],
        }
      }
      return { rows: [] }
    },
    release() {},
  }
  const store = new AgentStudioStore(
    { async connect() { return client } },
    { idFactory: () => artifactId },
  )

  const artifact = await store.compileDraft(
    'public-opinion-mapping',
    DRAFT_ID,
    { expectedRevision: 1 },
    { updatedBy: 'test-admin' },
  )
  assert.equal(artifact.artifactId, artifactId)
  assert.equal(artifact.status, 'valid')
  assert.equal(artifact.reused, false)
  assert.equal(artifact.normalizedPlan.policy.runnable, false)
  assert.equal(artifact.compiledAt, compiledAt.toISOString())
  const insert = statements.find(({ text }) => text.includes('INSERT INTO control.agent_compiled_artifacts'))
  assert.match(insert.text, /ON CONFLICT \(draft_id, draft_revision, artifact_hash\) DO NOTHING/u)
  assert.ok(statements.every(({ text }) => !/(?:agent_studio_runs|eval|release|deployment)/iu.test(text)))
})

test('Agent Studio routes separate platform-admin reads from Admin Token mutations', async () => {
  const calls = []
  const agentStudio = {
    async listProjects() { calls.push('list'); return [{ agentKey: 'seed' }] },
    async getProject(agentKey) { calls.push(`get:${agentKey}`); return { agentKey } },
    async createProject(body) { calls.push(['create', body]); return { project: { agentKey: body.agentKey }, draft: null } },
    async updateProject(agentKey, body) { calls.push(['updateProject', agentKey, body]); return { agentKey, ...body, revision: 2 } },
    async updateDraft() { calls.push('update'); return {} },
  }
  const app = createApp({
    service: {},
    store: new MemoryStore(),
    adapter: {},
    agentStudio,
    adminToken: ADMIN_TOKEN,
    listenerMode: 'admin',
    identity: {
      enabled: true,
      async resolve() {
        return {
          kind: 'launcher-user', memberId: 'member-1', platformAdmin: true,
          tenantIds: null, capabilities: ['membership.write'], memberships: [],
        }
      },
    },
    logger: { error() {} },
  })

  await withServer(app, async (baseUrl) => {
    const registry = await fetch(
      `${baseUrl}/internal/v1/admin/agent-studio/node-types`,
      requestOptions(),
    )
    assert.equal(registry.status, 200)
    assert.equal((await registry.json()).data.execution.status, 'unavailable')

    const projects = await fetch(
      `${baseUrl}/internal/v1/admin/agent-studio/projects`,
      requestOptions('launcher-platform-admin'),
    )
    assert.equal(projects.status, 200)
    assert.deepEqual((await projects.json()).data, [{ agentKey: 'seed' }])

    const denied = await fetch(
      `${baseUrl}/internal/v1/admin/agent-studio/projects/seed/drafts/${DRAFT_ID}`,
      requestOptions('launcher-platform-admin', {
        method: 'PUT',
        body: { expectedRevision: 1, definition: templateDefinition('public-opinion-mapping') },
      }),
    )
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).error.code, 'admin_token_required')
    assert.ok(!calls.includes('update'))

    const deniedProjectUpdate = await fetch(
      `${baseUrl}/internal/v1/admin/agent-studio/projects/seed`,
      requestOptions('launcher-platform-admin', {
        method: 'PUT', body: { expectedRevision: 1, archived: true },
      }),
    )
    assert.equal(deniedProjectUpdate.status, 403)
    assert.equal((await deniedProjectUpdate.json()).error.code, 'admin_token_required')
    assert.ok(!calls.some((call) => Array.isArray(call) && call[0] === 'updateProject'))

    const projectUpdate = await fetch(
      `${baseUrl}/internal/v1/admin/agent-studio/projects/seed`,
      requestOptions(ADMIN_TOKEN, {
        method: 'PUT', body: { expectedRevision: 1, archived: true },
      }),
    )
    assert.equal(projectUpdate.status, 200)
    assert.equal((await projectUpdate.json()).data.archived, true)

    const unavailable = await fetch(
      `${baseUrl}/internal/v1/admin/agent-studio/evals`,
      requestOptions(),
    )
    assert.equal(unavailable.status, 501)
    assert.equal((await unavailable.json()).error.code, 'agent_studio_phase_unavailable')
  })
})
