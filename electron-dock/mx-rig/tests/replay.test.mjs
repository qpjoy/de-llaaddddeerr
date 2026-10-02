import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserTools } from '../packages/runtime/browser.mjs'
import { replayDocument, replayFrames } from '../packages/runtime/replay.mjs'

// 回放: a mission's browser steps as frames, and as one HTML file that plays
// them with the hand moving from target to target.

test('frames come from the mission record; a failed step is a frame that says so', () => {
  const frames = replayFrames([
    { kind: 'tool_start', data: { tool: 'browser_open', args: { url: 'http://x/' } } },
    { kind: 'tool_result', at: 't1', data: { result: { screenshot: 'm/1.png', url: 'http://x/', frame: { label: '打开 http://x/' } } } },
    { kind: 'tool_start', data: { tool: 'workspace_read', args: { path: 'a' } } },
    { kind: 'tool_result', data: { result: { path: 'a', text: '' } } },
    { kind: 'tool_start', data: { tool: 'browser_click', args: { ref: 'e3' } } },
    {
      kind: 'tool_result',
      data: {
        result: {
          screenshot: 'm/3.png',
          frame: { label: '点击「保存」', intent: 'm/2-intent.png', box: { x: 1, y: 2, width: 3, height: 4 }, point: { x: 2, y: 4 } }
        }
      }
    },
    { kind: 'tool_start', data: { tool: 'browser_click', args: { ref: 'e9' } } },
    { kind: 'tool_error', message: 'browser_click 未完成：引用 e9 已不对应当前页面上的同一个元素', data: { tool: 'browser_click' } },
    { kind: 'tool_result', data: { result: { error: { code: 'stale_ref', message: '…' } } } },
    { kind: 'tool_start', data: { tool: 'browser_assert', args: {} } },
    { kind: 'tool_result', data: { result: { screenshot: 'm/4.png', assertion: { passed: false }, frame: { label: '断言：…' } } } }
  ])
  assert.deepEqual(
    frames.map((frame) => [frame.label, frame.image, frame.intent ?? null, frame.error ?? null, frame.assertion]),
    [
      ['打开 http://x/', 'm/1.png', null, null, undefined],
      ['点击「保存」', 'm/3.png', 'm/2-intent.png', null, undefined],
      ['browser_click 未完成', 'm/3.png', null, '引用 e9 已不对应当前页面上的同一个元素', undefined],
      ['断言：…', 'm/4.png', null, null, false]
    ]
  )
})

test('a replay file plays itself: the cursor travels to each target and the steps advance', async (t) => {
  const { chromium: engine } = await import('playwright')
  const launcher = { launch: (options) => engine.launch({ ...options, headless: true, channel: 'chromium' }) }
  const probe = await launcher.launch({}).catch(() => null)
  if (!probe) return t.skip('Chromium 未安装')
  await probe.close()
  const site = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>设置</title></head><body><h1>个人设置</h1><label for="n">昵称</label><input id="n"><button type="button" onclick="document.querySelector(\'p\').textContent=\'已保存\'">保存</button><p></p></body></html>'
    )
  })
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => site.close(resolve)))
  const origin = `http://127.0.0.1:${site.address().port}`
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-replay-'))
  const tools = new BrowserTools(root, launcher, { headless: true })
  t.after(() => tools.close())
  const missionId = '00000000-0000-4000-8000-00000000000a'
  const context = { policy: { browserOrigins: [origin], productionHosts: [], egress: {} }, signal: new AbortController().signal, missionId }

  // The record a mission keeps, step by step.
  const events = []
  const step = async (tool, args) => {
    events.push({ kind: 'tool_start', at: new Date().toISOString(), data: { tool, args } })
    const result = await tools.execute(tool, args, context)
    events.push({ kind: 'tool_result', at: new Date().toISOString(), data: { result } })
    return result
  }
  const opened = await step('browser_open', { url: origin })
  const ref = (pattern) => /\[ref=(e\d+)\]/.exec(opened.snapshot.split('\n').find((line) => pattern.test(line)))[1]
  await step('browser_fill', { ref: ref(/textbox "昵称"/), value: 'Rig' })
  await step('browser_click', { ref: ref(/button "保存"/) })
  await step('browser_assert', { kind: 'text_visible', expected: '已保存' })
  await tools.close()

  const { html, frames } = await replayDocument(
    { id: missionId, goal: '改昵称并保存', status: 'completed', createdAt: new Date().toISOString(), events },
    { readImage: (path) => readFile(join(root, path)) }
  )
  assert.equal(frames, 4)
  assert.ok(!html.includes('export function'), 'the player is inlined as a script, not a module')
  assert.ok(!/<\/script>[\s\S]*"image"/.test(html.split('<script type="application/json"')[0]))
  const file = join(root, 'replay.html')
  await writeFile(file, html)

  // Open it like a person would, and watch.
  const browser = await engine.launch({ headless: true, channel: 'chromium' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(pathToFileURL(file).href)
  await page.locator('.rig-replay__step').first().waitFor()
  assert.deepEqual(
    await page.locator('.rig-replay__step').allTextContents(),
    [`1打开 ${origin}`, '2填写「昵称」：Rig', '3点击「保存」', '✓断言：页面上可见指定文本「已保存」']
  )
  await page.waitForFunction(() =>
    document.querySelector('.rig-replay__svg image')?.getAttribute('href')?.startsWith('data:image/png;base64,')
  )
  // It plays on its own; the cursor has been placed on a target on the way.
  await page.waitForFunction(() => document.querySelector('.rig-replay__counter')?.textContent === '4 / 4', null, { timeout: 20_000 })
  const cursor = await page.locator('.rig-replay__cursor').getAttribute('transform')
  assert.match(cursor, /^translate\(\d+(\.\d+)? \d+(\.\d+)?\)$/)
  await page.waitForFunction(() => document.querySelector('.rig-replay__badge')?.getAttribute('opacity') === '1')
  assert.match(await page.locator('.rig-replay__badge text').textContent(), /^✓ 断言/)
  // Stepping by hand works too.
  await page.locator('.rig-replay__step').nth(2).click()
  assert.equal(await page.locator('.rig-replay__counter').textContent(), '3 / 4')
  assert.deepEqual(errors, [])
})
