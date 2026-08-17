import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before } from 'node:test'
import { loadConfig } from '../server/config.mjs'
import { start } from '../server/index.mjs'

// The whole platform over real HTTP: log in, author a case, run a task, upload a
// recording as a runner, and read back the report a tester would actually open.

const ADMIN = 'test-admin-token'
let base
let runtime
let artifactsRoot
let cookie = null

async function call(method, path, { body, token, raw, useCookie = true } = {}) {
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (useCookie && cookie && !token) headers.cookie = cookie
  if (body && !raw) headers['content-type'] = 'application/json'

  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  const text = await response.text()
  const isJson = (response.headers.get('content-type') ?? '').includes('json')
  return { status: response.status, body: isJson && text ? JSON.parse(text) : text, response }
}

before(async () => {
  artifactsRoot = await mkdtemp(join(tmpdir(), 'mxt-platform-'))
  const config = loadConfig({
    MXT_STORE: 'memory',
    MXT_ADMIN_TOKEN: ADMIN,
    MXT_PORT: '0',
    MXT_ARTIFACTS_DIR: artifactsRoot,
    MXT_INSECURE_COOKIES: 'true',
  })
  runtime = await start(config, { schedule: false })
  base = `http://127.0.0.1:${runtime.port}`
})

after(async () => {
  await runtime.close()
  await rm(artifactsRoot, { recursive: true, force: true })
})

// -- discovery & auth --------------------------------------------------------

test('an empty install tells you what to do instead of 404ing', async () => {
  const { status, body } = await call('GET', '/api/v1')
  assert.equal(status, 200)
  assert.match(body.nextStep, /seed|应用/)
  assert.equal(body.ui, '/')
})

test('the UI shell is served for client-side routes but not for assets', async () => {
  assert.equal((await call('GET', '/')).status, 200)
  assert.equal((await call('GET', '/tasks')).status, 200)
  // A missing stylesheet must 404, not silently return the HTML shell.
  assert.equal((await call('GET', '/assets/missing.css')).status, 404)
})

test('the design system stylesheet and its tokens both resolve', async () => {
  for (const path of ['/vendor/neon-void.css', '/vendor/tokens.css']) {
    const { status, response, body } = await call('GET', path)
    assert.equal(status, 200, path)
    assert.match(response.headers.get('content-type'), /text\/css/, path)
    assert.ok(body.length > 500, path)
  }
})

test('login sets a session cookie so recordings can load without a header', async () => {
  const bad = await call('POST', '/api/v1/auth/login', {
    body: { username: 'x', password: 'wrong' },
  })
  assert.equal(bad.status, 401)

  const good = await call('POST', '/api/v1/auth/login', {
    body: { username: '测试同学', password: ADMIN },
  })
  assert.equal(good.status, 200)
  assert.match(good.response.headers.get('set-cookie'), /HttpOnly/)
  assert.ok(cookie, '后续请求要靠这个 cookie')

  const me = await call('GET', '/api/v1/auth/me')
  assert.equal(me.status, 200)
  assert.equal(me.body.member.role, 'admin')
})

test('an unauthenticated request is refused with a usable hint', async () => {
  const { status, body } = await call('GET', '/api/v1/apps', { useCookie: false, token: '' })
  assert.equal(status, 401)
  assert.ok(body.error.hint, '错误里应当说明下一步怎么办')
})

// -- setup -------------------------------------------------------------------

test('registers an app and two suites', async () => {
  assert.equal(
    (
      await call('POST', '/api/v1/apps', {
        body: { slug: 'compass', displayName: '罗盘', surfaces: ['web', 'electron'] },
      })
    ).status,
    201,
  )
  assert.equal(
    (
      await call('POST', '/api/v1/apps/compass/suites', {
        body: {
          slug: 'web',
          displayName: '网页',
          engine: 'cypress',
          surface: 'web',
          runnerKind: 'server',
          command: ['pnpm', 'e2e:run:mock'],
        },
      })
    ).status,
    201,
  )
  assert.equal(
    (
      await call('POST', '/api/v1/apps/compass/suites', {
        body: {
          slug: 'desktop',
          displayName: '桌面',
          engine: 'playwright-electron',
          surface: 'electron',
          runnerKind: 'local',
          requirements: { os: ['windows'] },
        },
      })
    ).status,
    201,
  )
})

test('an unknown app names the ones that exist', async () => {
  const { status, body } = await call('GET', '/api/v1/apps/nope/cases')
  assert.equal(status, 404)
  assert.match(body.error.hint, /compass/)
})

// -- case authoring by a tester ---------------------------------------------

test('a tester writes a case in the UI with plain-language steps', async () => {
  const created = await call('POST', '/api/v1/apps/compass/cases', {
    body: {
      caseId: 'CPS-FE-LOGIN-001',
      title: '未登录访问受保护页面应跳转登录并保留目标地址',
      priority: 'P0',
      preconditions: '浏览器处于未登录状态',
      steps: [
        { action: '打开 /strategy', expect: '跳转到 /login' },
        { action: '查看地址栏', expect: 'redirect 参数等于 /strategy' },
      ],
      requirementRef: 'COMPASS-142',
    },
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.case.origin, 'platform')
  assert.equal(created.body.case.steps.length, 2)

  const listed = await call('GET', '/api/v1/apps/compass/cases')
  const entry = listed.body.cases.find((item) => item.caseId === 'CPS-FE-LOGIN-001')
  // Written but not yet implemented — the state that keeps it visible instead
  // of forgotten.
  assert.equal(entry.implemented, false)
  assert.equal(entry.lastStatus, 'notRun')
})

test('a malformed case id is refused with the expected format spelled out', async () => {
  const { status, body } = await call('POST', '/api/v1/apps/compass/cases', {
    body: { caseId: '随便写的', title: 'x' },
  })
  assert.equal(status, 400)
  assert.match(body.error.hint, /CPS-EL-BOOT-001|序号/)
})

test('a duplicate case id points at the case already using it', async () => {
  const { status, body } = await call('POST', '/api/v1/apps/compass/cases', {
    body: { caseId: 'CPS-FE-LOGIN-001', title: '重复' },
  })
  assert.equal(status, 409)
  assert.match(body.error.hint, /未登录访问受保护页面/)
})

test('exporting hands the engineer a repository-shaped catalog file', async () => {
  const { status, body } = await call('GET', '/api/v1/apps/compass/cases:export')
  assert.equal(status, 200)
  assert.equal(body.schemaVersion, 2)
  assert.equal(body.cases.length, 1)
  assert.equal(body.cases[0].id, 'CPS-FE-LOGIN-001')
  // The plain-language steps ride along so whoever implements it knows the intent.
  assert.ok(body.cases[0]._steps[0].includes('打开 /strategy'))
})

test('syncing a repository catalog does not disturb UI-authored cases', async () => {
  const sync = await call('POST', '/api/v1/apps/compass/catalog:sync', {
    body: {
      schemaVersion: 1,
      application: 'compass',
      catalogFile: 'cypress/case-catalog.frontend.json',
      cases: [
        { id: 'LP-FE-AUTH-001', priority: 'P0', title: '仓库里的用例一', spec: 'a.cy.ts' },
        { id: 'LP-FE-AUTH-002', priority: 'P0', title: '仓库里的用例二', spec: 'a.cy.ts' },
      ],
    },
  })
  assert.equal(sync.status, 200)
  assert.equal(sync.body.added.length, 2)

  const listed = await call('GET', '/api/v1/apps/compass/cases')
  assert.equal(listed.body.cases.length, 3)
  // The tester's case survives a repository sync it was never part of.
  assert.ok(listed.body.cases.some((entry) => entry.caseId === 'CPS-FE-LOGIN-001'))
})

test('a repository-owned case cannot be edited from the UI', async () => {
  const { status, body } = await call('PUT', '/api/v1/apps/compass/cases/LP-FE-AUTH-001', {
    body: { title: '偷偷改一下' },
  })
  assert.equal(status, 409)
  assert.match(body.error.hint, /git/)
})

// -- running -----------------------------------------------------------------

let runId
let runToken

test('a case that only ever recorded notRun is still 待实现', async () => {
  // A notRun row means "expected but absent", which is the opposite of
  // implemented. Counting it as implemented would hide exactly the gap the
  // catalog exists to surface.
  const { decorateCases } = await import('../server/routes/cases.mjs')
  const [onlyNotRun, executed, hasSpec] = decorateCases(
    [{ caseId: 'A-FE-X-001' }, { caseId: 'A-FE-X-002' }, { caseId: 'A-FE-X-003', specPath: 'a.ts' }],
    new Map([
      ['A-FE-X-001', { status: 'notRun', runId: 'r1' }],
      ['A-FE-X-002', { status: 'failed', runId: 'r1' }],
    ]),
  )
  assert.equal(onlyNotRun.implemented, false)
  assert.equal(executed.implemented, true, '跑过就说明有实现，哪怕失败了')
  assert.equal(hasSpec.implemented, true)
})

test('creates a task and runs it on demand', async () => {
  const task = await call('POST', '/api/v1/tasks', {
    body: {
      app: 'compass',
      suite: 'web',
      name: '网页冒烟',
      targetUrl: 'https://compass.example.internal',
    },
  })
  assert.equal(task.status, 201)

  const triggered = await call('POST', `/api/v1/tasks/${task.body.task.id}:run`)
  assert.equal(triggered.status, 202)
  assert.ok(triggered.body.note, '应当告诉使用者接下来会发生什么')
  runId = triggered.body.run.id
})

test('a runner claims the run and receives a run-scoped credential', async () => {
  const registered = await call('POST', '/runner/v1/runners:register', {
    body: { name: 'ci-1', kind: 'server', os: 'linux', engines: ['cypress'], surfaces: ['web'] },
  })
  const claimed = await call('POST', '/runner/v1/runs:claim', {
    token: registered.body.token,
    body: {},
  })
  assert.equal(claimed.status, 200)
  assert.equal(claimed.body.runId, runId)
  assert.ok(claimed.body.runToken.startsWith('mxt-run'))
  // compass reads E2E_*; the platform speaks both so that repo needs no edits.
  assert.equal(claimed.body.env.E2E_BASE_URL, 'https://compass.example.internal')
  runToken = claimed.body.runToken
})

test('the run credential cannot reach another run', async () => {
  const other = await call('POST', '/runner/v1/runs/trun_someone_else/heartbeat', {
    token: runToken,
  })
  assert.equal(other.status, 403)
})

test('a runner uploads a recording and completes the run', async () => {
  const upload = await call('PUT', `/runner/v1/runs/${runId}/artifacts/videos/login.mp4`, {
    token: runToken,
    raw: true,
    body: Buffer.from('pretend-this-is-an-mp4'),
  })
  assert.equal(upload.status, 201)

  const completed = await call('POST', `/runner/v1/runs/${runId}:complete`, {
    token: runToken,
    body: {
      exitCode: 1,
      summary: {
        schemaVersion: 2,
        runId,
        app: 'compass',
        status: 'failed',
        totals: { tests: 2, passed: 1, failed: 1 },
        cases: [
          { caseId: 'LP-FE-AUTH-001', status: 'passed', durationMs: 1200, spec: 'a.cy.ts' },
          {
            caseId: 'LP-FE-AUTH-002',
            status: 'failed',
            durationMs: 2400,
            spec: 'a.cy.ts',
            error: '期望看到订单列表，实际是空白页',
            steps: [
              { seq: 1, label: '打开订单页', status: 'passed', offsetMs: 100 },
              { seq: 2, label: '确认列表非空', status: 'failed', offsetMs: 2100 },
            ],
          },
        ],
      },
    },
  })
  assert.equal(completed.status, 200)
  assert.equal(completed.body.run.status, 'failed')
  // The tester's un-implemented case is counted, not lost.
  assert.equal(completed.body.run.catalog.counts.notRun, 1)
  // Artifacts are recorded from what landed on disk, not from what was claimed.
  assert.deepEqual(completed.body.run.artifacts.files, ['videos/login.mp4'])
})

test('the run credential dies with the run', async () => {
  const again = await call('POST', `/runner/v1/runs/${runId}/heartbeat`, { token: runToken })
  assert.equal(again.status, 403, '已结束的执行不能再被写入')
})

// -- reading the result ------------------------------------------------------

test('a recording is served to a logged-in browser with range support', async () => {
  const response = await fetch(`${base}/api/v1/runs/${runId}/artifacts/videos/login.mp4`, {
    headers: { cookie, range: 'bytes=0-5' },
  })
  assert.equal(response.status, 206)
  assert.equal(await response.text(), 'preten')
})

test('artifacts are not readable without a session', async () => {
  const response = await fetch(`${base}/api/v1/runs/${runId}/artifacts/videos/login.mp4`)
  assert.equal(response.status, 401)
})

test('the report renders the failure, the timeline and the three denominators', async () => {
  const { status, body, response } = await call('GET', `/api/v1/runs/${runId}/report`)
  assert.equal(status, 200)
  assert.match(response.headers.get('content-type'), /text\/html/)
  assert.match(body, /期望看到订单列表/)
  assert.match(body, /data-seek=/, '步骤应可点击跳转到录像')
  assert.match(body, /目录执行率|catalogCompletionPercent|覆盖情况/)
  assert.match(body, /尚无实现代码/, '未实现的用例应当在报告里说明原因')
})

test('the shared report strips internal detail but keeps what a customer needs', async () => {
  const { body } = await call('GET', `/api/v1/runs/${runId}/report?redacted=true`)
  assert.match(body, /已脱敏/)
  assert.doesNotMatch(body, /compass\.example\.internal/)
  assert.doesNotMatch(body, /期望看到订单列表/, '错误细节不外发')
  assert.doesNotMatch(body, /a\.cy\.ts/, 'spec 路径会泄漏仓库结构')
  assert.match(body, /LP-FE-AUTH-002/, '用例编号与标题仍然保留')
  // Hiding the spec path must not make an implemented case read as unwritten —
  // that would tell a customer the opposite of the truth.
  const pending = body.split('LP-FE-AUTH-002')[1]?.split('</details>')[0] ?? ''
  assert.doesNotMatch(pending, /尚无实现代码/)
})

test('the report shows a human timestamp, not a raw ISO string', async () => {
  const { body } = await call('GET', `/api/v1/runs/${runId}/report`)
  assert.doesNotMatch(body.split('<section')[0], /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
})

// -- permissions -------------------------------------------------------------

test('a viewer can look but not act', async () => {
  const { body } = await call('GET', '/api/v1/members')
  assert.ok(Array.isArray(body.members))

  // Demote the current principal to prove the check is enforced, then restore.
  await runtime.store.upsertMember({
    principalId: 'service-admin',
    displayName: 'v',
    role: 'viewer',
  })
  await runtime.store.setMemberRole('service-admin', 'viewer')

  // The service admin token bypasses membership by design, so exercise the
  // check directly against a demoted member instead.
  const { requireRole } = await import('../server/identity/index.mjs')
  assert.throws(
    () => requireRole({ role: 'viewer' }, 'operator'),
    (error) => error.code === 'forbidden' && /管理员/.test(error.details.hint),
  )
  assert.doesNotThrow(() => requireRole({ role: 'operator' }, 'operator'))
  assert.doesNotThrow(() => requireRole({ role: 'admin' }, 'operator'))
})
