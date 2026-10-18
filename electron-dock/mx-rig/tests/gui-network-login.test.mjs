import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { extname, resolve, sep } from 'node:path'
import { chromium } from 'playwright'

const webRoot = resolve(fileURLToPath(new URL('../apps/web/', import.meta.url)))
const origin = 'http://rig-ui.test'
const ready = {
  status: 'ready', statusText: '已连接', message: '内网已连接', serverReachable: true,
  serviceVip: '10.88.100.6', serverUrl: 'http://10.88.100.6', leaseIp: '10.94.0.2',
  identity: { kind: 'anonymous' }, connectedOnce: true
}
const recoverable = {
  ...ready, status: 'error', statusText: '连接失败', serverReachable: false,
  message: '缺少原设备的续租凭据', recoveryAvailable: true
}
let browser
before(async () => { browser = await chromium.launch({ headless: true, channel: 'chromium' }) })
after(async () => { await browser?.close() })

async function openPage(t, launcher = ready) {
  const page = await browser.newPage()
  t.after(() => page.close())
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  t.after(() => assert.deepEqual(errors, []))
  // Every browser request is answered from the checkout; no listener, server,
  // Launcher SDK, credentials or system network is involved.
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const file = resolve(webRoot, `.${decodeURIComponent(url.pathname)}`)
    if (url.origin !== origin || !file.startsWith(webRoot + sep)) return route.abort()
    try {
      await route.fulfill({
        body: await readFile(file),
        contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] ?? 'application/octet-stream'
      })
    } catch {
      await route.fulfill({ status: 404, body: '' })
    }
  })
  await page.addInitScript(({ launcher }) => {
    const calls = []
    const pending = new Map()
    let onNetwork
    window.mxRig = {
      desktop: true,
      request: async (action) => {
        calls.push(action)
        if (action === 'login-defaults') return { server: 'http://127.0.0.1:8791', privateHttp: true, launcher }
        if (action === 'oversea-status' || action === 'update-status') return null
        if (['login', 'network-connect', 'network-disconnect', 'network-recover'].includes(action))
          return new Promise((resolve, reject) => pending.set(action, { resolve, reject }))
        throw new Error(`Unexpected test action: ${action}`)
      },
      onNetwork: (callback) => { onNetwork = callback }
    }
    window.testRig = {
      calls,
      network: (snapshot) => onNetwork(snapshot),
      failLogin: () => pending.get('login').reject(new Error('用户网络尚未就绪')),
      connected: (snapshot) => pending.get('network-connect').resolve(snapshot),
      recovered: (snapshot) => pending.get('network-recover').resolve(snapshot),
      failRecovery: () => pending.get('network-recover').reject(new Error('备份网络身份失败'))
    }
  }, { launcher })
  await page.goto(`${origin}/index.html`)
  await page.waitForFunction(() => typeof window.testRig?.network === 'function' && document.getElementById('login-form').onsubmit)
  if (launcher) await page.locator('#network-panel').waitFor({ state: 'visible' })
  await page.locator('#account').fill('fixture-user')
  await page.locator('#password').fill('fixture-password')
  return page
}

const submit = (page) => page.locator('#login-form button[type=submit]')
const called = (page, action) => page.evaluate((name) => window.testRig.calls.filter((entry) => entry === name).length, action)
const emit = (page, snapshot) => page.evaluate((value) => window.testRig.network(value), snapshot)
const finishFailure = async (page) => {
  await page.evaluate(() => window.testRig.failLogin())
  await page.locator('#login-error').filter({ hasText: '用户网络尚未就绪' }).waitFor()
}

test('a ready event during login cannot unlock a second login or network mutation', async (t) => {
  const page = await openPage(t)
  await submit(page).click()
  assert.equal(await called(page, 'login'), 1)
  await emit(page, { ...ready, identity: { kind: 'user' } })
  assert.equal(await submit(page).isDisabled(), true)
  assert.equal(await page.locator('#network-connect').isDisabled(), true)
  assert.equal(await page.locator('#network-disconnect').isDisabled(), true)
  assert.equal(await page.locator('#network-recover').isDisabled(), true)
  await page.evaluate(() => {
    const form = document.getElementById('login-form')
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: form.querySelector('button[type=submit]') }))
    document.getElementById('network-connect').dispatchEvent(new MouseEvent('click'))
    document.getElementById('network-disconnect').dispatchEvent(new MouseEvent('click'))
    document.getElementById('network-recover').dispatchEvent(new MouseEvent('click'))
  })
  assert.equal(await called(page, 'login'), 1)
  assert.equal(await called(page, 'network-connect'), 0)
  assert.equal(await called(page, 'network-disconnect'), 0)
  assert.equal(await called(page, 'network-recover'), 0)
  await finishFailure(page)
  assert.equal(await submit(page).isEnabled(), true)
  assert.equal(await page.locator('#network-disconnect').isEnabled(), true)
})

test('failed handover keeps login disabled and exposes network recovery', async (t) => {
  const page = await openPage(t)
  await submit(page).click()
  await emit(page, { ...ready, status: 'error', statusText: '连接失败', serverReachable: false, message: '用户网络接管失败，请重新连接' })
  await finishFailure(page)
  assert.equal(await submit(page).isDisabled(), true)
  assert.equal(await page.locator('#network-connect').isVisible(), true)
  assert.equal(await page.locator('#network-connect').isEnabled(), true)
  assert.match(await page.locator('#network-message').textContent(), /用户网络接管失败/)
  await page.evaluate(() => document.getElementById('login-form').dispatchEvent(new SubmitEvent('submit', { cancelable: true })))
  assert.equal(await called(page, 'login'), 1)
})

test('a ready tunnel with an unreachable Rig service offers reconnection and gates login until it finishes', async (t) => {
  const page = await openPage(t, { ...ready, serverReachable: false })
  assert.equal(await submit(page).isDisabled(), true)
  assert.equal(await page.locator('#network-connect').isVisible(), true)
  await page.locator('#network-connect').click()
  assert.equal(await called(page, 'network-connect'), 1)
  await emit(page, ready)
  assert.equal(await submit(page).isDisabled(), true)
  await page.evaluate((snapshot) => window.testRig.connected(snapshot), ready)
  await page.waitForFunction(() => !document.querySelector('#login-form button[type=submit]').disabled)
  assert.equal(await page.locator('#network-connect').isVisible(), false)
  assert.equal(await page.locator('#network-disconnect').isEnabled(), true)
})

test('ordinary desktop login remains usable without a Launcher snapshot', async (t) => {
  const page = await openPage(t, null)
  assert.equal(await page.locator('#network-panel').isVisible(), false)
  assert.equal(await submit(page).isEnabled(), true)
  await submit(page).click()
  assert.equal(await submit(page).isDisabled(), true)
  await finishFailure(page)
  assert.equal(await submit(page).isEnabled(), true)
})

test('network identity recovery is offered only by the explicit desktop snapshot flag', async (t) => {
  const page = await openPage(t, { ...recoverable, recoveryAvailable: false, message: 'HTTP 401' })
  assert.equal(await page.locator('#network-recover').isVisible(), false)
  assert.equal(await page.locator('#network-recovery-hint').isVisible(), false)
  await page.evaluate(() => document.getElementById('network-recover').dispatchEvent(new MouseEvent('click')))
  assert.equal(await called(page, 'network-recover'), 0)
  await emit(page, { ...recoverable, recoveryAvailable: 'true' })
  assert.equal(await page.locator('#network-recover').isVisible(), false)
  await emit(page, recoverable)
  assert.equal(await page.locator('#network-recover').isVisible(), true)
  assert.equal(await page.locator('#network-recover').isEnabled(), true)
  assert.equal(await page.locator('#network-recover').textContent(), '重新登记本机网络')
  assert.match(await page.locator('#network-recovery-hint').textContent(), /备份.*重新登记.*Rig.*本机网络身份.*账号.*测试数据.*保留/s)
  assert.equal(await submit(page).isDisabled(), true)
})

test('network identity recovery blocks concurrent mutations until its returned snapshot completes', async (t) => {
  const page = await openPage(t, recoverable)
  await page.locator('#network-recover').click()
  assert.equal(await called(page, 'network-recover'), 1)
  for (const id of ['network-connect', 'network-disconnect', 'network-recover'])
    assert.equal(await page.locator(`#${id}`).isDisabled(), true)
  await page.evaluate(() => {
    for (const id of ['network-connect', 'network-disconnect', 'network-recover'])
      document.getElementById(id).dispatchEvent(new MouseEvent('click'))
    document.getElementById('login-form').dispatchEvent(new SubmitEvent('submit', { cancelable: true }))
  })
  assert.equal(await called(page, 'network-recover'), 1)
  assert.equal(await called(page, 'network-connect'), 0)
  assert.equal(await called(page, 'network-disconnect'), 0)
  assert.equal(await called(page, 'login'), 0)
  await emit(page, ready)
  assert.equal(await submit(page).isDisabled(), true)
  await page.evaluate((snapshot) => window.testRig.recovered(snapshot), ready)
  await page.waitForFunction(() => !document.querySelector('#login-form button[type=submit]').disabled)
  assert.equal(await page.locator('#network-recover').isVisible(), false)
  assert.equal(await page.locator('#network-recovery-hint').isVisible(), false)
  assert.equal(await page.locator('#network-disconnect').isEnabled(), true)
  assert.equal(await page.locator('#account').inputValue(), 'fixture-user')
})

test('failed recovery keeps login gated and lets the latest snapshot decide whether recovery remains available', async (t) => {
  const page = await openPage(t, recoverable)
  await page.locator('#network-recover').click()
  await page.evaluate(() => window.testRig.failRecovery())
  await page.locator('#network-message').filter({ hasText: '备份网络身份失败' }).waitFor()
  assert.equal(await submit(page).isDisabled(), true)
  assert.equal(await page.locator('#network-recover').isEnabled(), true)
  await page.locator('#network-recover').click()
  await page.evaluate((snapshot) => window.testRig.recovered(snapshot), { ...recoverable, recoveryAvailable: false, message: 'HTTP 401' })
  await page.locator('#network-message').filter({ hasText: 'HTTP 401' }).waitFor()
  assert.equal(await submit(page).isDisabled(), true)
  assert.equal(await page.locator('#network-recover').isVisible(), false)
  assert.equal(await page.locator('#network-connect').isEnabled(), true)
})
