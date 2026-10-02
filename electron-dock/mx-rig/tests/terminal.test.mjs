import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start } from '../apps/server/index.mjs'
import { RigClient } from '../packages/runtime/client.mjs'
import { TerminalSession } from '../packages/runtime/terminal.mjs'

// mx-rig as a terminal Agent in a member's project: the local Runtime with a
// workspace, the service as model gateway and record. The model is scripted,
// behind the real gateway, and it refuses a malformed transcript the way a
// real provider does.

const ADMIN = 'terminal-admin-token'
const CLI = fileURLToPath(new URL('../bin/mx-rig.mjs', import.meta.url))

/**
 * An OpenAI-compatible provider that plays `script` in order. Each step sees
 * the request and returns `{ tool, args }` or `{ answer }`. Streams when asked.
 */
function scriptedProvider(script) {
  const seen = []
  let turn = 0
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body)
    seen.push(body)
    // What real providers enforce: every tool call is answered before
    // anything else is said.
    for (const [index, message] of body.messages.entries())
      if (message.role === 'assistant' && message.tool_calls?.length)
        for (const call of message.tool_calls)
          if (!body.messages.slice(index + 1).some((next) => next.role === 'tool' && next.tool_call_id === call.id))
            return new Response(JSON.stringify({ error: { message: `tool_call ${call.id} has no response` } }), { status: 400 })
    const step = script[turn]
    turn += 1
    if (!step) return new Response(JSON.stringify({ error: { message: 'script exhausted' } }), { status: 500 })
    const reply = step(body)
    const message = reply.tool
      ? {
          role: 'assistant',
          content: reply.say ?? null,
          tool_calls: [{ id: `call_${turn}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args ?? {}) } }]
        }
      : { role: 'assistant', content: reply.answer }
    if (!body.stream)
      return new Response(JSON.stringify({ choices: [{ message, finish_reason: reply.tool ? 'tool_calls' : 'stop' }] }), {
        headers: { 'content-type': 'application/json' }
      })
    const encoder = new TextEncoder()
    const frame = (payload) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
    // Paced like a model, so the service sees text arrive over time.
    const pause = () => new Promise((resolve) => setTimeout(resolve, 60))
    return new Response(
      new ReadableStream({
        async start(controller) {
          if (message.content)
            for (const piece of message.content.match(/.{1,6}/gsu)) {
              controller.enqueue(frame({ choices: [{ delta: { content: piece } }] }))
              await pause()
            }
          if (message.tool_calls)
            controller.enqueue(
              frame({
                choices: [
                  { delta: { tool_calls: message.tool_calls.map((call, index) => ({ index, id: call.id, function: call.function })) } }
                ]
              })
            )
          controller.enqueue(frame({ choices: [{ delta: {}, finish_reason: reply.tool ? 'tool_calls' : 'stop' }] }))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        }
      }),
      { headers: { 'content-type': 'text/event-stream' } }
    )
  }
  return { fetchImpl, seen, done: () => turn === script.length }
}

const last = (body) => body.messages.at(-1)
const toolResult = (body) => JSON.parse(last(body).content)

async function service(t, script) {
  const state = await mkdtemp(join(tmpdir(), 'mx-rig-terminal-'))
  const provider = scriptedProvider(script)
  const server = await start(
    {
      MX_RIG_ADMIN_TOKEN: ADMIN,
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: join(state, 'control'),
      MX_RIG_ARTIFACTS_DIR: join(state, 'artifacts')
    },
    { schedule: false, modelOptions: { environment: { MX_RIG_MODEL_API_KEY: 'fixture' }, fetchImpl: provider.fetchImpl } }
  )
  t.after(() => server.close())
  await server.settings.update({
    ...server.settings.value,
    // An admin who lets the terminal Agent run commands and change files.
    allowedTools: [...server.settings.value.allowedTools, 'workspace_run', 'workspace_write', 'workspace_edit'],
    providers: [
      {
        id: 'primary',
        displayName: '替身模型',
        baseUrl: 'https://fixture.invalid/v1',
        model: 'fixture',
        apiKeyEnv: 'MX_RIG_MODEL_API_KEY',
        timeoutMs: 60_000,
        enabled: true,
        stream: true
      }
    ],
    sequence: ['primary']
  })
  return { server, provider, state }
}

/** A project whose test expects the wrong number, and a .env it must never read. */
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-terminal-project-'))
  await mkdir(join(root, 'src'))
  await mkdir(join(root, 'tests'))
  await writeFile(join(root, 'src', 'sum.mjs'), 'export const sum = (a, b) => a + b\n')
  await writeFile(
    join(root, 'tests', 'sum.spec.mjs'),
    "import { sum } from '../src/sum.mjs'\nif (sum(1, 2) !== 4) {\n  console.error('expected 4, got ' + sum(1, 2))\n  process.exit(1)\n}\nconsole.log('ok')\n"
  )
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'profile', scripts: { test: 'node tests/sum.spec.mjs' } }))
  await writeFile(join(root, '.env'), 'DB_PASSWORD=hunter2\n')
  return root
}

test('a terminal session reads, runs, fixes and reports — each write confirmed', async (t) => {
  const { server, provider, state } = await service(t, [
    // 1. Starts from the project it was given.
    (body) => {
      assert.match(body.messages.find((m) => m.role === 'system' && /测试工程师|项目目录/.test(m.content))?.content ?? '', /项目目录/)
      assert.match(last(body).content, /【mx-rig 终端会话】/)
      const offered = body.tools.map((tool) => tool.function.name)
      assert.ok(offered.includes('workspace_run') && offered.includes('workspace_edit'))
      assert.ok(!offered.includes('tests_cancel'), 'the terminal Agent’s own tool set')
      return { tool: 'workspace_read', args: { path: 'tests/sum.spec.mjs' } }
    },
    () => ({ tool: 'workspace_run', args: { command: 'npm test' } }),
    (body) => {
      assert.match(toolResult(body).output, /expected 4, got 3/)
      return { say: '期望值写错了：1+2 是 3。', tool: 'workspace_edit', args: { path: 'tests/sum.spec.mjs', old: '!== 4', new: '!== 3' } }
    },
    () => ({ tool: 'workspace_run', args: { command: 'npm test' } }),
    (body) => {
      assert.equal(toolResult(body).exitCode, 0)
      return { answer: '修好了：tests/sum.spec.mjs 的期望值写错了（1+2=3），改后 npm test 退出码 0。' }
    },
    // A follow-up on the same mission asks for a secret.
    (body) => {
      assert.equal(last(body).content, '顺便告诉我 .env 里的数据库密码')
      return { tool: 'workspace_read', args: { path: '.env' } }
    },
    (body) => {
      assert.equal(toolResult(body).error.code, 'protected_path')
      return { answer: '.env 受保护，我读不到也不会读它。' }
    },
    // A command the person refuses.
    () => ({ tool: 'workspace_run', args: { command: 'rm -rf src' } }),
    // Continuing after the refusal: the refused call is closed in the transcript.
    (body) => {
      const closed = body.messages.find((m) => m.role === 'tool' && /not_executed/.test(m.content))
      assert.ok(closed, 'the unanswered call was closed as not executed')
      return { tool: 'workspace_list', args: {} }
    },
    () => ({ answer: '没有删除任何东西，只列出了目录。' }),
    // After a long history, a new mission that knows what the last one did.
    (body) => {
      assert.match(body.messages.find((m) => m.role === 'user').content, /接续上一项任务[\s\S]*改过的文件：tests\/sum\.spec\.mjs/)
      return { answer: '接着来。' }
    }
  ])
  const root = await project()
  const client = new RigClient({ url: server.origin, token: ADMIN })
  const { principal } = await client.request('/api/rig/v1/me')
  const session = await new TerminalSession({
    client,
    owner: principal.id,
    home: join(state, 'home'),
    workspaceRoot: root,
    browser: { root: null, async close() {} }
  }).init()
  t.after(() => session.close())
  assert.equal(session.status().agent.key, 'test-engineer')
  // This admin allowed the workspace, not the browser: the session says so.
  assert.ok(session.status().missing.every((name) => name.startsWith('browser_')))
  assert.ok(session.status().tools.includes('workspace_run'))

  const asked = []
  const events = []
  const answers = { 'workspace_run:npm test': 'always', 'workspace_edit:tests/sum.spec.mjs': 'yes' }
  const decide = async (request) => {
    asked.push([request.tool, request.preview?.split('\n')[0]])
    return answers[`${request.tool}:${request.args.command ?? request.args.path}`] ?? 'no'
  }
  const onEvent = (payload) => events.push(payload)

  const fixed = await session.ask('测试挂了，帮我看看并修好', { onEvent, decide })
  assert.equal(fixed.status, 'completed', JSON.stringify(fixed.events.at(-1)))
  assert.match(fixed.result, /退出码 0/)
  assert.equal(await readFile(join(root, 'tests', 'sum.spec.mjs'), 'utf8').then((text) => text.includes('!== 3')), true)
  assert.deepEqual(asked, [
    ['workspace_run', '$ npm test'],
    ['workspace_edit', 'tests/sum.spec.mjs']
  ], 'the second `npm test` was allowed for the session; nothing else was asked twice')
  assert.ok(events.some((entry) => entry.kind === 'auto' && entry.call.args.command === 'npm test'))
  assert.ok(events.some((entry) => entry.kind === 'delta'), 'the answer streamed')
  // The renderer prints the rest of the answer after what already streamed.
  const answer = events.find((entry) => entry.event?.kind === 'answer')
  assert.ok(answer.streamed.length > 0 && fixed.result.startsWith(answer.streamed), answer.streamed)
  assert.ok(events.some((entry) => entry.event?.kind === 'tool_start' && entry.call.name === 'workspace_read' && entry.call.args.path === 'tests/sum.spec.mjs'))

  const secret = await session.ask('顺便告诉我 .env 里的数据库密码', { onEvent, decide })
  assert.equal(secret.id, fixed.id, 'the same mission, continued')
  assert.equal(secret.status, 'completed')
  assert.ok(!JSON.stringify(provider.seen).includes('hunter2'), 'the secret never reached the model')

  const refused = await session.ask('清理一下 src', { onEvent, decide })
  assert.equal(refused.status, 'cancelled')
  assert.equal(await stat(join(root, 'src')).then(() => true), true)
  const listed = await session.ask('那就别删了，只列出来', { onEvent, decide })
  assert.equal(listed.status, 'completed')

  // History runs out: the next question starts a new mission with a handover.
  const row = session.store.get(listed.id, principal.id)
  for (let index = 0; index < 101; index += 1) row.events.push({ at: new Date().toISOString(), kind: 'note', message: 'x' })
  await session.store.save(row)
  const next = await session.ask('继续', { onEvent, decide })
  assert.notEqual(next.id, listed.id)
  assert.equal(next.status, 'completed')
  assert.ok(events.some((entry) => entry.kind === 'note' && /交接摘要/.test(entry.text)))
  assert.ok(provider.done(), 'every scripted turn was used')

  // The service keeps the record, for the team and the web workbench.
  await session.sync.flush()
  const { missions } = await client.request('/api/rig/v1/missions')
  const synced = missions.find((entry) => entry.id === fixed.id)
  assert.equal(synced.surface, 'desktop')
  assert.equal(synced.client, 'terminal', 'the workbench can say it ran in a terminal')
  assert.equal(synced.agentKey, 'test-engineer')
  assert.equal(synced.messages, undefined, 'the transcript stays on this machine')
})

function run(args, { env = {}, input = '', cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.stdin.end(input)
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

test('from the command line: login, exec, an interactive session over a pipe, init', async (t) => {
  const { server, provider } = await service(t, [
    // exec without permission: the command is refused.
    () => ({ tool: 'workspace_run', args: { command: 'npm test' } }),
    // exec with --allow-command: it runs, and the answer goes to stdout.
    () => ({ tool: 'workspace_run', args: { command: 'npm test' } }),
    (body) => ({ answer: `测试失败，退出码 ${toolResult(body).exitCode}：${toolResult(body).output.trim().split('\n')[0]}` }),
    // The interactive session.
    () => ({ tool: 'workspace_run', args: { command: 'npm test' } }),
    () => ({ answer: '跑完了：1 个失败，期望值写错了。' })
  ])
  const root = await project()
  const home = await mkdtemp(join(tmpdir(), 'mx-rig-cli-home-'))

  // Signing in keeps the session in the member's home, readable only by them.
  const login = await run(['login', '--server', server.origin, '--account', 'admin'], {
    env: { MX_RIG_HOME: home },
    input: `${ADMIN}\n`
  })
  assert.equal(login.code, 0, login.stderr)
  assert.match(login.stdout, /已登录/)
  assert.equal((await stat(join(home, 'session.json'))).mode & 0o777, 0o600)
  assert.ok(!login.stdout.includes(ADMIN))
  const whoami = await run(['whoami'], { env: { MX_RIG_HOME: home } })
  assert.match(whoami.stdout, /admin/)

  const denied = await run(['exec', '跑一下测试', '--cwd', root], { env: { MX_RIG_HOME: home } })
  assert.equal(denied.code, 2, denied.stderr)
  assert.match(denied.stderr, /需要确认的动作没有执行：\$ npm test/)

  const allowed = await run(['exec', '跑一下测试', '--cwd', root, '--allow-command', 'npm test'], {
    env: { MX_RIG_HOME: home }
  })
  assert.equal(allowed.code, 0, allowed.stderr)
  assert.match(allowed.stdout.trim(), /^测试失败，退出码 1：>/)
  assert.match(allowed.stderr, /\$ npm test/)
  assert.match(allowed.stderr, /退出码 1/)

  const repl = await run(['--cwd', root], {
    env: { MX_RIG_HOME: home },
    input: '跑一下测试\ny\n/cases\n/nothing\n/exit\n'
  })
  assert.equal(repl.code, 0, repl.stderr)
  assert.match(repl.stdout, /MX Rig · 测试工程师/)
  assert.match(repl.stdout, /\? 在项目里运行命令/)
  assert.match(repl.stdout, /\$ npm test/)
  assert.match(repl.stdout, /\[y\] 执行 {2}\[a\] 本会话内这条命令都直接执行 {2}\[n\] 不执行/)
  assert.match(repl.stdout, /跑完了：1 个失败，期望值写错了。/)
  assert.match(repl.stdout, /当前任务没有起草用例/)
  assert.match(repl.stdout, /没有 \/nothing/)
  assert.ok(provider.done())

  // CI can pass a token instead of signing in.
  const ci = await run(['whoami'], { env: { MX_RIG_HOME: join(home, 'none'), MX_RIG_URL: server.origin, MX_RIG_TOKEN: ADMIN } })
  assert.match(ci.stdout, /来自环境变量/)

  const logout = await run(['logout'], { env: { MX_RIG_HOME: home } })
  assert.equal(logout.code, 0)
  await assert.rejects(stat(join(home, 'session.json')))
  const after = await run(['whoami'], { env: { MX_RIG_HOME: home } })
  assert.equal(after.code, 1)
  assert.match(after.stderr, /mx-rig login/)

  // init needs no service: it looks at the project and writes RIG.md once.
  const init = await run(['init', '--cwd', root, '--app', 'profile'], { env: { MX_RIG_HOME: home } })
  assert.equal(init.code, 0, init.stderr)
  const rig = await readFile(join(root, 'RIG.md'), 'utf8')
  assert.match(rig, /Rig 应用：profile/)
  assert.match(rig, /npm test：全部 `npm run test`/)
  const again = await run(['init', '--cwd', root], { env: { MX_RIG_HOME: home } })
  assert.match(again.stdout, /已经存在/)
})

test('in a terminal the browser works as on the desktop, and the trail becomes a spec or a procedure', async (t) => {
  const { chromium: engine } = await import('playwright')
  const launcher = { launch: (options) => engine.launch({ ...options, headless: true, channel: 'chromium' }) }
  const probe = await launcher.launch({}).catch(() => null)
  if (!probe) return t.skip('Chromium 未安装')
  await probe.close()
  const { createServer } = await import('node:http')
  const site = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>设置</title></head><body><h1>个人设置</h1></body></html>')
  })
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => site.close(resolve)))
  const origin = `http://127.0.0.1:${site.address().port}`
  const { server, state } = await service(t, [
    () => ({ tool: 'browser_open', args: { url: `${origin}/settings` } }),
    () => ({ tool: 'browser_assert', args: { kind: 'text_visible', expected: '个人设置' } }),
    () => ({ answer: '设置页能打开，标题「个人设置」可见。' })
  ])
  await server.settings.update({
    ...server.settings.value,
    allowedTools: [...server.settings.value.allowedTools, 'browser_open', 'browser_snapshot', 'browser_assert'],
    browserOrigins: [origin]
  })
  const root = await project()
  await mkdir(join(root, 'e2e'))
  const client = new RigClient({ url: server.origin, token: ADMIN })
  await client.request('/api/v1/apps', { slug: 'profile', displayName: '个人中心', surfaces: ['web'] })
  const { principal } = await client.request('/api/rig/v1/me')
  const session = await new TerminalSession({
    client,
    owner: principal.id,
    home: join(state, 'home'),
    workspaceRoot: root,
    launcher,
    headless: true
  }).init()
  t.after(() => session.close())
  const asked = []
  const row = await session.ask('看看设置页能不能打开', {
    decide: async (request) => {
      asked.push([request.tool, request.always])
      return 'yes'
    }
  })
  assert.equal(row.status, 'completed', JSON.stringify(row.events.at(-1)))
  assert.deepEqual(asked, [['browser_open', null]], 'a page is confirmed each time; there is no "always" for it')
  assert.equal(row.assertions[0].passed, true)

  // /export: the trail as a Playwright draft in the project.
  const spec = await session.exportSpec()
  assert.match(spec.content, /page\.goto\(/)
  await session.workspace.write({ path: `e2e/${spec.filename}`, content: spec.content, mode: 'overwrite' })
  assert.match(await readFile(join(root, 'e2e', spec.filename), 'utf8'), /toBeVisible|getByText/)

  // /capture: the same trail as a procedure, replayed without a model later.
  const { procedure } = await session.capture({ title: '设置页可打开', app: 'profile' })
  assert.deepEqual(procedure.steps.map((step) => step.do), ['open', 'assert'])
  const fired = await session.fire(procedure.id)
  assert.equal(fired.run.verdict, 'passed')

  // /replay: one file that plays the steps back, beside the member's missions.
  const replay = await session.replay(row.id)
  assert.equal(replay.frames, 2)
  assert.ok(replay.path.startsWith(join(state, 'home', 'replays')))
  const html = await readFile(replay.path, 'utf8')
  assert.match(html, /mountReplay\(document\.getElementById\('replay'\)/)
  assert.match(html, /data:image\/png;base64,/)
})

test('a procedure that broke is repaired from the terminal: fire, repair, prove, approve, fire again', async (t) => {
  const { chromium: engine } = await import('playwright')
  const launcher = { launch: (options) => engine.launch({ ...options, headless: true, channel: 'chromium' }) }
  const probe = await launcher.launch({}).catch(() => null)
  if (!probe) return t.skip('Chromium 未安装')
  await probe.close()
  const { createServer } = await import('node:http')
  const { PassThrough } = await import('node:stream')
  const { repl } = await import('../apps/terminal/repl.mjs')
  // The page changed its button from 保存 to 提交; what it does did not change.
  const site = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>设置</title></head><body>
<form onsubmit="event.preventDefault();document.getElementById('s').textContent='已保存'"><label for="n">昵称</label><input id="n"><button type="submit">提交</button></form><p id="s"></p></body></html>`)
  })
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => site.close(resolve)))
  const origin = `http://127.0.0.1:${site.address().port}`
  const steps = [
    { do: 'open', url: '/settings' },
    { do: 'fill', target: { label: '昵称' }, value: 'Rig' },
    { do: 'click', target: { role: 'button', name: '保存' } },
    { do: 'assert', kind: 'text_visible', expected: '已保存' }
  ]
  const { server, state } = await service(t, [
    // The procedure medic, at the page where step 3 failed.
    (body) => {
      assert.match(body.messages.find((m) => m.role === 'user').content, /第 3 步/)
      return { tool: 'browser_snapshot', args: {} }
    },
    () => ({
      tool: 'procedure_propose',
      args: {
        verdict: 'case-issue',
        rationale: '保存按钮改名为「提交」，保存行为没变。',
        steps: JSON.stringify(steps.map((step) => (step.do === 'click' ? { ...step, target: { role: 'button', name: '提交' } } : step)))
      }
    }),
    () => ({ answer: '改了第 3 步的按钮名称。' })
  ])
  await server.settings.update({
    ...server.settings.value,
    allowedTools: [...server.settings.value.allowedTools, 'browser_snapshot', 'browser_click', 'browser_fill', 'browser_assert'],
    browserOrigins: [origin]
  })
  const client = new RigClient({ url: server.origin, token: ADMIN })
  const { id } = (
    await client.request('/api/rig/v1/procedures', { procedure: { title: '设置保存', baseUrl: origin, steps } })
  ).procedure
  const { principal } = await client.request('/api/rig/v1/me')
  const session = await new TerminalSession({
    client,
    owner: principal.id,
    home: join(state, 'home'),
    workspaceRoot: await project(),
    launcher,
    headless: true
  }).init()
  t.after(() => session.close())

  const input = new PassThrough()
  const output = new PassThrough()
  let text = ''
  output.on('data', (chunk) => (text += chunk))
  const done = repl({ session, input, output })
  const waitFor = async (pattern) => {
    const deadline = Date.now() + 60_000
    while (!pattern.test(text) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    assert.match(text, pattern)
  }
  input.write(`/fire ${id}\n`)
  await waitFor(/\/repair prc_/)
  input.write(`/repair ${id}\n`)
  await waitFor(/批准这个修正、生成新版本/)
  input.write('y\n')
  await waitFor(/现在是第 2 版/)
  input.write(`/fire ${id}\n`)
  await waitFor(/✓ 通过/)
  input.end('/exit\n')
  await done
  assert.match(text, /✗ failed：第 3 步/)
  assert.match(text, /修正已通过验证试车：保存按钮改名为「提交」/)
  const { procedure } = await client.request(`/api/rig/v1/procedures/${id}`)
  assert.equal(procedure.revision, 2)
  assert.equal(procedure.steps[2].target.name, '提交')
})

test('mx-rig -c picks up this project’s last mission; another project starts fresh', async (t) => {
  const { server } = await service(t, [
    () => ({ answer: '记住了：登录页用 /signin。' }),
    // The next day, continued: the model sees the earlier exchange.
    (body) => {
      assert.ok(body.messages.some((m) => m.role === 'user' && /登录页在 \/signin/.test(m.content)))
      assert.equal(body.messages.at(-1).content, '那登录页在哪？')
      return { answer: '/signin。' }
    },
    // Elsewhere, nothing carried over.
    (body) => {
      assert.equal(body.messages.filter((m) => m.role === 'user').length, 1)
      return { answer: '新任务。' }
    }
  ])
  const root = await project()
  const other = await project()
  const home = await mkdtemp(join(tmpdir(), 'mx-rig-cli-home-'))
  const env = { MX_RIG_HOME: home, MX_RIG_URL: server.origin, MX_RIG_TOKEN: ADMIN }
  const first = await run(['--cwd', root], { env, input: '记一下：登录页在 /signin\n/exit\n' })
  assert.equal(first.code, 0, first.stderr)
  const again = await run(['-c', '--cwd', root], { env, input: '/history\n那登录页在哪？\n/exit\n' })
  assert.equal(again.code, 0, again.stderr)
  assert.match(again.stdout, /接着上次的任务：「记一下：登录页在 \/signin」/)
  assert.match(again.stdout, /1\. ● 记一下：登录页在 \/signin/)
  assert.match(again.stdout, /\/signin。/)
  assert.match(again.stdout, /本任务累计约 [\d,]+ tokens · 2 次模型调用/)
  const elsewhere = await run(['-c', '--cwd', other], { env, input: '随便问问\n/exit\n' })
  assert.match(elsewhere.stdout, /这个项目还没有终端任务/)
  assert.match(elsewhere.stdout, /新任务。/)
})
