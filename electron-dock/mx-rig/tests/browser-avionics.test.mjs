import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { annotateSnapshot, parseLine, sameElement } from '../packages/runtime/aria.mjs'
import { BrowserTools } from '../packages/runtime/browser.mjs'
import { MissionStore } from '../packages/runtime/store.mjs'
import { RigRuntime } from '../packages/runtime/engine.mjs'
import { ToolExecutor } from '../packages/runtime/tools.mjs'

// What Playwright 1.58 actually prints for a page with the awkward cases in it:
// YAML-quoted names, duplicates, disabled controls, an iframe, nested dialogs.
const SAMPLE = `- heading "订单 管理" [level=1]
- navigation:
  - link "Home":
    - /url: /home
  - 'link "About: us \\"quoted\\""':
    - /url: /about
- text: 项目名称
- textbox "项目名称": abc
- checkbox "同意条款" [checked]
- combobox "城市":
  - option "北京"
  - option "上海" [selected]
- button "保存"
- button "保存"
- button "禁用" [disabled]
- dialog "确认":
  - paragraph: 确定删除吗？
  - button "确定"
- iframe
- 'button "it''s here"'`

test('snapshot lines parse, including YAML-quoted names', () => {
  assert.deepEqual(parseLine('- button "保存"'), {
    indent: '',
    role: 'button',
    name: '保存',
    attrs: '',
    rest: ''
  })
  assert.equal(parseLine(`  - 'link "About: us \\"quoted\\""':`).name, 'About: us "quoted"')
  assert.equal(parseLine(`- 'button "it''s here"'`).name, "it's here")
  assert.equal(parseLine('- checkbox "同意条款" [checked]').attrs, ' [checked]')
  assert.equal(parseLine('- textbox "项目名称": abc').rest, ': abc')
  assert.equal(parseLine('    - /url: /home'), null)
  assert.equal(parseLine('not a list item'), null)
})

test('every actionable element gets a reference; context does not', () => {
  const { text, refs, truncated } = annotateSnapshot(SAMPLE)
  assert.equal(truncated, false)
  assert.match(text, /- heading "订单 管理" \[level=1\]$/m)
  assert.match(text, /- link "About: us \\"quoted\\"" \[ref=e2\]:/)
  assert.match(text, /- textbox "项目名称" \[ref=e3\]: abc/)
  // Duplicates are told apart by their position among elements of that role.
  assert.deepEqual(refs.get('e8'), { role: 'button', name: '保存', index: 0 })
  assert.deepEqual(refs.get('e9'), { role: 'button', name: '保存', index: 1 })
  assert.deepEqual(refs.get('e11'), { role: 'button', name: '确定', index: 3 })
  assert.deepEqual(refs.get('e12'), { role: 'button', name: "it's here", index: 4 })
  assert.ok(
    ![...refs.values()].some((entry) => entry.role === 'heading' || entry.role === 'iframe')
  )
})

test('an element found by position must still match what the model saw', () => {
  const expected = { role: 'button', name: '保存', index: 0 }
  assert.equal(sameElement(expected, '- button "保存"'), true)
  assert.equal(sameElement(expected, '- button "删除"'), false)
  assert.equal(sameElement(expected, '- link "保存"'), false)
  assert.equal(sameElement(expected, ''), false)
})

test('a very large page is truncated and says so', () => {
  const big = Array.from({ length: 2000 }, (_, i) => `- button "按钮 ${i}"`).join('\n')
  const { text, truncated } = annotateSnapshot(big, { limit: 500 })
  assert.equal(truncated, true)
  assert.match(text, /快照已截断/)
})

// -- the real thing -----------------------------------------------------------

const PAGE = `<!doctype html><title>Rig Avionics</title>
<h1>订单</h1>
<label>项目名称 <input id="name"></label>
<label>密码 <input type="password" id="secret"></label>
<label>城市 <select id="city"><option>北京</option><option>上海</option></select></label>
<label><input type="checkbox" id="agree"> 同意条款</label>
<button id="save">保存</button>
<button>保存</button>
<p id="status">准备就绪</p>
<script>
  document.getElementById('save').onclick = () => {
    const name = document.getElementById('name').value
    const city = document.getElementById('city').value
    const agree = document.getElementById('agree').checked
    setTimeout(() => {
      document.getElementById('status').textContent = '已保存 ' + name + ' ' + city + ' ' + agree
    }, 300)
  }
  window.renameSave = () => { document.getElementById('save').textContent = '提交' }
</script>`

async function realBrowser(t) {
  const { chromium } = await import('playwright')
  // The full Chromium in headless mode: the same binary the desktop uses.
  const launcher = {
    launch: (options) => chromium.launch({ ...options, headless: true, channel: 'chromium' })
  }
  try {
    const probe = await launcher.launch({})
    await probe.close()
  } catch {
    t.skip('Chromium 未安装；运行 npm run browser:install 后执行')
    return null
  }
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-avionics-'))
  const tools = new BrowserTools(root, launcher, { headless: true })
  t.after(() => tools.close())
  const missionId = '00000000-0000-0000-0000-00000000a001'
  const context = {
    policy: { browserOrigins: [origin] },
    signal: new AbortController().signal,
    missionId
  }
  const refOf = (snapshot, pattern) => {
    const line = snapshot.split('\n').find((entry) => pattern.test(entry))
    return /\[ref=(e\d+)\]/.exec(line ?? '')?.[1]
  }
  return { tools, context, origin, root, missionId, refOf }
}

test('the browser works by reference, asserts deterministically and keeps a trace', async (t) => {
  const f = await realBrowser(t)
  if (!f) return
  const { tools, context, origin, root, missionId, refOf } = f

  const opened = await tools.execute('browser_open', { url: origin }, context)
  assert.equal(opened.title, 'Rig Avionics')
  assert.match(opened.snapshot, /heading "订单"/)
  const name = refOf(opened.snapshot, /textbox "项目名称"/)
  const city = refOf(opened.snapshot, /combobox "城市"/)
  const agree = refOf(opened.snapshot, /checkbox "同意条款"/)
  const save = refOf(opened.snapshot, /button "保存"/)
  const secret = refOf(opened.snapshot, /textbox "密码"/)
  assert.ok(name && city && agree && save)

  await tools.execute('browser_fill', { ref: name, value: 'MX Rig' }, context)
  await tools.execute('browser_select', { ref: city, option: '上海' }, context)
  const checked = await tools.execute('browser_check', { ref: agree, checked: true }, context)
  assert.match(checked.snapshot, /checkbox "同意条款" \[checked\]/)

  // Passwords are never typed by the Agent, whichever way it points at them.
  if (secret)
    await assert.rejects(tools.execute('browser_fill', { ref: secret, value: 'x' }, context), {
      code: 'sensitive_field'
    })
  await assert.rejects(tools.execute('browser_fill', { label: '密码', value: 'x' }, context), {
    code: 'sensitive_field'
  })

  // Two buttons share a name: by role + name it is ambiguous, by ref it is not.
  await assert.rejects(tools.execute('browser_click', { role: 'button', name: '保存' }, context), {
    code: 'ambiguous_target'
  })
  const clicked = await tools.execute('browser_click', { ref: save }, context)
  assert.ok(clicked.revision > opened.revision)

  const waited = await tools.execute('browser_wait', { text: '已保存', timeoutMs: 5000 }, context)
  assert.equal(waited.wait.satisfied, true)
  const pass = await tools.execute(
    'browser_assert',
    { kind: 'text_visible', expected: '已保存 MX Rig 上海 true' },
    context
  )
  assert.equal(pass.assertion.passed, true)
  const fail = await tools.execute(
    'browser_assert',
    { kind: 'text_visible', expected: '不存在的文字', timeoutMs: 300 },
    context
  )
  assert.equal(fail.assertion.passed, false)
  assert.equal(fail.snapshot, undefined, 'an assertion does not spend a snapshot')
  const value = await tools.execute(
    'browser_assert',
    { kind: 'value_equals', ref: name, expected: 'MX Rig' },
    context
  )
  assert.equal(value.assertion.passed, true)
  const missing = await tools.execute(
    'browser_wait',
    { text: '永远不会出现', timeoutMs: 500 },
    context
  )
  assert.equal(missing.wait.satisfied, false)

  // The page changes under a reference: acting on it is refused, not misdirected.
  await tools.page.evaluate(() => window.renameSave())
  await assert.rejects(tools.execute('browser_click', { ref: save }, context), {
    code: 'stale_ref'
  })
  await assert.rejects(tools.execute('browser_click', { ref: 'e999' }, context), {
    code: 'stale_ref'
  })
  await assert.rejects(tools.execute('browser_press', { key: 'F12' }, context), {
    code: 'invalid_key'
  })

  assert.ok((await stat(join(root, clicked.screenshot))).size > 0)
  await tools.close()
  assert.ok(
    (await stat(join(root, missionId, 'trace.zip'))).size > 0,
    'the flight recorder was saved'
  )
})

// -- the engine around it -------------------------------------------------------

async function engineFixture(t, replies, { allowedTools, browser } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-engine-'))
  const store = await new MissionStore(root).init()
  const policy = {
    revision: 'v1',
    maxTurns: 6,
    allowedTools: allowedTools ?? [
      'tests_result',
      'tests_wait',
      'browser_snapshot',
      'browser_assert'
    ],
    browserOrigins: []
  }
  const calls = []
  const client = {
    async request(path, body, signal) {
      signal?.throwIfAborted()
      calls.push({ path, body })
      if (path === '/api/rig/v1/execution-config') return { policy: structuredClone(policy) }
      if (path === '/api/rig/v1/model/turn')
        return { message: replies.shift() || { content: '完成' } }
      return { run: { id: 'trun_a1', status: 'passed' } }
    }
  }
  const engine = new RigRuntime({
    store,
    client,
    executor: new ToolExecutor(client, browser ?? null),
    owner: 'alice'
  })
  t.after(() => engine.close())
  return { store, engine, calls }
}

const call = (id, name, args) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) }
})

test('integer arguments survive the graph checkpoint', async (t) => {
  const f = await engineFixture(t, [
    { tool_calls: [call('c1', 'tests_wait', { runId: 'trun_a1', timeoutMs: 1000 })] },
    { content: '执行已通过。' }
  ])
  const row = await f.engine.start({ mode: 'agent', goal: '等结果' })
  await f.engine.job
  const done = f.store.get(row.id, 'alice')
  assert.equal(done.status, 'completed', JSON.stringify(done.events.at(-1)))
  assert.ok(done.events.some((entry) => entry.kind === 'tool_result'))
})

test('extra tool calls in one step are not executed and the model is told', async (t) => {
  const f = await engineFixture(t, [
    {
      tool_calls: [
        call('c1', 'tests_result', { runId: 'trun_a1' }),
        call('c2', 'tests_result', { runId: 'trun_b2' })
      ]
    },
    { content: '好的。' }
  ])
  const row = await f.engine.start({ mode: 'agent', goal: '看结果' })
  await f.engine.job
  assert.equal(f.store.get(row.id, 'alice').status, 'completed')
  assert.equal(f.calls.filter((entry) => entry.path.startsWith('/api/v1/runs/')).length, 1)
  const messages = f.store.rows.get(row.id).messages
  const assistant = messages.find((entry) => entry.role === 'assistant' && entry.tool_calls)
  assert.equal(assistant.tool_calls.length, 1, 'the transcript records only the call that ran')
  assert.match(messages.find((entry) => entry.role === 'tool').content, /只执行了第一个/)
})

test('a page-level failure goes back to the model; the mission continues', async (t) => {
  const browser = {
    async execute(name, args) {
      if (name === 'browser_snapshot')
        return { url: 'https://t.example/', snapshot: '- button "保存" [ref=e1]' }
      if (name === 'browser_assert')
        return {
          assertion: { kind: 'text_visible', expected: '已保存', passed: false, description: 'x' }
        }
      throw new Error('unreachable')
    },
    async close() {}
  }
  const stale = {
    ...browser,
    calls: 0,
    async execute(name, args, context) {
      if (name === 'browser_snapshot' && this.calls++ === 0) {
        const { RigError } = await import('../packages/contracts/index.mjs')
        throw new RigError('stale_ref', '引用已过期', 409)
      }
      return browser.execute(name, args, context)
    }
  }
  const f = await engineFixture(
    t,
    [
      { tool_calls: [call('c1', 'browser_snapshot', {})] },
      { tool_calls: [call('c2', 'browser_snapshot', {})] },
      { tool_calls: [call('c3', 'browser_assert', { kind: 'text_visible', expected: '已保存' })] },
      { content: '保存后没有出现提示。' }
    ],
    { browser: stale }
  )
  const row = await f.engine.start({ mode: 'agent', goal: '检查保存' })
  await f.engine.job
  const done = f.store.get(row.id, 'alice')
  assert.equal(done.status, 'completed', JSON.stringify(done.events.at(-1)))
  assert.ok(
    done.events.some((entry) => entry.kind === 'tool_error' && /引用已过期/.test(entry.message))
  )
  // The assertion is a recorded fact on the mission, not just a line of chat.
  assert.equal(done.assertions.length, 1)
  assert.equal(done.assertions[0].passed, false)
  assert.ok(
    done.events.some((entry) => entry.kind === 'assertion' && /断言未通过/.test(entry.message))
  )
})

// -- exploration → script --------------------------------------------------------

test('an explored path exports to a Playwright spec that replays on a fresh page', async (t) => {
  const f = await realBrowser(t)
  if (!f) return
  const { tools, context, origin, refOf } = f
  const { exportPlaywright } = await import('../packages/runtime/export.mjs')
  const events = []
  const record = (result) =>
    events.push({ kind: 'tool_result', data: { result, action: result.action } })
  const opened = await tools.execute('browser_open', { url: origin }, context)
  record(opened)
  record(
    await tools.execute(
      'browser_fill',
      { ref: refOf(opened.snapshot, /textbox "项目名称"/), value: 'MX Rig' },
      context
    )
  )
  record(
    await tools.execute(
      'browser_select',
      { ref: refOf(opened.snapshot, /combobox "城市"/), option: '上海' },
      context
    )
  )
  record(
    await tools.execute(
      'browser_check',
      { ref: refOf(opened.snapshot, /checkbox "同意条款"/), checked: true },
      context
    )
  )
  // The second of two buttons named 保存: only its position tells them apart.
  const second = opened.snapshot.split('\n').filter((line) => /button "保存"/.test(line))[1]
  const clickSecond = await tools.execute(
    'browser_click',
    { ref: /\[ref=(e\d+)\]/.exec(second)[1] },
    context
  )
  assert.deepEqual(clickSecond.action.target, { role: 'button', name: '保存', nth: 1 })
  record(clickSecond)
  record(
    await tools.execute('browser_click', { ref: refOf(opened.snapshot, /button "保存"/) }, context)
  )
  record(await tools.execute('browser_wait', { text: '已保存', timeoutMs: 5000 }, context))
  for (const args of [
    { kind: 'text_visible', expected: '已保存 MX Rig 上海 true' },
    { kind: 'value_equals', ref: refOf(opened.snapshot, /textbox "项目名称"/), expected: 'MX Rig' },
    { kind: 'element_checked', ref: refOf(opened.snapshot, /checkbox "同意条款"/) },
    { kind: 'url_contains', expected: '127.0.0.1' }
  ]) {
    const { assertion } = await tools.execute('browser_assert', args, context)
    events.push({ kind: 'assertion', data: { assertion } })
  }

  const spec = exportPlaywright({
    id: '0f3c2a1b-0000-4000-8000-000000000001',
    goal: '保存项目',
    events
  })
  assert.equal(spec.steps, 11)
  assert.deepEqual(spec.warnings, [])
  assert.match(
    spec.content,
    /getByRole\("button", \{ name: "保存", exact: true \}\)\.nth\(1\)\.click\(\)/
  )
  assert.match(spec.content, /toHaveValue\("MX Rig"\)/)
  assert.equal(spec.catalogEntry.caseId, 'RIG-0F3C2A1B')

  // Replay the generated steps on a fresh page, with a minimal `expect`.
  const body = spec.content.slice(
    spec.content.indexOf('async ({ page }) => {') + 'async ({ page }) => {'.length,
    spec.content.lastIndexOf('})')
  )
  const poll = async (probe, ok, what) => {
    const deadline = Date.now() + 5000
    let last
    while (Date.now() < deadline) {
      last = await probe()
      if (ok(last)) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`${what}: ${last}`)
  }
  const expect = (subject) =>
    typeof subject.goto === 'function'
      ? {
          toHaveURL: (pattern) =>
            poll(
              () => subject.url(),
              (url) => pattern.test(url),
              'url'
            ),
          toHaveTitle: (pattern) =>
            poll(
              () => subject.title(),
              (title) => pattern.test(title),
              'title'
            )
        }
      : {
          toBeVisible: () => subject.waitFor({ state: 'visible', timeout: 5000 }),
          toBeChecked: () => poll(() => subject.isChecked(), Boolean, 'checked'),
          toHaveValue: (value) =>
            poll(
              () => subject.inputValue(),
              (actual) => actual === value,
              'value'
            ),
          toHaveCount: (count) =>
            poll(
              () => subject.count(),
              (actual) => actual === count,
              'count'
            )
        }
  const replay = new (Object.getPrototypeOf(async () => {}).constructor)('page', 'expect', body)
  // A separate context: the station's own closes any page it did not open.
  const separate = await tools.browser.newContext()
  const fresh = await separate.newPage()
  try {
    await replay(fresh, expect)
    assert.match(await fresh.locator('#status').textContent(), /已保存 MX Rig 上海 true/)
  } finally {
    await separate.close()
  }
})

test('an export says what it could not keep', async () => {
  const { exportPlaywright } = await import('../packages/runtime/export.mjs')
  const empty = exportPlaywright({ id: 'm', goal: 'g', events: [] })
  assert.equal(empty.steps, 0)
  assert.match(empty.warnings.join(), /没有可导出/)
  const failed = exportPlaywright({
    id: 'm',
    goal: 'g',
    truncated: true,
    events: [
      {
        kind: 'assertion',
        data: { assertion: { kind: 'text_visible', expected: '成功', passed: false } }
      }
    ]
  })
  assert.match(failed.content, /探索时未通过/)
  assert.match(failed.warnings.join(), /较早的工具输出已被省略/)
})

// -- the Electron station --------------------------------------------------------

test('a registered Electron app is launched and operated like a page', async (t) => {
  const { createRequire } = await import('node:module')
  const { writeFile } = await import('node:fs/promises')
  const electronPath = createRequire(import.meta.url)('electron')
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-electron-'))
  const main = join(root, 'main.cjs')
  const page =
    "<title>Fixture App</title><label>名字 <input></label><button onclick=\"document.querySelector('p').textContent='你好 '+document.querySelector('input').value\">打招呼</button><p>等待</p>"
  await writeFile(
    main,
    `const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false })
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(${JSON.stringify(page)}))
})
app.on('window-all-closed', () => app.quit())
`
  )
  const tools = new BrowserTools(root)
  tools.setElectronApps([{ id: 'fixture', name: 'Fixture', path: electronPath, args: [main] }])
  t.after(() => tools.close())
  const context = {
    policy: { browserOrigins: [], productionHosts: ['.prod.example'] },
    signal: new AbortController().signal,
    missionId: '00000000-0000-0000-0000-00000000e001'
  }
  await assert.rejects(tools.execute('electron_launch', { app: 'unregistered' }, context), {
    code: 'electron_app_unknown'
  })
  let launched
  try {
    launched = await tools.execute('electron_launch', { app: 'fixture' }, context)
  } catch (error) {
    if (error.code === 'electron_unavailable') return t.skip('这台机器无法启动 Electron')
    throw error
  }
  assert.equal(launched.title, 'Fixture App')
  assert.deepEqual(launched.action, { tool: 'electron_launch', app: 'fixture' })
  const ref = (pattern) =>
    /\[ref=(e\d+)\]/.exec(launched.snapshot.split('\n').find((line) => pattern.test(line)))[1]
  await tools.execute('browser_fill', { ref: ref(/textbox "名字"/), value: 'Rig' }, context)
  await tools.execute('browser_click', { ref: ref(/button "打招呼"/) }, context)
  const { assertion } = await tools.execute(
    'browser_assert',
    { kind: 'text_visible', expected: '你好 Rig' },
    context
  )
  assert.equal(assertion.passed, true)
  await tools.close()
  assert.equal(tools.mode, 'browser')
})

test('an Electron app’s window can be taken over like a page, its dialogs included', async (t) => {
  const { createRequire } = await import('node:module')
  const { writeFile } = await import('node:fs/promises')
  const electronPath = createRequire(import.meta.url)('electron')
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-electron-'))
  const main = join(root, 'main.cjs')
  const page =
    "<title>Fixture App</title><label>名字 <input id=\"n\"></label><button id=\"hi\" onclick=\"document.querySelector('p').textContent='你好 '+document.querySelector('input').value\">打招呼</button><button id=\"reset\" onclick=\"if(confirm('确定重置？'))document.querySelector('p').textContent='已重置'\">重置</button><p>等待</p>"
  await writeFile(
    main,
    `const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600 })
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(${JSON.stringify(page)}))
})
app.on('window-all-closed', () => app.quit())
`
  )
  const tools = new BrowserTools(root)
  tools.setElectronApps([{ id: 'fixture', name: 'Fixture', path: electronPath, args: [main] }])
  t.after(() => tools.close())
  const asked = []
  tools.onFrame = () => {}
  tools.onDialog = (info) => asked.push(info)
  const context = {
    policy: { browserOrigins: [], productionHosts: [] },
    signal: new AbortController().signal,
    missionId: '00000000-0000-0000-0000-00000000e002'
  }
  try {
    await tools.execute('electron_launch', { app: 'fixture' }, context)
  } catch (error) {
    if (error.code === 'electron_unavailable') return t.skip('这台机器无法启动 Electron')
    throw error
  }
  assert.equal(tools.canHandOver, true)
  await tools.beginManual({ reason: '在应用里输入名字', by: 'agent' })
  const at = async (selector) => {
    const box = await tools.page.locator(selector).boundingBox()
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
  }
  const click = async (selector) => {
    const point = await at(selector)
    await tools.input({ type: 'down', ...point })
    return tools.input({ type: 'up', ...point })
  }
  await click('#n')
  await tools.input({ type: 'text', text: '接管的人' })
  await click('#hi')
  await tools.page.getByText('你好 接管的人').waitFor()
  // A confirm in the app waits for the person, as on a page.
  const pending = click('#reset')
  for (let tries = 0; tries < 100 && !asked.length; tries += 1) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(asked[0]?.message, '确定重置？')
  await tools.answerDialog({ accept: true })
  await pending
  await tools.page.getByText('已重置').waitFor()
  const done = await tools.endManual()
  assert.match(done.summary, /点击 3 次、输入 1 段文字、回答了 1 个对话框/)
})
