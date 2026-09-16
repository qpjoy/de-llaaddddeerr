import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { start } from '../apps/server/index.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const qa = resolve(root, '.runtime/qa')
await mkdir(qa, { recursive: true })
const state = await mkdtemp(join(qa, 'desktop-'))
let modelCalls = 0
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
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message:
                  modelCalls++ === 0
                    ? {
                        content: null,
                        tool_calls: [
                          {
                            id: 'browser-call',
                            type: 'function',
                            function: {
                              name: 'browser_open',
                              arguments: JSON.stringify({ url: server.origin + '/rig/' })
                            }
                          }
                        ]
                      }
                    : { content: '已观察到隔离浏览器页面。此答复来自验收用模型替身。' }
              }
            ]
          })
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
  await page.locator('#server').fill(server.origin)
  await page.locator('#account').fill('admin')
  await page.locator('#password').fill('desktop-test-secret')
  await page.locator('#login-form button').click()
  console.log('Submitted native login')
  await page.locator('#workspace').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '任务工作台', exact: false }).click()
  await page.locator('#mode').waitFor({ state: 'visible' })
  assert.equal(await page.evaluate(() => window.mxRig.desktop), true)
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
  await page.getByRole('button', { name: 'Internal 配置', exact: false }).click()
  await page.locator('#model-key-env').waitFor({ state: 'visible' })
  assert.equal(await page.locator('#model-key-env').inputValue(), 'MX_RIG_MODEL_API_KEY')
  if (process.argv.includes('--browser')) {
    await server.settings.update({
      ...server.settings.value,
      allowedTools: ['browser_open', 'browser_snapshot'],
      browserOrigins: [server.origin],
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
    await page.locator('#goal').fill('验收：通过模型工具调用打开隔离浏览器')
    await page.locator('#start').click()
    await page.locator('#approval').waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '确认执行', exact: true }).click()
    await page.waitForFunction(
      () => document.querySelector('#mission-status')?.textContent === '任务完成'
    )
    assert.equal(await page.getByRole('button', { name: '打开截图', exact: true }).count(), 1)
    // A gateway that never streamed must leave no draft behind either.
    assert.equal(await page.locator('.rig-stream').count(), 0)
    await page.screenshot({ path: join(qa, 'desktop-browser-agent.png') })
    console.log(
      'Packaged agent → approved tool → real browser → evidence loop passed (fixture model).'
    )
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

  await page.locator('#logout').click()
  await page.locator('#login').waitFor({ state: 'visible' })
  assert.deepEqual(errors, [])
  console.log(
    'Desktop smoke passed: login, isolated renderer, runtime worker, exact approval, real test API dispatch, settings, the system layer over whitelisted IPC, one-line dispatch parsing, logout.'
  )
} catch (error) {
  console.error(error)
  throw error
} finally {
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
}
