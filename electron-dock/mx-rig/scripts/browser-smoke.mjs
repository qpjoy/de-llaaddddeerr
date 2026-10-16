import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { BrowserTools } from '../packages/runtime/browser.mjs'
import { start } from '../apps/server/index.mjs'
import { pretendRunner, recordClip, smokeCatalog, twoCaseSummary } from './smoke-run.mjs'

async function openNav(page, title) {
  const item = page.locator('.rig-nav__item').filter({ hasText: title })
  // Right after signing in the workspace shows before the nav is drawn.
  await item.waitFor({ state: 'attached' })
  const group = item.locator('xpath=parent::details')
  if (await group.count() && !await group.evaluate((node) => node.open)) await group.locator('summary').click()
  await item.click()
}
async function newAgentTask(page) {
  await openNav(page, 'Agent 会话')
  await page.locator('#new-agent-mission').click()
}

const root = fileURLToPath(new URL('../', import.meta.url))
const qa = resolve(process.env.MX_RIG_QA_DIR || resolve(root, '.runtime/qa'))
await mkdir(qa, { recursive: true })
const state = await mkdtemp(join(qa, 'browser-'))
const target = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(
    '<title>Rig Browser Acceptance</title><label>项目名称<input aria-label="项目名称"></label><label>密码<input type="password" aria-label="密码"></label><button onclick="document.querySelector(\'h1\').textContent=\'操作完成\'">保存</button><h1>准备就绪</h1>'
  )
})
await new Promise((r) => target.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${target.address().port}`
const tools = new BrowserTools(join(state, 'artifacts'))
const context = {
  policy: { browserOrigins: [origin] },
  signal: new AbortController().signal,
  missionId: '00000000-0000-0000-0000-000000000001'
}
let server, browser
try {
  const opened = await tools.execute('browser_open', { url: origin }, context)
  assert.equal(opened.title, 'Rig Browser Acceptance')
  assert.match(opened.snapshot, /准备就绪/)
  const ref = (pattern) =>
    /\[ref=(e\d+)\]/.exec(opened.snapshot.split('\n').find((line) => pattern.test(line)))[1]
  await tools.execute('browser_fill', { ref: ref(/textbox "项目名称"/), value: 'MX Rig' }, context)
  await assert.rejects(
    tools.execute('browser_fill', { label: '密码', value: 'never-fill' }, context),
    { code: 'sensitive_field' }
  )
  const result = await tools.execute('browser_click', { ref: ref(/button "保存"/) }, context)
  assert.match(result.snapshot, /操作完成/)
  const verdict = await tools.execute(
    'browser_assert',
    { kind: 'text_visible', expected: '操作完成' },
    context
  )
  assert.equal(verdict.assertion.passed, true)
  assert.ok((await stat(join(state, 'artifacts', result.screenshot))).size > 0)
  await assert.rejects(tools.execute('browser_open', { url: 'http://localhost:1' }, context), {
    code: 'origin_denied'
  })
  await tools.close()
  // A scripted upstream that answers over SSE, slowly enough that the
  // workbench really has to render a partial draft, and finishes the first
  // turn by submitting a structured conclusion.
  const FINDING = {
    verdict: 'environment-blocked',
    confidence: 'high',
    summary: '这次不是产品缺陷：窗口内执行机全部离线。',
    evidence: '引用 trun_smoke_未读 作为对照；本次任务并没有真的读过它。',
    nextStep: '让管理员上线一台执行机后复跑。'
  }
  const encoder = new TextEncoder()
  const frame = (payload) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
  let turns = 0
  server = await start(
    {
      MX_RIG_ADMIN_TOKEN: 'web-test-secret',
      // Secrets are encrypted at rest; without a key the service refuses to keep one.
      MX_RIG_SECRET_KEY: '5a'.repeat(32),
      MX_RIG_PORT: '0',
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: join(state, 'control'),
      MX_RIG_ARTIFACTS_DIR: join(state, 'test-artifacts')
    },
    {
      schedule: false,
      modelOptions: {
        environment: { MX_RIG_MODEL_API_KEY: 'fixture-key' },
        fetchImpl: async () => {
          const first = ++turns === 1
          const pieces = first
            ? ['正在读这次执行的证据', '：执行机在窗口内全部离线', '，所以先排除产品缺陷。']
            : ['已提交结论：环境受阻，不是产品缺陷。']
          return new Response(
            new ReadableStream({
              async start(controller) {
                for (const piece of pieces) {
                  controller.enqueue(frame({ choices: [{ delta: { content: piece } }] }))
                  await new Promise((r) => setTimeout(r, 450))
                }
                if (first)
                  controller.enqueue(
                    frame({
                      choices: [
                        {
                          delta: {
                            tool_calls: [
                              {
                                index: 0,
                                id: 'call_finding',
                                function: {
                                  name: 'finding_submit',
                                  arguments: JSON.stringify(FINDING)
                                }
                              }
                            ]
                          }
                        }
                      ]
                    })
                  )
                controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                controller.close()
              }
            }),
            { headers: { 'content-type': 'text/event-stream' } }
          )
        }
      }
    }
  )
  browser = await chromium.launch({ headless: false })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(server.origin + '/rig/')
  await page.locator('#account').fill('admin')
  await page.locator('#password').fill('web-test-secret')
  await page.locator('#login-form button[type=submit]').click()
  await page.locator('#workspace').waitFor({ state: 'visible' })
  await openNav(page, 'Agent 会话')
  await page.locator('#goal').fill('检查未配置模型的明确失败状态')
  await page.locator('#start').click()
  await page.waitForFunction(
    () => document.querySelector('#mission-status')?.textContent === '受阻'
  )
  await openNav(page, 'Internal 配置')
  await page.locator('#max-turns').fill('8')
  await page.locator('#save-settings').click()
  await page.getByText('已保存').waitFor({ state: 'visible' })
  await openNav(page, '工具与边界')
  await page.locator('.rig-table[data-layout="tools"]').first().waitFor({ state: 'visible' })
  await page.screenshot({ path: join(qa, 'web-tools.png') })
  await openNav(page, 'Agent 市场')
  await page.getByText('结果分析师', { exact: true }).waitFor({ state: 'visible' })
  await page.screenshot({ path: join(qa, 'web-agents.png') })
  // Focus belongs to the report, while the main navigation stays project based.
  await openNav(page, '质量报告')
  await page.locator('.rig-trend, .rig-empty').first().waitFor({ state: 'visible' })
  assert.equal(await page.locator('.rig-nav__lens').count(), 0)
  const focus = page.getByRole('group', { name: '报告重点', exact: true })
  assert.ok((await focus.evaluate((el) => el.getBoundingClientRect().height)) > 24)
  // The headline row; the Agent section below has tiles of its own.
  const metrics = await page.locator('.qp-metric-grid').first().locator('.qp-metric__value').allTextContents()
  assert.equal(metrics.length, 4)
  // Nothing ran in this fixture, so every rate must read "—", never 0% or 100%.
  assert.equal(metrics[0], '—')
  await page.getByRole('button', { name: '摘要', exact: true }).click()
  await page.waitForTimeout(400)
  const ordered = await page.locator('.rig-view > .qp-panel > h2').allTextContents()
  assert.equal(ordered[0], '每日通过率', `summary focus leads with the trend, saw ${ordered[0]}`)
  await page.getByRole('button', { name: '风险', exact: true }).click()
  await page.waitForTimeout(400)
  assert.equal(
    (await page.locator('.rig-view > .qp-panel > h2').allTextContents())[0],
    '要先处理的'
  )
  await page.screenshot({ path: join(qa, 'web-report.png'), fullPage: true })

  await openNav(page, '编排中心')
  await page.locator('.rig-graph svg').waitFor({ state: 'visible' })
  // The generic task graph: seven nodes, one of them the approval pause.
  assert.equal(await page.locator('.rig-graph__node').count(), 7)
  await page.screenshot({ path: join(qa, 'web-orchestration.png') })
  await openNav(page, '出网与通道')
  await page.locator('.rig-table[data-layout="egress"]').waitFor({ state: 'visible' })
  await page.screenshot({ path: join(qa, 'web-egress.png') })
  // The desktop's overseas channel card (docs/25 P3) exists only in the
  // Launcher-mode desktop; here it is drawn from its states with the page's
  // own styles, to see what each says and offers.
  const oversea = await page.evaluate(async () => {
    const { overseaPanel } = await import(new URL('views.js', location.href).href)
    const calls = []
    const ctx = { run: (work) => work(), oversea: async (action, body) => calls.push([action, body ?? null]) }
    const base = { channelId: 'launcher-oversea', enabled: false, browser: false, usingBrowser: false, verified: null, latencyMs: null, sites: [], busy: false }
    const states = [
      { ...base, state: 'unavailable', enabled: true, text: '用平台统一账号登录、连上内网后才能开启。' },
      { ...base, state: 'ready', enabled: true, browser: true, usingBrowser: true, verified: true, latencyMs: 286, text: '海外通道已就绪（试访问 286 ms）。' },
      { ...base, state: 'error', enabled: true, text: '这个账号没有海外权限，请联系管理员开通。' }
    ]
    const box = document.createElement('div')
    box.id = 'oversea-preview'
    box.className = 'rig-oversea-preview'
    for (const snap of states) box.append(overseaPanel(ctx, snap))
    document.querySelector('#view').prepend(box)
    const buttons = [...box.querySelectorAll('#oversea-toggle')].map((button) => button.textContent)
    box.querySelectorAll('#oversea-toggle')[1].click()
    box.querySelectorAll('#oversea-browser')[1].click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    return { buttons, calls, statuses: [...box.querySelectorAll('#oversea-state')].map((node) => node.dataset.status) }
  })
  assert.deepEqual(oversea.buttons, ['开启海外通道', '关闭海外通道', '重试'])
  assert.deepEqual(oversea.statuses, ['default', 'success', 'danger'])
  assert.deepEqual(oversea.calls, [['oversea-stop', null], ['oversea-browser', { on: false }]])
  await page.locator('#oversea-preview').screenshot({ path: join(qa, 'web-oversea-panel.png') })
  await page.evaluate(() => document.querySelector('#oversea-preview').remove())

  // The orchestration centre: open a saved spec, break it, see the compiler
  // refuse it by name, repair it, and watch the draft preview come back.
  await openNav(page, '编排中心')
  await page.getByRole('button', { name: '有人接才派发', exact: true }).click()
  // Selecting a spec fetches its compiled shape; wait for one of its own
  // nodes rather than for "a graph", which the task graph already satisfies.
  await page
    .locator('.rig-graph__node', { hasText: 'n_read_runners' })
    .waitFor({ state: 'visible' })
  const authored = await page.locator('.rig-graph__node').count()
  assert.ok(authored >= 9, `expected the compiled spec, saw ${authored} nodes`)
  await page.getByRole('button', { name: '校验并预览', exact: true }).click()
  await page.getByText('草稿可以编译', { exact: false }).waitFor({ state: 'visible' })
  await page.screenshot({ path: join(qa, 'web-orchestration-editor.png'), fullPage: true })
  await page.evaluate(() => {
    const field = [...document.querySelectorAll('input.qp-input')].find(
      (input) => input.value === 'onlineRunners'
    )
    field.value = 'ghostVariable'
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.getByRole('button', { name: '校验并预览', exact: true }).click()
  await page
    .getByText('判断了未定义的变量 ghostVariable', { exact: false })
    .first()
    .waitFor({ state: 'visible' })
  await page.screenshot({ path: join(qa, 'web-orchestration-invalid.png') })

  // -- the system layer -------------------------------------------------------
  // Two pages have been visited by now (工具与边界, 出网与通道), so their
  // signal-evidence quests must be claimable and the platform-state ones must
  // not: this asserts the difference is real, not decorative.
  await openNav(page, '系统')
  await page.locator('.rig-level').waitFor({ state: 'visible' })
  assert.match(await page.locator('.rig-level h2').textContent(), /Lv\.1/)
  const chapters = await page.locator('.rig-quests').count()
  assert.equal(chapters, 6, `expected six chapters, saw ${chapters}`)
  const openApp = page.locator('.rig-quest', { hasText: '接入一个被测应用' }).first()
  assert.equal(await openApp.getAttribute('data-status'), 'open')
  const claimable = page.locator('.rig-quest[data-status="claimable"]')
  assert.ok((await claimable.count()) >= 2, '两个已访问页面的任务应当可领取')
  const boundary = page.locator('.rig-quest', { hasText: '看清工具与边界这一页' }).first()
  const reward = await boundary.getByRole('button', { name: '领取', exact: false }).textContent()
  await boundary.getByRole('button', { name: '领取', exact: false }).click()
  // The reward is only XP: the quest turns claimed and the level line moves.
  await page.getByText(`经验 ${reward.replace(/\D/g, '')}`, { exact: false }).waitFor()
  await page
    .locator('.rig-quest[data-status="claimed"]', { hasText: '看清工具与边界这一页' })
    .waitFor({ state: 'visible' })
  await page.screenshot({ path: join(qa, 'web-system.png'), fullPage: true })

  // The teaching panel follows the reader across pages and can be put away.
  await page.locator('#hud-toggle').click()
  await page.locator('#hud .rig-quest').waitFor({ state: 'visible' })
  await openNav(page, '总览')
  await page.locator('#hud .rig-quest').waitFor({ state: 'visible' })
  await page.screenshot({ path: join(qa, 'web-system-hud.png') })
  await page.locator('#hud').getByRole('button', { name: '收起', exact: true }).click()
  assert.ok(await page.locator('#hud').isHidden(), 'the panel must close when asked')

  // -- 对话式下任务 -----------------------------------------------------------
  // A real plan exists for this one, so the parse has something to match.
  const api = async (path, body) => {
    const response = await fetch(server.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: 'Bearer web-test-secret',
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() }
  }
  await api('/api/v1/apps', { slug: 'compass', displayName: 'Compass', surfaces: ['web'] })
  await api('/api/v1/apps/compass/suites', {
    slug: 'smoke',
    displayName: 'Smoke',
    engine: 'playwright',
    surface: 'web',
    runnerKind: 'local',
    command: ['node', 'test.mjs'],
    targetMode: 'self'
  })
  const plan = await api('/api/v1/tasks', {
    app: 'compass',
    suite: 'smoke',
    name: 'Compass Web 冒烟',
    profile: 'mock',
    track: 'functional'
  })
  assert.equal(plan.status, 201, JSON.stringify(plan.body))
  // A new task, not the blocked one from earlier: parsing belongs to a fresh
  // composer, and a follow-up on a finished mission has no target to choose.
  await newAgentTask(page)
  await page.locator('#refresh').click()
  await page.locator('#goal').waitFor({ state: 'visible' })
  await page.locator('#goal').fill('跑一下 Compass Web 冒烟')
  await page.getByRole('button', { name: '解析成任务', exact: false }).click()
  await page.locator('.rig-proposal').first().waitFor({ state: 'visible' })
  const proposal = await page.locator('.rig-proposal pre').first().textContent()
  assert.match(proposal, new RegExp(plan.body.task.id), '候选里应当是真实的计划 ID')
  assert.match(
    await page.locator('.rig-proposal ul').first().textContent(),
    /计划名匹配/,
    'the parse has to say what it matched on'
  )
  // Parsing alone must not have started anything.
  assert.equal((await api('/api/v1/runs')).body.runs.length, 0)
  await page.screenshot({ path: join(qa, 'web-dispatch-plan.png'), fullPage: true })
  await page.getByRole('button', { name: '收起解析结果', exact: true }).click()

  // -- 流式输出与结构化结论 ---------------------------------------------------
  await server.settings.update({
    ...server.settings.value,
    providers: [
      {
        id: 'primary',
        displayName: '替身模型',
        baseUrl: 'https://fixture.invalid/v1',
        model: 'fixture-streamer',
        apiKeyEnv: 'MX_RIG_MODEL_API_KEY',
        timeoutMs: 60_000,
        enabled: true,
        stream: true
      }
    ],
    sequence: ['primary']
  })
  await newAgentTask(page)
  await page.locator('#goal').waitFor({ state: 'visible' })
  await page.locator('#goal').fill('这次执行为什么没通过？读证据后给结论。')
  await page.locator('#start').click()
  // The draft has to be on screen while the answer is still being written.
  await page.locator('.rig-stream').waitFor({ state: 'visible', timeout: 15_000 })
  const partial = await page.locator('.rig-stream').textContent()
  assert.ok(partial.length > 0, '流式草稿应当有内容')
  await page.screenshot({ path: join(qa, 'web-streaming.png'), fullPage: true })
  await page.waitForFunction(
    () => document.querySelector('#mission-status')?.textContent === '任务完成',
    null,
    { timeout: 30_000 }
  )
  // And it must be gone once the real answer exists.
  assert.equal(await page.locator('.rig-stream').count(), 0, '结束后不该留着半句草稿')
  const finding = page.locator('.rig-finding')
  await finding.waitFor({ state: 'visible' })
  assert.match(await finding.textContent(), /环境受阻/)
  assert.match(await finding.textContent(), /不是测试结论/)
  // The citation was never read in this mission, and the card says so.
  assert.match(await page.locator('.rig-ref').first().textContent(), /未读到/)
  await page.screenshot({ path: join(qa, 'web-finding.png'), fullPage: true })

  // -- 出网通道 ---------------------------------------------------------------
  await openNav(page, '出网与通道')
  await page.getByRole('button', { name: '保存通道', exact: true }).waitFor({ state: 'visible' })
  await page.getByLabel('通道 ID').fill('office')
  await page.getByLabel('名称').fill('办公网代理')
  await page.getByLabel('通道地址').fill('http://127.0.0.1:7890')
  await page.getByLabel('直连列表（逗号分隔）').fill('.internal.example.com')
  await page.getByRole('button', { name: '保存通道', exact: true }).click()
  await page.getByRole('button', { name: '切到这条', exact: true }).click()
  await page.getByText('已切换出网通道', { exact: false }).waitFor({ state: 'visible' })
  const routes = await page.locator('.qp-metric').allTextContents()
  assert.match(routes[0], /模型调用Rig 通道|模型调用\s*Rig 通道/, `saw ${routes[0]}`)
  // The environment observation must not have been rewritten by the switch.
  assert.match(await page.locator('.rig-view .qp-panel h2').first().textContent(), /环境观测/)
  await page.screenshot({ path: join(qa, 'web-egress-channel.png'), fullPage: true })
  await page.getByRole('button', { name: '改为直连', exact: true }).click()
  await page.getByText('已改为直连', { exact: false }).waitFor({ state: 'visible' })

  // -- 账号与成员、执行机与工位（docs/21 M1）：不再需要旧管理台 --------------------
  const admin = async (method, path, body) => {
    const response = await fetch(server.origin + path, {
      method,
      headers: { authorization: 'Bearer web-test-secret', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    })
    return response.status === 204 ? {} : response.json()
  }
  await openNav(page, '账号与成员')
  await page.locator('#new-member-account').fill('alice')
  await page.locator('#new-member-name').fill('Alice')
  await page.locator('#new-member-role').selectOption('operator')
  await page.getByRole('button', { name: '新建账号', exact: true }).click()
  const firstPassword = (await page.locator('#one-time-password-value').textContent()).trim()
  assert.ok(firstPassword.length >= 10, 'a one-time password is shown once')
  await page.screenshot({ path: join(qa, 'web-members-created.png'), fullPage: true })
  await page.locator('#one-time-password-done').click()
  await page.locator('#one-time-password').waitFor({ state: 'detached' })
  const signIn = await fetch(server.origin + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: firstPassword })
  })
  assert.equal(signIn.status, 200, 'the new account signs in with its one-time password')
  await page.locator('[data-member-role="local:alice"]').selectOption('viewer')
  await page.getByText('权限已更新', { exact: true }).waitFor()
  page.once('dialog', (dialog) => dialog.accept())
  await page.locator('[data-member-reset="local:alice"]').click()
  const secondPassword = (await page.locator('#one-time-password-value').textContent()).trim()
  assert.notEqual(secondPassword, firstPassword, 'a reset issues a new password')
  await page.locator('#one-time-password-done').click()
  page.once('dialog', (dialog) => dialog.accept())
  await page.locator('[data-member-disable="local:alice"]').click()
  await page.locator('[data-member-disable="local:alice"]', { hasText: '启用' }).waitFor()
  const alice = (await admin('GET', '/api/v1/members')).members.find((member) => member.principalId === 'local:alice')
  assert.deepEqual([alice.role, alice.local.disabled], ['viewer', true])

  await openNav(page, '执行机与工位')
  await page.locator('#enroll-start').click()
  assert.match(await page.locator('#enroll-command').textContent(), /MXT_CODE/, 'a one-time command to join another computer')
  assert.match(await page.locator('#enroll-status').textContent(), /等那台电脑连上来/)
  await page.screenshot({ path: join(qa, 'web-runners-enroll.png'), fullPage: true })
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await admin('POST', '/runner/v1/runners:register', { name: '测试机 A', os: 'linux', engines: ['playwright'], surfaces: ['web'] })
  await openNav(page, '执行记录')
  await openNav(page, '执行机与工位')
  await page.getByText('测试机 A', { exact: true }).waitFor()
  page.once('dialog', (dialog) => dialog.accept())
  await page.locator('[data-remove-runner]').first().click()
  await page.getByText('已移除「测试机 A」', { exact: true }).waitFor()
  assert.equal((await admin('GET', '/api/v1/runners')).runners.length, 0)

  // -- 项目设置、用例库、提升到用例库、通知渠道（docs/21 M2）----------------------
  await admin('POST', '/api/v1/apps', { slug: 'm2-demo', displayName: 'M2 演示项目', surfaces: ['web'], visibility: 'private' })
  const task = (await admin('POST', '/api/rig/v1/test-tasks', { app: 'm2-demo', goal: 'M2 登录验收' })).mission
  const book = `/api/rig/v1/missions/${task.id}/cases`
  await admin('POST', book, {
    expectedRevision: 0,
    cases: [{ caseId: 'M2-FE-AUTH-002', title: '错误密码提示', steps: '打开登录页\n输入错误密码', expected: '停留在登录页\n提示账号或密码错误', priority: 'P1', platforms: ['web'] }]
  })
  await admin('POST', `${book}:confirm`, { expectedRevision: 1 })
  await openNav(page, '项目与任务')
  await page.locator('#test-project').selectOption('m2-demo')
  // 设置：从模板新建执行方式，保存一个只写不读的密钥。
  await page.locator('.rig-project-tabs [role=tab]', { hasText: '设置' }).click()
  await page.locator('[data-suite-template="playwright"]').click()
  await page.locator('#suite-slug').fill('web-smoke')
  await page.locator('#suite-name').fill('Web 冒烟')
  // The notice shows before the page is drawn again: fill the new secret form, not the old one.
  await page.locator('#secret-form').evaluate((node) => (node.dataset.before = '1'))
  await page.locator('#suite-form button[type=submit]').click()
  await page.getByText('已新建执行方式「Web 冒烟」', { exact: true }).waitFor()
  await page.locator('#secret-form:not([data-before])').waitFor()
  const suites = (await admin('GET', '/api/v1/apps/m2-demo/suites')).suites
  assert.deepEqual([suites[0].slug, suites[0].engine, suites[0].command.join(' ')], ['web-smoke', 'playwright', 'npx playwright test'])
  await page.locator('#secret-name').fill('M2_TEST_PASSWORD')
  await page.locator('#secret-value').fill('m2-secret-value-never-shown')
  await page.locator('#secret-form button[type=submit]').click()
  await page.locator('[data-secret-delete="M2_TEST_PASSWORD"]').waitFor()
  assert.equal((await page.content()).includes('m2-secret-value-never-shown'), false, 'a secret value never comes back to the page')
  await page.screenshot({ path: join(qa, 'web-project-settings.png'), fullPage: true })
  // 用例库：写一条、编辑、停用。
  await page.locator('.rig-project-tabs [role=tab]', { hasText: '用例库' }).click()
  await page.locator('#catalog-new').click()
  await page.locator('#catalog-case-id').fill('M2-FE-AUTH-001')
  await page.locator('#catalog-case-title').fill('有效账号登录')
  await page.getByLabel('第 1 步操作').fill('打开 /login')
  await page.getByLabel('第 1 步期望').fill('出现登录表单')
  await page.locator('#catalog-form button[type=submit]').click()
  await page.locator('[data-case-edit="M2-FE-AUTH-001"]').click()
  await page.locator('#catalog-case-title').fill('有效账号登录并进入首页')
  await page.locator('#catalog-form button[type=submit]').click()
  await page.getByText('有效账号登录并进入首页', { exact: true }).waitFor()
  page.once('dialog', (dialog) => dialog.accept())
  await page.locator('[data-case-retire="M2-FE-AUTH-001"]').click()
  await page.getByText('已停用 M2-FE-AUTH-001', { exact: true }).waitFor()
  // 提升：任务里已确认的用例进入用例库。
  await page.locator('.rig-project-tabs [role=tab]', { hasText: '测试任务' }).click()
  // The task was made over the API after this page loaded.
  await page.locator('#refresh').click()
  await page.getByRole('button', { name: 'M2 登录验收', exact: true }).click()
  await page.locator('#promote-cases').click()
  assert.match(await page.locator('#promote-result').textContent(), /M2-FE-AUTH-002 · 已新增到用例库/)
  const library = (await admin('GET', '/api/v1/apps/m2-demo/cases')).cases
  assert.deepEqual(library.map((entry) => entry.caseId), ['M2-FE-AUTH-002'], 'the promoted case is in the library; the retired one is not listed')
  assert.deepEqual(library[0].steps.map((step) => step.expect), ['停留在登录页', '提示账号或密码错误'])
  await page.screenshot({ path: join(qa, 'web-promote.png'), fullPage: true })
  // 通知渠道：登记、发测试消息、删除。
  await openNav(page, '通知渠道')
  await page.locator('#channel-name').fill('测试群')
  await page.locator('#channel-url').fill('https://open.feishu.cn/open-apis/bot/v2/hook/smoke-only')
  await page.locator('#channel-form button[type=submit]').click()
  await page.getByText('open.feishu.cn', { exact: true }).waitFor()
  await page.locator('[data-channel-test]').first().click()
  await page.getByText('已入队', { exact: false }).waitFor()
  page.once('dialog', (dialog) => dialog.accept())
  await page.locator('[data-channel-delete]').first().click()
  await page.getByText('已删除通知渠道「测试群」', { exact: true }).waitFor()
  // 删除项目：输入标识确认。
  await openNav(page, '项目与任务')
  await page.locator('#test-project').selectOption('m2-demo')
  await page.locator('.rig-project-tabs [role=tab]', { hasText: '设置' }).click()
  await page.locator('#project-delete-confirm').fill('m2-demo')
  await page.locator('#project-delete').click()
  await page.getByText('已删除项目', { exact: true }).waitFor()
  assert.equal((await admin('GET', '/api/v1/apps')).apps.some((app) => app.slug === 'm2-demo'), false)

  // -- 执行计划（docs/21 M3）与「定时前先验证」（M6）：新建手动计划 → 立即执行 → 通过后才能定时 --
  await admin('POST', '/api/v1/apps', { slug: 'm3-demo', displayName: 'M3 演示项目', surfaces: ['web'], visibility: 'private' })
  await admin('POST', '/api/v1/apps/m3-demo/suites', { slug: 'web-smoke', displayName: 'Web 冒烟', engine: 'playwright', surface: 'web', runnerKind: 'local', targetMode: 'external', command: ['npx', 'playwright', 'test'] })
  await openNav(page, '项目与任务')
  await page.locator('#test-project').selectOption('m3-demo')
  // The setup checklist: an execution method exists; a plan is the next step.
  const checklist = page.locator('#setup-checklist')
  // This project's list: its execution method is already listed.
  await checklist.locator('li[data-step="suite"]', { hasText: 'Web 冒烟' }).waitFor()
  assert.equal(await checklist.getAttribute('data-left'), '3')
  assert.equal(await checklist.locator('li[data-next="true"]').getAttribute('data-step'), 'plan')
  await page.locator('.rig-project-tabs [role=tab]', { hasText: '执行计划' }).click()
  await page.locator('#plan-new').click()
  const cronOffered = () => page.locator('#plan-schedule option[value="cron"]').evaluate((option) => !option.disabled)
  assert.equal(await cronOffered(), false, 'a new plan cannot be scheduled')
  await page.getByText('定时要先验证', { exact: false }).waitFor()
  await page.locator('#plan-name').fill('每晚冒烟')
  await page.locator('#plan-target').fill('http://127.0.0.1:4610')
  await page.locator('#plan-form button[type=submit]').click()
  await page.getByText('已新建执行计划「每晚冒烟」', { exact: true }).waitFor()
  const m3plan = (await admin('GET', '/api/v1/tasks?app=m3-demo')).tasks[0]
  assert.deepEqual([m3plan.scheduleKind, m3plan.runsOn, m3plan.targetUrl], ['manual', 'any-runner', 'http://127.0.0.1:4610'])
  assert.equal(await page.locator(`[data-plan="${m3plan.id}"] [data-verification]`).getAttribute('data-verification'), 'unverified')
  // Run it now; a runner picks it up and it passes.
  const m3runner = pretendRunner(server.origin, 'web-test-secret')
  const m3machine = await m3runner.register('M3 测试机')
  await page.locator(`[data-plan-run-now="${m3plan.id}"]`).click()
  const dispatched = await page.locator('[data-plan-run]').getAttribute('data-plan-run')
  assert.match(dispatched, /^trun_/, 'run now creates a real run')
  assert.equal((await admin('GET', `/api/v1/runs/${dispatched}`)).run.taskId, m3plan.id)
  await m3runner.clearQueue(dispatched)
  const m3claim = await m3runner.claim()
  assert.equal(m3claim.runId, dispatched)
  await m3runner.call('POST', `/runner/v1/runs/${dispatched}:complete`, {
    token: m3claim.runToken,
    body: { exitCode: 0, summary: { schemaVersion: 2, runId: dispatched, app: 'm3-demo', status: 'passed', totals: { tests: 1, passed: 1 }, cases: [{ caseId: 'M3-FE-AUTH-001', status: 'passed', durationMs: 500 }] } }
  })
  await page.locator('#refresh').click()
  await page.locator(`[data-plan="${m3plan.id}"] [data-verification="verified"]`).waitFor()
  // Verified: now it may be scheduled.
  await page.locator(`[data-plan-edit="${m3plan.id}"]`).click()
  assert.equal(await cronOffered(), true, 'a verified plan can be scheduled')
  await page.locator('#plan-name').fill('每晚冒烟（只跑登录）')
  await page.locator('#plan-schedule').selectOption('cron')
  await page.locator('#plan-cron').fill('0 2 * * *')
  await page.locator('#plan-form button[type=submit]').click()
  await page.getByText('已更新执行计划「每晚冒烟（只跑登录）」', { exact: true }).waitFor()
  const scheduled = (await admin('GET', '/api/v1/tasks?app=m3-demo')).tasks[0]
  assert.deepEqual([scheduled.scheduleKind, scheduled.cronExpr], ['cron', '0 2 * * *'])
  assert.ok(scheduled.nextRunAt, 'a cron plan knows when it fires next')
  assert.equal(await page.locator('#setup-checklist').getAttribute('data-left'), '0')
  await page.getByText('上手清单 · 已经可以定时运行', { exact: true }).waitFor()
  await page.screenshot({ path: join(qa, 'web-plans.png'), fullPage: true })
  // 审计（M6）：the schedule change is on record, field by field.
  await openNav(page, '审计')
  await page.locator('#audit-resource').selectOption('task')
  const scheduleChange = page.locator('.rig-audit-row[data-action="task.update"]').first()
  await scheduleChange.waitFor()
  await scheduleChange.locator('summary').click()
  const changeText = await scheduleChange.innerText()
  assert.match(changeText, /修改执行计划/)
  assert.match(changeText, /scheduleKind\s+manual\s+cron/)
  await page.screenshot({ path: join(qa, 'web-audit.png'), fullPage: true })
  await openNav(page, '项目与任务')
  await page.locator(`[data-plan-toggle="${m3plan.id}"]`).click()
  await page.getByText('不再定时触发', { exact: false }).waitFor()
  assert.equal((await admin('GET', '/api/v1/tasks?app=m3-demo')).tasks[0].enabled, false)
  await page.locator(`[data-plan-toggle="${m3plan.id}"]`).click()
  await page.getByText('已启用', { exact: false }).waitFor()
  page.once('dialog', (dialog) => dialog.accept())
  await page.locator(`[data-plan-delete="${m3plan.id}"]`).click()
  await page.getByText('已删除执行计划', { exact: false }).waitFor()
  assert.equal((await admin('GET', '/api/v1/tasks?app=m3-demo')).tasks.length, 0)
  await m3runner.remove(m3machine.id)
  // A test task with no plan: make one inside 「执行与结果」, and it is the one picked.
  const m3task = (await admin('POST', '/api/rig/v1/test-tasks', { app: 'm3-demo', goal: 'M3 任务内建计划' })).mission
  await admin('POST', `/api/rig/v1/missions/${m3task.id}/cases`, {
    expectedRevision: 0,
    cases: [{ caseId: 'M3-FE-AUTH-001', title: '登录', steps: '打开登录页', expected: '看到表单', platforms: ['web'] }]
  })
  await admin('POST', `/api/rig/v1/missions/${m3task.id}/cases:confirm`, { expectedRevision: 1 })
  await page.locator('.rig-project-tabs [role=tab]', { hasText: '测试任务' }).click()
  await page.locator('#refresh').click()
  await page.getByRole('button', { name: 'M3 任务内建计划', exact: true }).click()
  await page.locator('.rig-test-tabs [role=tab]', { hasText: '执行与结果' }).click()
  assert.equal(await page.locator('#inline-plan').evaluate((node) => node.open), true, 'with no plan, the creator is open')
  await page.locator('#plan-name').fill('任务内的冒烟计划')
  await page.locator('#plan-target').fill('http://127.0.0.1:4610')
  await page.locator('#plan-form button[type=submit]').click()
  await page.locator('#execution-task').waitFor()
  assert.match(await page.locator('#execution-task option:checked').textContent(), /任务内的冒烟计划/)
  await page.screenshot({ path: join(qa, 'web-inline-plan.png'), fullPage: true })

  // -- 执行详情（docs/21 M4）：等待认领 → 实时流水 → 结果与录像跳转 → 只重跑这条 → 取消 --
  const clip = await recordClip(browser, join(state, 'clip'))
  const M4_CATALOG = smokeCatalog('m4-demo', 'web-smoke', 'M4-FE-AUTH')
  await admin('POST', '/api/v1/apps', { slug: 'm4-demo', displayName: 'M4 演示项目', surfaces: ['web'], visibility: 'private' })
  await admin('POST', '/api/v1/apps/m4-demo/suites', { slug: 'web-smoke', displayName: 'Web 冒烟', engine: 'playwright', surface: 'web', runnerKind: 'local', targetMode: 'external', command: ['npx', 'playwright', 'test'] })
  // The repository's catalog: two cases with specs, one registered and not yet written.
  await admin('POST', '/api/v1/apps/m4-demo/catalog:sync', M4_CATALOG)
  const m4plan = (await admin('POST', '/api/v1/tasks', { app: 'm4-demo', suite: 'web-smoke', name: '登录冒烟', targetUrl: 'http://127.0.0.1:4610', runsOn: 'any-runner', schedule: { kind: 'manual' } })).task
  const m4run = (await admin('POST', `/api/v1/tasks/${m4plan.id}:run`, {})).run.id
  const runner = pretendRunner(server.origin, 'web-test-secret')
  await runner.clearQueue(m4run)
  await openNav(page, '项目与任务')
  await page.locator('#test-project').selectOption('m4-demo')
  await page.locator('.rig-project-tabs [role=tab]', { hasText: '执行记录' }).click()
  await page.locator(`[data-run-open="${m4run}"]`).click()
  await page.locator(`#run-detail[data-run="${m4run}"]`).waitFor()
  await page.getByText('正在等一台执行机认领。', { exact: true }).waitFor()
  // A runner claims it and reports progress; the page follows without a reload.
  const machine4 = await runner.register()
  const claim4 = await runner.claim()
  assert.equal(claim4.runId, m4run)
  await runner.events(m4run, claim4.runToken, [
    { kind: 'stage', stage: 'checkout', status: 'ok' },
    { kind: 'stage', stage: 'execute', status: 'running' },
    { kind: 'case.started', caseId: 'M4-FE-AUTH-001', title: '有效账号登录' },
    { kind: 'step', caseId: 'M4-FE-AUTH-001', seq: 1, label: '打开登录页', offsetMs: 200 },
    { kind: 'log', line: 'Running 2 tests using 1 worker' }
  ])
  await page.locator('#run-live [data-case="M4-FE-AUTH-001"]').waitFor()
  await page.getByText('冒烟测试机 已经接手。', { exact: true }).waitFor()
  assert.equal(await page.locator('.rig-run-flow__node[data-state="active"]').count(), 1, 'one stage is in progress')
  assert.equal(await page.locator('.rig-run-flow__node[data-state="skipped"]').count(), 2, 'overtaken stages read as not applicable')
  await page.screenshot({ path: join(qa, 'web-run-live.png'), fullPage: true })
  // It finishes: the page reads the result once more and shows every case with its evidence.
  const clipPath = 'videos/M4-FE-AUTH-001.webm'
  await runner.upload(m4run, claim4.runToken, clipPath, clip)
  await runner.complete(m4run, claim4.runToken, twoCaseSummary(m4run, 'm4-demo', { video: clipPath, passed: 'M4-FE-AUTH-001', failed: 'M4-FE-AUTH-002' }))
  await page.locator('#run-cases').waitFor()
  assert.equal(await page.locator('#run-detail').getAttribute('data-status'), 'failed')
  const failedRow = page.locator('details.rig-run-case[data-case="M4-FE-AUTH-002"]')
  assert.equal(await failedRow.evaluate((node) => node.open), true, 'a failed case opens by itself')
  assert.match(await failedRow.innerText(), /账号或密码错误/)
  await page.getByText('有 1 条用例登记了但没有跑到。', { exact: true }).waitFor()
  const passedRow = page.locator('details.rig-run-case[data-case="M4-FE-AUTH-001"]')
  await passedRow.locator('summary').click()
  const player = await passedRow.locator('video').elementHandle()
  await page.waitForFunction((node) => node.readyState >= 1, player)
  await passedRow.locator('[data-seek="0.90"]').click()
  await page.waitForFunction((node) => Math.abs(node.currentTime - 0.9) < 0.6, player)
  await page.locator('[data-filter="failed"]').click()
  assert.equal(await page.locator('#run-cases .rig-run-case').count(), 1, 'the failed filter shows only failures')
  await page.locator('[data-filter="all"]').click()
  await passedRow.locator('summary').click()
  await page.screenshot({ path: join(qa, 'web-run-detail.png'), fullPage: true })
  // 只重跑这条: the same plan narrowed to that case, opened in place.
  await page.locator('[data-rerun="M4-FE-AUTH-002"]').click()
  await page.waitForFunction((id) => {
    const node = document.querySelector('#run-detail')
    return Boolean(node) && node.dataset.run !== id
  }, m4run)
  const rerun = await page.locator('#run-detail').getAttribute('data-run')
  assert.equal((await admin('GET', `/api/v1/runs/${rerun}`)).run.caseFilter, 'M4-FE-AUTH-002')
  await page.getByText('只跑了 M4-FE-AUTH-002', { exact: true }).waitFor()
  page.once('dialog', (dialog) => dialog.accept())
  await page.locator('#run-cancel').click()
  await page.waitForFunction(() => document.querySelector('#run-detail')?.dataset.status === 'cancelled')
  // 返回 goes back to the tab the run was opened from.
  await page.locator('#run-back').click()
  await page.locator(`[data-run-open="${m4run}"]`).waitFor()
  // 让 Agent 分析这次执行 (docs/23 M7c): a drafted, unstarted task for the failure grader.
  await page.locator(`[data-run-open="${m4run}"]`).click()
  await page.locator('#run-analyze').click()
  await page.waitForFunction((id) => document.querySelector('#goal')?.value.includes(id), m4run)
  assert.match(await page.locator('#goal').inputValue(), /能不能上线/)
  await page.getByText('Agent · failure-triage', { exact: true }).waitFor()
  assert.equal((await admin('GET', '/api/rig/v1/missions')).missions.filter((row) => row.goal?.includes(m4run)).length, 0, 'nothing starts until a person does')
  await runner.remove(machine4.id)
  // 演示一遍 on the web (docs/24): the Compass tour needs the desktop and says
  // so; 读懂一次执行 runs here, 快速准备 straight to the step the person presses.
  await openNav(page, '新手引导')
  assert.match(await page.locator('[data-tour-card="compass-web-smoke"]').innerText(), /要在桌面端演示/)
  assert.equal(await page.locator('[data-tour-card="compass-web-smoke"] [data-tour-start]').count(), 0)
  await openNav(page, '项目与任务')
  await page.locator('#test-project').selectOption('m4-demo')
  await openNav(page, '新手引导')
  await page.locator('[data-tour-card="read-a-run"] [data-tour-start]').click()
  await page.locator('#tour[data-state="intro"]').waitFor({ state: 'attached' })
  await page.locator('#tour [data-tour-action="fast"]').click()
  await page.locator('#tour[data-state="final"][data-step="analyze"]').waitFor({ state: 'attached', timeout: 30_000 })
  assert.equal(await page.locator('#run-detail').getAttribute('data-run'), rerun, 'the latest run of the project')
  await page.locator('#tour [data-tour-action="end"]').click()
  await page.locator('#tour').waitFor({ state: 'detached' })
  // A quest offers the tour that teaches it, as far as this end can take it:
  // here 「跟着演示亲手走一遍」 offers 读懂一次执行, since 新项目 needs the desktop.
  await openNav(page, '新手引导')
  assert.match(await page.locator('[data-tour-card="new-project"]').innerText(), /要在桌面端演示/)
  await openNav(page, '系统')
  const followCard = page.locator('[data-quest-tour="follow-a-tour"]')
  await followCard.click()
  await page.locator('#tour[data-tour="read-a-run"][data-state="intro"]').waitFor({ state: 'attached' })
  await page.locator('#tour [data-tour-action="cancel"]').click()
  await page.locator('#tour').waitFor({ state: 'detached' })
  // The person signed in to this page, not the service token.
  const ownSystem = await page.evaluate(() => fetch('/api/rig/v1/system').then((answer) => answer.json()))
  assert.equal(ownSystem.system.quests.find((quest) => quest.id === 'follow-a-tour').status, 'open', '快速准备 does not count as following')
  // 演示录像 (docs/24 M8c): a published recording plays on its card in 新手引导,
  // here also for a tour only the desktop can take.
  const published = await admin('PUT', '/api/rig/v1/tour-videos/new-project', { version: '0.8.0', recordedAt: new Date().toISOString(), durationMs: 2100, video: clip.toString('base64') })
  assert.equal(published.video.bytes, clip.length)
  await openNav(page, '新手引导')
  const tourVideo = page.locator('[data-tour-video="new-project"] video')
  assert.equal(await tourVideo.getAttribute('src'), '/api/rig/v1/tour-videos/new-project.webm')
  await page.waitForFunction(() => document.querySelector('[data-tour-video="new-project"] video')?.readyState >= 1, null, { timeout: 15_000 })
  assert.match(await page.locator('[data-tour-video="new-project"] figcaption').innerText(), /0\.8\.0 版界面/)
  assert.equal(await page.locator('[data-tour-video="read-a-run"]').count(), 0, 'a tour without a recording shows none')

  // -- 从验收包创建（docs/21 M5）：网页端登记项目、执行方式和用例库；快照在桌面端建立 --
  await openNav(page, '项目与任务')
  await page.locator('#pack-creator summary').click()
  const compassCard = page.locator('[data-pack="compass"]')
  await compassCard.waitFor()
  assert.match(await compassCard.innerText(), /23 条旧用例作参考（不计入）/)
  assert.match(await compassCard.innerText(), /feat\/yjj\/hdo_v2@a4cc5de/)
  await page.locator('#pack-submit-compass').click()
  await page.getByText('源码快照和 QA 仓库要在桌面端建立', { exact: false }).waitFor()
  await page.getByText('这个项目的测试对固定提交的源码快照运行', { exact: false }).waitFor()
  const packSuites = (await admin('GET', '/api/v1/apps/luopan/suites')).suites
  assert.deepEqual(packSuites.map((suite) => suite.repoUrl), ['rig-workspace://luopan/qa', 'rig-workspace://luopan/qa'])
  assert.equal((await admin('GET', '/api/v1/tasks?app=luopan')).tasks.length, 0, 'no plans until a desktop holds the workspace')
  await page.screenshot({ path: join(qa, 'web-pack.png'), fullPage: true })
  await page.locator('.rig-project-tabs [role=tab]', { hasText: '用例库' }).click()
  const referenceTags = page.locator('.qp-tag', { hasText: /^参考（不计入）$/ })
  await referenceTags.first().waitFor()
  assert.equal(await referenceTags.count(), 23)

  // -- 安装包（M6）：桌面端测的是安装包，登记在项目设置里 ------------------------------
  await page.locator('.rig-project-tabs [role=tab]', { hasText: '设置' }).click()
  await page.locator('#package-form').waitFor()
  await page.getByText('还没有登记安装包', { exact: false }).waitFor()
  await page.locator('#package-url').fill('https://downloads.example.com/compass/Compass-Setup-2.0.6.exe')
  await page.locator('#package-sha256').fill('ab'.repeat(32))
  await page.locator('#package-version').fill('2.0.6')
  await page.locator('#package-form button[type=submit]').click()
  await page.getByText('已登记安装包', { exact: false }).waitFor()
  assert.match(await page.locator('#package-latest').innerText(), new RegExp('ab'.repeat(32)))
  assert.equal((await admin('GET', '/api/v1/apps')).apps.find((app) => app.slug === 'luopan').latestPackage.version, '2.0.6')

  // -- 测试仓库（M7）：网页端只看服务器上的发布版本；写入、合入、发布在桌面端 -----------
  await admin('POST', '/api/v1/apps', { slug: 'm7-web', displayName: 'M7 测试仓库', surfaces: ['web'], visibility: 'private' })
  assert.equal((await admin('POST', '/api/v1/apps/m7-web/workspace-suite', {})).suite.slug, 'rig-tests-web')
  await page.locator('#refresh').click()
  await page.locator('#test-project').selectOption('m7-web')
  await page.locator('.rig-project-tabs [role=tab]', { hasText: '执行计划' }).click()
  await page.getByText('这个项目的测试写在它自己的测试仓库里', { exact: false }).waitFor()
  await page.getByText('服务器上还没有发布过测试版本。', { exact: true }).waitFor()

  // -- 旧管理台只读（M6）：横幅说明去向，写操作的按钮都不在了 ---------------------------
  // The last section, so the workbench page itself goes to the old console.
  const legacy = page
  await legacy.goto(server.origin + '/tasks')
  await legacy.getByText('旧管理台已改为只读，保留用来查看历史。', { exact: true }).waitFor()
  assert.match(await legacy.locator('[data-read-only]').innerText(), /项目与任务 → 执行计划/)
  assert.equal(await legacy.locator('[data-new-task], [data-run]').count(), 0, 'no way to create or run from the old console')
  await legacy.goto(server.origin + '/members')
  await legacy.locator('[data-read-only]').waitFor()
  assert.equal(await legacy.locator('[data-create], [data-reset], [data-disable]').count(), 0)
  await legacy.screenshot({ path: join(qa, 'web-legacy-readonly.png'), fullPage: true })

  assert.deepEqual(errors, [])
  console.log(
    'Browser tools and Web smoke passed: origin policy, real page fill/click, password refusal, screenshots, HttpOnly login, unconfigured model blocked, Internal settings, Agent market, quality report (empty rates read "—", report focus reorders sections), orchestration centre (compiled spec, draft preview, refused draft), egress observation, the desktop overseas channel card in each state, the system layer (signal vs platform evidence, claim, floating panel), one-line dispatch parsing (real plan id, no execution), switching Rig\'s own egress channel, streamed model output (a visible draft that the final answer replaces), a structured finding whose unread citation is marked, accounts (create, sign in with the one-time password, role, reset, disable), runners (enrol command, remove), the run detail (waiting for a runner, live pipeline, results with a seekable recording, rerun one case, cancel, an unstarted Agent analysis drafted from it, the read-only tour on the web, a quest offering it, a published tour recording playing in 新手引导), creating a project from the Compass acceptance pack (references shown, not counted), and M6 (scheduling only after a verified run, the setup checklist, the audit trail of a schedule change, registering an installer, the old console read-only), and the published versions of a test repository in the browser.'
  )
} finally {
  await tools.close()
  await browser?.close()
  await server?.close()
  await new Promise((r) => target.close(r))
}
