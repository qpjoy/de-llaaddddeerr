import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../apps/server/index.mjs'
import { BrowserTools } from '../packages/runtime/browser.mjs'
import { RigClient } from '../packages/runtime/client.mjs'
import { TerminalSession } from '../packages/runtime/terminal.mjs'
import { ProcedurePlayer, procedureFromMission, readProcedure } from '../packages/runtime/procedure.mjs'
import { exportPlaywright } from '../packages/runtime/export.mjs'
import { procedureSites, scopeSites, siteDecision } from '../packages/runtime/sites.mjs'

// 站点范围 and the page's own behaviour: a test site nobody listed is one
// question away, a page loads what it needs, and what the page does by itself
// — a dialog, a download, a new tab, a jump to somewhere else — is handled
// and said, not silently refused.

async function chromium() {
  const { chromium: engine } = await import('playwright')
  const launcher = { launch: (options) => engine.launch({ ...options, headless: true, channel: 'chromium' }) }
  const probe = await launcher.launch({}).catch(() => null)
  if (!probe) return null
  await probe.close()
  return launcher
}

/**
 * One server, three sites told apart by host name: the app on 127.0.0.1,
 * another site on other.localhost (and sso.localhost), and production on
 * prod.localhost. Chromium sends every *.localhost to this machine.
 */
async function sites(t) {
  const hosts = []
  const sockets = new Set()
  let port = 0
  const app = () => `http://127.0.0.1:${port}`
  const other = () => `http://other.localhost:${port}`
  const page = (title, body) =>
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`
  const server = createServer((req, res) => {
    hosts.push(req.headers.host)
    const path = req.url.split('?')[0]
    if (path === '/lib.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      return res.end("document.getElementById('lib').textContent = '脚本已加载'")
    }
    if (path === '/api') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' })
      return res.end('接口已返回')
    }
    if (path === '/file.csv') {
      res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="file.csv"' })
      return res.end('a,b\n1,2\n')
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (path === '/tab') return res.end(page('新窗口', '<h1>新窗口</h1><button type="button" onclick="window.close()">关闭</button>'))
    if (path === '/other') return res.end(page('别的站点', `<h1>别的站点</h1><p>${req.headers.host}</p>`))
    res.end(
      page(
        '应用',
        `<h1>应用</h1>
<p id="lib">脚本没有加载</p><p id="api">接口没有返回</p><p id="ws">没有连上推送</p>
<img alt="" src="http://prod.localhost:${port}/pixel">
<script src="${other()}/lib.js"></script>
<script>
fetch('${other()}/api').then((r) => r.text()).then((t) => (document.getElementById('api').textContent = t)).catch(() => {})
const ws = new WebSocket('ws://other.localhost:${port}/ws')
ws.onopen = () => (document.getElementById('ws').textContent = '推送已连上')
</script>
<p><a href="${other()}/other">去别的站点</a> <a href="http://sso.localhost:${port}/other">去登录中心</a> <a href="/tab" target="_blank">在新窗口打开</a></p>
<button type="button" onclick="document.getElementById('out').textContent = confirm('确定删除这条记录？') ? '已删除' : '已取消'">删除</button>
<p id="out"></p>
<p><a href="/file.csv">导出</a></p>
<label for="code">短信验证码</label><input id="code" value="482913">
<label for="note">备注</label><input id="note" value="可以复制的文字">
<label for="pw">密码</label><input id="pw" type="password" value="pw-only-for-the-page">`
      )
    )
  })
  // Enough of a WebSocket server to say yes to the handshake.
  server.on('upgrade', (req, socket) => {
    hosts.push(`ws:${req.headers.host}`)
    sockets.add(socket)
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.on('error', () => {})
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
  t.after(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(resolve)
      })
  )
  return { app: app(), other: other(), sso: `http://sso.localhost:${port}`, hosts }
}

const refOf = (snapshot, pattern) =>
  /\[ref=(e\d+)\]/.exec(String(snapshot).split('\n').find((line) => pattern.test(line)) ?? '')?.[1]

const center = async (page, selector) => {
  const box = await page.locator(selector).boundingBox()
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
}

test('which sites a mission may use: listed, asked about, or never', () => {
  const policy = { browserOrigins: ['https://t.example'], productionHosts: ['.prod.example'] }
  assert.equal(siteDecision('https://t.example/a', policy).status, 'allowed')
  assert.deepEqual(siteDecision('https://new.example/a', policy), { status: 'ask', origin: 'https://new.example' })
  assert.equal(siteDecision('https://app.prod.example/', policy).status, 'denied')
  assert.equal(siteDecision('https://user:pw@new.example/', policy).status, 'denied')
  assert.equal(siteDecision('file:///etc/passwd', policy).status, 'denied')
  assert.equal(siteDecision('https://new.example/', { ...policy, browserSites: 'list' }).status, 'denied')
  // A yes holds for the mission; production can never be said yes to.
  const scoped = scopeSites(policy, ['https://new.example', 'https://app.prod.example', 'not a url'])
  assert.deepEqual(scoped.browserOrigins, ['https://t.example', 'https://new.example'])
  assert.equal(scopeSites({ ...policy, browserSites: 'list' }, ['https://new.example']).browserOrigins.length, 1)
  assert.deepEqual(
    procedureSites({
      baseUrl: 'https://t.example/app',
      steps: [{ do: 'open', url: '/login' }, { do: 'open', url: 'https://sso.example/login?x=1' }, { do: 'click' }]
    }),
    ['https://t.example', 'https://sso.example']
  )
})

test('a page loads what it needs and does what it does; the Agent is told, never stranded', async (t) => {
  const launcher = await chromium()
  if (!launcher) return t.skip('Chromium 未安装')
  const s = await sites(t)
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-sites-'))
  const tools = new BrowserTools(root, launcher, { headless: true })
  t.after(() => tools.close())
  const policy = { browserOrigins: [s.app], browserSites: 'ask', productionHosts: ['prod.localhost'] }
  const ctx = { policy, missionId: '00000000-0000-4000-8000-0000000000a1' }

  await tools.execute('browser_open', { url: `${s.app}/app` }, ctx)
  // Scripts, an API and a WebSocket on another site: the page's own business.
  await tools.page.getByText('脚本已加载').waitFor({ timeout: 5_000 })
  await tools.page.getByText('接口已返回').waitFor({ timeout: 5_000 })
  await tools.page.getByText('推送已连上').waitFor({ timeout: 5_000 })
  // Production stays closed, even to an image.
  assert.ok(!s.hosts.some((host) => host.startsWith('prod.')), 'nothing reached production')

  let { snapshot } = await tools.execute('browser_snapshot', {}, ctx)
  // A code in a field nobody marked up is still kept from the model.
  assert.ok(!snapshot.includes('482913'), 'the code is not in the snapshot')
  assert.ok(!snapshot.includes('pw-only-for-the-page'))
  assert.match(snapshot, /textbox "短信验证码"[^\n]*: "?••••••/)
  assert.match(snapshot, /可以复制的文字/, 'ordinary fields are untouched')

  // A jump to a site nobody said yes to: stopped, said, and the page is back.
  const away = await tools.execute('browser_click', { ref: refOf(snapshot, /link "去别的站点"/) }, ctx)
  assert.equal(away.blocked, `${s.other}/other`)
  assert.match(away.notice, /还没有确认过[\s\S]*browser_open/)
  assert.equal(away.url, `${s.app}/app`)
  snapshot = away.snapshot

  // A new tab is followed, and closing it brings the page back.
  const tab = await tools.execute('browser_click', { ref: refOf(snapshot, /link "在新窗口打开"/) }, ctx)
  assert.equal(tab.url, `${s.app}/tab`)
  assert.match(tab.notice, /新标签页/)
  const closed = await tools.execute('browser_click', { ref: refOf(tab.snapshot, /button "关闭"/) }, ctx)
  assert.equal(closed.url, `${s.app}/app`)
  assert.match(closed.notice, /回到了上一个页面/)
  snapshot = closed.snapshot

  // A confirm: cancelled unless the action said yes, and either way said.
  const kept = await tools.execute('browser_click', { ref: refOf(snapshot, /button "删除"/) }, ctx)
  assert.deepEqual(kept.dialogs, [{ type: 'confirm', message: '确定删除这条记录？', answer: 'dismiss' }])
  assert.match(kept.notice, /dialog: "accept"/)
  assert.equal(await tools.page.locator('#out').textContent(), '已取消')
  const removed = await tools.execute('browser_click', { ref: refOf(kept.snapshot, /button "删除"/), dialog: 'accept' }, ctx)
  assert.equal(removed.dialogs[0].answer, 'accept')
  assert.equal(await tools.page.locator('#out').textContent(), '已删除')
  assert.equal(removed.action.dialog, 'accept', 'the yes travels with the step')
  assert.match(tools.describe('browser_click', { ref: refOf(removed.snapshot, /button "删除"/), dialog: 'accept' }), /弹出确认框时点「确定」/)

  // A download is kept with the mission's evidence.
  const exported = await tools.execute('browser_click', { ref: refOf(removed.snapshot, /link "导出"/) }, ctx)
  assert.equal(exported.downloads[0].name, 'file.csv')
  assert.equal(await readFile(join(root, exported.downloads[0].file), 'utf8'), 'a,b\n1,2\n')
  assert.match(exported.notice, /下载了 file\.csv/)
})

test('when the admin allows the list only, the old edges hold', async (t) => {
  const launcher = await chromium()
  if (!launcher) return t.skip('Chromium 未安装')
  const s = await sites(t)
  const tools = new BrowserTools(await mkdtemp(join(tmpdir(), 'mx-rig-sites-')), launcher, { headless: true })
  t.after(() => tools.close())
  const policy = { browserOrigins: [s.app], browserSites: 'list', productionHosts: [] }
  await tools.execute('browser_open', { url: `${s.app}/app` }, { policy, missionId: '00000000-0000-4000-8000-0000000000a2' })
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(await tools.page.locator('#lib').textContent(), '脚本没有加载')
  assert.equal(await tools.page.locator('#ws').textContent(), '没有连上推送')
  await assert.rejects(tools.precheck('browser_open', { url: `${s.other}/other` }, { policy }), {
    code: 'origin_denied',
    message: /只允许列表内的站点/
  })
})

test('during takeover the person goes anywhere, answers the page’s dialogs and copies from it', async (t) => {
  const launcher = await chromium()
  if (!launcher) return t.skip('Chromium 未安装')
  const s = await sites(t)
  const tools = new BrowserTools(await mkdtemp(join(tmpdir(), 'mx-rig-sites-')), launcher, { headless: true })
  t.after(() => tools.close())
  const asked = []
  tools.onFrame = () => {}
  tools.onDialog = (info) => asked.push(info)
  const policy = { browserOrigins: [s.app], productionHosts: [] }
  await tools.execute('browser_open', { url: `${s.app}/app` }, { policy, missionId: '00000000-0000-4000-8000-0000000000a3' })
  await tools.beginManual({ reason: '删除这条记录', by: 'agent' })

  // The page's confirm waits for the person, in the pane. The click that
  // raised it finishes once it is answered — the pane's answer does not wait
  // behind the person's queued input.
  const button = await center(tools.page, 'button')
  await tools.input({ type: 'down', ...button })
  const up = tools.input({ type: 'up', ...button })
  for (let tries = 0; tries < 100 && !asked.length; tries += 1) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(asked.map(({ type, message }) => ({ type, message })), [{ type: 'confirm', message: '确定删除这条记录？' }])
  await tools.answerDialog({ accept: true })
  await up
  await tools.page.getByText('已删除').waitFor()
  await assert.rejects(tools.answerDialog({ accept: true }), { code: 'no_dialog' })

  // Copy: the selection comes back for the person's clipboard; a password never does.
  await tools.page.locator('#note').evaluate((field) => {
    field.focus()
    field.select()
  })
  assert.deepEqual(await tools.copy(), { text: '可以复制的文字' })
  await tools.page.locator('#pw').evaluate((field) => {
    field.focus()
    field.select()
  })
  await assert.rejects(tools.copy(), { code: 'sensitive_field' })

  // A site nobody listed: the person may simply go there.
  const link = await center(tools.page, 'a[href*="sso.localhost"]')
  await tools.input({ type: 'down', ...link })
  await tools.input({ type: 'up', ...link })
  await tools.page.waitForURL(`${s.sso}/other`)
  const done = await tools.endManual()
  assert.equal(done.url, `${s.sso}/other`)
  assert.equal(done.counts.dialogs, 1)
  assert.equal(done.counts.copies, 1)
  assert.match(done.summary, /回答了 1 个对话框、复制 1 次/)
  await assert.rejects(tools.copy(), { code: 'not_in_takeover' })
})

test('a member says yes to a site once; a person’s own detour counts; production is never asked about', async (t) => {
  const launcher = await chromium()
  if (!launcher) return t.skip('Chromium 未安装')
  const s = await sites(t)
  const requests = []
  const script = [
    () => ({ tool: 'browser_open', args: { url: `${s.app}/app` } }),
    () => ({ tool: 'browser_open', args: { url: 'http://prod.localhost:1/' } }),
    (body) => {
      // Refused before anyone was asked.
      assert.equal(JSON.parse(body.messages.at(-1).content).error.code, 'origin_denied')
      return { tool: 'browser_snapshot', args: {} }
    },
    (body) => ({ tool: 'browser_click', args: { ref: refOf(JSON.parse(body.messages.at(-1).content).snapshot, /link "去别的站点"/) } }),
    (body) => {
      const result = JSON.parse(body.messages.at(-1).content)
      assert.match(result.notice, /browser_open/)
      return { tool: 'browser_open', args: { url: result.blocked } }
    },
    () => ({ tool: 'browser_open', args: { url: `${s.app}/app` } }),
    () => ({ tool: 'browser_handoff', args: { reason: '去登录中心登录' } }),
    (body) => {
      const back = body.messages.findLast((message) => message.role === 'user').content
      assert.match(back, /你请我帮忙：去登录中心登录/)
      return { tool: 'browser_snapshot', args: {} }
    },
    () => ({ answer: '去过三个站点。' })
  ]
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
  const state = await mkdtemp(join(tmpdir(), 'mx-rig-sites-'))
  const server = await start(
    {
      MX_RIG_ADMIN_TOKEN: 'sites-admin',
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: join(state, 'control'),
      MX_RIG_ARTIFACTS_DIR: join(state, 'artifacts')
    },
    { schedule: false, modelOptions: { environment: { MX_RIG_MODEL_API_KEY: 'k' }, fetchImpl } }
  )
  t.after(() => server.close())
  // Out of the box: browser tools on, no site listed, production named.
  await server.settings.update({
    ...server.settings.value,
    productionHosts: ['prod.localhost'],
    providers: [
      { id: 'p', displayName: 'p', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKeyEnv: 'MX_RIG_MODEL_API_KEY', timeoutMs: 60_000, enabled: true, stream: false }
    ],
    sequence: ['p']
  })
  assert.deepEqual(server.settings.value.browserOrigins, [])
  assert.equal(server.settings.value.browserSites, 'ask')
  const client = new RigClient({ url: server.origin, token: 'sites-admin' })
  const { principal } = await client.request('/api/rig/v1/me')
  const browser = new BrowserTools(join(state, 'artifacts-local'), launcher, { headless: true })
  browser.onFrame = () => {}
  const session = await new TerminalSession({
    client,
    owner: principal.id,
    home: join(state, 'home'),
    workspaceRoot: state,
    browser
  }).init()
  t.after(() => session.close())

  const asked = []
  const row = await session.ask('走一遍三个站点', {
    decide: async (request) => {
      asked.push(request)
      if (!request.takeover) return 'yes'
      const link = await center(browser.page, 'a[href*="sso.localhost"]')
      await browser.input({ type: 'down', ...link })
      await browser.input({ type: 'up', ...link })
      await browser.page.waitForURL(`${s.sso}/other`)
      return 'yes'
    }
  })
  assert.equal(row.status, 'completed', JSON.stringify(row.events.at(-1)))
  // Asked about twice — the app and the other site — and once more opening
  // the app again cost no question about the site.
  const opens = asked.filter((request) => request.tool === 'browser_open')
  assert.equal(opens.length, 3)
  assert.match(opens[0].preview, /还没有确认过/)
  assert.match(opens[1].preview, /还没有确认过/)
  assert.doesNotMatch(opens[2].preview, /还没有确认过/)
  assert.ok(!asked.some((request) => /prod\.localhost/.test(JSON.stringify(request))), 'production was never a question')
  assert.deepEqual(row.sites, [s.app, s.other, s.sso])
  assert.deepEqual(
    row.events.filter((event) => event.kind === 'site').map((event) => event.data.how),
    ['发起人确认', '发起人确认', '接管时由人打开']
  )
})

test('a saved procedure answers the confirm it was saved with, and the script does too', async (t) => {
  const launcher = await chromium()
  if (!launcher) return t.skip('Chromium 未安装')
  const s = await sites(t)
  const mission = {
    goal: '删除一条记录',
    events: [
      { kind: 'tool_result', data: { action: { tool: 'browser_open', url: `${s.app}/app` }, result: {} } },
      {
        kind: 'tool_result',
        data: { action: { tool: 'browser_click', target: { role: 'button', name: '删除' }, dialog: 'accept' }, result: {} }
      }
    ]
  }
  const { procedure: draft } = procedureFromMission(mission, { title: '删除记录' })
  assert.deepEqual(draft.steps[1], { do: 'click', target: { role: 'button', name: '删除' }, dialog: 'accept' })
  assert.match(exportPlaywright(mission).content, /page\.once\('dialog', \(dialog\) => dialog\.accept\(\)\)\n\s+await page\.getByRole\("button", \{ name: "删除", exact: true \}\)\.click\(\)/)

  const procedure = {
    id: 'prc_dialog',
    revision: 1,
    ...readProcedure({
      title: '删除记录',
      app: 'demo',
      baseUrl: s.app,
      steps: [...draft.steps, { do: 'assert', kind: 'text_visible', expected: '已删除' }]
    })
  }
  const tools = new BrowserTools(await mkdtemp(join(tmpdir(), 'mx-rig-sites-')), launcher, { headless: true })
  t.after(() => tools.close())
  // Nobody listed the site: the procedure brings it.
  const result = await new ProcedurePlayer(tools).run(procedure, { policy: { browserOrigins: [], productionHosts: [] }, runId: 'dialog' })
  assert.equal(result.verdict, 'passed', JSON.stringify(result.failure))
})
