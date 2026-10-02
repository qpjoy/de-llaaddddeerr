import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserTools } from '../packages/runtime/browser.mjs'
import { ProcedurePlayer } from '../packages/runtime/procedure.mjs'
import { intentLabel } from '../packages/runtime/pilot.mjs'

// The pilot: a cursor that shows where the Agent is about to act, on the page
// it drives — and that never becomes part of what is tested or kept.

async function chromium() {
  const { chromium: engine } = await import('playwright')
  const launcher = { launch: (options) => engine.launch({ ...options, headless: true, channel: 'chromium' }) }
  const probe = await launcher.launch({}).catch(() => null)
  if (!probe) return null
  await probe.close()
  return { engine, launcher }
}

// As strict as pages get: no inline style, no inline script, Trusted Types.
const CSP = "default-src 'self'; style-src 'self'; script-src 'self'; require-trusted-types-for 'script'"

async function site(t) {
  const server = createServer((req, res) => {
    if (req.url === '/page.css') {
      res.writeHead(200, { 'content-type': 'text/css' })
      return res.end('body { background: #ffffff; margin: 0; font: 16px sans-serif } .spacer { height: 1400px } button { margin: 40px; padding: 8px 16px }')
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP })
    res.end(
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>设置</title><link rel="stylesheet" href="/page.css"></head><body><h1>个人设置</h1><div class="spacer"></div><label for="n">昵称</label><input id="n"><button type="button">保存</button></body></html>'
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

/** One pixel of a PNG, read by the browser itself. */
async function pixel(engine, png, x, y) {
  const browser = await engine.launch({ headless: true, channel: 'chromium' })
  try {
    const page = await browser.newPage()
    return await page.evaluate(
      async ([data, px, py]) => {
        const image = new Image()
        image.src = `data:image/png;base64,${data}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.width
        canvas.height = image.height
        const context = canvas.getContext('2d')
        context.drawImage(image, 0, 0)
        return [...context.getImageData(px, py, 1, 1).data.slice(0, 3)]
      },
      [png.toString('base64'), x, y]
    )
  } finally {
    await browser.close()
  }
}

test('the Agent’s hand is visible on the page, and absent from the page’s structure and from evidence', async (t) => {
  const env = await chromium()
  if (!env) return t.skip('Chromium 未安装')
  const origin = await site(t)
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-pilot-'))
  const tools = new BrowserTools(root, env.launcher, { headless: true, dwellMs: 60 })
  t.after(() => tools.close())
  const frames = []
  tools.onFrame = (frame) => frames.push(frame)
  const context = {
    policy: { browserOrigins: [origin], productionHosts: [], egress: {} },
    signal: new AbortController().signal,
    missionId: '00000000-0000-4000-8000-000000000001'
  }
  const opened = await tools.execute('browser_open', { url: `${origin}/settings` }, context)
  const errors = []
  tools.page.on('console', (message) => message.type() === 'error' && errors.push(message.text()))
  tools.page.on('pageerror', (error) => errors.push(error.message))
  assert.deepEqual(opened.frame, { label: `打开 ${origin}/settings`, viewport: { width: 1280, height: 720 } })

  const line = (pattern) => /\[ref=(e\d+)\]/.exec(opened.snapshot.split('\n').find((entry) => pattern.test(entry)))[1]
  const filled = await tools.execute('browser_fill', { ref: line(/textbox "昵称"/), value: 'Rig' }, context)
  assert.equal(filled.frame.label, '填写「昵称」：Rig')
  const clicked = await tools.execute('browser_click', { ref: line(/button "保存"/) }, context)
  const { frame } = clicked
  assert.equal(frame.label, '点击「保存」')
  assert.ok(frame.box.y >= 0 && frame.box.y + frame.box.height <= 720, 'scrolled into view before aiming')
  assert.deepEqual(frame.point, {
    x: Math.round(frame.box.x + frame.box.width / 2),
    y: Math.round(frame.box.y + frame.box.height / 2)
  })
  assert.match(frame.intent, /^00000000-0000-4000-8000-000000000001\/\d+-intent\.png$/)

  // Not part of the page under test.
  assert.ok(!clicked.snapshot.includes('点击'), 'not in the accessibility snapshot')
  assert.equal(await tools.page.getByText('点击「保存」').count(), 0, 'not found by locators')
  assert.deepEqual(
    await tools.page.evaluate(() => {
      const host = document.querySelector('mx-rig-pilot')
      return [host.parentElement.tagName, host.getAttribute('aria-hidden'), document.body.contains(host)]
    }),
    ['HTML', 'true', false]
  )
  assert.deepEqual(errors, [], 'a strict CSP and Trusted Types page raises nothing')

  // Live, the outline is drawn; in the evidence it is not. Read the outline's
  // left border pixel in both.
  await tools.page.evaluate((box) => window.__mxRigPilot.aim(box, '点击「保存」'), frame.box)
  const border = [frame.box.x - 3, frame.point.y]
  // The outline fades in; a loaded machine may take longer than its 240 ms.
  let live = [255, 255, 255]
  for (let tries = 0; tries < 20 && live.join() === '255,255,255'; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    live = await pixel(env.engine, await tools.page.screenshot(), ...border)
  }
  const kept = await pixel(env.engine, await readFile(join(root, frame.intent)), ...border)
  assert.notDeepEqual(live, [255, 255, 255], 'the outline is on the live page')
  assert.deepEqual(kept, [255, 255, 255], 'the intent frame is the page alone')

  for (let tries = 0; tries < 50 && !frames.length; tries += 1) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.ok(frames.length > 0, 'the live pane gets frames')
  assert.ok(frames.every((entry) => typeof entry.data === 'string' && entry.data.length > 100))
  assert.equal(frames.at(-1).missionId, context.missionId)
})

test('a procedure replay shows the hand too, and its steps and verdicts do not change', async (t) => {
  const env = await chromium()
  if (!env) return t.skip('Chromium 未安装')
  const origin = await site(t)
  const tools = new BrowserTools(await mkdtemp(join(tmpdir(), 'mx-rig-pilot-')), env.launcher, { headless: true })
  t.after(() => tools.close())
  const result = await new ProcedurePlayer(tools).run(
    {
      id: 'prc_000000000000000000',
      revision: 1,
      title: '保存昵称',
      baseUrl: origin,
      steps: [
        { do: 'open', url: '/settings' },
        { do: 'fill', target: { label: '昵称' }, value: 'Rig' },
        { do: 'click', target: { role: 'button', name: '保存' } },
        { do: 'assert', kind: 'value_equals', target: { label: '昵称' }, expected: 'Rig' }
      ]
    },
    { policy: { browserOrigins: [origin], productionHosts: [], egress: {} }, runId: 'pilot-run' }
  )
  assert.equal(result.verdict, 'passed', JSON.stringify(result.failure))
  assert.equal(await tools.page.evaluate(() => Boolean(window.__mxRigPilot)), true)
  assert.equal(intentLabel('check', { role: 'checkbox', name: '同意' }, { checked: false }), '取消勾选「同意」')
})
