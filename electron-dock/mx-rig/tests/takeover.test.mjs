import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../apps/server/index.mjs'
import { BrowserTools, redactSecrets } from '../packages/runtime/browser.mjs'
import { RigClient } from '../packages/runtime/client.mjs'
import { TerminalSession } from '../packages/runtime/terminal.mjs'
import { usableTools } from '../packages/runtime/tools.mjs'
import { replayFrames } from '../packages/runtime/replay.mjs'

// 接管: a person drives the page the Agent was driving — typing the password
// it must not type — and hands it back. What they typed reaches the page and
// nowhere else.

const SECRET = 'hunter2-only-for-the-page'

async function chromium() {
  const { chromium: engine } = await import('playwright')
  const launcher = { launch: (options) => engine.launch({ ...options, headless: true, channel: 'chromium' }) }
  const probe = await launcher.launch({}).catch(() => null)
  if (!probe) return null
  await probe.close()
  return launcher
}

async function loginSite(t) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (req.url.startsWith('/upload'))
      return res.end(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>上传</title></head><body><label for="f">附件</label><input id="f" type="file"><p id="name"></p><script>document.getElementById("f").onchange=(e)=>document.getElementById("name").textContent="已选择 "+e.target.files[0].name</script></body></html>'
      )
    res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>登录</title></head><body>
<form id="login"><label for="u">账号</label><input id="u" value="tester"><label for="p">密码</label><input id="p" type="password" autocomplete="current-password"><button type="submit">登录</button></form>
<p id="out"></p>
<script>document.getElementById('login').onsubmit=(e)=>{e.preventDefault();const ok=document.getElementById('p').value==='${SECRET}';document.getElementById('out').textContent=ok?'欢迎回来，tester':'密码错误'}</script>
</body></html>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

const center = async (page, selector) => {
  const box = await page.locator(selector).boundingBox()
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
}

test('a person’s input reaches the page only during takeover, and only its kind is counted', async (t) => {
  const launcher = await chromium()
  if (!launcher) return t.skip('Chromium 未安装')
  const origin = await loginSite(t)
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-takeover-'))
  const tools = new BrowserTools(root, launcher, { headless: true })
  tools.onFrame = () => {}
  t.after(() => tools.close())
  const chooser = []
  tools.onChooser = (info) => chooser.push(info)
  const context = {
    policy: { browserOrigins: [origin], productionHosts: [], egress: {} },
    signal: new AbortController().signal,
    missionId: '00000000-0000-4000-8000-0000000000c1'
  }
  await tools.execute('browser_open', { url: `${origin}/login` }, context)
  assert.equal(tools.canHandOver, true, 'a pane is watching')
  await assert.rejects(tools.input({ type: 'text', text: 'x' }), { code: 'not_in_takeover' })

  // What can never be done is refused before anyone is asked, and a
  // password is not read back through an assertion either.
  const opened = await tools.execute('browser_snapshot', {}, context)
  const password = /\[ref=(e\d+)\]/.exec(opened.snapshot.split('\n').find((line) => /textbox "密码"/.test(line)))[1]
  await assert.rejects(tools.precheck('browser_fill', { ref: password, value: 'x' }), { code: 'sensitive_field' })
  await assert.rejects(tools.execute('browser_assert', { kind: 'value_equals', ref: password, expected: 'x' }, context), {
    code: 'sensitive_field'
  })

  await tools.beginManual({ reason: '输入密码并登录', by: 'agent' })
  const field = await center(tools.page, '#p')
  await tools.input({ type: 'down', ...field, button: 'left', clickCount: 1 })
  await tools.input({ type: 'up', ...field, button: 'left', clickCount: 1 })
  // Key by key, as the live pane sends it, with a typo put right: still one
  // stretch of typing — a count per character would give away the length.
  for (const char of `${SECRET}x`) await tools.input({ type: 'text', text: char })
  await tools.input({ type: 'key', key: 'Backspace' })
  await tools.input({ type: 'key', key: 'Enter' })
  await tools.page.getByText('欢迎回来，tester').waitFor()
  await tools.input({ type: 'wheel', ...field, dx: 0, dy: 40 })
  await assert.rejects(tools.input({ type: 'key', key: 'Control+Shift+Alt+Meta+Enter' }), { code: 'invalid_input' })
  await assert.rejects(tools.input({ type: 'down', x: -1, y: 5 }), { code: 'invalid_input' })
  await assert.rejects(tools.input({ type: 'teleport' }), { code: 'invalid_input' })

  const done = await tools.endManual()
  assert.equal(done.summary, '点击 1 次、输入 1 段文字、按键 2 次、滚动 1 次')
  assert.deepEqual(done.counts, { clicks: 1, typing: 1, keys: 2, scrolls: 1, files: 0, dialogs: 0, copies: 0, downloads: 0 })
  assert.ok(await stat(join(root, done.screenshot)))
  assert.ok(!JSON.stringify(done).includes(SECRET), 'the record of it holds no content')
  await assert.rejects(tools.input({ type: 'text', text: 'late' }), { code: 'not_in_takeover' })

  // A page asking for a file: held for the pane, answered with what the person picked.
  await tools.execute('browser_open', { url: `${origin}/upload` }, context)
  await tools.beginManual({ reason: '选择附件' })
  const input = await center(tools.page, '#f')
  await tools.input({ type: 'down', ...input, button: 'left' })
  await tools.input({ type: 'up', ...input, button: 'left' })
  for (let tries = 0; tries < 50 && !chooser.length; tries += 1) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(chooser, [{ missionId: context.missionId, multiple: false }])
  const file = join(root, 'fixture.txt')
  await writeFile(file, 'attachment')
  assert.deepEqual(await tools.chooseFiles([file]), { files: 1 })
  await tools.page.getByText('已选择 fixture.txt').waitFor()
  assert.equal((await tools.endManual()).counts.files, 1)
})

test('the Agent asks for the password instead of failing; the person types it; the mission goes on', async (t) => {
  const launcher = await chromium()
  if (!launcher) return t.skip('Chromium 未安装')
  const origin = await loginSite(t)
  const requests = []
  const script = [
    () => ({ tool: 'browser_open', args: { url: `${origin}/login` } }),
    (body) => ({ tool: 'browser_fill', args: { ref: ref(body, /textbox "密码"/) ?? ref(body, /密码/), value: 'guess' } }),
    (body) => {
      // Refused: the Agent does not type passwords. It asks for a person.
      assert.equal(JSON.parse(body.messages.at(-1).content).error.code, 'sensitive_field')
      assert.match(JSON.parse(body.messages.at(-1).content).error.message, /browser_handoff/)
      return { tool: 'browser_handoff', args: { reason: '在密码框里输入测试账号的密码并点登录', ref: refs.password } }
    },
    (body) => {
      const back = body.messages.findLast((message) => message.role === 'user').content
      assert.match(back, /你请我帮忙：在密码框里输入测试账号的密码并点登录/)
      assert.match(back, /点击 \d+ 次/)
      assert.match(back, /补充说明：已经登录了，接着检查欢迎语/)
      assert.match(back, /我输入的内容不会告诉你/)
      return { tool: 'browser_snapshot', args: {} }
    },
    () => ({ tool: 'browser_assert', args: { kind: 'text_visible', expected: '欢迎回来' } }),
    () => ({ answer: '登录后页面显示「欢迎回来，tester」，断言通过。密码由测试人员输入。' })
  ]
  const refs = {}
  function ref(body, pattern) {
    const snapshot = [...body.messages].reverse().map((message) => {
      try {
        return JSON.parse(message.content).snapshot
      } catch {
        return null
      }
    }).find(Boolean) ?? ''
    const found = /\[ref=(e\d+)\]/.exec(snapshot.split('\n').find((line) => pattern.test(line)) ?? '')?.[1]
    if (found && /密码/.test(String(pattern))) refs.password = found
    return found
  }
  let turn = 0
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    requests.push(init.body)
    const reply = script[turn++](body)
    const message = reply.tool
      ? { role: 'assistant', content: null, tool_calls: [{ id: `c${turn}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }
      : { role: 'assistant', content: reply.answer }
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: reply.tool ? 'tool_calls' : 'stop' }] }), {
      headers: { 'content-type': 'application/json' }
    })
  }
  const state = await mkdtemp(join(tmpdir(), 'mx-rig-handoff-'))
  const server = await start(
    {
      MX_RIG_ADMIN_TOKEN: 'handoff-admin',
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: join(state, 'control'),
      MX_RIG_ARTIFACTS_DIR: join(state, 'artifacts')
    },
    { schedule: false, modelOptions: { environment: { MX_RIG_MODEL_API_KEY: 'k' }, fetchImpl } }
  )
  t.after(() => server.close())
  await server.settings.update({
    ...server.settings.value,
    allowedTools: [...server.settings.value.allowedTools, 'browser_open', 'browser_snapshot', 'browser_fill', 'browser_click', 'browser_assert'],
    browserOrigins: [origin],
    providers: [
      { id: 'p', displayName: 'p', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKeyEnv: 'MX_RIG_MODEL_API_KEY', timeoutMs: 60_000, enabled: true, stream: false }
    ],
    sequence: ['p']
  })
  assert.ok(server.settings.value.allowedTools.includes('browser_handoff'), 'on by default for new deployments')
  const client = new RigClient({ url: server.origin, token: 'handoff-admin' })
  const { principal } = await client.request('/api/rig/v1/me')
  const browser = new BrowserTools(join(state, 'artifacts-local'), launcher, { headless: true })
  browser.onFrame = () => {} // a pane is watching, so a person can take over
  const session = await new TerminalSession({
    client,
    owner: principal.id,
    home: join(state, 'home'),
    workspaceRoot: state,
    browser
  }).init()
  t.after(() => session.close())

  const asked = []
  const row = await session.ask('用测试账号登录，确认欢迎语', {
    decide: async (request) => {
      asked.push(request)
      if (!request.takeover) return 'yes'
      // The person, at the pane: click the password field, type, press Enter.
      const field = await center(browser.page, '#p')
      await browser.input({ type: 'down', ...field, button: 'left' })
      await browser.input({ type: 'up', ...field, button: 'left' })
      await browser.input({ type: 'text', text: SECRET })
      await browser.input({ type: 'key', key: 'Enter' })
      await browser.page.getByText('欢迎回来').waitFor()
      return { answer: 'yes', note: '已经登录了，接着检查欢迎语' }
    }
  })
  assert.equal(row.status, 'completed', JSON.stringify(row.events.at(-1)))
  const takeover = asked.find((request) => request.takeover)
  assert.equal(takeover.reason, '在密码框里输入测试账号的密码并点登录')
  assert.equal(takeover.title, 'Agent 请你来操作浏览器')

  // Nowhere but the page.
  // Not even in the snapshot after login, where the password field still
  // holds it: sensitive values are redacted before anything leaves the page.
  assert.ok(!requests.some((body) => body.includes(SECRET)), 'never sent to the model')
  assert.ok(requests.some((body) => body.includes('[ref=e2]: ••••••')), 'the field is shown as filled, not what it holds')
  assert.ok(!JSON.stringify(row).includes(SECRET), 'never in the mission record')
  const handoff = row.events.find((event) => event.kind === 'handoff')
  assert.match(handoff.message, /Agent 请你来操作：在密码框里输入/)
  const ended = row.events.findLast((event) => event.kind === 'takeover')
  assert.match(ended.message, /人工操作结束，已交还给 Agent：点击 1 次、输入 1 段文字、按键 1 次；补充说明：已经登录了/)
  assert.deepEqual(ended.data.manual, { clicks: 1, typing: 1, keys: 1, scrolls: 0, files: 0, dialogs: 0, copies: 0, downloads: 0 })

  // In the replay, the person's part is a step of its own.
  const frames = replayFrames(row.events)
  const manual = frames.find((frame) => frame.manual)
  assert.equal(manual.label, '人工操作：在密码框里输入测试账号的密码并点登录')
  const png = await readFile(join(browser.root, manual.image))
  assert.ok(png.length > 1000)
  assert.ok(frames.some((frame) => frame.assertion === true))
  assert.ok(frames.some((frame) => frame.label === '观察页面'), 'a step without a caption of its own reads as one')

  // In the activity view, the refused fill is neither done nor a failure.
  const { activityBlocks, stepsSummary } = await import('../apps/web/activity.js')
  const first = activityBlocks(row).find((block) => block.kind === 'steps')
  assert.equal(stepsSummary(first.steps), '打开了 1 个页面，请你接手 1 次，按规则拒绝 1 步')
})

test('what sensitive fields hold never reaches the model, even when it cannot be read', () => {
  const yaml = ['- textbox "账号": tester', '- textbox "密码": hunter22', '- paragraph: 欢迎 hunter22', '- textbox "验证码": 42'].join('\n')
  assert.equal(
    redactSecrets(yaml, ['hunter22', '42']),
    ['- textbox "账号": tester', '- textbox "密码": ••••••', '- paragraph: 欢迎 ••••••', '- textbox "验证码": ••••••'].join('\n')
  )
  // A short value only goes where it is a field's value: "42" in text stays.
  assert.equal(redactSecrets('- paragraph: 第 42 页', ['42']), '- paragraph: 第 42 页')
  // Could not ask the page: every field is blanked rather than one leaked.
  assert.equal(
    redactSecrets(yaml, null),
    ['- textbox "账号": ••••••', '- textbox "密码": ••••••', '- paragraph: 欢迎 hunter22', '- textbox "验证码": ••••••'].join('\n')
  )
  // Handing over needs a page to hand over.
  assert.deepEqual(usableTools(['browser_handoff', 'tests_list']), ['tests_list'])
  assert.deepEqual(usableTools(['browser_open', 'browser_handoff']), ['browser_open', 'browser_handoff'])
})

test('a drag in the pane drags on the page: a slider moves', async (t) => {
  const launcher = await chromium()
  if (!launcher) return t.skip('Chromium 未安装')
  const origin = await loginSite(t)
  const tools = new BrowserTools(await mkdtemp(join(tmpdir(), 'mx-rig-drag-')), launcher, { headless: true })
  t.after(() => tools.close())
  tools.onFrame = () => {}
  await tools.execute('browser_open', { url: `${origin}/login` }, {
    policy: { browserOrigins: [origin], productionHosts: [] },
    missionId: '00000000-0000-4000-8000-0000000000d1'
  })
  await tools.page.setContent('<input type="range" id="r" min="0" max="100" value="0" style="width:400px;margin:40px">')
  await tools.beginManual({ reason: '把滑块拖到最右边', by: 'agent' })
  const box = await tools.page.locator('#r').boundingBox()
  const y = Math.round(box.y + box.height / 2)
  await tools.input({ type: 'down', x: Math.round(box.x + 2), y })
  for (let x = box.x + 40; x <= box.x + box.width + 20; x += 40) await tools.input({ type: 'move', x: Math.round(x), y })
  await tools.input({ type: 'up', x: Math.round(box.x + box.width + 20), y })
  assert.equal(await tools.page.locator('#r').inputValue(), '100')
  assert.equal((await tools.endManual()).counts.clicks, 1)
})

test('a native app is handed over as it is: the person uses its own window', async () => {
  const native = { current: { id: 'calc', name: '计算器', bundleId: 'com.apple.calculator' }, close() {}, setApps() {} }
  const tools = new BrowserTools(await mkdtemp(join(tmpdir(), 'mx-rig-native-')), undefined, { headless: true, native })
  assert.equal(tools.canHandOver, true)
  assert.equal(tools.surface, 'native')
  await tools.beginManual({ reason: '在计算器里输入 PIN', by: 'agent' })
  await assert.rejects(tools.input({ type: 'text', text: 'x' }), { code: 'not_in_takeover' })
  const done = await tools.endManual()
  assert.match(done.summary, /在 计算器 的窗口里操作/)
  assert.equal(done.screenshot, null)
  // An Agent with only the native station still gets to ask a person.
  assert.deepEqual(usableTools(['native_launch', 'browser_handoff']), ['native_launch', 'browser_handoff'])
})
