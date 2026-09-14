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
  await page.locator('#goal').fill('检查未配置模型的明确失败状态')
  await page.locator('#start').click()
  await page.waitForFunction(() => document.querySelector('#mission-status').textContent === '受阻')
  await page.getByRole('button', { name: 'Internal 配置', exact: false }).click()
  await page.locator('#max-turns').fill('8')
  await page.locator('#settings-form button').click()
  await page.getByRole('button', { name: '工具与能力', exact: false }).click()
  await page.locator('#tools .card').first().waitFor({ state: 'visible' })
  await page.screenshot({ path: join(qa, 'web-tools.png') })
  assert.deepEqual(errors, [])
  console.log(
    'Browser tools and Web smoke passed: origin policy, real page fill/click, password refusal, screenshots, HttpOnly login, unconfigured model blocked, Internal settings.'
  )
} finally {
  await tools.close()
  await browser?.close()
  await server?.close()
  await new Promise((r) => target.close(r))
}
