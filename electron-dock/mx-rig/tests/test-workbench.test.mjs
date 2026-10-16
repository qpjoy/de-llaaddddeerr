import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../apps/server/index.mjs'
import { CaseBooks } from '../apps/server/case-books.mjs'
import { MissionStore } from '../packages/runtime/store.mjs'
import { RigRuntime } from '../packages/runtime/engine.mjs'
import { ToolExecutor } from '../packages/runtime/tools.mjs'
import { caseBrief } from '../packages/runtime/test-workspace.mjs'
import { modelTurnBody } from '../apps/server/schemas.mjs'
import { verifyProjectVisibility } from './fixtures/project-visibility.mjs'

const CASE = {
  caseId: 'LOGIN-001',
  title: '有效账号登录',
  steps: '输入有效账号并点击登录',
  expected: '进入首页',
  platforms: ['web', 'electron']
}
const ADMIN = 'test-workbench-only'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rig-case-workbench-'))
  const runtime = await start(
    {
      MX_RIG_ADMIN_TOKEN: ADMIN,
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: root,
      MX_RIG_ARTIFACTS_DIR: join(root, 'artifacts')
    },
    { schedule: false }
  )
  t.after(() => runtime.close())
  const api = async (path, body, token = ADMIN) => {
    const response = await fetch(runtime.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() }
  }
  await api('/api/v1/apps', {
    slug: 'luopan-test',
    displayName: 'Luopan fixture',
    sourceDirectory: '/read-only/po-frontend',
    surfaces: ['web', 'electron']
  })
  const created = await api('/api/rig/v1/test-tasks', { app: 'luopan-test', goal: '双端登录验收' })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const id = created.body.mission.id
  return {
    api,
    runtime,
    root,
    id,
    path: `/api/rig/v1/missions/${id}/cases`,
    created: created.body.mission
  }
}

test('real accounts share projects but not task material; two owner sessions reject stale edits', async (t) => {
  const f = await fixture(t)
  await verifyProjectVisibility(f.api)
})

test('project task starts without a model or suite and remains a draft after restart', async (t) => {
  const f = await fixture(t)
  assert.equal(f.created.status, 'draft')
  assert.equal(f.created.agentKey, 'rig-test-assistant')
  assert.equal(f.created.workbench.sourceDirectory, '/read-only/po-frontend')
  assert.equal(f.created.usage, undefined)
  assert.deepEqual((await f.api('/api/v1/tasks')).body.tasks, [])
  assert.deepEqual((await f.api('/api/v1/runs')).body.runs, [])
  assert.equal((await f.api(f.path)).body.book.revision, 0)
  const store = await new MissionStore(join(f.root, 'missions')).init()
  assert.equal(store.get(f.id, 'service-admin').status, 'draft')
  assert.deepEqual(store.get(f.id, 'service-admin').events, [])
  assert.equal(
    (await f.api('/api/rig/v1/test-tasks', { app: 'missing', goal: 'test' })).status,
    404
  )
  assert.equal(
    (
      await f.api('/api/v1/apps', {
        slug: 'invalid-path',
        displayName: 'Bad',
        sourceDirectory: '../other'
      })
    ).status,
    400
  )
})

test('case confirmation preserves its snapshot; revisions require review again', async (t) => {
  const f = await fixture(t)
  const saved = await f.api(f.path, { expectedRevision: 0, cases: [CASE] })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.book.confirmed, false)
  const confirmed = await f.api(f.path + ':confirm', { expectedRevision: 1 })
  assert.equal(confirmed.body.book.confirmed, true)
  assert.equal(confirmed.body.book.confirmedBy, 'service-admin')
  const revised = await f.api(f.path, {
    expectedRevision: 1,
    cases: [{ ...CASE, expected: '进入指定工作区' }]
  })
  assert.equal(revised.body.book.revision, 2)
  assert.equal(revised.body.book.confirmed, false)
  const old = (await f.api(f.path + '?revision=1')).body.book
  assert.equal(old.confirmed, true)
  assert.equal(old.cases[0].expected, CASE.expected)
  assert.equal(old.currentRevision, 2)
  assert.equal((await f.api(f.path + ':confirm', { expectedRevision: 1 })).status, 409)
  const reloaded = new CaseBooks((id) => join(f.root, 'case-books', `${id}.json`))
  assert.equal((await reloaded.read(f.id)).revision, 2)
  assert.deepEqual(
    (await f.api('/api/v1/runs')).body.runs,
    [],
    'confirmation never dispatches a test'
  )
})

test('invalid batches, incomplete cases and stale editors cannot change the accepted scope', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.api(f.path, { expectedRevision: 0, cases: [CASE, CASE] })).status, 400)
  assert.equal((await f.api(f.path)).body.book.revision, 0)
  await f.api(f.path, { expectedRevision: 0, cases: [{ ...CASE, expected: '' }] })
  assert.equal((await f.api(f.path + ':confirm', { expectedRevision: 1 })).status, 409)
  const raced = await Promise.all([
    f.api(f.path, { expectedRevision: 1, cases: [CASE] }),
    f.api(f.path, { expectedRevision: 1, cases: [{ ...CASE, title: '其他编辑' }] })
  ])
  assert.deepEqual(raced.map((r) => r.status).sort(), [200, 409])
  assert.equal((await f.api(f.path)).body.book.revision, 2)
  assert.equal((await f.api(f.path + '?revision=99')).status, 404)
  assert.equal((await f.api(f.path + '?revision=NaN')).status, 400)
})

test('case books enforce mission ownership and the operator role', async (t) => {
  const f = await fixture(t)
  const resolve = f.runtime.kernel.identity.resolve
  f.runtime.kernel.identity.resolve = async (token, source) => {
    if (token === 'foreign') return { id: 'another-member', role: 'operator' }
    if (token === 'viewer') return { id: 'service-admin', role: 'viewer' }
    return resolve(token, source)
  }
  assert.equal((await f.api(f.path, undefined, 'foreign')).status, 404)
  assert.equal((await f.api(f.path, { expectedRevision: 0, cases: [CASE] }, 'foreign')).status, 404)
  assert.equal((await f.api(f.path, undefined, 'viewer')).status, 200)
  assert.equal((await f.api(f.path, { expectedRevision: 0, cases: [CASE] }, 'viewer')).status, 403)
  assert.equal(
    (await f.api('/api/rig/v1/test-tasks', { app: 'luopan-test', goal: 'No' }, 'viewer')).status,
    403
  )
})

test('conversation receives the latest user cases but Agent suggestions never edit or confirm them', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rig-case-agent-'))
  const store = await new MissionStore(join(root, 'missions')).init()
  const books = new CaseBooks((id) => join(root, 'books', `${id}.json`))
  const turns = []
  const client = {
    async request(path, body) {
      if (path === '/api/v1/apps')
        return {
          apps: [
            { id: 'app-a', slug: 'luopan-test', displayName: 'Luopan', sourceDirectory: '/source' }
          ]
        }
      if (path.endsWith('/cases')) return { book: await books.read(path.split('/')[5]) }
      if (path === '/api/rig/v1/execution-config')
        return {
          policy: { revision: '1', maxTurns: 4, allowedTools: ['case_draft'], browserOrigins: [] }
        }
      if (path === '/api/rig/v1/model/turn') {
        turns.push(structuredClone(body))
        return {
          message:
            turns.length === 1
              ? {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'draft-1',
                      type: 'function',
                      function: {
                        name: 'case_draft',
                        arguments: JSON.stringify({
                          app: 'luopan-test',
                          caseId: CASE.caseId,
                          title: '登录修订建议',
                          priority: 'P1',
                          steps: '点击登录 => 进入工作区'
                        })
                      }
                    }
                  ]
                }
              : { content: '草稿已提交，请审阅。' }
        }
      }
      if (path.endsWith('/project-access')) return { allowed: true }
      if (path.endsWith('/access')) return { access: { canWrite: true } }
      throw new Error(`Unexpected ${path}`)
    }
  }
  const runtime = new RigRuntime({
    store,
    client,
    executor: new ToolExecutor(client),
    owner: 'alice'
  })
  t.after(() => runtime.close())
  const created = await runtime.createTestTask({ app: 'luopan-test', goal: '登录验收' })
  await books.change(created.id, 'alice', 'edit', { expectedRevision: 0, cases: [CASE] })
  await books.change(created.id, 'alice', 'confirm', { expectedRevision: 1 })
  await runtime.followup(created.id, { goal: '请修正这个用例' })
  await runtime.job
  assert.equal(store.get(created.id, 'alice').status, 'completed')
  assert.equal(store.get(created.id, 'alice').caseDrafts[0].caseId, CASE.caseId)
  assert.match(turns[0].messages[0].content, /用户已确认/)
  assert.match(turns[0].messages[0].content, /进入首页/)
  assert.equal((await books.read(created.id)).cases[0].expected, CASE.expected)
  assert.equal((await books.read(created.id)).confirmed, true)
  await books.change(created.id, 'alice', 'edit', {
    expectedRevision: 1,
    cases: [{ ...CASE, expected: '本轮新的用户预期' }]
  })
  await runtime.followup(created.id, { goal: '继续核对' })
  await runtime.job
  assert.match(turns.at(-1).messages.at(-1).content, /本轮新的用户预期/)
})

test('large case books explicitly bound model context within the transport contract', () => {
  const mission = {
    goal: 'G'.repeat(8000),
    workbench: { displayName: 'P', appSlug: 'p', sourceDirectory: '/source' }
  }
  const book = {
    revision: 1,
    confirmed: false,
    cases: Array.from({ length: 200 }, (_, i) => ({
      ...CASE,
      caseId: `C-${i}`,
      expected: 'E'.repeat(8000)
    }))
  }
  const content = `${'U'.repeat(8000)}\n\n${caseBrief(mission, book)}`
  assert.match(content, /仅附前/)
  assert.ok(modelTurnBody.safeParse({ messages: [{ role: 'user', content }], tools: [] }).success)
})

test('task results retain missing cases and paginate model evidence without silently dropping coverage', async () => {
  const id = '00000000-0000-0000-0000-000000000001'
  const policy = { revision: '1', allowedTools: ['task_results'] }
  const calls = []
  const executor = new ToolExecutor({ async request(path) {
    calls.push(path)
    if (path.endsWith('execution-config')) return { policy }
    return { hasMore: false, runs: [{ id: 'run-own', status: 'blocked', revision: 2, platform: 'electron', profile: 'real', coverage: Array.from({ length: 21 }, (_, i) => ({ caseId: `CASE-${i}`, result: i === 20 ? null : { status: 'failed', errorText: 'x'.repeat(1000) } })) }] }
  } })
  const ctx = { policy, workbench: true, missionId: id }
  const first = (await executor.execute('task_results', {}, ctx)).runs[0]
  assert.equal(first.coverage.length, 10)
  assert.equal(first.nextCaseOffset, 10)
  assert.equal(first.totalCases, 21)
  assert.equal(first.coverage[0].result.errorTruncated, true)
  const last = (await executor.execute('task_results', { runId: 'run-own', caseOffset: 20 }, ctx)).runs[0]
  assert.equal(last.nextCaseOffset, null)
  assert.equal(last.coverage[0].caseId, 'CASE-20')
  assert.equal(last.coverage[0].result, null)
  assert.equal(calls.at(-1), `/api/rig/v1/missions/${id}/executions?run=run-own`)
})
