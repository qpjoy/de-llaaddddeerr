import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../apps/server/index.mjs'
import { BrowserTools } from '../packages/runtime/browser.mjs'
import { ProcedureStation, enrollStation } from '../packages/runtime/station.mjs'
import { batchSummary } from '../packages/runtime/procedure.mjs'
import { normalizeSummary } from '../packages/test-platform/server/ingest/summary.mjs'
import { fileURLToPath } from 'node:url'
import { RigClient } from '../packages/runtime/client.mjs'
import { localStation } from '../apps/desktop/local-runner.mjs'

// The service coordinates, a station executes: a regression task queues a
// batch of an app's procedures, a station claims it like a runner, replays
// them with its own browser, and reports each as a case of one run.

const ADMIN = 'station-admin-token'

async function chromium() {
  const { chromium: engine } = await import('playwright')
  const launcher = {
    launch: (options) => engine.launch({ ...options, headless: true, channel: 'chromium' })
  }
  const probe = await launcher.launch({}).catch(() => null)
  if (!probe) return null
  await probe.close()
  return launcher
}

/** A Rig service in memory, with a member-style caller. */
async function service(t, { origins = [] } = {}) {
  const state = await mkdtemp(join(tmpdir(), 'mx-rig-station-'))
  const server = await start(
    {
      MX_RIG_ADMIN_TOKEN: ADMIN,
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: join(state, 'control'),
      MX_RIG_ARTIFACTS_DIR: join(state, 'artifacts')
    },
    { schedule: false }
  )
  t.after(() => server.close())
  await server.settings.update({ ...server.settings.value, browserOrigins: origins })
  const call = async (method, path, body, token = ADMIN) => {
    const response = await fetch(server.origin + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: response.status === 204 ? null : await response.json() }
  }
  return { server, call, state }
}

/** A catalog case and the procedure that implements it, proven once and enabled. */
async function procedure(call, { app, caseId, title, baseUrl, steps }) {
  await call('POST', `/api/v1/apps/${app}/cases`, { caseId, title, priority: 'P1', steps: [] })
  const { id } = (await call('POST', '/api/rig/v1/procedures', { procedure: { title, app, caseId, baseUrl, steps } })).body
    .procedure
  // Only active procedures join a batch, and only a proven one can be enabled.
  await call('POST', `/api/rig/v1/procedures/${id}/runs`, {
    run: { revision: 1, verdict: 'passed', failedStep: null, failure: null, steps: [], startedAt: '2026-09-29T00:00:00.000Z', finishedAt: '2026-09-29T00:00:01.000Z', durationMs: 1, station: 'test' }
  })
  assert.equal((await call('POST', `/api/rig/v1/procedures/${id}:status`, { status: 'active' })).status, 200)
  return id
}

/** The settings page the procedures drive; under /renamed its button changed. */
async function settingsSite(t) {
  const web = createServer((req, res) => {
    const button = req.url.startsWith('/renamed') ? '提交' : '保存'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>设置</title></head><body>
<form onsubmit="event.preventDefault();document.getElementById('s').textContent='已保存'"><label for="n">昵称</label><input id="n"><button type="submit">${button}</button></form><p id="s"></p></body></html>`)
  })
  await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => web.close(resolve)))
  return `http://127.0.0.1:${web.address().port}`
}

const SAVE = [
  { do: 'fill', target: { label: '昵称' }, value: 'Rig' },
  { do: 'click', target: { role: 'button', name: '保存' } },
  { do: 'assert', kind: 'text_visible', expected: '已保存' }
]

test('an empty or mixed batch reads the way the kernel reads any run', () => {
  const empty = normalizeSummary(batchSummary([]), 0)
  assert.equal(empty.status, 'blocked')
  assert.match(empty.blockedReason, /没有可以回归的规程/)
  const procedure = (id) => ({ id, revision: 1, title: id, caseId: `PRF-WEB-SET-00${id}`, steps: [] })
  const result = (verdict) => ({
    verdict,
    durationMs: 10,
    steps: [],
    failure: verdict === 'passed' ? null : { index: 0, message: '找不到' },
    startedAt: '2026-09-29T00:00:00.000Z',
    finishedAt: '2026-09-29T00:00:01.000Z'
  })
  const mixed = normalizeSummary(
    batchSummary([
      { procedure: procedure(1), result: result('passed') },
      { procedure: procedure(2), result: result('blocked') }
    ]),
    0
  )
  assert.equal(mixed.status, 'passed')
  assert.deepEqual(
    mixed.cases.map((entry) => entry.status),
    ['passed', 'skipped'],
    'a blocked replay is visible as skipped, not hidden'
  )
})

test('a station claims a regression batch, replays it, and reports one run', async (t) => {
  const launcher = await chromium()
  if (!launcher) return t.skip('Chromium 未安装')

  const origin = await settingsSite(t)
  const { server, call, state } = await service(t, { origins: [origin] })
  await call('POST', '/api/v1/apps', { slug: 'profile', displayName: '个人中心', surfaces: ['web'] })
  const good = await procedure(call, {
    app: 'profile',
    caseId: 'PRF-WEB-SET-001',
    title: '设置保存',
    baseUrl: origin,
    steps: [{ do: 'open', url: '/settings' }, ...SAVE]
  })
  const drifted = await procedure(call, {
    app: 'profile',
    caseId: 'PRF-WEB-SET-002',
    title: '改版后的设置保存',
    baseUrl: origin,
    steps: [{ do: 'open', url: '/renamed' }, ...SAVE]
  })

  // Regression is a kernel task on the app's procedure suite.
  const created = await call('POST', '/api/rig/v1/procedure-tasks', { app: 'profile', name: '夜间回归' })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const taskId = created.body.task.id

  // A station, enrolled with a one-shot code; and a Playwright runner that
  // must never be handed a procedure batch.
  const code = async () => (await call('POST', '/api/v1/runners:enroll', {})).body.code
  const enrolled = await enrollStation({ server: server.origin, code: await code(), name: 'station-1', kind: 'local', os: 'linux', arch: 'x64' })
  const playwright = await (
    await fetch(`${server.origin}/runner/v1/runners:enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: await code(), name: 'pw', kind: 'local', os: 'linux', arch: 'x64', engines: ['playwright'], surfaces: ['web'] })
    })
  ).json()

  const dispatched = await call('POST', `/api/rig/v1/procedure-tasks/${taskId}:run`, {})
  assert.equal(dispatched.status, 201, JSON.stringify(dispatched.body))
  const runId = dispatched.body.run.id
  assert.equal(dispatched.body.run.status, 'pending-runner', 'waits for a station')
  assert.equal((await call('POST', '/runner/v1/runs:claim', {}, playwright.token)).status, 204)

  const root = join(state, 'station')
  const station = new ProcedureStation({
    server: server.origin,
    runnerToken: enrolled.runnerToken,
    browser: new BrowserTools(root, launcher, { headless: true }),
    root
  })
  t.after(() => station.browser.close())
  const outcome = await station.once()
  assert.deepEqual([outcome.runId, outcome.status, outcome.procedures], [runId, 'failed', 2])
  assert.equal(await station.once(), null, 'nothing left to take')

  const run = (await call('GET', `/api/v1/runs/${runId}`)).body.run
  assert.equal(run.status, 'failed')
  const cases = (await call('GET', `/api/v1/runs/${runId}/cases`)).body.cases
  assert.deepEqual(
    cases.map((entry) => [entry.caseId, entry.status]),
    [
      ['PRF-WEB-SET-001', 'passed'],
      ['PRF-WEB-SET-002', 'failed']
    ],
    'measured against the procedures it replayed, nothing else'
  )
  assert.equal(cases[1].steps.length, 4)
  const artifacts = (await call('GET', `/api/v1/runs/${runId}/artifacts`)).body.artifacts
  assert.ok(artifacts.some((entry) => /procedures\/2-stop\.png$/.test(entry.path ?? entry.name ?? '')), JSON.stringify(artifacts))
  // A finished run's stream replays its backlog and ends.
  const stream = await (
    await fetch(`${server.origin}/api/v1/runs/${runId}/events`, { headers: { authorization: `Bearer ${ADMIN}` } })
  ).text()
  assert.match(stream, /event: case\.finished/, 'reported live')
  assert.match(stream, /event: end/)

  // Each replay is on its procedure, tied to the batch run, not a run of its own.
  const record = (await call('GET', `/api/rig/v1/procedures/${drifted}`)).body.procedure.runs[0]
  assert.deepEqual([record.station, record.verdict, record.kernelRunId, record.failedStep], ['station', 'failed', runId, 2])
  assert.equal((await call('GET', `/api/rig/v1/procedures/${good}`)).body.procedure.runs[0].kernelRunId, runId)

  // The run token dies with the run; a stranger never had one.
  assert.equal((await call('GET', `/api/rig/v1/station/runs/${runId}/procedures`, undefined, 'nope')).status, 403)

  // The members' view: the task with its last run, and the station.
  const overview = (await call('GET', '/api/rig/v1/procedure-tasks')).body
  assert.deepEqual(
    overview.tasks.map((task) => [task.name, task.app, task.lastRun?.id, task.lastRun?.status]),
    [['夜间回归', 'profile', runId, 'failed']]
  )
  assert.deepEqual(overview.stations.map((entry) => entry.name), ['station-1'])
  assert.deepEqual(overview.apps, [{ slug: 'profile', procedures: 2 }])

  // An app with nothing to replay is completed as blocked, not left to expire.
  await call('POST', '/api/v1/apps', { slug: 'empty', displayName: '空', surfaces: ['web'] })
  const emptyTask = (await call('POST', '/api/rig/v1/procedure-tasks', { app: 'empty', name: '空回归' })).body.task
  const emptyRun = (await call('POST', `/api/rig/v1/procedure-tasks/${emptyTask.id}:run`, {})).body.run
  const blocked = await station.once()
  assert.deepEqual([blocked.runId, blocked.status], [emptyRun.id, 'blocked'])
  assert.equal((await call('GET', `/api/v1/runs/${emptyRun.id}`)).body.run.status, 'blocked')
})

test('a cancelled batch stops between steps and sends the stop receipt', async (t) => {
  const origin = 'http://127.0.0.1:9'
  const { server, call, state } = await service(t, { origins: [origin] })
  await call('POST', '/api/v1/apps', { slug: 'slow', displayName: '慢应用', surfaces: ['web'] })
  const id = await procedure(call, {
    app: 'slow',
    caseId: 'SLW-WEB-OPN-001',
    title: '打开',
    baseUrl: origin,
    steps: [
      { do: 'open', url: '/' },
      { do: 'open', url: '/2' }
    ]
  })
  const task = (await call('POST', '/api/rig/v1/procedure-tasks', { app: 'slow', name: '回归' })).body.task
  const code = (await call('POST', '/api/v1/runners:enroll', {})).body.code
  const enrolled = await enrollStation({ server: server.origin, code, name: 'station-2', kind: 'local', os: 'linux', arch: 'x64' })
  const runId = (await call('POST', `/api/rig/v1/procedure-tasks/${task.id}:run`, {})).body.run.id

  // A page that never finishes loading, until the run is stopped.
  let entered
  const inside = new Promise((resolve) => (entered = resolve))
  const performed = []
  const browser = {
    root: state,
    async perform(step, { signal }) {
      performed.push(step.url)
      entered()
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
    async close() {}
  }
  const station = new ProcedureStation({ server: server.origin, runnerToken: enrolled.runnerToken, browser, heartbeatMs: 50 })
  const outcome = station.once()
  await inside
  assert.equal((await call('POST', `/api/v1/runs/${runId}:cancel`, {})).status, 200)
  assert.deepEqual(await outcome, { runId, status: 'cancelled' })
  assert.deepEqual(performed, [`${origin}/`], 'the second step never starts')
  const run = (await call('GET', `/api/v1/runs/${runId}`)).body.run
  assert.deepEqual([run.status, run.cancellation.stopState], ['cancelled', 'stopped'])
  const doc = (await call('GET', `/api/rig/v1/procedures/${id}`)).body.procedure
  assert.equal(doc.runs.filter((entry) => entry.kernelRunId === runId).length, 0, 'nothing recorded for a stopped replay')
})

test('a desktop on duty runs `mx-rig station watch`, takes a batch, and stops politely', async (t) => {
  if (!(await chromium())) return t.skip('Chromium 未安装')
  const origin = await settingsSite(t)
  const { server, call, state } = await service(t, { origins: [origin] })
  await call('POST', '/api/v1/apps', { slug: 'profile', displayName: '个人中心', surfaces: ['web'] })
  const id = await procedure(call, {
    app: 'profile',
    caseId: 'PRF-WEB-SET-001',
    title: '设置保存',
    baseUrl: origin,
    steps: [{ do: 'open', url: '/settings' }, ...SAVE]
  })
  const task = (await call('POST', '/api/rig/v1/procedure-tasks', { app: 'profile', name: '值守回归' })).body.task

  // What the desktop does with the member's session: register this computer
  // as a station, keep its token in the profile, start the program.
  const client = new RigClient({ url: server.origin, token: ADMIN })
  const station = localStation({
    dir: join(state, 'station'),
    script: fileURLToPath(new URL('../bin/mx-rig.mjs', import.meta.url))
  })
  t.after(() => station.stop(2_000))
  await assert.rejects(station.start(), { code: 'runner_unregistered', message: /工位/ })
  const registered = await station.register(client, { name: 'my-mac', engines: ['cypress'] })
  assert.deepEqual([registered.name, registered.engines, registered.surfaces], ['my-mac', ['rig-procedure'], ['web']], 'a person cannot widen a station')
  await station.start()

  const runId = (await call('POST', `/api/rig/v1/procedure-tasks/${task.id}:run`, {})).body.run.id
  const deadline = Date.now() + 60_000
  let run
  while (Date.now() < deadline) {
    run = (await call('GET', `/api/v1/runs/${runId}`)).body.run
    if (['passed', 'failed', 'blocked'].includes(run.status)) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.equal(run.status, 'passed', (await station.status()).log.join('\n'))
  assert.equal((await call('GET', `/api/rig/v1/procedures/${id}`)).body.procedure.runs[0].kernelRunId, runId)
  const overview = (await call('GET', '/api/rig/v1/procedure-tasks')).body
  assert.deepEqual(
    overview.stations.map((entry) => [entry.name, entry.kind, entry.mine]),
    [['my-mac', 'local', true]]
  )

  const began = Date.now()
  const stopped = await station.stop(10_000)
  assert.ok(Date.now() - began < 8_000, 'a stop cuts the idle wait short')
  assert.equal(stopped.exited.code, 0, (stopped.log ?? []).join('\n'))
  assert.ok(stopped.log.some((line) => /设置保存/.test(line)))
  assert.ok(stopped.log.some((line) => /收到停止请求/.test(line)))
  const removed = await station.remove(client)
  assert.deepEqual([removed.registered, removed.unregistered], [false, true])
})

test('the procedures page sets up regression and shows where it runs', async (t) => {
  if (!(await chromium())) return t.skip('Chromium 未安装')
  const origin = await settingsSite(t)
  const { server, call } = await service(t, { origins: [origin] })
  await call('POST', '/api/v1/apps', { slug: 'profile', displayName: '个人中心', surfaces: ['web'] })
  await procedure(call, {
    app: 'profile',
    caseId: 'PRF-WEB-SET-001',
    title: '设置保存',
    baseUrl: origin,
    steps: [{ do: 'open', url: '/settings' }, ...SAVE]
  })
  const code = (await call('POST', '/api/v1/runners:enroll', {})).body.code
  await enrollStation({ server: server.origin, code, name: 'team-station', kind: 'server', os: 'linux', arch: 'x64' })

  const { chromium: engine } = await import('playwright')
  const browser = await engine.launch({ headless: true, channel: 'chromium' })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(server.origin + '/rig/')
  await page.locator('#account').fill('admin')
  await page.locator('#password').fill(ADMIN)
  await page.locator('#login-form button').click()
  await page.locator('#workspace').waitFor({ state: 'visible' })
  await page.locator('.rig-nav__item', { hasText: '试验规程' }).click()
  await page.getByRole('heading', { name: '定时回归' }).waitFor()
  assert.ok(await page.getByText('team-station').isVisible(), 'the team station is listed')
  assert.equal(await page.getByText('本机工位值守').count(), 0, 'duty is a desktop thing')

  await page.locator('#regression-form summary').click()
  await page.locator('#regression-name').fill('夜间回归')
  await page.locator('#regression-cron').fill('0 2 * * *')
  await page.locator('#regression-runs-on').selectOption('server')
  await page.locator('#regression-save').click()
  await page.getByText('0 2 * * *', { exact: false }).waitFor()
  assert.ok(await page.getByText('团队工位（服务器 / 容器）').first().isVisible())
  await page.getByRole('button', { name: '立即回归' }).click()
  await page.getByText(/已排队|已派发/).waitFor()

  const tasks = (await call('GET', '/api/rig/v1/procedure-tasks')).body.tasks
  const queued = (await call('GET', `/api/v1/runs/${tasks[0].lastRunId}`)).body.run
  assert.deepEqual(
    [queued.status, queued.runsOn, Boolean(queued.claimDeadline)],
    ['pending-runner', 'server', true],
    'a team batch waits for a team station, and can expire'
  )
  assert.deepEqual(
    tasks.map((task) => [task.name, task.scheduleKind, task.cronExpr, task.runsOn, Boolean(task.lastRunId)]),
    [['夜间回归', 'cron', '0 2 * * *', 'server', true]]
  )
  assert.deepEqual(errors, [])
})

test('Ctrl-C or docker stop mid-batch lets the batch finish, browser and evidence intact', async (t) => {
  if (!(await chromium())) return t.skip('Chromium 未安装')
  const { spawn } = await import('node:child_process')
  // A page that takes a moment: the stop arrives while the first step waits.
  const web = createServer((req, res) => {
    const send = () => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>慢页面</title></head><body><h1>已加载</h1></body></html>')
    }
    if (req.url.startsWith('/slow')) setTimeout(send, 1_500)
    else send()
  })
  await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => web.close(resolve)))
  const origin = `http://127.0.0.1:${web.address().port}`
  const { server, call, state } = await service(t, { origins: [origin] })
  await call('POST', '/api/v1/apps', { slug: 'slow', displayName: '慢应用', surfaces: ['web'] })
  await procedure(call, {
    app: 'slow',
    caseId: 'SLW-WEB-LD-001',
    title: '慢页面加载',
    baseUrl: origin,
    steps: [
      { do: 'open', url: '/slow' },
      { do: 'assert', kind: 'text_visible', expected: '已加载' }
    ]
  })
  await procedure(call, {
    app: 'slow',
    caseId: 'SLW-WEB-LD-002',
    title: '改版后的标题',
    baseUrl: origin,
    steps: [
      { do: 'open', url: '/' },
      { do: 'assert', kind: 'title_contains', expected: '新版' }
    ]
  })
  const task = (await call('POST', '/api/rig/v1/procedure-tasks', { app: 'slow', name: '回归' })).body.task
  const dir = join(state, 'cli-station')
  const cli = fileURLToPath(new URL('../bin/mx-rig.mjs', import.meta.url))
  const code = (await call('POST', '/api/v1/runners:enroll', {})).body.code
  const enrol = spawn(process.execPath, [cli, 'station', 'enroll', '--server', server.origin, '--code', code, '--name', 'cli', '--kind', 'local'], {
    env: { ...process.env, MX_RIG_STATION_DIR: dir }
  })
  assert.equal(await new Promise((resolve) => enrol.on('exit', resolve)), 0)

  const runId = (await call('POST', `/api/rig/v1/procedure-tasks/${task.id}:run`, {})).body.run.id
  const child = spawn(process.execPath, [cli, 'station', 'watch'], {
    env: { ...process.env, MX_RIG_STATION_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  t.after(() => child.exitCode === null && child.kill('SIGKILL'))
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const deadline = Date.now() + 30_000
  while (!/▶/.test(output) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.match(output, /▶/, output)
  child.kill('SIGTERM')
  const exit = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  assert.deepEqual(exit, { code: 0, signal: null }, output)
  assert.match(output, /当前批次完成后停止/)

  const run = (await call('GET', `/api/v1/runs/${runId}`)).body.run
  assert.equal(run.status, 'failed', output)
  const cases = (await call('GET', `/api/v1/runs/${runId}/cases`)).body.cases
  assert.deepEqual(
    cases.map((entry) => [entry.caseId, entry.status]),
    [
      ['SLW-WEB-LD-001', 'passed'],
      ['SLW-WEB-LD-002', 'failed']
    ],
    'the stop did not decide any verdict'
  )
  const artifacts = (await call('GET', `/api/v1/runs/${runId}/artifacts`)).body.artifacts
  assert.ok(artifacts.some((entry) => /procedures\/2-stop\.png$/.test(entry.path ?? '')), 'the failure kept its evidence')
})
