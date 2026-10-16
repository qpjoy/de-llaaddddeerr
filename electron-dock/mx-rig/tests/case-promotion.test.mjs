import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../apps/server/index.mjs'
import { libraryCase } from '../apps/server/case-promotion.mjs'

// 提升到项目用例库 (docs/21 M2): a task's confirmed cases become the project's
// baseline, through the library's own validation.

const ADMIN = 'case-promotion-only'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rig-case-promotion-'))
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
  const api = async (method, path, body) => {
    const response = await fetch(runtime.origin + path, {
      method,
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: response.status === 204 ? {} : await response.json() }
  }
  await api('POST', '/api/v1/apps', { slug: 'luopan', displayName: 'Luopan', surfaces: ['web', 'electron'] })
  const created = await api('POST', '/api/rig/v1/test-tasks', { app: 'luopan', goal: '发布双端验收' })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  return { api, id: created.body.mission.id }
}

test('a task case reads as a library case: steps pair with expectations, numbering dropped', () => {
  const paired = libraryCase(
    {
      caseId: 'lp-fe-auth-001',
      title: '有效账号登录',
      steps: '1. 打开登录页\n2、输入测试账号\n3) 点击登录',
      expected: '- 显示登录表单\n- 账号框有值\n- 进入首页',
      priority: 'P3',
      platforms: ['web'],
      requirementRef: 'R'.repeat(200)
    },
    { goal: '发布验收', revision: 2, confirmedBy: 'local:alice', confirmedAt: '2026-10-05T08:00:00.000Z' }
  )
  assert.equal(paired.caseId, 'LP-FE-AUTH-001')
  assert.deepEqual(paired.steps, [
    { action: '打开登录页', expect: '显示登录表单' },
    { action: '输入测试账号', expect: '账号框有值' },
    { action: '点击登录', expect: '进入首页' }
  ])
  assert.equal(paired.priority, 'P2', 'P3 has no place in the library; the note says so')
  assert.match(paired.notes, /原优先级 P3/)
  assert.match(paired.notes, /第 2 版/)
  assert.ok(paired.requirementRef.length <= 96)
  // Different counts: the expectations belong to the last step.
  const tail = libraryCase({ caseId: 'X-1-001', title: 't', steps: '打开\n点击', expected: '看到首页' })
  assert.deepEqual(tail.steps, [
    { action: '打开', expect: '' },
    { action: '点击', expect: '看到首页' }
  ])
})

test('only a confirmed version is promoted; ids the library cannot hold and repository cases are skipped, said why', async (t) => {
  const { api, id } = await fixture(t)
  const base = `/api/rig/v1/missions/${id}/cases`
  const saved = await api('POST', base, {
    expectedRevision: 0,
    cases: [
      { caseId: 'LP-FE-AUTH-001', title: '有效账号登录', steps: '打开登录页\n点击登录', expected: '进入首页', priority: 'P0', platforms: ['web'] },
      { caseId: 'LOGIN-002', title: '自定义编号', steps: '打开', expected: '看到', platforms: ['web'] },
      { caseId: 'LP-EL-BOOT-001', title: '桌面冷启动', steps: '启动应用', expected: '进入登录页', platforms: ['electron'] }
    ]
  })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  // A draft is the task's own business.
  const early = await api('POST', `${base}:promote`, { expectedRevision: 1 })
  assert.equal(early.status, 409)
  assert.match(early.body.error.message, /已确认/)
  // The repository owns LP-EL-BOOT-001 already.
  const synced = await api('POST', '/api/v1/apps/luopan/catalog:sync', {
    schemaVersion: 2,
    application: 'luopan',
    catalogFile: 'qa/catalog.electron.json',
    cases: [{ id: 'LP-EL-BOOT-001', title: '仓库里的启动用例', priority: 'P0', spec: 'tests/boot.spec.ts' }]
  })
  assert.equal(synced.status, 200, JSON.stringify(synced.body))
  assert.equal((await api('POST', `${base}:confirm`, { expectedRevision: 1 })).status, 200)
  // A stale page cannot promote.
  assert.equal((await api('POST', `${base}:promote`, { expectedRevision: 0 })).status, 409)

  const first = await api('POST', `${base}:promote`, { expectedRevision: 1 })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.deepEqual(first.body.promoted, [{ caseId: 'LP-FE-AUTH-001', action: 'created' }])
  assert.deepEqual(
    first.body.skipped.map((entry) => entry.caseId),
    ['LOGIN-002', 'LP-EL-BOOT-001']
  )
  assert.match(first.body.skipped[0].reason, /编号不符合用例库规范/)
  assert.match(first.body.skipped[1].reason, /代码仓库/)

  const { body: library } = await api('GET', '/api/v1/apps/luopan/cases')
  const promoted = library.cases.find((entry) => entry.caseId === 'LP-FE-AUTH-001')
  assert.equal(promoted.origin, 'platform')
  assert.equal(promoted.priority, 'P0')
  assert.deepEqual(promoted.steps.map((step) => step.action), ['打开登录页', '点击登录'])
  assert.match(promoted.notes, /发布双端验收/)
  assert.equal(library.cases.find((entry) => entry.caseId === 'LP-EL-BOOT-001').title, '仓库里的启动用例')

  // A later version updates the library entry it promoted before.
  const revised = await api('POST', base, {
    expectedRevision: 1,
    cases: [{ caseId: 'LP-FE-AUTH-001', title: '有效账号登录（含记住我）', steps: '打开登录页\n勾选记住我\n点击登录', expected: '进入首页', priority: 'P0', platforms: ['web'] }]
  })
  assert.equal(revised.status, 200)
  assert.equal((await api('POST', `${base}:confirm`, { expectedRevision: 2 })).status, 200)
  const second = await api('POST', `${base}:promote`, { expectedRevision: 2, caseIds: ['lp-fe-auth-001'] })
  assert.deepEqual(second.body.promoted, [{ caseId: 'LP-FE-AUTH-001', action: 'updated' }])
  const { body: after } = await api('GET', '/api/v1/apps/luopan/cases')
  assert.equal(after.cases.find((entry) => entry.caseId === 'LP-FE-AUTH-001').title, '有效账号登录（含记住我）')
  // Each promotion is in the audit trail.
  const { body: audit } = await api('GET', '/api/v1/audit?app=luopan')
  assert.equal(audit.events.filter((event) => event.action === 'case.promote').length, 2)
})
