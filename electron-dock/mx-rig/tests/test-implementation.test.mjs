import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { start } from '../apps/server/index.mjs'
import { CaseBooks } from '../apps/server/case-books.mjs'
import { TestImplementations } from '../apps/server/test-implementations.mjs'
import { TestProjectWorkspace } from '../packages/runtime/test-project-workspace.mjs'
import { ToolExecutor } from '../packages/runtime/tools.mjs'
import { RigClient } from '../packages/runtime/client.mjs'
import { InProcessClient } from '../apps/server/in-process-client.mjs'

const ID = '00000000-0000-0000-0000-000000000001'
const CASE = {
  caseId: 'LOGIN-001',
  title: '登录',
  steps: '输入账号并登录',
  expected: '进入工作区',
  platforms: ['web', 'electron']
}
const PROPOSAL = {
  summary: '登录测试',
  engine: 'playwright',
  platform: 'web',
  files: [
    {
      path: 'tests/login.spec.ts',
      content:
        "test('LOGIN-001 登录', async ({ page }) => { await expect(page.getByText('工作区')).toBeVisible() })\n"
    }
  ],
  mappings: [{ caseId: CASE.caseId, path: 'tests/login.spec.ts', assertion: '工作区可见' }]
}
async function docs() {
  const root = await mkdtemp(join(tmpdir(), 'rig-implementation-'))
  const books = new CaseBooks((id) => join(root, 'cases', id + '.json'))
  const implementations = new TestImplementations((id) => join(root, 'code', id + '.json'), books)
  await books.change(ID, 'alice', 'edit', { expectedRevision: 0, cases: [CASE] })
  await books.change(ID, 'alice', 'confirm', { expectedRevision: 1 })
  const save = (proposal = PROPOSAL, expectedVersion = 0, caseRevision = 1) =>
    implementations.change(ID, 'alice', 'edit', { expectedVersion, caseRevision, proposal })
  const approve = (data) =>
    implementations.change(ID, 'alice', 'approve', {
      expectedVersion: data.version,
      hash: data.proposal.hash
    })
  return { root, books, implementations, save, approve }
}

test('implementation revisions bind confirmed cases, retain approvals and restore as a new draft', async () => {
  const f = await docs()
  let data = await f.save()
  assert.equal(data.version, 1)
  assert.equal(data.proposal.reviewedAt, null)
  data = await f.approve(data)
  assert.equal(data.proposal.reviewedBy, 'alice')
  const first = data.proposal
  const next = await f.save(
    {
      ...PROPOSAL,
      summary: '修改断言',
      files: [{ ...PROPOSAL.files[0], content: PROPOSAL.files[0].content + '// revised\n' }]
    },
    1
  )
  assert.equal(next.proposal.reviewedAt, null)
  assert.equal(next.baseVersion, 1)
  assert.match(next.diffs[0].diff, /\+ \/\/ revised/)
  assert.equal((await f.implementations.read(ID, 1)).proposal.hash, first.hash)
  await assert.rejects(f.approve(data), { code: 'implementation_conflict' })
  const restored = await f.save(PROPOSAL, 2)
  assert.equal(restored.version, 3)
  assert.equal(restored.proposal.hash, first.hash)
  assert.equal(restored.proposal.reviewedAt, null, 'restoring content never restores approval')
  await f.books.change(ID, 'alice', 'edit', {
    expectedRevision: 1,
    cases: [{ ...CASE, expected: '进入指定工作区' }]
  })
  assert.equal((await f.implementations.read(ID)).stale, true)
  await assert.rejects(f.approve(restored), { code: 'implementation_stale' })
  await assert.rejects(f.save(PROPOSAL, 3), { code: 'implementation_stale' })
})

test('invalid paths, case scope, platforms and concurrent editors cannot silently change a reviewed proposal', async () => {
  const f = await docs()
  for (const path of [
    '../src/app.ts',
    '/tmp/test.spec.ts',
    'tests/../../a.spec.ts',
    'tests/./a.spec.ts',
    'tests//a.spec.ts',
    'package.json'
  ])
    await assert.rejects(
      f.save({
        ...PROPOSAL,
        files: [{ path, content: 'x' }],
        mappings: [{ ...PROPOSAL.mappings[0], path }]
      })
    )
  await assert.rejects(
    f.save({ ...PROPOSAL, mappings: [{ ...PROPOSAL.mappings[0], caseId: 'UNKNOWN' }] }),
    { code: 'invalid_implementation' }
  )
  await assert.rejects(f.save({ ...PROPOSAL, platform: 'electron' }), {
    code: 'invalid_implementation'
  })
  const race = await Promise.allSettled([f.save(), f.save({ ...PROPOSAL, summary: '并发编辑' })])
  assert.equal(race.filter((row) => row.status === 'fulfilled').length, 1)
  assert.equal((await f.implementations.read(ID)).version, 1)
})

test('desktop source is task-bound, read-only and refuses credential aliases and directory escapes', async () => {
  const f = await docs()
  const source = join(f.root, 'source')
  await mkdir(source)
  await writeFile(join(source, 'login.ts'), "export const title = '工作区'\n")
  await writeFile(join(source, '.env'), 'API_KEY=never-send')
  await symlink('.env', join(source, 'innocent.ts'))
  await symlink(f.root, join(source, 'escape'))
  const local = new TestProjectWorkspace(join(f.root, 'rig'))
  await local.bind(ID, source)
  const context = { missionId: ID, workbench: true }
  assert.match(
    (await local.execute({ operation: 'read', path: 'login.ts' }, context)).text,
    /工作区/
  )
  await assert.rejects(local.execute({ operation: 'read', path: 'innocent.ts' }, context), {
    code: 'protected_path'
  })
  await assert.rejects(
    local.execute({ operation: 'read', path: 'escape/cases/' + ID + '.json' }, context),
    { code: 'outside_workspace' }
  )
  await assert.rejects(local.execute({ operation: 'run', command: 'echo no' }, context), {
    code: 'source_read_only'
  })
  await assert.rejects(local.bind(ID, f.root), { code: 'invalid_source' })
  local.disconnect(ID)
  await assert.rejects(local.execute({ operation: 'read', path: 'login.ts' }, context), {
    code: 'source_not_connected'
  })
  assert.equal(await readFile(join(source, 'login.ts'), 'utf8'), "export const title = '工作区'\n")
})

test('approved files export immutably and idempotently under Rig, never under source', async () => {
  const f = await docs()
  const local = new TestProjectWorkspace(join(f.root, 'rig'))
  let data = await f.save()
  const input = { version: data.version, hash: data.proposal.hash }
  await assert.rejects(local.export(ID, data, input), { code: 'implementation_not_reviewed' })
  data = await f.approve(data)
  const exported = await local.export(ID, data, input)
  assert.equal(exported.executed, false)
  assert.ok(exported.directory.startsWith(await realpath(join(f.root, 'rig', 'qa'))))
  assert.equal(
    await readFile(join(exported.directory, PROPOSAL.files[0].path), 'utf8'),
    PROPOSAL.files[0].content
  )
  assert.equal((await local.export(ID, data, input)).directory, exported.directory)
  await writeFile(join(exported.directory, PROPOSAL.files[0].path), 'user edit')
  await assert.rejects(local.export(ID, data, input), { code: 'implementation_export_changed' })
  assert.equal(
    await readFile(join(exported.directory, PROPOSAL.files[0].path), 'utf8'),
    'user edit'
  )
  const other = new TestProjectWorkspace(join(f.root, 'other-rig'))
  await mkdir(other.root)
  const protectedDir = join(f.root, 'outside')
  await mkdir(protectedDir)
  await symlink(protectedDir, join(other.root, 'qa'))
  await assert.rejects(other.export(ID, data, input), { code: 'outside_workspace' })
  assert.deepEqual(await readdir(protectedDir), [], 'no directory is created through a QA symlink')
})

test('implementation APIs enforce ownership, live roles and identical Web/desktop tool contracts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rig-implementation-api-'))
  const server = await start(
    {
      MX_RIG_ADMIN_TOKEN: 'test-only',
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: root,
      MX_RIG_ARTIFACTS_DIR: join(root, 'artifacts')
    },
    { schedule: false }
  )
  t.after(() => server.close())
  const api = async (path, body, token = 'test-only') => {
    const res = await fetch(server.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: res.status, body: await res.json() }
  }
  await api('/api/v1/apps', { slug: 'implementation-app', displayName: 'Test app' })
  const { body: created } = await api('/api/rig/v1/test-tasks', {
    app: 'implementation-app',
    goal: '验证实现'
  })
  const id = created.mission.id
  const base = `/api/rig/v1/missions/${id}`
  await api(base + '/cases', { expectedRevision: 0, cases: [CASE] })
  await api(base + '/cases:confirm', { expectedRevision: 1 })
  const client = new RigClient({ url: server.origin, token: 'test-only' })
  const { policy } = await client.request('/api/rig/v1/execution-config')
  const context = { policy, missionId: id, workbench: true, caseRevision: 1 }
  const executor = new ToolExecutor(client)
  const drafted = await executor.execute(
    'implementation_draft',
    { expectedVersion: 0, proposal: JSON.stringify(PROPOSAL) },
    context
  )
  assert.equal(drafted.version, 1)
  assert.equal((await api(base + '/implementation')).body.proposal.reviewedAt, null)
  assert.equal(
    (await executor.execute('implementation_read', { path: PROPOSAL.files[0].path }, context)).file
      .content,
    PROPOSAL.files[0].content
  )
  const books = new CaseBooks((key) => join(root, 'case-books', key + '.json'))
  const implementations = new TestImplementations(
    (key) => join(root, 'implementations', key + '.json'),
    books
  )
  const inProcess = new InProcessClient({
    principal: { kind: 'service', id: 'service-admin', role: 'admin' },
    kernel: server.kernel,
    settings: server.settings,
    missions: server.missions,
    implementations
  })
  assert.equal(
    (await new ToolExecutor(inProcess).execute('implementation_read', {}, context)).version,
    1
  )
  await assert.rejects(
    executor.execute(
      'implementation_draft',
      { expectedVersion: 1, proposal: JSON.stringify(PROPOSAL) },
      { ...context, caseRevision: 2 }
    ),
    { code: 'implementation_stale' }
  )
  await api(base + '/implementation', {
    expectedVersion: 1,
    caseRevision: 1,
    proposal: { ...PROPOSAL, summary: '用户在 Agent 思考期间修订' }
  })
  for (const caller of [executor, new ToolExecutor(inProcess)])
    await assert.rejects(
      caller.execute(
        'implementation_draft',
        { expectedVersion: 1, proposal: JSON.stringify(PROPOSAL) },
        context
      ),
      { code: 'implementation_conflict' }
    )
  assert.equal((await api(base + '/implementation')).body.version, 2)
  assert.equal((await api(base + '/implementation')).body.proposal.summary, '用户在 Agent 思考期间修订')
  await assert.rejects(
    executor.execute('implementation_read', {}, { ...context, workbench: false }),
    { code: 'not_test_task' }
  )
  const resolve = server.kernel.identity.resolve
  server.kernel.identity.resolve = async (token, source) =>
    token === 'foreign'
      ? { id: 'foreign', role: 'operator' }
      : token === 'viewer'
        ? { id: 'service-admin', role: 'viewer' }
        : resolve(token, source)
  assert.equal((await api(base + '/implementation', undefined, 'foreign')).status, 404)
  assert.equal(
    (
      await api(
        base + '/implementation',
        { expectedVersion: 1, caseRevision: 1, proposal: PROPOSAL },
        'viewer'
      )
    ).status,
    403
  )
  assert.equal(
    (
      await api(
        base + '/implementation:approve',
        { expectedVersion: 1, hash: drafted.hash },
        'viewer'
      )
    ).status,
    403
  )
  assert.equal((await api(base + '/implementation?revision=oops')).status, 400)
  assert.deepEqual((await api('/api/v1/runs')).body.runs, [])
})
