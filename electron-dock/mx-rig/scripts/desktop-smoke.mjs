import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { _electron, chromium } from 'playwright'
import { start } from '../apps/server/index.mjs'
import { pretendRunner, recordClip, smokeCatalog, twoCaseSummary } from './smoke-run.mjs'
import { TOURS } from '../apps/web/tours.js'

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
const state = await mkdtemp(join(qa, 'desktop-'))
// The page the browser acceptance drives: a settings form that says 已保存.
// A login page laid out at fixed positions, so the acceptance knows where the
// password field is in the live frame it clicks into.
const PASSWORD = 'desktop-smoke-only-password'
const LOGIN_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>登录</title></head>
<body style="margin:0;font:16px -apple-system,sans-serif;background:#ffffff">
<form id="login">
<label for="u" style="position:absolute;left:100px;top:100px">账号</label>
<input id="u" value="tester" style="position:absolute;left:100px;top:130px;width:300px;height:32px;box-sizing:border-box">
<label for="p" style="position:absolute;left:100px;top:180px">密码</label>
<input id="p" type="password" autocomplete="current-password" style="position:absolute;left:100px;top:210px;width:300px;height:32px;box-sizing:border-box">
<button type="submit" style="position:absolute;left:100px;top:270px;width:120px;height:36px">登录</button>
</form><p id="out" style="position:absolute;left:100px;top:330px;margin:0"></p>
<button id="clear" type="button" style="position:absolute;left:100px;top:380px;width:120px;height:36px" onclick="if(confirm('确定清除登录记录？'))document.getElementById('out').textContent='欢迎回来，tester（记录已清除）'">清除记录</button>
<script>document.getElementById('login').onsubmit=(e)=>{e.preventDefault();document.getElementById('out').textContent=document.getElementById('p').value==='${PASSWORD}'?'欢迎回来，tester':'密码错误'}</script>
</body></html>`
const site = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  if (req.url.startsWith('/login')) return res.end(LOGIN_PAGE)
  res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>个人设置</title></head>
<body style="font:15px -apple-system,sans-serif;margin:0;background:#f6f8fa">
<header style="background:#0f766e;color:#fff;padding:14px 24px;font-weight:600">验收站点 · 个人设置</header>
<main style="max-width:520px;margin:32px auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:24px">
<label for="n" style="display:block;margin-bottom:6px">昵称</label>
<input id="n" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;box-sizing:border-box">
<button onclick="document.querySelector('#s').textContent='已保存'" style="margin-top:18px;background:#0f766e;color:#fff;border:0;border-radius:6px;padding:8px 18px">保存</button>
<p id="s" style="color:#047857"></p></main></body></html>`)
})
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
const siteOrigin = `http://127.0.0.1:${site.address().port}`
// The same server under a name nobody listed: a site the member is asked about.
const unlistedOrigin = `http://localhost:${site.address().port}`

/**
 * The stand-in model. The workflow and model-less missions never reach it;
 * the browser acceptance does, and it acts like a model that reads the page:
 * references come from the snapshot the last tool returned.
 */
function scripted(body) {
  const done = body.messages.filter((message) => message.role === 'tool')
  const goal = body.messages.find((message) => message.role === 'user')?.content ?? ''
  const snapshot = (() => {
    try {
      return JSON.parse(done.at(-1)?.content ?? '{}').snapshot ?? ''
    } catch {
      return ''
    }
  })()
  const ref = (pattern) => /\[ref=(e\d+)\]/.exec(snapshot.split('\n').find((line) => pattern.test(line)) ?? '')?.[1]
  const call = (name, args, say = null) => ({
    content: say,
    tool_calls: [{ id: `call-${done.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
  })
  if (/登录/.test(goal))
    switch (done.length) {
      case 0:
        return call('browser_open', { url: `${unlistedOrigin}/login` })
      case 1:
        // Refused before anyone is asked: the Agent does not type passwords.
        return call('browser_fill', { ref: ref(/textbox "密码"/), value: 'guess' })
      case 2:
        return call(
          'browser_handoff',
          { reason: '在密码框里输入测试账号的密码并点登录', ref: ref(/textbox "密码"/) },
          '密码要由你来输入。'
        )
      case 3:
        return call('browser_snapshot', {})
      case 4:
        return call('browser_assert', { kind: 'text_visible', expected: '欢迎回来' })
      default:
        return { content: '登录成功，页面显示「欢迎回来，tester」。密码由测试人员在画面里输入。此答复来自验收用模型替身。' }
    }
  switch (done.length) {
    case 0:
      return call('browser_open', { url: `${siteOrigin}/settings` }, '先打开设置页看看。')
    case 1:
      return call('browser_fill', { ref: ref(/textbox "昵称"/), value: 'Rig' })
    case 2:
      return call('browser_click', { ref: ref(/button "保存"/) })
    case 3:
      return call('browser_assert', { kind: 'text_visible', expected: '已保存' }, '确认页面给出了保存成功的提示。')
    default:
      return { content: '已把昵称改成 Rig 并保存，页面显示「已保存」，断言通过。此答复来自验收用模型替身。' }
  }
}

const server = await start(
  {
    MX_RIG_HOST: '127.0.0.1',
    MX_RIG_PORT: '0',
    MX_RIG_STORE: 'memory',
    MX_RIG_ADMIN_TOKEN: 'desktop-test-secret',
    MX_RIG_SECRET_KEY: '6b'.repeat(32),
    MX_RIG_STATE_DIR: join(state, 'control'),
    MX_RIG_ARTIFACTS_DIR: join(state, 'artifacts')
  },
  {
    schedule: false,
    modelOptions: {
      environment: { MX_RIG_MODEL_API_KEY: 'fixture-only' },
      // Answers with an ordinary JSON body even though the service asks for a
      // stream: this is the gateway-ignores-streaming path, exercised here
      // through the whole desktop stack. Real SSE is covered by browser-smoke.
      fetchImpl: async (_url, init) =>
        new Response(
          JSON.stringify({ choices: [{ message: scripted(JSON.parse(init.body)) }] })
        )
    }
  }
)
async function api(path, body) {
  const r = await fetch(server.origin + path, {
    method: 'POST',
    headers: { authorization: 'Bearer desktop-test-secret', 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  assert.ok(r.ok, await r.text())
}
await api('/api/v1/apps', {
  slug: 'desktop-fixture',
  displayName: 'Desktop fixture',
  surfaces: ['web']
})
await api('/api/v1/apps/desktop-fixture/suites', {
  slug: 'smoke',
  displayName: 'Smoke',
  engine: 'playwright',
  surface: 'web',
  runnerKind: 'local',
  targetMode: 'self',
  command: ['node', 'test.mjs']
})
await api('/api/v1/tasks', {
  app: 'desktop-fixture',
  suite: 'smoke',
  name: '桌面验收计划',
  profile: 'mock',
  track: 'functional'
})
const env = { ...process.env, MX_RIG_USER_DATA_DIR: join(state, 'profile') }
delete env.ELECTRON_RUN_AS_NODE
delete env.MX_RIG_SERVER_URL
// A build made for a team starts with its server address (package --server).
const defaultsFile = join(root, 'apps/desktop/defaults.json')
const previousDefaults = await readFile(defaultsFile, 'utf8').catch(() => null)
await writeFile(defaultsFile, JSON.stringify({ server: server.origin, privateHttp: false }))
let desktop
try {
  console.log('Launching desktop smoke…')
  const launch = process.argv.includes('--packaged')
    ? { executablePath: join(root, 'dist/win-unpacked/MX Rig.exe'), args: [] }
    : { args: [join(root, 'apps/desktop/main.mjs')] }
  desktop = await _electron.launch({ ...launch, env, timeout: 30_000 })
  console.log('Electron connected')
  const page = await desktop.firstWindow()
  page.setDefaultTimeout(15_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  // Nobody types the address: it came with the build.
  await page.waitForFunction((origin) => document.querySelector('#server').value === origin, server.origin)
  await page.locator('#account').fill('admin')
  await page.locator('#password').fill('desktop-test-secret')
  await page.locator('#login-form button[type=submit]').click()
  console.log('Submitted native login')
  await page.locator('#workspace').waitFor({ state: 'visible' })
  await openNav(page, 'Agent 会话')
  await page.locator('#mode').waitFor({ state: 'visible' })
  assert.equal(await page.evaluate(() => window.mxRig.desktop), true)
  // The test browser is found without anyone installing it here.
  assert.equal((await page.evaluate(() => window.mxRig.request('browser-status'))).ready, true)
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
  const summary = await page.evaluate(() => window.mxRig.request('me'))
  assert.equal(summary.token, undefined)
  await page.screenshot({ path: join(qa, 'desktop-workspace.png') })
  await page.locator('#mode').selectOption('workflow')
  await page.locator('#task option').first().waitFor({ state: 'attached' })
  await page.locator('#goal').fill('检查桌面工作流是否正确生成测试执行记录')
  await page.locator('#start').click()
  await page.locator('#approval').waitFor({ state: 'visible' })
  await page.screenshot({ path: join(qa, 'desktop-approval.png') })
  await page.getByRole('button', { name: '确认执行', exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('#mission-status')?.textContent === '任务完成'
  )
  assert.match(await page.locator('#timeline').innerText(), /不代表测试通过/)
  await page.screenshot({ path: join(qa, 'desktop-completed.png') })
  await page.locator('#goal').fill('继续分析这个测试执行；没有模型时应明确受阻')
  await page.locator('#start').click()
  await page.waitForFunction(
    () => document.querySelector('#mission-status')?.textContent === '受阻'
  )
  assert.equal(await page.locator('.rig-mission-item').count(), 1)
  // The run's report opens in a window of the desktop's own — no system
  // browser, no second login — and that window reaches nothing but this
  // run's report and artifacts (docs/21 M0).
  const { runs } = await page.evaluate(() => window.mxRig.request('runs'))
  assert.ok(runs[0]?.id, 'the workflow dispatched a real run')
  const opened = desktop.waitForEvent('window')
  await page.evaluate((id) => window.mxRig.request('open-path', { path: `/api/v1/runs/${id}/report` }), runs[0].id)
  const report = await opened
  await report.waitForLoadState('domcontentloaded')
  assert.match(await report.title(), /测试报告/)
  // Rendered for a signed-in member: an unauthenticated request gets an error, not a report.
  assert.match(await report.locator('body').innerText(), /用例明细/)
  const elsewhere = await report.evaluate(() =>
    fetch('/api/v1/members').then((response) => `status ${response.status}`, () => 'blocked')
  )
  assert.equal(elsewhere, 'blocked', 'the report window cannot call other APIs')
  // Styled: the design system's colours arrived (its tokens are an @import).
  assert.notEqual(
    await report.evaluate(() => getComputedStyle(document.body).getPropertyValue('--qp-text-1').trim()),
    '',
    'report stylesheets and their tokens load'
  )
  await report.screenshot({ path: join(qa, 'desktop-report-window.png') })
  await report.close()
  // The project page's own tabs.
  await openNav(page, '项目与任务')
  await page.locator('.rig-project-tabs').waitFor({ state: 'visible' }).catch(() => {})
  // Accounts and machines through the main process (docs/21 M1): PATCH and
  // DELETE travel with the member's token, which the renderer never holds.
  const made = await page.evaluate(() => window.mxRig.request('member-create', { account: 'bob', role: 'operator' }))
  assert.ok(made.initialPassword?.length >= 10, 'a one-time password for the new account')
  const lowered = await page.evaluate(() => window.mxRig.request('member-update', { principalId: 'local:bob', role: 'viewer' }))
  assert.equal(lowered.member.role, 'viewer')
  const reset = await page.evaluate(() => window.mxRig.request('member-reset', { principalId: 'local:bob' }))
  assert.notEqual(reset.initialPassword, made.initialPassword)
  const disabled = await page.evaluate(() => window.mxRig.request('member-update', { principalId: 'local:bob', disabled: true }))
  assert.equal(disabled.member.local.disabled, true)
  // A refusal reads in the service's own words, not as a bare status code.
  const refused = await page.evaluate(() =>
    window.mxRig.request('member-create', { account: 'Not Valid!', role: 'viewer' }).then(() => null, (error) => error.message)
  )
  assert.match(refused, /账号/)
  const enrolment = await page.evaluate(() => window.mxRig.request('machine-enroll'))
  assert.match(enrolment.commands.unix, /MXT_CODE=/)
  assert.equal((await page.evaluate((id) => window.mxRig.request('machine-enrollment', { id }), enrolment.enrollment.id)).status, 'pending')
  const machine = await (
    await fetch(server.origin + '/runner/v1/runners:register', {
      method: 'POST',
      headers: { authorization: 'Bearer desktop-test-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ name: '桌面验收测试机', os: 'linux', engines: ['playwright'], surfaces: ['web'] })
    })
  ).json()
  await openNav(page, '执行机与工位')
  await page.getByText('桌面验收测试机', { exact: true }).waitFor()
  assert.ok(await page.getByText('本机执行机 · 桌面端').isVisible(), 'this desktop can host a runner from the same page')
  await page.screenshot({ path: join(qa, 'desktop-runners.png') })
  assert.deepEqual(await page.evaluate((id) => window.mxRig.request('machine-remove', { id }), machine.runner.id), {})
  // Project settings, the case library and promotion through the main
  // process (docs/21 M2): the same route table the browser uses, PUT included.
  await api('/api/v1/apps', { slug: 'm2-desk', displayName: 'M2 桌面', surfaces: ['web'], visibility: 'private' })
  const ask = (action, body) => page.evaluate(([name, input]) => window.mxRig.request(name, input), [action, body])
  const suite = await ask('suite-create', { app: 'm2-desk', slug: 'web-smoke', displayName: 'Web 冒烟', engine: 'playwright', surface: 'web', runnerKind: 'local', targetMode: 'external', command: ['npx', 'playwright', 'test'] })
  assert.equal(suite.suite.slug, 'web-smoke')
  assert.deepEqual(await ask('secret-put', { app: 'm2-desk', name: 'M2_DESK_PASSWORD', value: 'desk-secret-value' }), {})
  const secrets = await ask('app-secrets', { app: 'm2-desk' })
  assert.deepEqual(secrets.secrets.map((entry) => entry.name), ['M2_DESK_PASSWORD'])
  assert.equal(JSON.stringify(secrets).includes('desk-secret-value'), false)
  await ask('case-create', { app: 'm2-desk', caseId: 'M2-FE-LIST-001', title: '列表可以打开', steps: [{ action: '打开列表', expect: '看到表格' }] })
  await ask('case-update', { app: 'm2-desk', caseId: 'M2-FE-LIST-001', title: '列表可以打开并分页', steps: [{ action: '打开列表', expect: '看到表格' }] })
  const exported = await ask('cases-export', { app: 'm2-desk' })
  assert.ok(JSON.stringify(exported).includes('列表可以打开并分页'))
  const { mission: deskTask } = await ask('test-task-create', { app: 'm2-desk', goal: '桌面提升验收' })
  await ask('task-cases-save', { id: deskTask.id, expectedRevision: 0, cases: [{ caseId: 'M2-FE-LIST-002', title: '空列表提示', steps: '筛选不存在的数据', expected: '提示没有结果', platforms: ['web'] }] })
  await ask('task-cases-confirm', { id: deskTask.id, expectedRevision: 1 })
  const promotion = await ask('task-cases-promote', { id: deskTask.id, expectedRevision: 1 })
  assert.deepEqual(promotion.promoted, [{ caseId: 'M2-FE-LIST-002', action: 'created' }])
  const channel = await ask('channel-create', { name: '桌面验收群', kind: 'webhook', events: ['failure'], config: { url: 'https://hooks.example.invalid/rig' } })
  assert.equal(channel.channel.config.urlHost, 'hooks.example.invalid')
  assert.deepEqual(await ask('channel-delete', { id: channel.channel.id }), {})
  // A path the table does not list cannot be reached, whatever the renderer sends.
  const bad = await page.evaluate(() => window.mxRig.request('case-update', { app: '../members', caseId: 'x' }).then(() => null, (error) => error.message))
  assert.match(bad, /项目标识无效/)
  // Execution plans through the main process (docs/21 M3), and the old
  // console gone from the desktop: nothing opens the system browser.
  const made3 = await ask('plan-create', { app: 'm2-desk', suite: 'web-smoke', name: '桌面每晚冒烟', profile: 'mock', track: 'functional', targetUrl: 'http://127.0.0.1:4610', runsOn: 'any-runner', schedule: { kind: 'cron', cronExpr: '0 3 * * *' } })
  assert.equal(made3.task.scheduleKind, 'cron')
  const edited3 = await ask('plan-update', { id: made3.task.id, name: '桌面冒烟（手动）', schedule: { kind: 'manual' } })
  assert.deepEqual([edited3.task.name, edited3.task.scheduleKind], ['桌面冒烟（手动）', 'manual'])
  const ran3 = await ask('plan-run', { id: made3.task.id })
  assert.match(ran3.run.id, /^trun_/)
  assert.match(ran3.note, /执行机与工位/, 'the hint names the page by its current name')
  assert.deepEqual(await ask('plan-delete', { id: made3.task.id }), {})
  assert.equal(await page.locator('#console-link').isHidden(), true, 'no old-console entry on the desktop')
  const outward = await page.evaluate(() => window.mxRig.request('open-path', { path: '/test-center/' }).then(() => null, (error) => error.message))
  assert.match(outward, /只在应用内打开执行报告/)
  assert.equal((await ask('project-delete', { app: 'm2-desk', force: true })).deleted, 'm2-desk')
  // The run detail on the desktop (docs/21 M4): the timeline is polled as
  // JSON through the main process, and the recording plays through
  // rig-media:, which the main process answers with the member's token.
  // The full Chromium the browser smoke uses, headless: no second browser download.
  const clipBrowser = await chromium.launch({ channel: 'chromium' })
  const clip = await recordClip(clipBrowser, join(state, 'clip')).finally(() => clipBrowser.close())
  const runner = pretendRunner(server.origin, 'desktop-test-secret')
  await runner.call('POST', '/api/v1/apps', { body: { slug: 'm4-desk', displayName: 'M4 桌面', surfaces: ['web'], visibility: 'private' } })
  await runner.call('POST', '/api/v1/apps/m4-desk/suites', { body: { slug: 'web-smoke', displayName: 'Web 冒烟', engine: 'playwright', surface: 'web', runnerKind: 'local', targetMode: 'external', command: ['npx', 'playwright', 'test'] } })
  await runner.call('POST', '/api/v1/apps/m4-desk/catalog:sync', { body: smokeCatalog('m4-desk', 'web-smoke', 'M4-DK-AUTH') })
  const plan4 = (await runner.call('POST', '/api/v1/tasks', { body: { app: 'm4-desk', suite: 'web-smoke', name: '桌面登录冒烟', targetUrl: 'http://127.0.0.1:4610', runsOn: 'any-runner', schedule: { kind: 'manual' } } })).task
  const run4 = (await ask('plan-run', { id: plan4.id })).run.id
  await runner.clearQueue(run4)
  const machine4 = await runner.register('桌面冒烟测试机')
  const claim4 = await runner.claim()
  assert.equal(claim4.runId, run4)
  await openNav(page, '执行记录')
  await page.locator(`[data-run-open="${run4}"]`).click()
  await page.locator(`#run-detail[data-run="${run4}"]`).waitFor()
  await runner.events(run4, claim4.runToken, [
    { kind: 'stage', stage: 'execute', status: 'running' },
    { kind: 'case.started', caseId: 'M4-DK-AUTH-001', title: '有效账号登录' }
  ])
  await page.locator('#run-live [data-case="M4-DK-AUTH-001"]').waitFor()
  const clipPath = 'videos/M4-DK-AUTH-001.webm'
  await runner.upload(run4, claim4.runToken, clipPath, clip)
  await runner.complete(run4, claim4.runToken, twoCaseSummary(run4, 'm4-desk', { video: clipPath, passed: 'M4-DK-AUTH-001', failed: 'M4-DK-AUTH-002' }))
  await page.locator('#run-cases').waitFor()
  const passed4 = page.locator('details.rig-run-case[data-case="M4-DK-AUTH-001"]')
  await passed4.locator('summary').click()
  assert.match(await passed4.locator('video').getAttribute('src'), /^rig-media:\/\/run\//, 'the desktop page names the file, never the service')
  const player4 = await passed4.locator('video').elementHandle()
  await page.waitForFunction((node) => node.readyState >= 1, player4)
  await passed4.locator('[data-seek="0.90"]').click()
  await page.waitForFunction((node) => Math.abs(node.currentTime - 0.9) < 0.6, player4)
  await page.screenshot({ path: join(qa, 'desktop-run-detail.png') })
  // Anything but a run's recording or image is refused by the main process.
  const other = await page.evaluate(
    (id) =>
      new Promise((resolve) => {
        const image = document.createElement('img')
        image.onload = () => resolve('loaded')
        image.onerror = () => resolve('refused')
        image.src = `rig-media://run/${id}/summary.json`
      }),
    run4
  )
  assert.equal(other, 'refused')
  // Both reports open in the desktop's own window from the detail.
  const opened4 = desktop.waitForEvent('window')
  await page.locator('#run-report-redacted').click()
  const redacted4 = await opened4
  await redacted4.waitForLoadState('domcontentloaded')
  assert.match(await redacted4.title(), /测试报告/)
  await redacted4.close()
  // The 对外版 saved as a PDF; the save dialog answers with a file in the QA folder.
  const pdfPath = join(state, 'report-redacted.pdf')
  await desktop.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
  }, pdfPath)
  await page.locator('#run-report-save').click()
  await page.getByText('已保存对外版执行报告（PDF）', { exact: true }).waitFor()
  const pdf = await readFile(pdfPath)
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', 'a real PDF')
  assert.ok(pdf.length > 10_000, 'with the report in it')
  await page.locator('#run-back').click()
  await page.locator(`[data-run-open="${run4}"]`).waitFor()
  await runner.remove(machine4.id)
  // 演示一遍 (docs/24): 读懂一次执行 is read-only. Taken in 演示, a click of the
  // person's own pauses it and nothing moves until 继续; it stops at the step
  // the person presses, on this project's latest run.
  await openNav(page, '项目与任务')
  await page.locator('#test-project').selectOption('m4-desk')
  if (await page.locator('#hud').isHidden()) await page.locator('#hud-toggle').click()
  await page.locator('#hud [data-tour-start="read-a-run"]').click()
  const tour = page.locator('#tour')
  await page.locator('#tour[data-state="intro"]').waitFor({ state: 'attached' })
  assert.match(await tour.innerText(), /只读：不会新建或改动任何东西/)
  assert.doesNotMatch(await tour.innerText(), /null|undefined/, 'no empty slot printed as text')
  await page.locator('#tour [data-tour-action="demo"]').click()
  await page.locator('#tour[data-step="open"]').waitFor({ state: 'attached' })
  await page.locator('#view h2', { hasText: '被测项目' }).click()
  await page.locator('#tour[data-state="paused"]').waitFor({ state: 'attached' })
  assert.match(await tour.innerText(), /你接手了/)
  assert.doesNotMatch(await tour.innerText(), /null|undefined/)
  const pausedAt = await tour.getAttribute('data-step')
  await page.waitForTimeout(1500)
  assert.equal(await tour.getAttribute('data-step'), pausedAt, 'nothing moves while paused')
  await page.locator('#tour [data-tour-action="resume"]').click()
  await page.locator('#tour[data-state="final"][data-step="analyze"]').waitFor({ state: 'attached', timeout: 30_000 })
  assert.equal(await page.locator('#hud').isVisible(), false, 'the 系统 panel steps aside while a tour runs')
  assert.equal(await page.locator('#run-detail').getAttribute('data-run'), run4)
  await page.screenshot({ path: join(qa, 'desktop-tour-read.png') })
  await page.locator('#tour [data-tour-action="end"]').click()
  await tour.waitFor({ state: 'detached' })
  assert.equal(await page.locator('#hud').isVisible(), true, 'and comes back when it ends')
  // 演示录像 (docs/24 M8c): the recording plays through rig-media:, as run recordings do.
  await runner.call('PUT', '/api/rig/v1/tour-videos/read-a-run', { body: { version: '0.8.0', recordedAt: new Date().toISOString(), durationMs: 2100, video: clip.toString('base64') } })
  await openNav(page, '新手引导')
  assert.equal(await page.locator('[data-tour-video="read-a-run"] video').getAttribute('src'), 'rig-media://tour/read-a-run.webm')
  await page.waitForFunction(() => document.querySelector('[data-tour-video="read-a-run"] video')?.readyState >= 1, null, { timeout: 15_000 })
  // 从验收包创建 on the desktop (docs/21 M5): the source snapshot and the QA
  // repository are built here, from a repository that is only read, and the
  // plans are pinned to this computer's runner. A small repository stands in
  // for po-frontend; the Compass specs themselves are exercised by
  // tests/project-workspace.test.mjs and the end-to-end run in docs/21 §6.6.
  const source = join(state, 'compass-source')
  const sourceGit = (...args) =>
    execFileSync('git', ['-c', 'user.name=dev', '-c', 'user.email=dev@example.test', '-c', 'commit.gpgsign=false', ...args], {
      cwd: source,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }
    }).trim()
  await mkdir(join(source, 'po-frontend'), { recursive: true })
  sourceGit('init', '-q', '-b', 'feat/yjj/hdo_v2')
  await writeFile(join(source, 'po-frontend', 'package.json'), '{"name":"compass-fixture"}\n')
  sourceGit('add', '.')
  sourceGit('commit', '-q', '-m', 'fixture v1')
  const pinnedCommit = sourceGit('rev-parse', 'HEAD')
  await desktop.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
  }, join(source, 'po-frontend'))
  // The project is built by following its tour (docs/24) — the step list the
  // workbench walks a person through — with this script as the person: it
  // presses what the panel points at, answers the directory dialog, pins the
  // fixture's own commit, and leaves the runner for later in this smoke.
  const compassTour = TOURS.find((entry) => entry.id === 'compass-web-smoke')
  await page.locator('#hud [data-tour-start="compass-web-smoke"]').click()
  await page.locator('#tour[data-state="intro"]').waitFor({ state: 'attached' })
  assert.match(await page.locator('#tour').innerText(), /会新建（已有的直接沿用/)
  await page.locator('#tour [data-tour-action="follow"]').click()
  for (const [index, step] of compassTour.steps.entries()) {
    // Steps already done go by on their own; the others wait for the person.
    await page.waitForFunction((i) => Number(document.querySelector('#tour')?.dataset.index) >= i, index, { timeout: 120_000 })
    if (Number(await page.locator('#tour').getAttribute('data-index')) !== index) continue
    if (step.action === 'final') break
    if (step.id === 'runner') {
      await page.locator('#tour [data-tour-action="skip"]').click()
      continue
    }
    if (step.id === 'commit') await page.locator(step.target).fill(pinnedCommit)
    if (step.action === 'look') await page.locator('#tour [data-tour-action="next"]').click()
    else if (step.action === 'select') await page.locator(step.target).selectOption(step.value)
    else await page.locator(step.target).click()
  }
  await page.locator('#tour[data-state="final"][data-step="run"]').waitFor({ state: 'attached', timeout: 60_000 })
  // What is pointed at is on screen: the page's own redraws do not scroll it away.
  await page.waitForFunction((selector) => {
    const box = document.querySelector(selector)?.getBoundingClientRect()
    return Boolean(box) && box.top >= 0 && box.bottom <= window.innerHeight
  }, compassTour.steps.at(-1).target, { timeout: 5_000 })
  const smokePlan = (await runner.call('GET', '/api/v1/tasks?app=luopan')).tasks.find((plan) => plan.name === '罗盘 Web · 主路径冒烟')
  assert.equal(await page.locator(compassTour.steps.at(-1).target).getAttribute('data-plan-run-now'), smokePlan.id, 'it points at 立即执行 of the smoke plan')
  assert.equal(smokePlan.lastRunId ?? null, null, 'and stops there: the real flow is the person\'s')
  assert.equal((await ask('runner-status')).running, false, 'a skipped step is not done behind the person\'s back')
  await page.screenshot({ path: join(qa, 'desktop-tour-compass.png') })
  await page.locator('#tour [data-tour-action="end"]').click()
  await page.locator('#tour').waitFor({ state: 'detached' })
  // Followed to its last step: 「跟着演示亲手走一遍」 can be claimed (界面上报).
  const followQuest = (await ask('system')).system.quests.find((quest) => quest.id === 'follow-a-tour')
  assert.equal(followQuest.status, 'claimable')
  assert.equal(followQuest.evidence, 'signal')
  await page.locator('#hud-toggle').click()
  const facts = page.locator('#workspace-facts')
  await facts.waitFor()
  assert.match(await facts.innerText(), new RegExp(`feat/yjj/hdo_v2@${pinnedCommit.slice(0, 7)}`))
  assert.match(await facts.innerText(), /初始：验收包 compass/)
  assert.equal(await page.locator('#workspace-behind').innerText(), '与固定的提交一致')
  const pinnedPlans = (await runner.call('GET', '/api/v1/tasks?app=luopan')).tasks
  assert.equal(pinnedPlans.length, 2)
  const localRunner = await page.evaluate(() => window.mxRig.request('runner-status'))
  assert.ok(pinnedPlans.every((plan) => plan.runsOn === 'pinned-runner' && plan.runnerId === localRunner.runnerId), 'pinned to this computer')
  await facts.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(qa, 'desktop-pack-workspace.png') })
  // The source moves on; the baseline is updated on purpose, and the old snapshot stays.
  await writeFile(join(source, 'po-frontend', 'package.json'), '{"name":"compass-fixture","version":"2"}\n')
  sourceGit('commit', '-qam', 'fixture v2')
  const nextCommit = sourceGit('rev-parse', 'HEAD')
  await page.locator('#refresh').click()
  await page.locator('#workspace-behind').filter({ hasText: '已前进 1 个提交' }).waitFor()
  await page.locator('#workspace-rebase').click()
  assert.equal(await page.locator('#workspace-rebase-commit').inputValue(), nextCommit, 'the branch tip is offered')
  await page.locator('#workspace-rebase-form button[type=submit]').click()
  await page.getByText('基准已更新到', { exact: false }).waitFor({ timeout: 60_000 })
  await facts.filter({ hasText: `@${nextCommit.slice(0, 7)}` }).waitFor()
  assert.match(await facts.innerText(), /2 个（旧快照和旧测试都保留/)
  assert.match(await facts.innerText(), /更新基准：/)
  assert.equal(sourceGit('status', '--porcelain'), '', "the source repository's working tree is as the developer left it")
  // 上线检查 (docs/23 M7c): the branch moved again; one click pins its tip and
  // runs the plan covering every case, opened in place.
  await writeFile(join(source, 'po-frontend', 'package.json'), '{"name":"compass-fixture","version":"3"}\n')
  sourceGit('commit', '-qam', 'fixture v3')
  const releaseCommit = sourceGit('rev-parse', 'HEAD')
  await page.locator('#refresh').click()
  await page.locator('#workspace-behind').filter({ hasText: '已前进 1 个提交' }).waitFor()
  await page.locator('#workspace-release-check').click()
  await page.getByText('上线检查已开始', { exact: false }).waitFor({ timeout: 60_000 })
  const releaseRunId = await page.locator('#run-detail').getAttribute('data-run')
  const releaseRun = (await runner.call('GET', `/api/v1/runs/${releaseRunId}`)).run
  assert.equal(releaseRun.caseFilter ?? null, null, 'every case')
  assert.equal(releaseRun.taskId, pinnedPlans.find((plan) => !plan.caseFilter).id)
  assert.equal((await ask('workspace-status', { app: 'luopan' })).snapshot.commit, releaseCommit, 'the baseline is the branch tip')
  // Nothing here runs the Compass specs: the run is cancelled before any runner claims it.
  await runner.call('POST', `/api/v1/runs/${releaseRunId}:cancel`, { body: {} })
  await page.locator('#run-back').click()
  // 测试仓库 (docs/23 M7): an approved implementation is written to the
  // project's own repository, that commit is run on this computer, and once a
  // run has passed it goes to main and is published for other computers.
  await runner.call('POST', '/api/v1/apps', { body: { slug: 'm7-desk', displayName: 'M7 测试仓库', surfaces: ['web'], visibility: 'private' } })
  const { mission: repoTask } = await ask('test-task-create', { app: 'm7-desk', goal: 'M7 物资详情验收' })
  await ask('task-cases-save', { id: repoTask.id, expectedRevision: 0, cases: [{ caseId: 'M7-WEB-ITEM-001', title: '无负责人显示未分配', steps: '打开 3 号物资', expected: '负责人：未分配', platforms: ['web'] }] })
  await ask('task-cases-confirm', { id: repoTask.id, expectedRevision: 1 })
  const repoDraft = await ask('task-implementation-save', {
    id: repoTask.id,
    expectedVersion: 0,
    caseRevision: 1,
    proposal: {
      summary: '物资详情：无负责人',
      engine: 'playwright',
      platform: 'web',
      files: [{ path: 'tests/items.spec.ts', content: "import { test, expect } from '@playwright/test'\ntest('M7-WEB-ITEM-001 无负责人显示未分配', async ({ page }) => {\n  await page.goto('/items/3')\n  await expect(page.getByText('负责人：未分配')).toBeVisible()\n})\n" }],
      mappings: [{ caseId: 'M7-WEB-ITEM-001', path: 'tests/items.spec.ts', assertion: '出现「负责人：未分配」' }]
    }
  })
  await ask('task-implementation-approve', { id: repoTask.id, expectedVersion: 1, hash: repoDraft.proposal.hash })
  await openNav(page, '项目与任务')
  await page.locator('#test-project').selectOption('m7-desk')
  await page.locator('.rig-project-tabs [role=tab]', { hasText: '测试任务' }).click()
  await page.locator('#refresh').click()
  await page.getByRole('button', { name: 'M7 物资详情验收', exact: true }).click()
  await page.locator('.rig-test-tabs [role=tab]', { hasText: '执行与结果' }).click()
  await page.locator('#repository-commit').click()
  await page.getByText('已写入 task/', { exact: false }).waitFor()
  await page.locator('#repository-target').fill('http://127.0.0.1:4610')
  await page.locator('#repository-plan-form button[type=submit]').click()
  await page.getByText('指定在本机执行机上跑', { exact: false }).waitFor()
  await page.locator('#repository-run').click()
  await page.getByText('测试仓库：task/', { exact: false }).waitFor()
  await page.getByRole('button', { name: '按此范围开始执行', exact: true }).click()
  // This computer's runner: the plan is pinned to it. Its token is in the profile.
  const workspacesDir = join(state, 'profile', 'workspaces')
  let runnerConfig = null
  for (const entry of await readdir(workspacesDir)) {
    runnerConfig = await readFile(join(workspacesDir, entry, 'runner', 'runner.json'), 'utf8').then(JSON.parse, () => null)
    if (runnerConfig) break
  }
  const repoClaim = await (await fetch(server.origin + '/runner/v1/runs:claim', { method: 'POST', headers: { authorization: `Bearer ${runnerConfig.runnerToken}`, 'content-type': 'application/json' }, body: '{}' })).json()
  assert.match(repoClaim.app.repoUrl, /^rig-workspace:\/\/m7-desk\/qa$/)
  assert.match(repoClaim.sourceRef, /^[a-f0-9]{40}$/, 'the run checks out the exact commit')
  const repoCommit = repoClaim.sourceRef
  const repoDone = await (await fetch(`${server.origin}/runner/v1/runs/${repoClaim.runId}:complete`, {
    method: 'POST',
    headers: { authorization: `Bearer ${repoClaim.runToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ exitCode: 0, summary: { schemaVersion: 2, runId: repoClaim.runId, app: 'm7-desk', status: 'passed', totals: { tests: 1, passed: 1 }, cases: [{ caseId: 'M7-WEB-ITEM-001', spec: 'tests/items.spec.ts', status: 'passed', durationMs: 900 }], sourceRef: { ref: repoCommit, gitSha: repoCommit, version: `QA ${repoCommit.slice(0, 7)}` } } })
  })).json()
  assert.equal(repoDone.run.status, 'passed')
  await page.locator('#refresh').click()
  await page.locator('#task-repository-facts [data-verification="verified"]').waitFor()
  await page.locator('#repository-merge').click()
  await page.locator('#notice', { hasText: '已合入本机主线' }).waitFor()
  await page.locator('#repository-publish').click()
  await page.locator('#notice', { hasText: '已发布为服务器版本 v1' }).waitFor()
  await page.screenshot({ path: join(qa, 'desktop-repository-task.png') })
  // The project's plans page: branches, what is published, the service's versions.
  await page.locator('.rig-project-tabs [role=tab]', { hasText: '执行计划' }).click()
  await page.locator('#test-versions li[data-version="1"]').waitFor()
  assert.match(await page.locator('#repository-branches li[data-branch="main"]').innerText(), /已发布/)
  // The notice shows before the page is drawn again: wait for the new panel.
  await page.locator('#repository-facts').evaluate((node) => (node.dataset.before = '1'))
  await page.locator('#repository-pull').click()
  await page.getByText('本机已经是服务器最新版本', { exact: true }).waitFor()
  await page.locator('#repository-facts:not([data-before])').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(qa, 'desktop-repository.png') })
  const qaDir = join(workspacesDir, (await readdir(workspacesDir))[0], 'project-workspaces', 'm7-desk', 'qa')
  const qaGit = (...args) => execFileSync('git', args, { cwd: qaDir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
  assert.equal(qaGit('rev-parse', 'main'), repoCommit)
  assert.equal(qaGit('rev-parse', 'rig/v1'), repoCommit)
  assert.equal(qaGit('show', 'main:.rig/cases/M7-WEB-ITEM-001.json').includes('tests/items.spec.ts'), true)
  // 新项目 (docs/24 M8b), followed with this script as the person: register the
  // proving ground, write one case, provide and approve its implementation,
  // write it to the test repository, start the proving ground, build the plan.
  // Fields are left to 替我做这一步; the runner is left for later; it stops at
  // the run, which nobody presses here.
  const newProject = TOURS.find((entry) => entry.id === 'new-project')
  await openNav(page, '新手引导')
  await page.locator('[data-tour-card="new-project"] [data-tour-start]').click()
  await page.locator('#tour[data-state="intro"]').waitFor({ state: 'attached' })
  assert.match(await page.locator('#tour').innerText(), /在本机启动内置试验场/)
  await page.locator('#tour [data-tour-action="follow"]').click()
  for (const [index, step] of newProject.steps.entries()) {
    await page.waitForFunction((i) => Number(document.querySelector('#tour')?.dataset.index) >= i, index, { timeout: 120_000 })
    if (Number(await page.locator('#tour').getAttribute('data-index')) !== index) continue
    if (step.action === 'final') break
    if (step.id === 'runner') {
      await page.locator('#tour [data-tour-action="skip"]').click()
      continue
    }
    if (step.action === 'fill') await page.locator('#tour [data-tour-action="do"]').click()
    else if (step.action === 'look') await page.locator('#tour [data-tour-action="next"]').click()
    else if (step.action === 'select') await page.locator(step.target).selectOption(step.value)
    else await page.locator(step.target).click()
  }
  await page.locator('#tour[data-state="final"][data-step="run"]').waitFor({ state: 'attached', timeout: 60_000 })
  await page.waitForFunction(() => {
    const box = document.querySelector('#repository-run')?.getBoundingClientRect()
    return Boolean(box) && box.top >= 0 && box.bottom <= window.innerHeight
  }, null, { timeout: 5_000 })
  await page.screenshot({ path: join(qa, 'desktop-tour-new-project.png') })
  const groundPlans = (await runner.call('GET', '/api/v1/tasks?app=proving-ground')).tasks
  assert.equal(groundPlans.length, 1)
  const ground = await ask('proving-ground-status')
  assert.equal(ground.running, true)
  assert.equal(groundPlans[0].targetUrl, ground.origin, 'the plan tests the proving ground this computer started')
  assert.equal(groundPlans[0].lastRunId ?? null, null, 'and nothing ran: the run is the person\u2019s to press')
  assert.match(await (await fetch(ground.origin)).text(), /星港物资台/)
  const groundApp = (await runner.call('GET', '/api/v1/apps')).apps.find((entry) => entry.slug === 'proving-ground')
  assert.match(groundApp.sourceDirectory, /test-packs[\\/]proving-ground$/)
  await page.locator('#tour [data-tour-action="end"]').click()
  await page.locator('#tour').waitFor({ state: 'detached' })
  // A deployment from before browser testing was a default: one click.
  // A deployment from before browser testing was a default: one click.
  await server.settings.update({
    ...server.settings.value,
    allowedTools: server.settings.value.allowedTools.filter((name) => !name.startsWith('browser_') && name !== 'electron_launch')
  })
  await openNav(page, 'Internal 配置')
  await page.locator('#model-key-env').waitFor({ state: 'visible' })
  assert.equal(await page.locator('#model-key-env').inputValue(), 'MX_RIG_MODEL_API_KEY')
  assert.ok(await page.locator('#browser-sites-ask').isChecked(), 'sites nobody listed are asked about, out of the box')
  await page.locator('#enable-browser').click()
  await page.locator('#save-settings').click()
  await page.waitForFunction(() => !document.querySelector('#enable-browser'))
  assert.ok(server.settings.value.allowedTools.includes('browser_open'), 'browser testing turned on in one click')
  assert.equal(server.settings.value.browserSites, 'ask')
  if (process.argv.includes('--browser')) {
    await server.settings.update({
      ...server.settings.value,
      allowedTools: ['browser_open', 'browser_snapshot', 'browser_fill', 'browser_click', 'browser_assert', 'browser_handoff'],
      browserOrigins: [siteOrigin],
      providers: [
        {
          id: 'primary',
          displayName: '替身模型',
          baseUrl: 'https://fixture.invalid/v1',
          model: 'fixture',
          apiKeyEnv: 'MX_RIG_MODEL_API_KEY',
          timeoutMs: 60_000,
          enabled: true
        }
      ],
      sequence: ['primary']
    })
    await newAgentTask(page)
    await page.locator('#mode').waitFor({ state: 'visible' })
    await page.locator('#mode').selectOption('agent')
    await page.locator('#goal').fill('验收：把昵称改成 Rig 并保存，确认页面提示「已保存」')
    await page.locator('#start').click()
    // Each page action is confirmed; between them the browser tab shows the
    // page live, with the Agent's cursor on it.
    let sawLive = false
    for (let approvals = 0; approvals < 3; approvals += 1) {
      await page.locator('#approval').waitFor({ state: 'visible', timeout: 30_000 })
      if (approvals > 0 && !sawLive) {
        await page.waitForFunction(
          () => document.querySelector('.rig-live__image')?.src?.startsWith('data:image/jpeg'),
          null,
          { timeout: 15_000 }
        )
        sawLive = true
        await page.screenshot({ path: join(qa, 'desktop-live.png') })
        // Elsewhere in the app, the hand stays in sight: a small window in
        // the corner, which leads back to the mission's browser tab.
        await page.getByRole('button', { name: '确认执行', exact: true }).click()
        await openNav(page, '总览')
        await page.locator('.rig-pip').waitFor({ state: 'visible', timeout: 15_000 })
        await page.screenshot({ path: join(qa, 'desktop-pip.png') })
        await page.locator('.rig-pip').click()
        await page.locator('#mission-tab-browser.is-active').waitFor()
        continue
      }
      await page.getByRole('button', { name: '确认执行', exact: true }).click()
    }
    await page.waitForFunction(
      () => document.querySelector('#mission-status')?.textContent === '任务完成',
      null,
      { timeout: 30_000 }
    )
    assert.ok(sawLive, 'the live pane showed the page while the Agent worked')
    // The work, folded: one group of browser steps with a thumbnail each.
    const summaries = await page.locator('.rig-work__text').allTextContents()
    assert.ok(summaries.some((text) => /打开了 1 个页面/.test(text)), summaries.join(' | '))
    assert.ok(summaries.some((text) => /填写 1 处/.test(text) && /点击 1 次/.test(text)), summaries.join(' | '))
    assert.ok(summaries.some((text) => /断言 1 条/.test(text)), summaries.join(' | '))
    await page.locator('.rig-work summary').last().click()
    await page.locator('.rig-thumb img[src^="data:image/png"]').first().waitFor({ timeout: 15_000 })
    assert.ok((await page.locator('.rig-thumb').count()) >= 4)
    await page.locator('.rig-thumb').first().click()
    await page.locator('.rig-lightbox__image[src^="data:image/png"]').waitFor()
    await page.screenshot({ path: join(qa, 'desktop-lightbox.png') })
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('.rig-lightbox').count(), 0)
    // Afterwards the browser tab replays the steps, the hand moving between them.
    await page.locator('#mission-tab-browser').click()
    await page.locator('.rig-replay').waitFor()
    assert.equal(await page.locator('.rig-replay__step').count(), 4)
    await page.getByRole('button', { name: '播放回放', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.rig-replay__counter')?.textContent === '3 / 4', null, {
      timeout: 20_000
    })
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(qa, 'desktop-replay.png') })
    // A gateway that never streamed must leave no draft behind either.
    assert.equal(await page.locator('.rig-stream').count(), 0)
    console.log(
      'Agent → approved browser steps with a visible cursor → live pane → folded steps with thumbnails → lightbox → replay passed (fixture model).'
    )

    // Takeover in the live pane: the Agent asks for the password; the
    // person clicks into the frame, types it, and hands the page back.
    await newAgentTask(page)
    await page.locator('#mode').waitFor({ state: 'visible' })
    await page.locator('#mode').selectOption('agent')
    await page.locator('#goal').fill('验收：用测试账号登录（密码由人来输入），确认欢迎语')
    await page.locator('#start').click()
    await page.locator('#approval').waitFor({ state: 'visible', timeout: 30_000 })
    // A site nobody listed: the same yes opens it and lets this mission use it.
    assert.match(await page.locator('#approval-site').innerText(), new RegExp(`${unlistedOrigin} 是这项任务第一次去的站点`))
    await page.screenshot({ path: join(qa, 'desktop-site.png') })
    await page.getByRole('button', { name: '确认执行', exact: true }).click()
    await page.locator('#handback').waitFor({ timeout: 30_000 }).catch(async (error) => {
      await page.screenshot({ path: join(qa, 'desktop-takeover-failed.png') })
      throw error
    })
    await page.waitForFunction(() => document.querySelector('.rig-live__image')?.src?.startsWith('data:image/jpeg'))
    assert.match(await page.locator('.rig-takeover__banner').innerText(), /Agent 请你来操作[\s\S]*在密码框里输入测试账号的密码并点登录/)
    const stage = await page.locator('.rig-live__stage').boundingBox()
    const at = (x, y) => [stage.x + (x / 1280) * stage.width, stage.y + (y / 720) * stage.height]
    await page.mouse.click(...at(250, 226))
    await page.keyboard.type(PASSWORD)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1200)
    await page.screenshot({ path: join(qa, 'desktop-takeover.png') })
    // The page asks「确定…？」: the live frame cannot show a browser dialog,
    // so the pane does, and the person answers there.
    await page.mouse.click(...at(160, 398))
    await page.locator('#dialog-accept').waitFor({ timeout: 15_000 })
    assert.match(await page.locator('.rig-takeover__dialog').innerText(), /页面要你确认[\s\S]*确定清除登录记录？/)
    await page.screenshot({ path: join(qa, 'desktop-dialog.png') })
    await page.locator('#dialog-accept').click()
    await page.locator('.rig-takeover__dialog').waitFor({ state: 'detached' })
    await page.locator('#handback-note').fill('已经登录了，接着检查欢迎语')
    await page.locator('#handback').click()
    await page.waitForFunction(
      () => document.querySelector('#mission-status')?.textContent === '任务完成',
      null,
      { timeout: 30_000 }
    )
    const manual = await page.locator('.rig-act--manual').innerText()
    assert.match(manual, /人工操作结束，已交还给 Agent：点击 2 次、输入 1 段文字、按键 1 次、回答了 1 个对话框；补充说明：已经登录了/)
    assert.match(await page.locator('#timeline').innerText(), new RegExp(`本任务可以访问 ${unlistedOrigin}（发起人确认）`))
    assert.match(await page.locator('#timeline').innerText(), /欢迎回来，tester/)
    const { missions } = await page.evaluate(() => window.mxRig.request('missions'))
    assert.ok(!JSON.stringify(missions).includes(PASSWORD), 'the password is on the page and nowhere else')
    await page.screenshot({ path: join(qa, 'desktop-takeover-done.png') })
    console.log('Agent asks for the password → person types it in the live pane → hands back with a note → mission completes; the password is recorded nowhere.')
  }
  // The system layer across the desktop's whitelisted IPC. The renderer can
  // never name a path, so every new action has to exist in the main process
  // table — a missing one shows up here and nowhere else.
  await openNav(page, '系统')
  await page.locator('.rig-level').waitFor({ state: 'visible' })
  // Logging in on the desktop is itself a reported side quest.
  await page
    .locator('.rig-quest[data-status="claimable"]', { hasText: '在桌面端登录一次' })
    .waitFor({ state: 'visible' })
  await page.locator('#hud-toggle').click()
  await page.locator('#hud .rig-quest').waitFor({ state: 'visible' })
  await page.screenshot({ path: join(qa, 'desktop-system.png') })
  await page.locator('#hud').getByRole('button', { name: '收起', exact: true }).click()
  const parsed = await page.evaluate(() =>
    window.mxRig.request('plan-dispatch', { text: '跑一下桌面验收计划' })
  )
  assert.equal(parsed.plan.proposals[0].kind, 'workflow')
  assert.ok(parsed.plan.proposals[0].body.taskId, '桌面端解析要拿到真实计划 ID')

  // This computer on duty as a station: Electron runs `mx-rig station watch`
  // as Node, with its own headless browser, and stops it politely.
  await openNav(page, '试验规程')
  await page.getByRole('heading', { name: '定时回归' }).waitFor()
  await page.locator('#station-register').click()
  await page.locator('#station-start').click()
  await page.locator('#station-stop').waitFor()
  const duty = await page.evaluate(() => window.mxRig.request('station-status'))
  assert.equal(duty.running, true)
  assert.deepEqual([duty.engines, duty.surfaces], [['rig-procedure'], ['web']])
  const regression = await page.evaluate(() => window.mxRig.request('procedure-tasks'))
  assert.deepEqual(regression.stations.map((entry) => entry.kind), ['local'])
  await page.screenshot({ path: join(qa, 'desktop-station.png') })
  await page.locator('#station-stop').click()
  await page.locator('#station-start').waitFor()
  const stopped = await page.evaluate(() => window.mxRig.request('station-status'))
  assert.equal(stopped.exited?.code, 0, stopped.log.join('\n'))
  await page.getByRole('button', { name: '注销工位', exact: true }).click()
  await page.locator('#station-register').waitFor()

  await page.locator('#logout').click()
  await page.locator('#login').waitFor({ state: 'visible' })
  // The address and account that worked are offered next time; the password is not kept.
  const remembered = JSON.parse(await readFile(join(state, 'profile', 'login.json'), 'utf8'))
  assert.deepEqual(remembered, { server: server.origin, privateHttp: false, account: 'admin' })
  assert.deepEqual(errors, [])
  // Launcher mode (docs/25 §3): the same app started as Launcher's standalone
  // product mx-rig, against a stand-in entrance that knows no mx-rig. The login
  // page puts the network first and waits for it; 连接内网 goes as far as asking
  // for the product network and says what the administrator must register.
  // Nothing is installed here: the stand-in never hands out a product.
  await desktop.close()
  desktop = null
  const entrance = createServer((req, res) => {
    const healthy = req.url.startsWith('/healthz')
    res.writeHead(healthy ? 200 : 404, { 'content-type': 'application/json' })
    res.end(healthy ? '{"ok":true}' : '{"message":"product not found"}')
  })
  await new Promise((resolve) => entrance.listen(0, '127.0.0.1', resolve))
  try {
    desktop = await _electron.launch({
      ...launch,
      env: {
        ...env,
        MX_RIG_LAUNCHER: '1',
        MX_RIG_BOOTSTRAP_URLS: `http://127.0.0.1:${entrance.address().port}`,
        MX_RIG_USER_DATA_DIR: join(state, 'launcher-profile'),
        // Updates as an installed copy would have them (docs/25 P2).
        MX_RIG_UPDATE_DISTRIBUTION: 'installed'
      },
      timeout: 30_000
    })
    const launched = await desktop.firstWindow()
    launched.setDefaultTimeout(15_000)
    await launched.locator('#network-panel').waitFor({ state: 'visible' })
    assert.equal(await launched.locator('#server-field').isVisible(), false, 'no address to type: the service is behind the product VIP')
    assert.equal(await launched.locator('#network-first').isVisible(), true, 'the first connection says what it installs')
    assert.equal(await launched.locator('#login-form button[type=submit]').isDisabled(), true, 'signing in waits for the network')
    await launched.locator('#network-connect').click()
    await launched.locator('#network-message', { hasText: 'scripts/manage.sh launcher plan' }).waitFor()
    assert.equal(await launched.locator('#network-status').getAttribute('data-status'), 'error')
    // Updates (docs/25 P2) come from Release Center behind the product VIP:
    // the version is shown, and 检查更新 without the network says so, with the
    // install ID a targeted plan is made for. Nothing reaches the page but text.
    const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    await launched.locator('#update-version', { hasText: version }).waitFor()
    assert.equal(await launched.locator('#update-banner').isVisible(), false, 'no card before there is something to say')
    await launched.locator('#update-check').click()
    await launched.locator('#update-text', { hasText: '连上内网后才能检查更新' }).waitFor()
    assert.match(await launched.locator('#update-install-id').textContent(), /^安装 ID：[0-9a-f-]{36}/)
    assert.equal(await launched.locator('#update-download').isVisible(), false)
    assert.equal(await launched.locator('#update-install').isVisible(), false)
    await launched.screenshot({ path: join(qa, 'desktop-launcher-login.png') })
    await launched.locator('#update-close').click()
    assert.equal(await launched.locator('#update-banner').isVisible(), false)
    // The overseas channel (docs/25 P3) follows the account's network: without
    // a unified sign-in it waits, remembers that it was asked for, and turns off.
    const overseaOff = await launched.evaluate(() => window.mxRig.request('oversea-status'))
    assert.deepEqual([overseaOff.state, overseaOff.enabled, overseaOff.usingBrowser], ['off', false, false])
    const overseaWaiting = await launched.evaluate(() => window.mxRig.request('oversea-start'))
    assert.deepEqual([overseaWaiting.state, overseaWaiting.enabled], ['unavailable', true])
    assert.match(overseaWaiting.text, /统一账号登录/)
    assert.equal((await launched.evaluate(() => window.mxRig.request('oversea-stop'))).state, 'off')
  } finally {
    entrance.close()
  }
  console.log(
    'Desktop smoke passed: login, isolated renderer, runtime worker, exact approval, real test API dispatch, settings, the system layer over whitelisted IPC, one-line dispatch parsing, station duty (register, watch, polite stop, unregister), the in-app report window, accounts and machines over the main process, the run detail (live timeline over JSON, a recording played and seeked through rig-media:, the 对外版 saved as PDF), the read-only tour in 演示 (taken over, resumed, stopped at the step the person presses) and its published recording playing through rig-media:, a project from the Compass pack built by following its tour (which then counts in 系统) with its snapshot, QA repository and pinned plans (baseline updated, old snapshot kept, a release check pinning the branch tip and running every case), the test repository (an approved implementation written, its commit run, verified, merged and published as v1), a new project on the proving ground by following its tour up to the run, logout, and Launcher mode (the network first, an unregistered product explained, updates waiting for the network, the overseas channel waiting for a unified sign-in).'
  )
} catch (error) {
  console.error(error)
  throw error
} finally {
  if (previousDefaults === null) await rm(defaultsFile, { force: true })
  else await writeFile(defaultsFile, previousDefaults)
  if (desktop) {
    const child = desktop.process()
    let timer
    try {
      await Promise.race([
        desktop.close(),
        new Promise((r) => {
          timer = setTimeout(() => {
            child.kill()
            r()
          }, 5000)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  await server.close()
  site.close()
}
