import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { BrowserTools } from '../packages/runtime/browser.mjs'
import { start } from '../apps/server/index.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const qa = resolve(root, '.runtime/qa')
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
  assert.match(opened.text, /准备就绪/)
  await tools.execute('browser_fill', { label: '项目名称', value: 'MX Rig' }, context)
  await assert.rejects(
    tools.execute('browser_fill', { label: '密码', value: 'never-fill' }, context),
    { code: 'sensitive_field' }
  )
  const result = await tools.execute('browser_click', { role: 'button', name: '保存' }, context)
  assert.match(result.text, /操作完成/)
  assert.ok((await stat(join(state, 'artifacts', result.screenshot))).size > 0)
  await assert.rejects(tools.execute('browser_open', { url: 'http://localhost:1' }, context), {
    code: 'origin_denied'
  })
  await tools.close()
  server = await start(
    {
      MX_RIG_ADMIN_TOKEN: 'web-test-secret',
      MX_RIG_PORT: '0',
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: join(state, 'control'),
      MX_RIG_ARTIFACTS_DIR: join(state, 'test-artifacts')
    },
    { schedule: false }
  )
  browser = await chromium.launch({ headless: false })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(server.origin + '/rig/')
  await page.locator('#account').fill('admin')
  await page.locator('#password').fill('web-test-secret')
  await page.locator('#login-form button').click()
  await page.locator('#workspace').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '任务工作台', exact: false }).click()
  await page.locator('#goal').fill('检查未配置模型的明确失败状态')
  await page.locator('#start').click()
  await page.waitForFunction(
    () => document.querySelector('#mission-status')?.textContent === '受阻'
  )
  await page.getByRole('button', { name: 'Internal 配置', exact: false }).click()
  await page.locator('#max-turns').fill('8')
  await page.locator('#save-settings').click()
  await page.getByText('已保存').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '工具与边界', exact: false }).click()
  await page.locator('.rig-table[data-layout="tools"]').first().waitFor({ state: 'visible' })
  await page.screenshot({ path: join(qa, 'web-tools.png') })
  await page.getByRole('button', { name: 'Agent 市场', exact: false }).click()
  await page.getByText('结果分析师', { exact: true }).waitFor({ state: 'visible' })
  await page.screenshot({ path: join(qa, 'web-agents.png') })
  // The quality report, and the lens switcher that reorders it. The switcher
  // sits inside a wrapper on purpose; a regression there collapses it to a
  // 2px sliver that still passes a visibility check but cannot be clicked.
  await page.locator('.rig-nav__item', { hasText: '质量报告' }).click()
  await page.locator('.rig-trend, .rig-empty').first().waitFor({ state: 'visible' })
  const lens = page.locator('.rig-nav__lens .qp-segmented')
  assert.ok(
    (await lens.evaluate((el) => el.getBoundingClientRect().height)) > 24,
    'the lens switcher must not collapse'
  )
  const metrics = await page.locator('.qp-metric__value').allTextContents()
  assert.equal(metrics.length, 4)
  // Nothing ran in this fixture, so every rate must read "—", never 0% or 100%.
  assert.equal(metrics[0], '—')
  await page.getByRole('button', { name: '负责人', exact: true }).click()
  await page.waitForTimeout(400)
  const ordered = await page.locator('.rig-view > .qp-panel > h2').allTextContents()
  assert.equal(ordered[0], '每日通过率', `lead lens leads with the trend, saw ${ordered[0]}`)
  await page.getByRole('button', { name: '测试', exact: true }).click()
  await page.waitForTimeout(400)
  assert.equal(
    (await page.locator('.rig-view > .qp-panel > h2').allTextContents())[0],
    '要先处理的'
  )
  await page.screenshot({ path: join(qa, 'web-report.png'), fullPage: true })

  await page.getByRole('button', { name: '编排中心', exact: false }).click()
  await page.locator('.rig-graph svg').waitFor({ state: 'visible' })
  // The generic task graph: seven nodes, one of them the approval pause.
  assert.equal(await page.locator('.rig-graph__node').count(), 7)
  await page.screenshot({ path: join(qa, 'web-orchestration.png') })
  await page.getByRole('button', { name: '出网观测', exact: false }).click()
  await page.locator('.rig-table[data-layout="egress"]').waitFor({ state: 'visible' })
  await page.screenshot({ path: join(qa, 'web-egress.png') })

  // The orchestration centre: open a saved spec, break it, see the compiler
  // refuse it by name, repair it, and watch the draft preview come back.
  await page.getByRole('button', { name: '编排中心', exact: false }).click()
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
  assert.deepEqual(errors, [])
  console.log(
    'Browser tools and Web smoke passed: origin policy, real page fill/click, password refusal, screenshots, HttpOnly login, unconfigured model blocked, Internal settings, Agent market, quality report (empty rates read "—", lens reorders sections), orchestration centre (compiled spec, draft preview, refused draft), egress observation.'
  )
} finally {
  await tools.close()
  await browser?.close()
  await server?.close()
  await new Promise((r) => target.close(r))
}
