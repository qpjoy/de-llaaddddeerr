import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { start } from '../apps/server/index.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const qa = resolve(root, '.runtime/qa')
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
  await page.locator('#login-form button').click()
  console.log('Submitted native login')
  await page.locator('#workspace').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '任务工作台', exact: false }).click()
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
  // A deployment from before browser testing was a default: one click.
  await server.settings.update({
    ...server.settings.value,
    allowedTools: server.settings.value.allowedTools.filter((name) => !name.startsWith('browser_') && name !== 'electron_launch')
  })
  await page.getByRole('button', { name: 'Internal 配置', exact: false }).click()
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
    await page.locator('#new-mission').click()
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
        await page.locator('.rig-nav__item', { hasText: '总览' }).click()
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
    await page.locator('#new-mission').click()
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
  await page.locator('.rig-nav__item', { hasText: '系统' }).click()
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
  await page.locator('.rig-nav__item', { hasText: '试验规程' }).click()
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
  console.log(
    'Desktop smoke passed: login, isolated renderer, runtime worker, exact approval, real test API dispatch, settings, the system layer over whitelisted IPC, one-line dispatch parsing, station duty (register, watch, polite stop, unregister), logout.'
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
